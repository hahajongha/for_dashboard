"""Configuration, secrets (.env) and small helpers shared by every module."""
from __future__ import annotations
import datetime as dt
import json
import math
import os
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_json(obj, path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(jsonable(obj), ensure_ascii=False, indent=1), encoding="utf-8")


def jsonable(o):
    """Convert pandas / numpy objects to JSON-safe python (NaN/inf -> None)."""
    if isinstance(o, dict):
        return {str(k): jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [jsonable(v) for v in o]
    if isinstance(o, pd.Series):
        return {str(k): jsonable(v) for k, v in o.items()}
    if isinstance(o, pd.DataFrame):
        return [jsonable(r) for r in o.reset_index().to_dict(orient="records")]
    if isinstance(o, (pd.Timestamp, dt.date, dt.datetime)):
        return o.strftime("%Y-%m-%d")
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        v = float(o)
        return None if (math.isnan(v) or math.isinf(v)) else v
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if o is pd.NaT:
        return None
    return o


def load_env(path: Path) -> dict:
    env = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("FRED_API_KEY", "ANTHROPIC_API_KEY"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


class Config:
    def __init__(self, root: Path | str = ROOT):
        self.root = Path(root)
        c = self.root / "config"
        self.universe = load_json(c / "universe.json")
        self.params = load_json(c / "model_params.json")
        self.fred = load_json(c / "fred_series.json")
        self.settings = load_json(c / "settings.json")
        local = c / "settings.local.json"
        if local.exists():
            self.settings.update(load_json(local))
        self.env = load_env(self.root / ".env")

    # ---- universe helpers -------------------------------------------------
    @property
    def tickers(self):
        return [e["ticker"] for e in self.universe["etfs"]]

    @property
    def proxies(self):
        return self.universe["proxies"]

    @property
    def sleeves(self):
        s = dict(self.universe["sleeves"])
        s["risk_assets"] = s["pure_equity"] + s["covered_call"] + s["credit_risk"] + s["risk_assets_extra"]
        return s

    @property
    def asset_class(self):
        return {e["ticker"]: e["asset_class"] for e in self.universe["etfs"]}

    @property
    def opt_class(self):
        return {e["ticker"]: e["opt_class"] for e in self.universe["etfs"]}

    @property
    def durations(self):
        return {e["ticker"]: (e["duration"] or 0.0) for e in self.universe["etfs"]}

    @property
    def cash(self):
        return self.universe["cash_ticker"]

    def market_tickers(self):
        out = list(self.tickers)
        for t in list(self.proxies.values()) + list(self.universe["reference_tickers"]):
            if t not in out:
                out.append(t)
        return out

    def path(self, key):
        p = self.root / self.settings[key]
        p.mkdir(parents=True, exist_ok=True)
        return p

    def save_local_settings(self, **kw):
        p = self.root / "config" / "settings.local.json"
        cur = load_json(p) if p.exists() else {}
        cur.update(kw)
        save_json(cur, p)
        self.settings.update(kw)

    def engine_params(self, **override):
        """Flatten model_params.json into the optimiser/scoring parameter dict."""
        p = self.params
        caps, inc, risk, fl = p["caps"], p["income"], p["risk"], p["floors"]
        P = dict(
            L=int(p["signal"]["lookback_months"]), cfg=p["signal"]["config"], wsets=p["signal"]["weight_sets"],
            mac_full=p["signal"]["macro_sample_full"], kappa=float(p["expected_return"]["kappa"]),
            hist_window=p["expected_return"]["hist_window"], hist_min_obs=p["expected_return"]["hist_min_obs"],
            lam=float(risk["lam"]), lam_cvar=float(risk["lam_cvar"]), lam_c=float(risk["lam_conc"]),
            cov_win=int(risk["cov_window"]), cvar_win=int(risk["cvar_window"]), shrink=float(risk["shrink"]),
            cvar_alpha=float(risk["cvar_alpha"]),
            income_mode=inc["mode"], target=float(inc["target"]), lam_inc=float(inc["lam_income"]),
            lam_y=float(inc["lam_utility"]), rolling_income=bool(inc["rolling_12m"]), floor=float(inc["corridor_floor"]),
            util_cap=float(inc["corridor_util_cap"]), lam_floor=float(inc["corridor_lam_floor"]),
            single=float(caps["single"]), cc_cap=float(caps["covered_call"]), credit_cap=float(caps["credit"]),
            clo_aaa_cap=float(caps["clo_aaa"]), alt_cap=float(caps["alt"]), eq_cap=float(caps["equity"]),
            div_cap=float(caps["dividend"]), real_cap=float(caps["real_asset"]), cash_min=float(caps["cash_min"]),
            use_floors=bool(fl["enabled"]), def_min=dict(fl["defensive"]), eq_min=dict(fl["equity"]),
            band=float(p["rebalance"]["band"]), tc=float(p["rebalance"]["turnover_penalty"]),
            tc_bps=float(p["rebalance"]["tc_bps"]),
        )
        P.update(override)
        return P


# ---------------------------------------------------------------------------
# NYSE trading calendar (rule based; special closures are not modelled)
# ---------------------------------------------------------------------------
def _easter(y):
    a = y % 19; b = y // 100; c = y % 100; d = b // 4; e = b % 4; f = (b + 8) // 25; g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30; i = c // 4; k = c % 4; l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451; month = (h + l - 7 * m + 114) // 31; day = ((h + l - 7 * m + 114) % 31) + 1
    return dt.date(y, month, day)


def _nth_weekday(y, m, wd, n):
    d = dt.date(y, m, 1)
    while d.weekday() != wd:
        d += dt.timedelta(days=1)
    return d + dt.timedelta(days=7 * (n - 1))


def _last_weekday(y, m, wd):
    d = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1))
    while d.weekday() != wd:
        d -= dt.timedelta(days=1)
    return d


def _observed(d):
    if d.weekday() == 5:
        return d - dt.timedelta(days=1)
    if d.weekday() == 6:
        return d + dt.timedelta(days=1)
    return d


@lru_cache(maxsize=None)
def nyse_holidays(y: int):
    h = set()
    ny = dt.date(y, 1, 1)
    if ny.weekday() == 6:
        h.add(ny + dt.timedelta(days=1))
    elif ny.weekday() < 5:
        h.add(ny)
    h.add(_nth_weekday(y, 1, 0, 3)); h.add(_nth_weekday(y, 2, 0, 3))
    h.add(_easter(y) - dt.timedelta(days=2)); h.add(_last_weekday(y, 5, 0))
    if y >= 2022:
        h.add(_observed(dt.date(y, 6, 19)))
    h.add(_observed(dt.date(y, 7, 4))); h.add(_nth_weekday(y, 9, 0, 1)); h.add(_nth_weekday(y, 11, 3, 4))
    h.add(_observed(dt.date(y, 12, 25)))
    return frozenset(h)


def is_trading_day(d) -> bool:
    d = pd.Timestamp(d).date()
    return d.weekday() < 5 and d not in nyse_holidays(d.year)


def next_trading_day(d):
    d = pd.Timestamp(d).date() + dt.timedelta(days=1)
    while not is_trading_day(d):
        d += dt.timedelta(days=1)
    return d


def first_trading_day_next_month(d):
    d = pd.Timestamp(d).date()
    f = dt.date(d.year + (d.month == 12), d.month % 12 + 1, 1)
    while not is_trading_day(f):
        f += dt.timedelta(days=1)
    return f


def last_trading_day_of_month(y, m):
    d = dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1)
    while not is_trading_day(d):
        d -= dt.timedelta(days=1)
    return d


def business_days_between(a, b) -> int:
    """Number of NYSE trading days in (a, b]."""
    a = pd.Timestamp(a).date(); b = pd.Timestamp(b).date()
    if b <= a:
        return 0
    n, d = 0, a
    while d < b:
        d += dt.timedelta(days=1)
        if is_trading_day(d):
            n += 1
    return n


def month_key(d) -> str:
    return pd.Timestamp(d).strftime("%Y-%m")
