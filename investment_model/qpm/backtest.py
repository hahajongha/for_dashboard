"""Backtest paths and walk-forward parameter selection (soft-income structure, v3.0 procedure)."""
from __future__ import annotations
import collections
import itertools
import numpy as np
import pandas as pd
from .engine import optimize, apply_band
from .scoring import build_scores


def run_path(ctx, S_total, P, start, end, band=None, tc_cost=0.001):
    band = P["band"] if band is None else band
    dates = [d for d in ctx.ME if pd.Timestamp(start) <= d <= pd.Timestamp(end)]
    w_prev = pd.Series(0.0, index=ctx.U)
    rets, turns, incs, W, y_hist = [], [], [], {}, []
    for i, d in enumerate(dates[:-1]):
        nxt = dates[i + 1]
        tgt, _ = optimize(ctx, d, S_total.loc[d], w_prev, y_hist, P)
        if i > 0 and band > 0:
            tgt, _ = apply_band(tgt, w_prev, band, P["single"], ctx.cfg.cash)
        turn = float((tgt - w_prev).abs().sum()) if i > 0 else 0.0
        r = ctx.Rm_me.loc[nxt].fillna(0)
        rets.append(float((tgt * r).sum()) - tc_cost * turn)
        turns.append(turn)
        yv = float((tgt * ctx.met["yield_ttm"].loc[d].fillna(0)).sum())
        y_hist.append(yv)
        incs.append(yv)
        W[d] = tgt
        w_prev = tgt * (1 + r)
        w_prev = w_prev / w_prev.sum()
    idx = dates[1:]
    return dict(ret=pd.Series(rets, index=idx), turn=pd.Series(turns, index=idx), inc=pd.Series(incs, index=idx), W=pd.DataFrame(W).T)


def rf_monthly(ctx):
    return (ctx.P["rf"].resample("ME").last() / 12).reindex(ctx.ME).ffill()


def stats(r, rf_m, turn=None, inc=None):
    r = r.dropna()
    n = len(r)
    if n < 6:
        return None
    ex = r - rf_m.reindex(r.index).fillna(0)
    ddev = np.sqrt((r.clip(upper=0) ** 2).mean()) * np.sqrt(12)
    cum = (1 + r).cumprod()
    return dict(Sharpe=ex.mean() / ex.std() * np.sqrt(12) if ex.std() > 0 else np.nan, Sortino=ex.mean() * 12 / ddev if ddev > 0 else np.nan,
                MDD=float((cum / cum.cummax() - 1).min()), CVaR=float(r.nsmallest(max(int(n * 0.05), 1)).mean()),
                CAGR=float(cum.iloc[-1] ** (12 / n) - 1), Vol=float(r.std() * np.sqrt(12)),
                Income=(float(inc.mean()) if inc is not None else np.nan), Turnover=(float(turn.sum() / (n / 12)) if turn is not None else np.nan))


def composite_rank(df):
    ranks = pd.DataFrame({"Sharpe": df["Sharpe"].rank(ascending=False), "Sortino": df["Sortino"].rank(ascending=False),
                          "MDD": df["MDD"].rank(ascending=False), "CVaR": df["CVaR"].rank(ascending=False)})
    return ranks.mean(axis=1)


def _window(p, a, b):
    return p["ret"].loc[a:b], p["turn"].loc[a:b], p["inc"].loc[a:b]


def walk_forward(paths, keys, rf_m, years, train=36):
    oos, chosen = [], {}
    for Y in years:
        te = pd.Timestamp(f"{Y-1}-12-31")
        ts = te - pd.DateOffset(months=train) + pd.Timedelta(days=1)
        rows = {}
        for k in keys:
            r, tu, ic = _window(paths[k], ts, te)
            if len(r) >= 24:
                rows[k] = stats(r, rf_m, tu, ic)
        if not rows:
            continue
        df = pd.DataFrame(rows).T
        df["composite"] = composite_rank(df)
        best = df.sort_values(["composite", "Turnover"]).index[0]
        chosen[Y] = (best, round(float(df.loc[best, "composite"]), 2))
        oos.append(paths[best]["ret"].loc[f"{Y}-01-01":f"{Y}-12-31"])
    return dict(ret=pd.concat(oos) if oos else pd.Series(dtype=float), chosen=chosen)


def run_walkforward(cfg, ctx, log=print, quick=False):
    """Annual re-selection: grid under the soft-income structure, choose by trailing-36M composite rank.
    Writes a *proposal*; config/model_params.json is only changed by the user."""
    P0 = cfg.engine_params()
    start, end = cfg.settings["backtest_start"], str(ctx.t.date())
    rf_m = rf_monthly(ctx)
    grid = list(itertools.product([12, 24], ["A", "C"], [0.0, 0.5, 1.0], [1.0, 1.5])) if not quick else [(24, "A", 1.0, 1.5), (24, "C", 0.5, 1.5)]
    paths, cache = {}, {}
    for i, (L, c, k, lam) in enumerate(grid, 1):
        if (L, c) not in cache:
            cache[(L, c)] = build_scores(ctx.met, ctx.avail, ctx.cond_n, L, P0["wsets"][c], P0["mac_full"])["total"]
        paths[("S", L, c, k, lam)] = run_path(ctx, cache[(L, c)], {**P0, "kappa": k, "lam": lam}, start, end)
        log(f"walk-forward grid {i}/{len(grid)}: L{L} cfg{c} κ{k} λ{lam}")
    years = range(2017, ctx.t.year + 1)
    wf = walk_forward(paths, list(paths), rf_m, years)
    win_end = ctx.t
    win_start = win_end - pd.DateOffset(months=P0.get("wf_window", 36)) + pd.Timedelta(days=1)
    rows = {}
    for k, p in paths.items():
        r, tu, ic = _window(p, win_start, win_end)
        rows[k] = stats(r, rf_m, tu, ic)
    df = pd.DataFrame(rows).T
    df["composite"] = composite_rank(df)
    best = df.sort_values(["composite", "Turnover"]).index[0]
    cnt = collections.Counter(k[1:] for k, _ in wf["chosen"].values())
    proposal = dict(selected_at=str(ctx.t.date()), rule="trailing 36M composite rank (Sharpe·Sortino·MDD·CVaR)",
                    L=int(best[1]), cfg=best[2], kappa=float(best[3]), lam=float(best[4]),
                    trailing_table=[dict(L=k[1], cfg=k[2], kappa=k[3], lam=k[4], **{c: (None if pd.isna(v) else float(v)) for c, v in df.loc[k].items()}) for k in df.index],
                    annual_choices=[dict(year=int(Y), L=int(k[1]), cfg=k[2], kappa=float(k[3]), lam=float(k[4]), composite=s) for Y, (k, s) in wf["chosen"].items()],
                    modal=[dict(params=str(k), count=v) for k, v in cnt.most_common()],
                    oos=stats(wf["ret"], rf_m) if len(wf["ret"]) else None)
    return proposal
