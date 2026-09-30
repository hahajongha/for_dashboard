"""Risk model, regime overlay, expected returns, CVaR-penalised optimiser and rebalance band (v3.0)."""
from __future__ import annotations
import numpy as np
import pandas as pd
import cvxpy as cp


def covariance(Rm_me, t, months, shrink=0.3, with_eig=False):
    sub = Rm_me.loc[:t].tail(months)
    C = (sub.cov(min_periods=12) * 12).fillna(0)
    Cm = (1 - shrink) * C.values + shrink * np.diag(np.diag(C.values))
    ev_raw = float(np.linalg.eigvalsh((Cm + Cm.T) / 2).min())
    w_, v_ = np.linalg.eigh(Cm)
    Cm = v_ @ np.diag(np.clip(w_, 1e-6, None)) @ v_.T
    out = pd.DataFrame(Cm, index=sub.columns, columns=sub.columns)
    return (out, ev_raw) if with_eig else out


def regime_overlay(cfg, mrow, U):
    tilt = pd.Series(0.0, index=U)
    vmult = pd.Series(1.0, index=U)
    sl, ro = cfg.sleeves, cfg.universe["regime_overlay"]
    applied = []

    def apply(key):
        for rule in ro[key]:
            names = [n for n in (rule.get("tickers") or sl[rule["list"]]) if n in U]
            tilt[names] += rule.get("tilt", 0.0)
            if "vol_mult" in rule:
                vmult[names] *= rule["vol_mult"]
        applied.append(key)

    if mrow["RATES_regime"] == "Rising": apply("rates_rising")
    if mrow["RATES_regime"] == "Falling": apply("rates_falling")
    if mrow["INFL_regime"] == "Falling": apply("infl_falling")
    if mrow["INFL_regime"] == "Rising": apply("infl_rising")
    if mrow["CREDIT_regime"] == "Deteriorating": apply("credit_deteriorating")
    if mrow["CREDIT_regime"] == "Improving": apply("credit_improving")
    if mrow["RISK_STATE"] == "RiskOff": apply("risk_off")
    return tilt, vmult, mrow["RISK_STATE"], mrow["DEF_STATE"], applied


def expected_returns(ctx, t, score_row, kappa, hist_window=120, hist_min=36):
    R = ctx.Rm_me.loc[:t].tail(hist_window)
    hist = (R.mean() * 12).where(R.count() >= hist_min)
    xs = hist.mean()
    base = 0.5 * hist.fillna(xs) + 0.5 * xs
    sig = ctx.met["vol_12m"].loc[t]
    tilt, vmult, rs, ds, applied = regime_overlay(ctx.cfg, ctx.M.loc[t], ctx.U)
    mu = base + kappa * sig * score_row.fillna(0) + tilt * sig
    return mu, vmult, rs, ds, dict(base=base, signal=kappa * sig * score_row.fillna(0), regime=tilt * sig, applied=applied)


def _constraints(ctx, av, w, P, rs, ds, caps_only=False):
    cfg = ctx.cfg
    sl, oc = cfg.sleeves, cfg.opt_class
    avs = list(av)

    def ix(names):
        s = set(names)
        return np.array([i for i, a in enumerate(avs) if a in s], dtype=int)

    cons = {"sum": cp.sum(w) == 1, "nonneg": w >= 0, "single": w <= P["single"]}

    def cap(key, names, lim, ge=False):
        ii = ix(names)
        if len(ii):
            cons[key] = (cp.sum(w[ii]) >= lim) if ge else (cp.sum(w[ii]) <= lim)

    cap("cc", sl["covered_call"], P["cc_cap"])
    cap("credit", sl["credit_risk"], P["credit_cap"])
    cap("clo_aaa", sl["clo_aaa"], P["clo_aaa_cap"])
    for key, cname, lim in [("cls_Equity", "Equity", P["eq_cap"]), ("cls_Dividend", "Dividend", P["div_cap"]),
                            ("cls_RealAsset", "RealAsset", P["real_cap"]), ("cls_Alt", "Alt", P["alt_cap"])]:
        cap(key, [a for a in avs if oc[a] == cname], lim)
    cap("cash", [cfg.cash], P["cash_min"], ge=True)
    eqmin = P["eq_min"][rs] if P["use_floors"] else 0.0
    defmin = P["def_min"][ds] if P["use_floors"] else 0.0
    if eqmin > 0:
        cap("eq_min", sl["pure_equity"], eqmin, ge=True)
    if defmin > 0:
        cap("def_min", sl["defensive"], defmin, ge=True)
    return cons, eqmin, defmin, ix


def optimize(ctx, t, score_row, w_prev, y_hist, P):
    av = score_row.dropna().index.tolist()
    n = len(av)
    mu_all, vmult, rs, ds, parts = expected_returns(ctx, t, score_row, P["kappa"], P.get("hist_window", 120), P.get("hist_min_obs", 36))
    mu = mu_all.loc[av].values
    y = ctx.met["yield_ttm"].loc[t, av].fillna(0).values
    Sig = covariance(ctx.Rm_me, t, P["cov_win"], P["shrink"]).loc[av, av].values
    vm = np.sqrt(vmult.loc[av].values)
    Sig = Sig * np.outer(vm, vm)
    Sig = (Sig + Sig.T) / 2
    R = ctx.Rm_me.loc[:t, av].tail(P["cvar_win"]).fillna(0).values
    w = cp.Variable(n)
    z = cp.Variable(R.shape[0])
    alpha = cp.Variable()
    wp = w_prev.reindex(av).fillna(0).values
    cvar = alpha + cp.sum(z) / (P["cvar_alpha"] * R.shape[0])
    cons, eqmin, defmin, ix = _constraints(ctx, av, w, P, rs, ds)
    cons["z1"] = z >= 0
    cons["z2"] = z >= -(R @ w) - alpha
    inc = y @ w
    if P["rolling_income"] and y_hist:
        h = list(y_hist)[-11:]
        inc_eff = (sum(h) + inc) / (len(h) + 1)
    else:
        inc_eff = inc
    obj = mu @ w - P["lam"] * 2.0 * cp.quad_form(w, Sig) - P["lam_c"] * cp.sum_squares(w) - P["lam_cvar"] * cvar - P["tc"] * cp.norm1(w - wp)
    mode, status = P["income_mode"], "ok"
    if mode == "hard":
        obj = obj + P["lam_y"] * inc
        cons["income"] = inc >= P["target"]
    elif mode == "soft":
        obj = obj + P["lam_y"] * inc - P["lam_inc"] * cp.square(cp.pos(P["target"] - inc_eff))
    elif mode == "corridor":
        obj = obj + P["lam_y"] * cp.minimum(inc, P["util_cap"]) - P["lam_inc"] * cp.square(cp.pos(P["target"] - inc_eff)) - P["lam_floor"] * cp.square(cp.pos(P["floor"] - inc))
    prob = cp.Problem(cp.Maximize(obj), list(cons.values()))
    prob.solve(solver=cp.CLARABEL)
    if prob.status not in ("optimal", "optimal_inaccurate"):
        if mode == "hard":
            cons.pop("income")
            obj2 = obj - P["lam_inc"] * cp.square(cp.pos(P["target"] - inc))
            prob = cp.Problem(cp.Maximize(obj2), list(cons.values()))
            prob.solve(solver=cp.CLARABEL)
            status = "hard_infeasible->soft"
        if prob.status not in ("optimal", "optimal_inaccurate"):
            for k in ("eq_min", "def_min"):
                cons.pop(k, None)
            prob = cp.Problem(cp.Maximize(obj), list(cons.values()))
            prob.solve(solver=cp.CLARABEL)
            status = "floors_dropped"
    if prob.status not in ("optimal", "optimal_inaccurate"):
        raise RuntimeError(f"optimizer failed at {t.date()}: {prob.status}")
    wv = pd.Series(np.clip(w.value, 0, None), index=av)
    wv = wv / wv.sum()
    duals, vec = {}, {}
    for k, c in cons.items():
        if k in ("z1", "z2") or c.dual_value is None:
            continue
        dv = c.dual_value
        duals[k] = float(dv) if np.ndim(dv) == 0 else float(np.max(np.abs(dv)))
    for k in ("nonneg", "single"):
        if k in cons and cons[k].dual_value is not None:
            vec[k] = pd.Series(np.abs(np.asarray(cons[k].dual_value).ravel()), index=av)
    wfull = wv.reindex(ctx.U).fillna(0.0)
    info = dict(status=status, solver=prob.status, risk_state=rs, def_state=ds, eq_min=eqmin, def_min=defmin,
                duals=duals, dual_vec=vec, inc=float((wfull * ctx.met["yield_ttm"].loc[t].fillna(0)).sum()),
                mu=mu_all, mu_parts=parts, cvar=float(cvar.value), objective=float(prob.value),
                turnover_term=float(P["tc"] * np.abs(wv.values - wp).sum()))
    return wfull, info


def apply_band(raw, current, band, single, cash):
    """Positions whose change is below the band keep the current weight; residual goes to traded names."""
    if current is None:
        return raw.copy(), []
    current = current.reindex(raw.index).fillna(0.0)
    diff = raw - current
    keep = (diff.abs() < band) & (current <= single + 1e-6)
    tgt = raw.where(~keep, current).copy()
    resid = 1.0 - tgt.sum()
    traded = ~keep
    if traded.any() and tgt[traded].sum() > 0:
        tgt[traded] = tgt[traded] + resid * tgt[traded] / tgt[traded].sum()
    else:
        tgt[cash] += resid
    over = tgt > single + 1e-9
    if over.any():
        exc = (tgt[over] - single).sum()
        tgt[over] = single
        tgt[cash] += exc
    return tgt, list(keep[keep].index)


def max_income(ctx, t, P, rs, ds):
    """Largest TTM income achievable under the constraint set (LP)."""
    av = [a for a in ctx.U if not np.isnan(ctx.met["yield_ttm"].loc[t, a]) and bool(ctx.avail.loc[t, a])]
    y = ctx.met["yield_ttm"].loc[t, av].fillna(0).values
    w = cp.Variable(len(av))
    cons, *_ = _constraints(ctx, av, w, P, rs, ds)
    prob = cp.Problem(cp.Maximize(y @ w), list(cons.values()))
    prob.solve(solver=cp.CLARABEL)
    if prob.status not in ("optimal", "optimal_inaccurate"):
        return None, None
    return float(prob.value), pd.Series(np.clip(w.value, 0, None), index=av)
