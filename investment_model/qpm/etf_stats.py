"""Total-return / income panels and rolling ETF statistics (v3.0 logic, as-of aware)."""
from __future__ import annotations
import numpy as np
import pandas as pd
from .macro import build_macro

KEYS = ["ret_1m", "ret_3m", "ret_6m", "ret_12m", "ret_24m", "cagr_5y", "vol_3m", "vol_6m", "vol_12m", "ddev_12m",
        "mdd_12m", "cvar95_12m", "sharpe_12m", "sortino_12m", "calmar_12m", "yield_ttm", "dist_growth", "dist_stab"]


class Ctx:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def build_prices(mkt, cfg, as_of):
    as_of = pd.Timestamp(as_of)
    adj = mkt["Adj Close"].loc[:as_of]
    close = mkt["Close"].loc[:as_of]
    div = mkt["Dividends"].loc[:as_of].fillna(0.0)
    U, PROXY = cfg.tickers, cfg.proxies
    TR = pd.DataFrame(index=adj.index)
    splice = {}
    for t in U:
        s = adj[t].dropna()
        if s.empty:
            raise ValueError(f"no price data for {t}")
        if t in PROXY and PROXY[t] in adj.columns:
            p = adj[PROXY[t]].dropna()
            pre = p.loc[:s.index[0]]
            if len(pre) > 1:
                pre = pre / pre.iloc[-1] * s.iloc[0]
                s = pd.concat([pre.iloc[:-1], s])
                splice[t] = f"{PROXY[t]} proxy before {adj[t].dropna().index[0].date()}"
        TR[t] = s
    TR = TR.loc["2009-06-01":]
    TRm = TR.resample("ME").last()
    Rm = TRm / TRm.shift(1) - 1
    DIV = pd.DataFrame(index=close.index)
    PX = pd.DataFrame(index=close.index)
    for t in U:
        d = div[t].copy()
        p = close[t].copy()
        if t in PROXY and PROXY[t] in close.columns:
            pr = PROXY[t]
            cutoff = close[t].dropna().index[0] - pd.Timedelta(days=1)
            d.loc[:cutoff] = div[pr].loc[:cutoff]
            p.loc[:cutoff] = close[pr].loc[:cutoff]
        DIV[t] = d
        PX[t] = p
    rf = adj["^IRX"].ffill() / 100
    return dict(TR=TR, TRm=TRm, Rm=Rm, DIV=DIV, PX=PX, rf=rf, splice=splice, adj=adj, close=close)


def compute_metrics(P, reg, eval_start="2011-12-31"):
    TR, TRm, Rm, DIV, PX, rf = P["TR"], P["TRm"], P["Rm"], P["DIV"], P["PX"], P["rf"]
    U = list(TR.columns)
    rd = TR / TR.shift(1) - 1
    rf_d = rf.reindex(rd.index).ffill() / 252
    ME = TRm.index[TRm.index >= pd.Timestamp(eval_start)]
    ttm_div = DIV.rolling("365D").sum()

    def win(t, m):
        return t - pd.DateOffset(months=m)

    rows = {k: {} for k in KEYS}
    for t in ME:
        tr = TRm.loc[:t].iloc[-1]

        def r(k):
            prev = TRm.loc[:win(t, k)]
            return (tr / prev.iloc[-1] - 1) if len(prev) else tr * np.nan

        rows["ret_1m"][t] = r(1); rows["ret_3m"][t] = r(3); rows["ret_6m"][t] = r(6)
        rows["ret_12m"][t] = r(12); rows["ret_24m"][t] = r(24)
        p5 = TRm.loc[:win(t, 60)]
        rows["cagr_5y"][t] = (tr / p5.iloc[-1]) ** (1 / 5) - 1 if len(p5) else np.nan * tr
        for k in (3, 6, 12):
            seg = rd.loc[win(t, k) + pd.Timedelta(days=1):t]
            rows[f"vol_{k}m"][t] = seg.std() * np.sqrt(252)
        seg12 = rd.loc[win(t, 12) + pd.Timedelta(days=1):t]
        ex = seg12.sub(rf_d.loc[seg12.index], axis=0)
        dd = seg12.clip(upper=0)
        rows["ddev_12m"][t] = np.sqrt((dd ** 2).mean()) * np.sqrt(252)
        tr12 = TR.loc[win(t, 12):t]
        rows["mdd_12m"][t] = (tr12 / tr12.cummax() - 1).min()
        rows["cvar95_12m"][t] = seg12.apply(lambda s: s.dropna().nsmallest(max(int(len(s.dropna()) * 0.05), 1)).mean())
        rows["sharpe_12m"][t] = ex.mean() * 252 / (ex.std() * np.sqrt(252))
        rows["sortino_12m"][t] = ex.mean() * 252 / rows["ddev_12m"][t]
        rows["calmar_12m"][t] = rows["ret_12m"][t] / rows["mdd_12m"][t].abs()
        px_t = PX.loc[:t].iloc[-1]
        d_t = ttm_div.loc[:t].iloc[-1]
        d_prev = ttm_div.loc[:win(t, 12)].iloc[-1]
        rows["yield_ttm"][t] = d_t / px_t
        rows["dist_growth"][t] = (d_t / d_prev - 1).where(d_prev > 0)
        q = DIV.loc[win(t, 12) + pd.Timedelta(days=1):t].resample("QE").sum()
        rows["dist_stab"][t] = 1 - q.std() / q.mean().replace(0, np.nan)
    met = {k: pd.DataFrame(v).T.sort_index() for k, v in rows.items()}
    avail = TRm.reindex(ME).notna() & TRm.shift(12).reindex(ME).notna()
    met["relmom_6m"] = met["ret_6m"].sub(met["ret_6m"].where(avail).median(axis=1), axis=0)
    # ---- macro-conditioned statistics: only months strictly before t (look-ahead free)
    regk = reg.reindex(ME, method="ffill")
    keys3 = list(zip(regk["GROWTH_regime"], regk["INFL_regime"], regk["RATES_regime"]))
    RG = list(regk["REGIME"])
    Rm_me = Rm.reindex(ME)
    cs = pd.DataFrame(index=ME, columns=U, dtype=float)
    cr = cs.copy()
    cn = cs.copy()
    info = {}
    for i, t in enumerate(ME):
        if i < 24:
            continue
        S = [j for j in range(i) if keys3[j] == keys3[i]]
        mode = "GIR"
        if len(S) < 12:
            S = [j for j in range(i) if RG[j] == RG[i]]
            mode = "REGIME"
        if len(S) < 12:
            continue
        sub = Rm_me.iloc[S]
        mu, sd, n = sub.mean(), sub.std(), sub.count()
        cs.loc[t] = (mu / sd * np.sqrt(12)).where(n >= 12)
        cr.loc[t] = (mu * 12).where(n >= 12)
        cn.loc[t] = n
        info[t] = dict(mode=mode, n_months=len(S))
    met["cond_sharpe"], met["cond_ret"] = cs, cr
    met["income_12m_avg"] = met["yield_ttm"].rolling(12, min_periods=6).mean()
    return met, avail, ME, cn, info


def build_context(cfg, mkt, F, as_of, vintage_ids=frozenset(), log=print):
    as_of = pd.Timestamp(as_of)
    log("④ Macro regime frame")
    M = build_macro(F, as_of, cfg.fred["series"], vintage_ids)
    log("⑤ ETF statistics (total return, income, rolling risk, macro-conditioned)")
    P = build_prices(mkt, cfg, as_of)
    reg = M[["GROWTH_regime", "INFL_regime", "RATES_regime", "REGIME"]]
    met, avail, ME, cond_n, cond_info = compute_metrics(P, reg, cfg.settings.get("eval_start", "2011-12-31"))
    return Ctx(cfg=cfg, as_of=as_of, U=cfg.tickers, M=M, P=P, met=met, avail=avail, ME=ME, cond_n=cond_n,
               cond_info=cond_info, Rm_me=P["Rm"].reindex(ME), t=ME[-1],
               rf_now=float(P["rf"].loc[:as_of].dropna().iloc[-1]))
