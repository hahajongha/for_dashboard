"""ETF score: rolling (own-history) z + cross-sectional z, v3.0 construction."""
from __future__ import annotations
import numpy as np
import pandas as pd


def rz(df, L):
    m = df.shift(1).rolling(L, min_periods=max(6, L // 2)).mean()
    s = df.shift(1).rolling(L, min_periods=max(6, L // 2)).std()
    return ((df - m) / s).clip(-3, 3)


def csz(df):
    mu, sd = df.mean(axis=1), df.std(axis=1)
    return df.sub(mu, axis=0).div(sd, axis=0).clip(-3, 3)


def _avg(frames):
    return pd.concat(frames, axis=0).groupby(level=0).mean()


def build_scores(met, avail, cond_n, L, w, mac_full=24):
    A = avail.astype(float).replace(0, np.nan)

    def m(k):
        return met[k] * A

    S_ret = csz(_avg([rz(m("ret_3m"), L), rz(m("ret_6m"), L), rz(m("ret_12m"), L), csz(m("relmom_6m"))]))
    S_ra = csz(_avg([rz(m("sharpe_12m"), L), csz(m("sortino_12m").clip(-5, 5)), csz(m("calmar_12m").clip(-5, 5))]))
    inc_g = m("dist_growth").fillna(0).clip(-1, 1)
    inc_s = m("dist_stab").clip(-1, 1).fillna(-1)
    S_inc = csz(_avg([csz(m("yield_ttm")), csz(rz(m("yield_ttm"), L)), csz(inc_g), csz(inc_s)]))
    S_mac_raw = csz(m("cond_sharpe").clip(-4, 4)).fillna(0)
    S_pen = csz(_avg([csz(m("vol_6m")), csz(-m("mdd_12m")), csz(-m("cvar95_12m")), rz(m("vol_6m"), L)]))
    wgt = (cond_n.astype(float) / mac_full).clip(0, 1).fillna(0)
    S_mac = S_mac_raw * wgt
    total = (w["ret"] * S_ret + w["ra"] * S_ra + w["inc"] * S_inc + w["mac"] * S_mac - w["pen"] * S_pen) * A
    hist_z = dict(ret_12m=rz(met["ret_12m"], L), sharpe_12m=rz(met["sharpe_12m"], L), yield_ttm=rz(met["yield_ttm"], L), vol_6m=rz(met["vol_6m"], L))
    return dict(total=total, ret=S_ret, ra=S_ra, inc=S_inc, mac=S_mac, mac_raw=S_mac_raw, pen=S_pen, mac_wgt=wgt, hist_z=hist_z)


def sample_flag(n_obs, full=24, minimum=12):
    if n_obs is None or (isinstance(n_obs, float) and np.isnan(n_obs)) or n_obs < minimum:
        return "Insufficient Sample (Macro=Neutral)"
    if n_obs < full:
        return "Partial weight"
    return "Computed"
