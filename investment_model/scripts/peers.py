"""Peer 비교 데이터 — 비교 펀드 가격 수집(update_prices)과 비교 지표 계산(build → output/peers.json).

- 비교 대상은 config/peers.json (모델 유니버스와 무관하며 모델 계산에 쓰지 않습니다).
- 가격: yfinance Adj Close(분배 재투자 총수익) · Close · Dividends → data/peers/*.csv.gz
  새로 받은 티커별 이력이 기존보다 짧거나 비면 그 티커는 기존 값을 유지합니다(이력 보호).
- 우리 모델 비교 시계열 (라벨 구분 유지):
    model_bt   현재 고정 파라미터로 qpm.backtest.run_path를 돌린 월간 수익률 (밴드·10bp 비용 반영)
               → "Fixed params backtest (partial in-sample)"; 과거 매크로는 빈티지 미적용(K-7)
    v3_oos     params/backtest_v3.0.json의 연도별 수익률(M6-Soft WF = Honest OOS, 정적)
    live       history/에 기록된 실제 발표 목표를 다음 기준일까지 보유했다고 가정한 수익률
모델 계산 코드(qpm/)는 호출만 하고 수정하지 않습니다.
"""
from __future__ import annotations
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pandas as pd

FIELDS = {"Adj Close": "adj_close", "Close": "close", "Dividends": "dividends"}


def _cfg_peers(root: Path):
    return json.loads((root / "config" / "peers.json").read_text(encoding="utf-8"))


def _read(p: Path):
    if not p.exists():
        return None
    df = pd.read_csv(p, index_col=0)
    df.index = pd.to_datetime(df.index, format="ISO8601")
    return df


# ------------------------------------------------------------------ prices
def update_prices(root: Path, data_dir: Path, as_of=None, log=print) -> dict:
    """Peer 가격을 받아 data/peers/에 저장. 실패해도 예외를 던지지 않고 보고서를 반환(기존 파일 유지)."""
    conf = _cfg_peers(root)
    tickers = [p["ticker"] for p in conf["peers"]]
    out_dir = Path(data_dir) / "peers"
    out_dir.mkdir(parents=True, exist_ok=True)
    rep = dict(status="ok", tickers=len(tickers), kept_old=[], failed=[])
    try:
        import yfinance as yf
        end = (pd.Timestamp(as_of) + pd.Timedelta(days=1)).strftime("%Y-%m-%d") if as_of else None
        df = yf.download(tickers, start=conf.get("start", "2009-01-01"), end=end, auto_adjust=False,
                         actions=True, progress=False, threads=True)
        if df is None or df.empty:
            raise RuntimeError("yfinance returned no data")
    except Exception as e:  # 네트워크 등 — 기존 데이터 유지
        rep.update(status="failed", error=str(e)[:160])
        log(f"peers: 다운로드 실패 — 기존 데이터 유지 ({rep['error']})")
        return rep
    lvl0 = df.columns.get_level_values(0)
    new = {}
    for f, slug in FIELDS.items():
        if f in lvl0:
            new[slug] = df[f].reindex(columns=tickers).astype(float)
        else:
            new[slug] = pd.DataFrame(0.0 if f == "Dividends" else np.nan, index=df.index, columns=tickers)
    old_adj = _read(out_dir / "adj_close.csv.gz")
    for t in tickers:
        n_new = int(new["adj_close"][t].notna().sum())
        if old_adj is not None and t in old_adj.columns:
            o = old_adj[t].dropna()
            first_new = new["adj_close"][t].first_valid_index()
            bad = n_new == 0 or n_new < 0.99 * len(o) or (first_new is not None and len(o) and first_new > o.index[0] + pd.Timedelta(days=7))
            if bad:  # 이 티커는 기존 이력 유지
                rep["kept_old"].append(t)
                for slug in FIELDS.values():
                    old = _read(out_dir / f"{slug}.csv.gz")
                    if old is not None and t in old.columns:
                        idx = new[slug].index.union(old.index)
                        new[slug] = new[slug].reindex(idx)
                        new[slug][t] = old[t].reindex(idx)
        elif n_new == 0:
            rep["failed"].append(t)
    idx = new["adj_close"].index
    for slug in FIELDS.values():
        d = new[slug].reindex(idx)
        d.index.name = "Date"
        d.to_csv(out_dir / f"{slug}.csv.gz", compression="gzip")
    last = {t: (None if new["adj_close"][t].last_valid_index() is None else str(new["adj_close"][t].last_valid_index().date())) for t in tickers}
    meta = dict(downloaded_at=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), as_of_request=as_of,
                per_ticker_last=last, kept_old=rep["kept_old"], failed=rep["failed"])
    (out_dir / "_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    if rep["kept_old"] or rep["failed"]:
        rep["status"] = "partial"
    log(f"peers: {len(tickers)}종 저장 · 기존 유지 {rep['kept_old']} · 실패 {rep['failed']}")
    return rep


# ------------------------------------------------------------------ stats
def _ann(r: pd.Series):
    n = len(r)
    return float((1 + r).prod() ** (12 / n) - 1) if n else None


def _stats(r: pd.Series, rf: pd.Series, end: pd.Timestamp) -> dict:
    """r: 월간 수익률(월말 라벨). end: 마지막 완결 월말."""
    r = r.dropna().loc[:end]
    out = {}
    if r.empty:
        return out
    complete = r.index[-1] == end

    def tail(m):
        s = r.iloc[-m:]
        return s if complete and len(s) == m and (s.index[0] >= end - pd.DateOffset(months=m) - pd.Timedelta(days=3)) else None

    for k, m in (("r1m", 1), ("r3m", 3), ("r6m", 6)):
        s = tail(m)
        out[k] = float((1 + s).prod() - 1) if s is not None else None
    ytd = r.loc[str(end.year)]
    out["ytd"] = float((1 + ytd).prod() - 1) if complete and len(ytd) == end.month else None
    for k, m in (("r1y", 12), ("r3y", 36), ("r5y", 60), ("r10y", 120)):
        s = tail(m)
        out[k] = _ann(s) if s is not None else None
    s = tail(36)
    if s is not None:
        ex = s - rf.reindex(s.index).fillna(0)
        cum = pd.concat([pd.Series([1.0]), (1 + s).cumprod().reset_index(drop=True)])  # 시작값 1 포함
        out.update(vol3y=float(s.std() * np.sqrt(12)), sharpe3y=float(ex.mean() / ex.std() * np.sqrt(12)) if ex.std() > 0 else None,
                   mdd3y=float((cum / cum.cummax() - 1).min()), worst3y=float(s.min()))
    out["start"] = str(r.index[0].date())
    return out


def _calendar(r: pd.Series, end: pd.Timestamp) -> dict:
    r = r.dropna().loc[:end]
    cal = {}
    for y, s in r.groupby(r.index.year):
        full = len(s) == 12 or (y == end.year and len(s) == end.month)
        if full and (y != r.index[0].year or s.index[0].month == 1):
            cal[str(y)] = float((1 + s).prod() - 1)
    return cal


def build(cfg, data_dir: Path, out_path: Path, as_of, log=print) -> dict:
    """비교 지표 계산 → peers.json. cfg는 qpm.config.Config (패키지 루트)."""
    from qpm.config import last_trading_day_of_month, load_json
    from qpm.pipeline import _inputs
    from qpm.etf_stats import build_context
    from qpm.scoring import build_scores
    from qpm.backtest import run_path, rf_monthly

    root = Path(cfg.root)
    data_dir = Path(data_dir)
    a = pd.Timestamp(as_of)
    # 마지막 완결 월말: as_of가 그 달 마지막 거래일이면 그 달, 아니면 전월
    ltd = pd.Timestamp(last_trading_day_of_month(a.year, a.month))
    end = (a + pd.offsets.MonthEnd(0)) if a.normalize() >= ltd else (a - pd.offsets.MonthEnd(1))
    end = end.normalize()

    dl, mkt, F, vint, frep, vrep, a2 = _inputs(cfg, str(a.date()), lambda *x: None)
    ctx = build_context(cfg, mkt, {**F, **vint}, a2, frozenset(vint), lambda *x: None)
    rf = rf_monthly(ctx)
    rf.index = rf.index + pd.offsets.MonthEnd(0)
    P0 = cfg.engine_params()
    S_tot = build_scores(ctx.met, ctx.avail, ctx.cond_n, P0["L"], P0["wsets"][P0["cfg"]], P0["mac_full"])["total"]
    bt = run_path(ctx, S_tot, P0, cfg.settings["backtest_start"], str(ctx.t.date()))
    r_bt = bt["ret"].copy()
    r_bt.index = r_bt.index + pd.offsets.MonthEnd(0)

    series, monthly = [], {}
    series.append(dict(id="model_bt", label="TAA 모델 (고정 파라미터 백테스트)", kind="model",
                       badge="Fixed params backtest (partial in-sample)", tier="모델",
                       stats=_stats(r_bt, rf, end), calendar=_calendar(r_bt, end)))
    monthly["model_bt"] = r_bt.loc[:end]

    # 실제 발표 목표 보유 가정 (live)
    TR = ctx.P["TR"]
    idx = load_json(root / "history" / "index.json")
    months = [m for m in idx.get("months", []) if m.get("source") == "live" and m.get("weights")]
    live = []
    for i, m in enumerate(months):
        s0 = pd.Timestamp(m["as_of"])
        s1 = pd.Timestamp(months[i + 1]["as_of"]) if i + 1 < len(months) else a
        if s1 <= s0:
            continue
        w = pd.Series(m["weights"], dtype=float)
        t0 = TR.loc[:s0].ffill().iloc[-1].reindex(w.index)
        t1 = TR.loc[:s1].ffill().iloc[-1].reindex(w.index)
        ret = float((w * (t1 / t0 - 1)).fillna(0).sum())
        live.append(dict(month=m["month"], target_month=m.get("target_month"), start=str(s0.date()), end=str(s1.date()),
                         ret=ret, complete=i + 1 < len(months)))
    cum_live = float(np.prod([1 + x["ret"] for x in live]) - 1) if live else None

    # 정적 v3.0 연도별 (Honest OOS 등)
    v3 = load_json(root / "params" / "backtest_v3.0.json")["backtest"]["calendar"]
    v3cal = {k: {str(row["year"]): row.get(k) for row in v3 if row.get(k) is not None}
             for k in ("M6-Soft WF", "Final(fixed cfg)", "M0")}
    series.append(dict(id="v3_oos", label="TAA v3.0 워크포워드 (정적)", kind="static", badge="Honest OOS (annual walk-forward)",
                       tier="모델", stats={}, calendar=v3cal["M6-Soft WF"]))

    # Peers
    conf = _cfg_peers(root)
    adj = _read(data_dir / "peers" / "adj_close.csv.gz")
    for p in conf["peers"]:
        t = p["ticker"]
        item = dict(id=t, label=f"{t} — {p['name']}", kind="peer", tier=p["tier"], type=p["type"], category=p["category"],
                    stats={}, calendar={})
        if adj is not None and t in adj.columns and adj[t].notna().any():
            s = adj[t].dropna().loc[:end]
            mr = s.resample("ME").last().pct_change()
            # 첫 달은 월중 시작이면 제외
            mr = mr.iloc[1:] if len(mr) > 1 else mr.iloc[0:0]
            item["stats"] = _stats(mr, rf, end)
            item["calendar"] = _calendar(mr, end)
            monthly[t] = mr
            item["last_date"] = str(s.index[-1].date()) if len(s) else None
        series.append(item)

    # 차트용 월간 누적지수 (각 시계열 시작 = 100, 화면에서 기간별로 다시 정규화)
    all_idx = sorted(set().union(*[set(v.dropna().index) for v in monthly.values()]))
    all_idx = [d for d in all_idx if d <= end]
    chart = {"dates": [str(d.date()) for d in all_idx], "returns": {}}
    for k, v in monthly.items():
        vv = v.reindex(all_idx)
        chart["returns"][k] = [None if pd.isna(x) else round(float(x), 6) for x in vv]

    out = dict(generated_at=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), as_of=str(a.date()),
               last_month_end=str(end.date()), series=series, chart=chart,
               live=dict(rows=live, cumulative=cum_live,
                         note="history/에 기록된 실제 발표 목표(source=live)를 다음 기준일까지 그대로 보유했다고 가정. 마지막 행은 진행 중(기준일까지)."),
               v3_calendar=v3cal,
               notes=["수익률은 총수익(분배 재투자) 기준. 공모펀드·ETF는 보수 차감 후, 모델 백테스트는 ETF 보수 반영·거래비용 10bp 차감, 세금 미반영.",
                      "모델 백테스트는 현재 고정 파라미터로 과거를 계산한 부분 In-Sample 결과이며 과거 매크로는 빈티지를 쓰지 않음(K-7).",
                      "v3.0 워크포워드(Honest OOS) 연도별 수익률은 이사 전 스크립트 산출물(정적, K-12)."])
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    log(f"peers.json: 시계열 {len(series)} · 차트 {len(all_idx)}개월 · 기준 월말 {end.date()}")
    return out
