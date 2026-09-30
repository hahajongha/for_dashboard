"""Portfolio metrics, constraint diagnostics, income-risk frontier, parameter stability, stress,
zero-weight analysis and CLO / Preferred special analysis."""
from __future__ import annotations
import numpy as np
import pandas as pd
from .engine import optimize, apply_band, covariance, max_income

SCENARIOS = [
    ("Recession", "주식 −25%, 10Y −100bp, Baa +200bp", dict(EQ=-0.25, dY10=-1.0, dBAA=2.0)),
    ("Equity Crash", "주식 −20%", dict(EQ=-0.20)),
    ("Credit Stress", "Baa +150bp, 주식 −12%", dict(dBAA=1.5, EQ=-0.12)),
    ("Liquidity Shock", "주식 −10%, Baa +100bp, USD +5%", dict(EQ=-0.10, dBAA=1.0, dDXY=0.05)),
    ("Inflation Shock", "BEI +50bp, 10Y +75bp, 주식 −8%", dict(dBE=0.5, dY10=0.75, EQ=-0.08)),
    ("Rate Shock", "10Y +100bp, 주식 −5%", dict(dY10=1.0, EQ=-0.05)),
    ("USD Shock", "USD +8%", dict(dDXY=0.08)),
]
FACTOR_LABEL = {"EQ": "주식", "dY10": "금리", "dBAA": "크레딧", "dDXY": "달러", "dBE": "인플레 기대"}


def _pct(s):
    return s / s.shift(1) - 1


def factor_betas(ctx):
    ME, M, t = ctx.ME, ctx.M, ctx.t
    eq = ctx.cfg.universe["equity_factor_ticker"]
    Fx = pd.DataFrame({"EQ": ctx.Rm_me[eq], "dY10": M["DGS10"].reindex(ME).diff(), "dBAA": M["BAA10Y"].reindex(ME).diff(),
                       "dDXY": _pct(M["DXY_broad"].reindex(ME)), "dBE": M["T10YIE"].reindex(ME).diff()}).loc["2010-06-30":t]
    B, N = {}, {}
    for e in ctx.U:
        df = pd.concat([ctx.Rm_me[e].loc[Fx.index].rename("y"), Fx], axis=1).dropna()
        N[e] = int(len(df))
        if len(df) < 24:
            continue
        X = np.column_stack([np.ones(len(df)), df[Fx.columns].values])
        coef = np.linalg.lstsq(X, df["y"].values, rcond=None)[0]
        B[e] = pd.Series(coef[1:], index=Fx.columns)
    return pd.DataFrame(B).T.reindex(ctx.U), pd.Series(N)


def exposure_block(cfg, w):
    sl = cfg.sleeves

    def g(names):
        return float(sum(float(w.get(k, 0.0)) for k in names))

    return {"CoveredCall": g(sl["covered_call"]), "Dividend": g(sl["dividend"]), "PureEquity": g(sl["pure_equity"]),
            "CreditRisk": g(sl["credit_risk"]), "CLO_AAA": g(sl["clo_aaa"]), "Defensive": g(sl["defensive"]),
            "TreasuryTIPS": g(sl["treasury_tips"]), "Cash": g(sl["cash"]), "RealAsset": g(sl["real_asset"]),
            "Alternative": g(sl["alternative"]), "CC_plus_Credit": g(sl["covered_call"]) + g(sl["credit_risk"])}


def class_weights(cfg, w):
    ac = cfg.asset_class
    return {c: float(sum(float(w.get(t, 0.0)) for t in cfg.tickers if ac[t] == c)) for c in cfg.universe["asset_class_order"]}


def hist_sim(ctx, w, n):
    sub = ctx.Rm_me.loc[:ctx.t].tail(n)
    avl = sub.notna()
    pr = []
    for dd, row in sub.iterrows():
        ww = w[avl.loc[dd]]
        s = ww.sum()
        ww = ww / s if s > 0 else ww
        pr.append((ww * row[ww.index]).sum())
    return pd.Series(pr, index=sub.index)


def portfolio_metrics(ctx, w, mu, y_hist_prev, B, P):
    t, cfg = ctx.t, ctx.cfg
    y = ctx.met["yield_ttm"].loc[t].fillna(0)
    out = {"IncomeYield": float((w * y).sum())}
    h = list(y_hist_prev)[-11:] + [out["IncomeYield"]]
    out["Income_3M"], out["Income_6M"], out["Income_12M"] = float(np.mean(h[-3:])), float(np.mean(h[-6:])), float(np.mean(h[-12:]))
    out["ExpTotalReturn"] = float((w * mu.reindex(w.index).fillna(0)).sum())
    rf = ctx.rf_now
    out["RiskFree"] = rf
    for n in (36, 60):
        S = covariance(ctx.Rm_me, t, n, P["shrink"]).loc[w.index, w.index].values
        v = float(np.sqrt(w.values @ S @ w.values))
        out[f"Vol_{n}M"] = v
        out[f"Sharpe_{n}M"] = (out["ExpTotalReturn"] - rf) / v if v > 0 else None
    for nm, n in (("36M", 36), ("60M", 60), ("Full", 400)):
        pr = hist_sim(ctx, w, n)
        cum = (1 + pr).cumprod()
        dn = np.sqrt((pr.clip(upper=0) ** 2).mean()) * np.sqrt(12)
        out[f"MDD_{nm}"] = float((cum / cum.cummax() - 1).min())
        out[f"CVaR95m_{nm}"] = float(pr.nsmallest(max(int(len(pr) * 0.05), 1)).mean())
        out[f"Sortino_{nm}"] = (out["ExpTotalReturn"] - rf) / dn if dn > 0 else None
        if nm == "Full":
            out["Full_start"] = str(pr.index[0].date())
            out["Full_CAGR"] = float(cum.iloc[-1] ** (12 / len(pr)) - 1)
            out["Full_Vol"] = float(pr.std() * np.sqrt(12))
            out["Full_WorstMonth"] = float(pr.min())
            out["Full_WorstMonthDate"] = str(pr.idxmin().date())
            yr = (1 + pr).groupby(pr.index.year).prod() - 1
            out["Full_WorstYear"] = int(yr.idxmin())
            out["Full_WorstYearRet"] = float(yr.min())
            for Y in (2020, 2022, 2023):
                out[f"Full_{Y}"] = float(yr.get(Y, np.nan))
            peak = cum.cummax()
            trough = (cum / peak - 1).idxmin()
            after = cum.loc[trough:]
            rec = after[after >= peak.loc[trough]]
            out["Full_MDD_trough"] = str(trough.date())
            out["Full_RecoveryMonths"] = int((rec.index[0].to_period("M") - trough.to_period("M")).n) if len(rec) else None
    out["EffEquityBeta"] = float((w * B["EQ"].reindex(w.index).fillna(0)).sum())
    out["Duration"] = float(sum(float(w[k]) * cfg.durations.get(k, 0.0) for k in w.index))
    out.update(exposure_block(cfg, w))
    return out


def stress(ctx, w, B):
    Bf = B.fillna(0)
    held = w[w > 0.001].index
    rows = []
    for name, desc, sh in SCENARIOS:
        shock = pd.Series(sh).reindex(Bf.columns).fillna(0)
        pnl = (Bf @ shock).reindex(ctx.U).fillna(0)
        contrib = w * pnl
        fc = {FACTOR_LABEL[f]: float((w * Bf[f].reindex(ctx.U).fillna(0)).sum() * shock[f]) for f in Bf.columns if shock[f] != 0}
        rows.append(dict(scenario=name, desc=desc, loss=float(contrib.sum()), factor=fc,
                         top=[[k, float(v)] for k, v in contrib.sort_values().head(3).items()],
                         worst=[[k, float(v)] for k, v in pnl.reindex(held).sort_values().head(3).items()],
                         etf={k: float(v) for k, v in contrib.items() if abs(v) > 1e-6},
                         etf_pnl={k: float(v) for k, v in pnl.items()}))
    return rows


def constraint_table(ctx, raw, final, info, P, inc_raw, inc_final, inc_12m):
    cfg, sl, oc = ctx.cfg, ctx.cfg.sleeves, ctx.cfg.opt_class
    d = info["duals"]

    def g(w, names):
        return float(sum(float(w.get(k, 0)) for k in names))

    def cls(w, c):
        return float(sum(float(w[k]) for k in ctx.U if oc[k] == c))

    rs, ds = info["risk_state"], info["def_state"]
    items = [
        ("Income (soft target, 12M avg)", "target", P["target"], inc_raw, inc_final, None, "soft"),
        ("Covered Call cap", "≤", P["cc_cap"], g(raw, sl["covered_call"]), g(final, sl["covered_call"]), d.get("cc"), "cap"),
        ("Credit cap (VCIT·USHY·JBBB·PFF)", "≤", P["credit_cap"], g(raw, sl["credit_risk"]), g(final, sl["credit_risk"]), d.get("credit"), "cap"),
        ("CLO AAA cap (JAAA)", "≤", P["clo_aaa_cap"], g(raw, sl["clo_aaa"]), g(final, sl["clo_aaa"]), d.get("clo_aaa"), "cap"),
        ("Single ETF cap", "≤", P["single"], float(raw.max()), float(final.max()), d.get("single"), "cap"),
        ("DBMF (Alternative) cap", "≤", P["alt_cap"], cls(raw, "Alt"), cls(final, "Alt"), d.get("cls_Alt"), "cap"),
        ("Pure Equity cap", "≤", P["eq_cap"], cls(raw, "Equity"), cls(final, "Equity"), d.get("cls_Equity"), "cap"),
        ("Dividend cap", "≤", P["div_cap"], cls(raw, "Dividend"), cls(final, "Dividend"), d.get("cls_Dividend"), "cap"),
        ("Real Asset cap", "≤", P["real_cap"], cls(raw, "RealAsset"), cls(final, "RealAsset"), d.get("cls_RealAsset"), "cap"),
        ("Cash minimum (SGOV)", "≥", P["cash_min"], float(raw[cfg.cash]), float(final[cfg.cash]), d.get("cash"), "floor"),
        (f"Equity minimum ({rs})", "≥", info["eq_min"], g(raw, sl["pure_equity"]), g(final, sl["pure_equity"]), d.get("eq_min"), "floor"),
        (f"Defensive minimum ({ds})", "≥", info["def_min"], g(raw, sl["defensive"]), g(final, sl["defensive"]), d.get("def_min"), "floor"),
    ]
    rows = []
    for name, op, lim, a_raw, a_fin, dual, kind in items:
        if kind == "soft":
            short = max(0.0, lim - inc_12m)
            status = f"Soft / Non-binding (12M 평균 미달 {short*100:.2f}%p)" if short > 1e-6 else "Soft / 충족"
            rows.append(dict(name=name, op=op, limit=lim, raw=a_raw, final=a_fin, status=status, binding=False, dual=None,
                             note=f"벌점 = λ_income × 부족분² = {P['lam_inc']:.0f} × {short:.4f}² = {P['lam_inc']*short**2:.5f}", at_cap=[]))
            continue
        gap = (lim - a_raw) if op == "≤" else (a_raw - lim)
        binding = (dual is not None and dual > 1e-4) or (abs(gap) < 5e-4 and lim > 0)
        breach = (a_fin > lim + 1e-6) if op == "≤" else (a_fin < lim - 1e-6)
        at_cap = [k for k in ctx.U if float(raw[k]) >= P["single"] - 5e-4] if name == "Single ETF cap" else []
        rows.append(dict(name=name, op=op, limit=lim, raw=a_raw, final=a_fin, status="Binding" if binding else "Non-binding",
                         binding=bool(binding), dual=dual, at_cap=at_cap,
                         note=("최종 비중은 밴드 유지분 때문에 한도와 소폭 다름" if breach else "")))
    order = sorted([r for r in rows if r["binding"]], key=lambda r: -(r["dual"] or 0))
    pen = dict(cvar_monthly=info["cvar"], cvar_term=P["lam_cvar"] * info["cvar"], turnover_term=info["turnover_term"],
               income_penalty=(P["lam_inc"] * max(0.0, P["target"] - inc_12m) ** 2) if P["income_mode"] in ("soft", "corridor") else None)
    return rows, [r["name"] for r in order], pen


def _summ(ctx, label, w_, st, mu, Scov, B, P):
    t, sl = ctx.t, ctx.cfg.sleeves
    y = ctx.met["yield_ttm"].loc[t].fillna(0)
    er = float((w_ * mu.reindex(w_.index).fillna(0)).sum())
    vol = float(np.sqrt(w_.values @ Scov.loc[w_.index, w_.index].values @ w_.values))
    pr = hist_sim(ctx, w_, 60)
    cum = (1 + pr).cumprod()

    def g(names):
        return float(sum(float(w_.get(k, 0)) for k in names))

    return dict(target=label, status=st, feasible=(st == "ok"), income=float((w_ * y).sum()), exp_ret=er, vol=vol,
                sharpe=(er - ctx.rf_now) / vol if vol > 0 else None, mdd_60m=float((cum / cum.cummax() - 1).min()),
                cvar_60m=float(pr.nsmallest(3).mean()), cc=g(sl["covered_call"]), credit=g(sl["credit_risk"]),
                clo_aaa=g(sl["clo_aaa"]), pure_eq=g(sl["pure_equity"]), defensive=g(sl["defensive"]),
                beta=float((w_ * B["EQ"].reindex(w_.index).fillna(0)).sum()))


def frontier(ctx, Srow, w_cur, y_hist, P, B, rs, ds):
    t = ctx.t
    Scov = covariance(ctx.Rm_me, t, P["cov_win"], P["shrink"])
    wc = w_cur if w_cur is not None else pd.Series(0.0, index=ctx.U)
    rows, W = [], {}
    w_, i_ = optimize(ctx, t, Srow, wc, y_hist, {**P, "income_mode": "none"})
    rows.append(_summ(ctx, "Unconstrained", w_, "ok", i_["mu"], Scov, B, P)); W["Unconstrained"] = w_
    for T in (0.055, 0.06, 0.065, 0.07, 0.075, 0.08):
        w_, i_ = optimize(ctx, t, Srow, wc, y_hist, {**P, "income_mode": "hard", "target": T})
        rows.append(_summ(ctx, f"{T*100:.1f}%", w_, i_["status"], i_["mu"], Scov, B, P)); W[f"{T*100:.1f}%"] = w_
    combos = [("현재 한도 (CC30 · Credit25 · Single15)", {}), ("CC 40%", {"cc_cap": 0.40}), ("Credit 30%", {"credit_cap": 0.30}),
              ("Single 20%", {"single": 0.20}), ("CC40 + Credit30", {"cc_cap": 0.40, "credit_cap": 0.30}),
              ("CC40 + Single20", {"cc_cap": 0.40, "single": 0.20}), ("Credit30 + Single20", {"credit_cap": 0.30, "single": 0.20}),
              ("CC40 + Credit30 + Single20", {"cc_cap": 0.40, "credit_cap": 0.30, "single": 0.20})]
    rel = []
    for name, ov in combos:
        mx, _ = max_income(ctx, t, {**P, **ov}, rs, ds)
        rel.append(dict(case=name, max_income=mx, feasible_target=(mx is not None and mx >= P["target"] - 1e-6)))
    return rows, rel, W


def stability(ctx, Srow, w_cur, y_hist, P, base_raw, base_final):
    t, cash = ctx.t, ctx.cfg.cash
    variants = [("κ 0.5", {"kappa": 0.5}), ("κ 0.75", {"kappa": 0.75}), ("λ 1.0", {"lam": 1.0}), ("λ 2.0", {"lam": 2.0}),
                ("Income 6.5%", {"target": 0.065}), ("Cov/CVaR 36M", {"cov_win": 36, "cvar_win": 36}),
                ("CC cap 40%", {"cc_cap": 0.40}), ("Credit cap 30%", {"credit_cap": 0.30}), ("Band 1.0%", "band")]
    wc = w_cur if w_cur is not None else pd.Series(0.0, index=ctx.U)
    base_cls = class_weights(ctx.cfg, base_final)
    y = ctx.met["yield_ttm"].loc[t].fillna(0)
    rows, W = [], {"Base": {"raw": base_raw, "final": base_final}}
    for name, ov in variants:
        if ov == "band":
            raw = base_raw
            fin = apply_band(base_raw, w_cur, 0.01, P["single"], cash)[0] if w_cur is not None else base_raw
        else:
            raw, _ = optimize(ctx, t, Srow, wc, y_hist, {**P, **ov})
            fin = apply_band(raw, w_cur, P["band"], P["single"], cash)[0] if w_cur is not None else raw
        dr, df = (raw - base_raw).abs(), (fin - base_final).abs()
        cl = class_weights(ctx.cfg, fin)
        dcl = {k: abs(cl[k] - base_cls[k]) for k in cl}
        kmax = max(dcl, key=dcl.get)
        rows.append(dict(variant=name, max_etf_delta_raw=float(dr.max()), etf_raw=dr.idxmax(), max_etf_delta_final=float(df.max()),
                         etf_final=df.idxmax(), max_class_delta=float(dcl[kmax]), class_name=kmax, income=float((fin * y).sum()),
                         cc=float(sum(fin[k] for k in ctx.cfg.sleeves["covered_call"])), pure_eq=float(sum(fin[k] for k in ctx.cfg.sleeves["pure_equity"]))))
        W[name] = {"raw": raw, "final": fin}
    worst = max(r["max_etf_delta_raw"] for r in rows if r["variant"] not in ("CC cap 40%", "Credit cap 30%"))
    verdict = "Stable" if worst <= 0.05 else "Unstable (parameter sensitivity > 5%p)"
    return rows, W, verdict


def zero_weight(ctx, final, raw, info, S, B, cons_rows, P):
    t, cfg = ctx.t, ctx.cfg
    held = final[final >= 0.01].index
    zero = final[final < 0.001].index
    C = ctx.Rm_me.loc[:t].tail(60).corr(min_periods=24)
    nn = info["dual_vec"].get("nonneg", pd.Series(dtype=float))
    total = S["total"].loc[t]
    rank = total.rank(ascending=False)
    q35 = total.quantile(0.35)
    y = ctx.met["yield_ttm"].loc[t]
    binding = {r["name"] for r in cons_rows if r["binding"]}
    sleeve_cap = {"CoveredCall": "Covered Call cap", "Alt": "DBMF (Alternative) cap", "Equity": "Pure Equity cap", "Dividend": "Dividend cap", "RealAsset": "Real Asset cap"}
    rows = []
    for e in zero:
        comps = {"Momentum": float(S["ret"].loc[t, e]), "RiskAdj": float(S["ra"].loc[t, e]), "Income": float(S["inc"].loc[t, e]),
                 "Macro": float(S["mac"].loc[t, e]), "Risk(−)": float(-S["pen"].loc[t, e])}
        cr = C[e].reindex(held).drop(e, errors="ignore").dropna() if e in C else pd.Series(dtype=float)
        mc_t, mc = (cr.idxmax(), float(cr.max())) if len(cr) else (None, None)
        flags = []
        if float(raw[e]) >= 0.001:
            flags.append(["Band", f"원 최적화 {raw[e]*100:.1f}%이나 밴드 {P['band']*100:.1f}%p 이내라 미편입"])
        cap_name = sleeve_cap.get(cfg.opt_class[e])
        if e in cfg.sleeves["credit_risk"]:
            cap_name = "Credit cap (VCIT·USHY·JBBB·PFF)"
        if cap_name in binding:
            flags.append(["Constraint", f"{cap_name} Binding — 같은 슬리브의 다른 ETF가 한도를 사용"])
        if total[e] <= q35:
            weakest = min(comps, key=comps.get)
            flags.append(["Score", f"총점 {total[e]:+.2f} (순위 {int(rank[e])}/{int(total.notna().sum())}), 가장 약한 요소 {weakest} {comps[weakest]:+.2f}"])
        if float(S["pen"].loc[t, e]) > 1.0:
            flags.append(["Risk penalty", f"위험 z {S['pen'].loc[t, e]:+.2f} (변동성·낙폭·CVaR 상위)"])
        if mc is not None and mc >= 0.85:
            flags.append(["Redundancy", f"보유 중인 {mc_t}와 60M 상관 {mc:.2f}"])
        if float(S["mac"].loc[t, e]) < -0.3:
            flags.append(["Macro", f"현재 국면 과거 성과 z {S['mac'].loc[t, e]:+.2f}"])
        if not flags:
            flags.append(["Portfolio trade-off", "점수는 중간이나 분산·위험 대비 기대수익이 보유 ETF보다 낮음"])
        rows.append(dict(ticker=e, asset_class=cfg.asset_class[e], score=float(total[e]), rank=int(rank[e]),
                         income=None if pd.isna(y[e]) else float(y[e]), risk_z=float(S["pen"].loc[t, e]),
                         macro_z=float(S["mac"].loc[t, e]), max_corr_with=mc_t, max_corr=mc,
                         reduced_cost=(float(nn.get(e)) if e in nn.index else None), raw_weight=float(raw[e]),
                         components=comps, reasons=flags, primary=flags[0][0]))
    pe = float(sum(final[k] for k in cfg.sleeves["pure_equity"]))
    note = ("순수 주식 0% — 인컴 벌점과 총수익 목표가 충돌하는지 점검 필요" if pe < 0.001 else
            f"순수 주식 {pe*100:.1f}% (하한 {info['eq_min']*100:.0f}%)")
    return rows, note


def special_analysis(ctx, final, B, N, stress_rows, P, ref_holdings=None, ref_meta=None):
    t, met, cfg = ctx.t, ctx.met, ctx.cfg
    Rm = ctx.Rm_me.loc[:t]
    y = met["yield_ttm"].loc[t]
    xlf = ctx.P["adj"]["XLF"] if "XLF" in ctx.P["adj"] else None

    def corr(a, b, n=60):
        x = Rm[[a, b]].tail(n).dropna()
        return (float(x.corr().iloc[0, 1]) if len(x) >= 12 else None), int(len(x))

    def hist_m(e):
        s = ctx.P["adj"][e].dropna()
        return round((ctx.as_of - s.index[0]).days / 30.44, 1)

    def sc(name, e):
        r = next(x for x in stress_rows if x["scenario"] == name)
        return dict(contribution=r["etf"].get(e, 0.0), etf_pnl=r["etf_pnl"].get(e, 0.0))

    def b(e, f):
        v = B.loc[e, f] if e in B.index else np.nan
        return None if pd.isna(v) else float(v)

    credit_total = float(sum(final[k] for k in cfg.sleeves["credit_risk"]))
    out = {}
    c_sg, n1 = corr("JAAA", "SGOV"); c_eq, _ = corr("JAAA", "VOO"); c_hy, _ = corr("JAAA", "USHY")
    out["JAAA"] = dict(role="CLO AAA — 현금 대체·방어적 캐리 (신용 슬리브와 별도 관리)", target=float(final["JAAA"]), cap=P["clo_aaa_cap"],
                       cap_usage=float(final["JAAA"] / P["clo_aaa_cap"]), duration=cfg.durations["JAAA"], duration_src="Morningstar 2026-09",
                       ttm_yield=float(y["JAAA"]), sgov_yield=float(y["SGOV"]), carry_vs_sgov=float(y["JAAA"] - y["SGOV"]),
                       vol_12m=float(met["vol_12m"].loc[t, "JAAA"]), mdd_12m=float(met["mdd_12m"].loc[t, "JAAA"]),
                       corr_sgov=c_sg, corr_voo=c_eq, corr_ushy=c_hy, corr_obs=n1, beta_eq=b("JAAA", "EQ"), beta_credit=b("JAAA", "dBAA"),
                       beta_rate=b("JAAA", "dY10"), history_months=hist_m("JAAA"), stress_credit=sc("Credit Stress", "JAAA"),
                       stress_recession=sc("Recession", "JAAA"),
                       flags=["Insufficient Sample: 약 6년 이력(2020-10 상장) — 2020-03 유동성 위기 미경험",
                              "CLO 유동성 스트레스(가격 급락·스프레드 확대) 과소추정 가능"])
    c_eq, n2 = corr("JBBB", "VOO"); c_hy, _ = corr("JBBB", "USHY")
    out["JBBB"] = dict(role="CLO BBB — 신용 리스크 슬리브(VCIT·USHY·PFF와 합산, Credit cap 25%)", target=float(final["JBBB"]),
                       credit_sleeve_total=credit_total, share_of_credit=(float(final["JBBB"] / credit_total) if credit_total > 0 else None),
                       duration=cfg.durations["JBBB"], ttm_yield=float(y["JBBB"]), vol_12m=float(met["vol_12m"].loc[t, "JBBB"]),
                       mdd_12m=float(met["mdd_12m"].loc[t, "JBBB"]), corr_voo=c_eq, corr_ushy=c_hy, corr_obs=n2,
                       beta_eq=b("JBBB", "EQ"), beta_credit=b("JBBB", "dBAA"), beta_rate=b("JBBB", "dY10"),
                       history_months=hist_m("JBBB"), stress_credit=sc("Credit Stress", "JBBB"), stress_recession=sc("Recession", "JBBB"),
                       flags=["Insufficient Sample: 약 4.7년 이력(2022-01 상장) — 2020년 위기 미경험",
                              "Credit Stress 기여도는 짧은 표본 회귀라 과소추정 가능"])
    xb = xc = None
    if xlf is not None:
        xm = xlf.resample("ME").last()
        xr = (xm / xm.shift(1) - 1).reindex(Rm.index)
        j = pd.concat([Rm["PFF"], xr.rename("XLF")], axis=1).tail(60).dropna()
        if len(j) >= 24:
            xc = float(j.corr().iloc[0, 1])
            xb = float(np.cov(j["PFF"], j["XLF"])[0, 1] / np.var(j["XLF"], ddof=1))
    rate_b = b("PFF", "dY10")
    top = None
    if ref_holdings is not None:
        try:
            top = [[str(i), str(r.iloc[0]), float(r.iloc[1])] for i, r in ref_holdings.head(5).iterrows()]
        except Exception:
            top = None
    out["PFF"] = dict(role="우선주 — 신용 리스크 슬리브에 포함", target=float(final["PFF"]), duration=cfg.durations["PFF"],
                      duration_src="Proxy: FPE 유효 듀레이션 5.42 (PFF 미공시)", empirical_duration=(-rate_b * 100 if rate_b is not None else None),
                      ttm_yield=float(y["PFF"]), vol_12m=float(met["vol_12m"].loc[t, "PFF"]), mdd_12m=float(met["mdd_12m"].loc[t, "PFF"]),
                      beta_eq=b("PFF", "EQ"), beta_credit=b("PFF", "dBAA"), beta_rate=rate_b, xlf_beta=xb, xlf_corr=xc,
                      financial_concentration="Data unavailable — 공급사 섹터 데이터는 보통주 부분(약 5%)만 반영. XLF 베타를 Proxy로 사용",
                      top_holdings=top, top_holdings_meta=ref_meta, history_months=hist_m("PFF"),
                      stress_rate=sc("Rate Shock", "PFF"), stress_credit=sc("Credit Stress", "PFF"),
                      flags=["Duration Proxy", "금융주 집중도 Data unavailable (XLF 베타 Proxy)"])
    return out
