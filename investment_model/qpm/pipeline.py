"""Monthly workflow: ① market → ② FRED → ③ validation → ④ macro → ⑤ ETF stats → ⑥ score → ⑦ covariance →
⑧ risk model → ⑨ parameter set → ⑩ optimisation → ⑪ target → ⑫ actual → ⑬ target vs actual → ⑭ orders."""
from __future__ import annotations
import datetime as dt
import time
import numpy as np
import pandas as pd
from . import SYSTEM_VERSION, MODEL_VERSION
from .config import Config, load_json, save_json, month_key, first_trading_day_next_month
from .data_layer import DataLayer
from .validation import validate_data, validate_model
from .etf_stats import build_context
from .scoring import build_scores, sample_flag
from .engine import optimize, apply_band, covariance
from .analytics import (factor_betas, portfolio_metrics, stress, constraint_table, frontier, stability, zero_weight,
                        special_analysis, class_weights)
from .macro import factor_table, composite_label
from .history import History
from .commentary import build_facts, rule_based_commentary, llm_commentary
from .rebalance import parse_actual_csv, normalize_actual, compare
from .dashboard import write_dashboard


class ValidationError(Exception):
    def __init__(self, report):
        super().__init__("검증 실패 — 오류 항목을 확인한 뒤 다시 실행하세요.")
        self.report = report


def _f(x):
    try:
        return None if x is None or pd.isna(x) else float(x)
    except (TypeError, ValueError):
        return None


def _ref_history(cfg):
    p = cfg.path("history_dir") / "_reference" / "backtest_chain_weights.csv"
    if not p.exists():
        return []
    W = pd.read_csv(p, index_col=0)
    return [dict(month=str(m), class_weights={c: float(sum(float(r.get(t, 0.0)) for t in cfg.tickers if cfg.asset_class[t] == c))
                                              for c in cfg.universe["asset_class_order"]}) for m, r in W.iterrows()]


def detect_as_of(mkt, cfg):
    adj = mkt["Adj Close"][cfg.tickers]
    cnt = adj.notna().sum(axis=1)
    return cnt[cnt >= int(0.9 * len(cfg.tickers))].index[-1]


def update_data(cfg=None, as_of=None, fred_mode=None, log=print):
    cfg = cfg or Config()
    dl = DataLayer(cfg, log)
    mode = fred_mode or cfg.settings.get("fred_mode", "csv")
    log("① Update Market Data (yfinance)")
    mkt = dl.update_market(as_of)
    a = pd.Timestamp(as_of) if as_of else detect_as_of(mkt, cfg)
    log(f"② Update FRED ({mode})")
    _, frep = dl.update_fred(mode)
    vrep = None
    if cfg.settings.get("use_alfred_vintage", True):
        _, vrep = dl.fetch_vintages(a, mode)
    dl.update_reference()
    rec = dict(as_of=str(a.date()), fred_mode=mode, fred_report=frep, vintage_report=vrep,
               updated_at=dt.datetime.now().isoformat(timespec="seconds"))
    save_json(rec, dl.dir / "_last_update.json")
    log(f"Data As Of 자동 인식: {a.date()}")
    return rec


def _inputs(cfg, as_of, log):
    dl = DataLayer(cfg, log)
    mkt, F = dl.load_market(), dl.load_fred()
    a = pd.Timestamp(as_of) if as_of else detect_as_of(mkt, cfg)
    p = dl.dir / "_last_update.json"
    lu = load_json(p) if p.exists() else {}
    vint, vrep = {}, None
    if cfg.settings.get("use_alfred_vintage", True):
        vint, vrep = dl.fetch_vintages(a, cfg.settings.get("fred_mode", "csv"))
    return dl, mkt, F, vint, lu.get("fred_report"), vrep, a


def validate(cfg=None, as_of=None, log=print):
    cfg = cfg or Config()
    dl, mkt, F, vint, frep, vrep, a = _inputs(cfg, as_of, log)
    log("③ Data Validation")
    rep = validate_data(cfg, mkt, {**F, **vint}, frep, vrep, a)
    out = dict(as_of=str(a.date()), **rep.to_dict())
    save_json(out, cfg.path("output_dir") / "validation_latest.json")
    log(f"검증 결과: {out['summary']}")
    return out


def _limitations(cfg, vint, special, P, stab_verdict, basis, bt):
    lab = []
    lab.append(dict(item="Data vintage", status=(f"Actual — 월간 운용 시점: ALFRED as-of 빈티지 {len(vint)}개 시리즈 사용. 과거 백테스트는 발표시차 규칙(빈티지 미통제)"
                                                if vint else "Estimated — ALFRED 빈티지 미사용, 발표시차 규칙만 적용"), label=("Actual" if vint else "Estimated")))
    lab.append(dict(item="FRED release lag", status="Computed — 월간 지표 1개월(발표일 가드), 주간 지표 1~5일 지연 반영", label="Computed"))
    lab.append(dict(item="JAAA history", status=f"약 {special['JAAA']['history_months']/12:.1f}년 (2020-10 상장) — 2020-03 위기 미경험", label="Insufficient Sample"))
    lab.append(dict(item="JBBB history", status=f"약 {special['JBBB']['history_months']/12:.1f}년 (2022-01 상장) — 2020년 위기 미경험", label="Insufficient Sample"))
    lab.append(dict(item="PFF duration", status="FPE 유효 듀레이션 5.42를 대용 (실증 금리 베타로 교차 확인)", label="Proxy"))
    lab.append(dict(item="PFF 금융주 집중도", status="공급사 섹터 데이터 부재 — XLF 베타로 대체", label="Proxy"))
    lab.append(dict(item="Expected return κ=1.0", status="모델 기대수익은 모멘텀 틸트로 과대 가능 — OOS 실현치와 별도 표시", label="Estimated"))
    lab.append(dict(item="CLO liquidity stress", status="짧은 표본의 팩터 회귀 — 스트레스 손실 과소추정 가능", label="Estimated"))
    lab.append(dict(item="Short-history ETFs (Macro score)", status="GPIX·JEPQ·JEPI·DBMF·VYMI·PDBC·JAAA·JBBB: 유사국면 관측 < 24개월 → 부분/중립 가중", label="Insufficient Sample"))
    lab.append(dict(item="Tax · ROC · ELN income", status="분배금 과세·ROC·ELN 일반소득 처리 미반영", label="Not modelled"))
    lab.append(dict(item="FX", status="원화 환산·환헤지 미반영 (USD 기준)", label="Not modelled"))
    lab.append(dict(item="Factor beta stability", status="2010~ 월간 회귀 — 신규 ETF는 표본 짧음", label="Estimated"))
    lab.append(dict(item="Transaction cost", status=f"회전율 1단위당 {P['tc_bps']:.0f}bp 가정 (스프레드·슬리피지 포함)", label="Estimated"))
    lab.append(dict(item="Parameter stability", status=stab_verdict, label="Computed"))
    lab.append(dict(item="Current weights", status=("실보유 기준" if basis == "actual" else "Actual 미입력 — Model Current(직전 목표의 드리프트 추정)로 최적화"), label=("Actual" if basis == "actual" else "Estimated")))
    return lab


def run_model(cfg=None, as_of=None, current_basis="model", log=print, source="live", make_html=True, llm=None):
    t0 = time.time()
    cfg = cfg or Config()
    P = cfg.engine_params()
    U = cfg.tickers
    dl, mkt, F, vint, frep, vrep, a = _inputs(cfg, as_of, log)
    month = month_key(a)
    reb = first_trading_day_next_month(a)
    log(f"Data As Of {a.date()} → {reb:%Y-%m} 목표 (리밸런싱 {reb})")
    log("③ Data Validation")
    F2 = {**F, **vint}
    vdata = validate_data(cfg, mkt, F2, frep, vrep, a)
    if vdata.errors:
        out = dict(as_of=str(a.date()), **vdata.to_dict())
        save_json(out, cfg.path("output_dir") / "validation_latest.json")
        raise ValidationError(out)
    ctx = build_context(cfg, mkt, F2, a, frozenset(vint), log)
    t, met = ctx.t, ctx.met
    log("⑥ ETF Score")
    S = build_scores(met, ctx.avail, ctx.cond_n, P["L"], P["wsets"][P["cfg"]], P["mac_full"])
    Srow = S["total"].loc[t]
    log("⑦ Correlation / Covariance")
    _, ev_min = covariance(ctx.Rm_me, t, P["cov_win"], P["shrink"], with_eig=True)
    B, N = factor_betas(ctx)
    log("⑧ Risk Model (60M 수축 공분산 · CVaR95 · 팩터 베타)")
    wfp = cfg.params.get("walk_forward", {})
    wf_due = int(wfp.get("last_selection_year", 0)) < a.year
    log(f"⑨ Parameter set: {cfg.params['param_source']}" + (" — 올해 워크포워드 재선정 필요" if wf_due else ""))
    hist = History(cfg)
    prev = hist.previous(month)
    prev_result = hist.load_result(prev["month"]) if prev else None
    if prev_result is not None and "scores" not in prev_result:
        prev_result = None
    model_current = None
    if prev is not None:
        TR = ctx.P["TR"]
        p0, p1 = TR.loc[:pd.Timestamp(prev["as_of"])].iloc[-1], TR.loc[:a].iloc[-1]
        mc = prev["target"].reindex(U).fillna(0.0) * (p1 / p0).reindex(U).fillna(1.0)
        model_current = mc / mc.sum()
    act = hist.load_actual(month)
    basis, w_basis = "model", model_current
    if current_basis == "actual" and act is not None:
        w_basis = act.set_index("ticker")["weight"].reindex(U).fillna(0.0)
        basis = "actual"
    y_hist = hist.income_history_before(month)
    log("⑩ Portfolio Optimization")
    raw, info = optimize(ctx, t, Srow, w_basis if w_basis is not None else pd.Series(0.0, index=U), y_hist, P)
    final, kept = apply_band(raw, w_basis, P["band"], P["single"], cfg.cash)
    y = met["yield_ttm"].loc[t].fillna(0)
    inc_final = float((final * y).sum())
    inc_chk = float(np.dot(final.reindex(U).values, y.reindex(U).values))
    vmodel = validate_model(cfg, raw, final, info, P, ev_min, inc_final, inc_chk)
    if vmodel.errors:
        out = dict(as_of=str(a.date()), **vdata.extend(vmodel).to_dict())
        save_json(out, cfg.path("output_dir") / "validation_latest.json")
        raise ValidationError(out)
    log("⑪ Target Portfolio · 지표 · 제약 진단 · 프론티어 · 민감도 · 스트레스")
    mu = info["mu"]
    pm_t = portfolio_metrics(ctx, final, mu, y_hist, B, P)
    pm_t["Turnover_vs_model_current"] = float((final - w_basis).abs().sum()) if w_basis is not None else None
    pm_c = portfolio_metrics(ctx, model_current, mu, y_hist, B, P) if model_current is not None else None
    cons_rows, order, pen = constraint_table(ctx, raw, final, info, P, float((raw * y).sum()), inc_final, pm_t["Income_12M"])
    fr_rows, relax, frW = frontier(ctx, Srow, w_basis, y_hist, P, B, info["risk_state"], info["def_state"])
    st_rows, stW, verdict = stability(ctx, Srow, w_basis, y_hist, P, raw, final)
    s_rows = stress(ctx, final, B)
    z_rows, z_note = zero_weight(ctx, final, raw, info, S, B, cons_rows, P)
    ref, refmeta = dl.load_reference()
    special = special_analysis(ctx, final, B, N, s_rows, P, ref, refmeta)
    lp = ctx.P["close"][U].ffill().loc[:a].iloc[-1]
    names = {e["ticker"]: e["name"] for e in cfg.universe["etfs"]}
    mp = info["mu_parts"]
    rows = [dict(ticker=e, name=names[e], asset_class=cfg.asset_class[e], target=float(final[e]),
                 model_current=(float(model_current[e]) if model_current is not None else None), raw_opt=float(raw[e]),
                 unconstrained=float(frW["Unconstrained"][e]), band_kept=(e in kept), yield_ttm=float(y[e]), exp_ret=float(mu[e]),
                 mu_base=float(mp["base"][e]), mu_signal=float(mp["signal"][e]), mu_regime=float(mp["regime"][e]),
                 score=_f(Srow.get(e)), price=float(lp[e]), beta_eq=_f(B.loc[e, "EQ"]) if e in B.index else None,
                 duration=cfg.durations[e]) for e in U]
    tot = S["total"].loc[t]
    rk = tot.rank(ascending=False)
    cobs = ctx.cond_n.loc[t] if t in ctx.cond_n.index else pd.Series(np.nan, index=U)
    hz = S["hist_z"]
    first = {e: ctx.P["adj"][e].first_valid_index() for e in U}
    scores = []
    for e in U:
        g = lambda k: _f(met[k].loc[t, e])
        scores.append(dict(ticker=e, asset_class=cfg.asset_class[e], ret_1m=g("ret_1m"), ret_3m=g("ret_3m"), ret_6m=g("ret_6m"), ret_12m=g("ret_12m"),
                           ret_24m=g("ret_24m"), cagr_5y=g("cagr_5y"), mom_z=_f(S["ret"].loc[t, e]), ra_z=_f(S["ra"].loc[t, e]),
                           inc_z=_f(S["inc"].loc[t, e]), mac_z=_f(S["mac"].loc[t, e]), mac_raw=_f(S["mac_raw"].loc[t, e]),
                           mac_weight=_f(S["mac_wgt"].loc[t, e]), risk_z=_f(S["pen"].loc[t, e]), total=_f(tot[e]), rank=_f(rk[e]),
                           ttm_yield=g("yield_ttm"), income_12m_avg=g("income_12m_avg"), dist_growth=g("dist_growth"), dist_stab=g("dist_stab"),
                           vol_3m=g("vol_3m"), vol_6m=g("vol_6m"), vol_12m=g("vol_12m"), ddev_12m=g("ddev_12m"), mdd_12m=g("mdd_12m"),
                           cvar95_12m=g("cvar95_12m"), sharpe_12m=g("sharpe_12m"), sortino_12m=g("sortino_12m"), calmar_12m=g("calmar_12m"),
                           cond_sharpe=g("cond_sharpe"), cond_obs=_f(cobs.get(e)), sample_flag=sample_flag(_f(cobs.get(e))),
                           hz_ret12=_f(hz["ret_12m"].loc[t, e]), hz_sharpe=_f(hz["sharpe_12m"].loc[t, e]), hz_yield=_f(hz["yield_ttm"].loc[t, e]),
                           hz_vol=_f(hz["vol_6m"].loc[t, e]), history_months=round((a - first[e]).days / 30.44, 1), proxy=ctx.P["splice"].get(e)))
    mrow = ctx.M.loc[t]
    hcols = ["GROWTH_z", "INFL_z", "DGS10", "BAA10Y", "HY_OAS", "VIX", "NFCI", "DXY_broad", "GROWTH_regime", "INFL_regime", "RATES_regime",
             "CREDIT_regime", "VOL_regime", "LIQ_regime", "DXY_regime", "REGIME", "RISK_STATE", "DEF_STATE"]
    mh = ctx.M[hcols].tail(36).copy()
    mh.insert(0, "month", mh.index.strftime("%Y-%m"))
    macro = dict(factors=factor_table(ctx.M, t), composite=mrow["REGIME"], composite_long=composite_label(mrow), risk_state=mrow["RISK_STATE"],
                 def_state=mrow["DEF_STATE"], floors=dict(equity_min=info["eq_min"], defensive_min=info["def_min"], equity_table=P["eq_min"], defensive_table=P["def_min"]),
                 overlay=mp["applied"], cond=dict(key=[mrow["GROWTH_regime"], mrow["INFL_regime"], mrow["RATES_regime"]], **ctx.cond_info.get(t, {})),
                 history=mh.round(4).to_dict(orient="records"))
    params = dict(L=P["L"], cfg=P["cfg"], weights=P["wsets"][P["cfg"]], kappa=P["kappa"], lam=P["lam"], lam_cvar=P["lam_cvar"], lam_income=P["lam_inc"],
                  income_target=P["target"], income_mode=P["income_mode"], rolling_income=P["rolling_income"], cc_cap=P["cc_cap"], credit_cap=P["credit_cap"],
                  single=P["single"], clo_aaa_cap=P["clo_aaa_cap"], alt_cap=P["alt_cap"], eq_cap=P["eq_cap"], div_cap=P["div_cap"], real_cap=P["real_cap"],
                  cash_min=P["cash_min"], band=P["band"], cov_win=P["cov_win"], cvar_win=P["cvar_win"], shrink=P["shrink"], tc_bps=P["tc_bps"],
                  floors=dict(defensive=P["def_min"], equity=P["eq_min"]), param_source=cfg.params["param_source"], wf_due=wf_due)
    validation = vdata.extend(vmodel).to_dict()
    pdir = cfg.root / "params"
    bt = load_json(pdir / "backtest_v3.0.json") if (pdir / "backtest_v3.0.json").exists() else None
    wfp_files = sorted(pdir.glob("wf_proposal_*.json"))
    result = dict(
        meta=dict(system_version=SYSTEM_VERSION, model_version=MODEL_VERSION, month=month, data_as_of=str(a.date()), rebalance_date=str(reb),
                  target_month=f"{reb:%Y-%m}", run_at=dt.datetime.now().isoformat(timespec="seconds"), universe_size=len(U),
                  fred_mode=cfg.settings.get("fred_mode"), vintage=dict(enabled=bool(cfg.settings.get("use_alfred_vintage")), series=sorted(vint), report=vrep),
                  current_basis=basis, source=source, status=("OK" if not validation["summary"]["warnings"] else "OK (warnings)"),
                  params=params, prev_month=(prev["month"] if prev else None)),
        universe=dict(tickers=U, asset_class=cfg.asset_class, sleeves=cfg.sleeves, asset_class_order=cfg.universe["asset_class_order"], names=names),
        history_reference=_ref_history(cfg),
        macro=macro, scores=scores,
        portfolio=dict(rows=rows, class_weights=class_weights(cfg, final), status=info["status"], solver=info["solver"], kept=kept,
                       current_basis=basis, model_current_available=model_current is not None, prev_month=(prev["month"] if prev else None),
                       prev_source=(prev.get("source") if prev else None)),
        metrics=pm_t, metrics_model_current=pm_c,
        constraints=dict(rows=cons_rows, binding_order=order, penalties=pen, risk_state=info["risk_state"], def_state=info["def_state"]),
        frontier=dict(rows=fr_rows, relaxation=relax, target=P["target"]),
        stability=dict(rows=st_rows, verdict=verdict, weights={k: {"raw": v["raw"].round(5).to_dict(), "final": v["final"].round(5).to_dict()} for k, v in stW.items()}),
        stress=dict(rows=s_rows, note="팩터 회귀(2010~, 월간) 기반 추정. JAAA(2020-10)·JBBB(2022-01)는 2020년 위기 미경험 → CLO 손실 과소추정 가능"),
        zero_weight=dict(rows=z_rows, note=z_note), special=special,
        backtest=bt.get("backtest") if bt else None, walk_forward=bt.get("walk_forward") if bt else None,
        wf_proposal=load_json(wfp_files[-1]) if wfp_files else None,
        validation=validation, limitations=_limitations(cfg, vint, special, P, verdict, basis, bt),
        actual=dict(provided=False), rebalance=None)
    facts = build_facts(result, prev_result)
    result["commentary"] = dict(rule_based=rule_based_commentary(facts), llm=None, llm_note=None, facts=facts)
    if llm or (llm is None and cfg.settings.get("commentary", {}).get("llm_enabled")):
        txt, note = llm_commentary(facts, cfg)
        result["commentary"].update(llm=txt, llm_note=note)
    result["meta"]["runtime_sec"] = round(time.time() - t0, 1)
    tables = {"target_portfolio": pd.DataFrame(rows).set_index("ticker"), "etf_scores": pd.DataFrame(scores).set_index("ticker"),
              "macro_factors": pd.DataFrame(macro["factors"]).set_index("factor"), "constraints": pd.DataFrame(cons_rows).set_index("name"),
              "stress_test": pd.DataFrame([dict(scenario=r["scenario"], desc=r["desc"], loss=r["loss"], factor=r["factor"], top=r["top"], worst=r["worst"]) for r in s_rows]).set_index("scenario"),
              "frontier": pd.DataFrame(fr_rows).set_index("target"), "stability": pd.DataFrame(st_rows).set_index("variant"),
              "zero_weight": pd.DataFrame(z_rows).set_index("ticker") if z_rows else pd.DataFrame()}
    hist.save_run(result, tables, {"commentary.md": result["commentary"]["rule_based"]})
    if act is not None:
        log("⑫~⑭ 저장된 실보유로 Target vs Actual 재계산")
        _rebalance_and_save(cfg, hist, month, result, act.to_dict(orient="records"), None, 0.0, from_saved=True)
        result = hist.load_result(month)
    if make_html:
        out = write_dashboard(cfg, result, hist.index())
        if out:
            log(f"대시보드(정적 모드) 저장: {out.name}")
    log(f"완료 — {result['meta']['runtime_sec']}초, 목표 인컴 {pm_t['IncomeYield']:.2%}, 상태 {result['meta']['status']}")
    return result


def _rebalance_and_save(cfg, hist, month, res, rows, pv_override, extra_cash, from_saved=False):
    P = cfg.engine_params()
    last_prices = {r["ticker"]: r["price"] for r in res["portfolio"]["rows"]}
    if from_saved:
        df = pd.DataFrame(rows)
        for c in ("in_universe", "is_cash"):
            df[c] = df[c].astype(bool)
        pv, notes = float(df["market_value"].sum()), ["저장된 실보유 재사용"]
    else:
        df, pv, notes = normalize_actual(rows, cfg, last_prices, pv_override, extra_cash)
    target = pd.Series({r["ticker"]: r["target"] for r in res["portfolio"]["rows"]})
    beta = {r["ticker"]: (r["beta_eq"] or 0.0) for r in res["portfolio"]["rows"]}
    dur = {r["ticker"]: (r["duration"] or 0.0) for r in res["portfolio"]["rows"]}
    rb = compare(cfg, target, df, pv, P["band"], P["tc_bps"], beta, dur, last_prices)
    rb["notes"] = notes
    res2 = hist.save_actual(month, df, rb)
    if res2 is not None:
        facts = build_facts(res2, None)
        res2["commentary"]["rule_based"] = rule_based_commentary(facts)
        res2["commentary"]["facts"] = facts
        from .config import save_json as _sj
        _sj(res2, hist.dir / month / "result.json")
        if month == hist.latest_month():
            _sj(res2, cfg.path("output_dir") / "latest.json")
            write_dashboard(cfg, res2, hist.index())
    return rb


def submit_actual(cfg=None, month=None, csv_text=None, rows=None, pv_override=None, extra_cash=0.0, log=print):
    cfg = cfg or Config()
    hist = History(cfg)
    month = month or hist.latest_month()
    res = hist.load_result(month)
    if res is None or "scores" not in res:
        raise ValueError(f"{month} 모델 결과가 없습니다. 먼저 모델을 실행하세요.")
    if csv_text:
        rows = parse_actual_csv(csv_text)
    if not rows:
        raise ValueError("실보유 행이 없습니다 (Ticker 열 필요).")
    rb = _rebalance_and_save(cfg, hist, month, res, rows, pv_override, extra_cash)
    log(f"실보유 저장 · 주문 생성: 매수 {rb['totals']['n_buy']} · 매도 {rb['totals']['n_sell']}")
    return rb


def run_walkforward_job(cfg=None, as_of=None, quick=False, log=print):
    from .backtest import run_walkforward
    cfg = cfg or Config()
    dl, mkt, F, vint, frep, vrep, a = _inputs(cfg, as_of, log)
    ctx = build_context(cfg, mkt, {**F, **vint}, a, frozenset(vint), log)
    prop = run_walkforward(cfg, ctx, log, quick=quick)
    out = cfg.root / "params" / f"wf_proposal_{a:%Y-%m}{'_quick' if quick else ''}.json"
    save_json(prop, out)
    log(f"워크포워드 제안 저장: {out.name} — 적용하려면 config/model_params.json을 수정하세요.")
    return prop
