"""Market (yfinance) and macro (FRED / ALFRED) data acquisition with a local cache.

FRED modes
  api   : api.stlouisfed.org with FRED_API_KEY from .env (key is never logged or sent to the browser)
  csv   : keyless fredgraph.csv endpoint
  cache : last downloaded local files only (no network)
ALFRED as-of vintages (point-in-time data as known on data_as_of) are fetched for series flagged
`revisable` when settings.use_alfred_vintage is true (keyless alfredgraph.csv or API realtime params).
"""
from __future__ import annotations
import datetime as dt
import io
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from .config import Config, save_json

FIELDS = ["Adj Close", "Close", "Open", "High", "Low", "Volume", "Dividends", "Stock Splits"]
UA = {}  # custom user-agents are rejected (HTTP 503) by FRED; use the requests default


def _slug(f):
    return f.lower().replace(" ", "_")


def _series_from_csv_text(text):
    df = pd.read_csv(io.StringIO(text))
    if df.shape[1] < 2:
        raise ValueError("unexpected FRED CSV format")
    df = df.iloc[:, :2]
    df.columns = ["date", "value"]
    df["date"] = pd.to_datetime(df["date"])
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df.set_index("date")["value"].dropna().sort_index()


class DataLayer:
    def __init__(self, cfg: Config, log=print):
        self.cfg, self.log = cfg, log
        self.dir = cfg.path("data_dir")
        for sub in ("market", "fred", "alfred", "reference"):
            (self.dir / sub).mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ market
    def update_market(self, as_of=None):
        import yfinance as yf
        tickers = self.cfg.market_tickers()
        start = self.cfg.settings["market_start"]
        end_excl = (pd.Timestamp(as_of) + pd.Timedelta(days=1)).strftime("%Y-%m-%d") if as_of else None
        self.log(f"yfinance: {len(tickers)} tickers, start={start}, end(excl)={end_excl or 'latest'}")
        df = yf.download(tickers, start=start, end=end_excl, auto_adjust=False, actions=True,
                         progress=False, threads=True)
        if df is None or df.empty:
            raise RuntimeError("yfinance returned no data (network/ticker problem)")
        lvl0 = df.columns.get_level_values(0)
        out = {}
        for f in FIELDS:
            if f in lvl0:
                out[f] = df[f].reindex(columns=tickers).astype(float)
            elif f in ("Dividends", "Stock Splits"):
                out[f] = pd.DataFrame(0.0, index=df.index, columns=tickers)
        out = self._drop_partial_session(out, as_of)
        for f, d in out.items():
            d.index.name = "Date"
            d.to_csv(self.dir / "market" / f"{_slug(f)}.csv.gz", compression="gzip")
        last = out["Adj Close"].apply(lambda s: s.last_valid_index())
        meta = {"downloaded_at": dt.datetime.now().isoformat(timespec="seconds"), "as_of_request": as_of,
                "last_date": str(out["Adj Close"].index[-1].date()),
                "per_ticker_last": {k: (str(v.date()) if v is not None and v is not pd.NaT else None) for k, v in last.items()}}
        save_json(meta, self.dir / "market" / "_meta.json")
        self.log(f"yfinance: saved {len(out)} fields, last date {meta['last_date']}")
        return out

    def _drop_partial_session(self, out, as_of):
        """Drop today's row if the US session is not closed yet (avoids intraday prices)."""
        try:
            from zoneinfo import ZoneInfo
            now_ny = dt.datetime.now(ZoneInfo("America/New_York"))
        except Exception:
            now_ny = dt.datetime.utcnow() - dt.timedelta(hours=4)
        idx = out["Adj Close"].index
        if len(idx) and idx[-1].date() == now_ny.date() and (now_ny.hour, now_ny.minute) < (16, 30):
            self.log(f"yfinance: dropped partial session {idx[-1].date()} (NY time {now_ny:%H:%M})")
            out = {k: v.iloc[:-1] for k, v in out.items()}
        return out

    def load_market(self):
        out = {}
        for f in FIELDS:
            p = self.dir / "market" / f"{_slug(f)}.csv.gz"
            if p.exists():
                out[f] = pd.read_csv(p, index_col=0, parse_dates=True, compression="gzip")
        if "Adj Close" not in out:
            raise FileNotFoundError("market cache missing - run Update Data first")
        return out

    # -------------------------------------------------------------------- FRED
    def _fred_api_key(self):
        k = self.cfg.env.get("FRED_API_KEY", "")
        if not k:
            raise RuntimeError("FRED API mode selected but FRED_API_KEY is empty in .env")
        return k

    @staticmethod
    def _get(url, params=None, tries=3):
        last = None
        for k in range(tries):
            try:
                r = requests.get(url, params=params, timeout=45, headers=UA)
                if r.status_code in (429, 500, 502, 503, 504):
                    raise requests.HTTPError(f"{r.status_code} {r.reason}")
                r.raise_for_status()
                return r
            except Exception as e:
                last = e
                time.sleep(1.5 * (k + 1))
        raise last

    def _fetch_csv(self, sid):
        return _series_from_csv_text(self._get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}").text)

    def _fetch_api(self, sid, key, realtime=None):
        params = dict(series_id=sid, api_key=key, file_type="json", observation_start="1900-01-01")
        if realtime:
            params.update(realtime_start=realtime, realtime_end=realtime)
        obs = self._get("https://api.stlouisfed.org/fred/series/observations", params=params).json().get("observations", [])
        s = pd.Series({pd.Timestamp(o["date"]): (np.nan if o["value"] in (".", "") else float(o["value"])) for o in obs})
        return s.dropna().sort_index()

    def _fetch_alfred_csv(self, sid, as_of):
        url = f"https://alfred.stlouisfed.org/graph/alfredgraph.csv?id={sid}&vintage_date={pd.Timestamp(as_of):%Y-%m-%d}"
        return _series_from_csv_text(self._get(url).text)

    def _cache_path(self, sid):
        return self.dir / "fred" / f"{sid}.csv"

    def load_fred_cache(self, sid):
        p = self._cache_path(sid)
        if not p.exists():
            return None
        return pd.read_csv(p, index_col=0, parse_dates=True).iloc[:, 0].dropna()

    def update_fred(self, mode=None):
        mode = mode or self.cfg.settings.get("fred_mode", "csv")
        key = self._fred_api_key() if mode == "api" else None
        out, report = {}, []
        for s in self.cfg.fred["series"]:
            sid = s["id"]
            old = self.load_fred_cache(sid)
            try:
                if mode == "cache":
                    if old is None:
                        raise FileNotFoundError("no local cache")
                    new, status = old, "cache"
                else:
                    new = self._fetch_api(sid, key) if mode == "api" else self._fetch_csv(sid)
                    status = mode
                    rev = self._revisions(old, new)
                    new.rename("value").to_frame().to_csv(self._cache_path(sid))
                out[sid] = new
                report.append(dict(id=sid, status=status, first=str(new.index[0].date()), last=str(new.index[-1].date()),
                                   n=int(len(new)), revised=(rev["n_revised"] if mode != "cache" else None),
                                   revised_max_abs=(rev["max_abs"] if mode != "cache" else None)))
            except Exception as e:
                if old is not None:
                    out[sid] = old
                    report.append(dict(id=sid, status="fallback_cache", error=str(e)[:160], last=str(old.index[-1].date()), n=int(len(old))))
                else:
                    report.append(dict(id=sid, status="failed", error=str(e)[:160]))
            if mode != "cache":
                time.sleep(0.15)
        save_json({"mode": mode, "updated_at": dt.datetime.now().isoformat(timespec="seconds"), "series": report},
                  self.dir / "fred" / "_update_report.json")
        ok = sum(r["status"] in ("csv", "api", "cache") for r in report)
        self.log(f"FRED ({mode}): {ok}/{len(report)} series updated; fallbacks/failures: "
                 f"{[r['id'] for r in report if r['status'] not in ('csv', 'api', 'cache')]}")
        return out, report

    @staticmethod
    def _revisions(old, new):
        if old is None or new is None:
            return {"n_revised": 0, "max_abs": 0.0}
        j = pd.concat([old.rename("o"), new.rename("n")], axis=1, join="inner").dropna()
        d = (j["n"] - j["o"]).abs()
        m = d > 1e-9
        return {"n_revised": int(m.sum()), "max_abs": float(d[m].max()) if m.any() else 0.0}

    def load_fred(self):
        out = {}
        for s in self.cfg.fred["series"]:
            v = self.load_fred_cache(s["id"])
            if v is not None:
                out[s["id"]] = v
        return out

    def fetch_vintages(self, as_of, mode=None):
        """Point-in-time (as-of) vintages for revisable series. Returns {sid: Series} and a report."""
        mode = mode or self.cfg.settings.get("fred_mode", "csv")
        tag = pd.Timestamp(as_of).strftime("%Y%m%d")
        out, report = {}, []
        for s in self.cfg.fred["series"]:
            if not s.get("revisable"):
                continue
            sid = s["id"]
            p = self.dir / "alfred" / f"{sid}_{tag}.csv"
            try:
                if mode == "cache" or p.exists():
                    if not p.exists():
                        raise FileNotFoundError("no cached vintage")
                    v = pd.read_csv(p, index_col=0, parse_dates=True).iloc[:, 0].dropna()
                    src = "alfred_cache"
                elif mode == "api":
                    v = self._fetch_api(sid, self._fred_api_key(), realtime=pd.Timestamp(as_of).strftime("%Y-%m-%d"))
                    src = "alfred_api"
                else:
                    v = self._fetch_alfred_csv(sid, as_of)
                    src = "alfred_csv"
                if v.empty:
                    raise ValueError("empty vintage")
                v.rename("value").to_frame().to_csv(p)
                out[sid] = v
                report.append(dict(id=sid, status=src, vintage_date=str(pd.Timestamp(as_of).date()), last_obs=str(v.index[-1].date())))
            except Exception as e:
                report.append(dict(id=sid, status="no_vintage", error=str(e)[:160]))
            if mode not in ("cache",):
                time.sleep(0.15)
        self.log(f"ALFRED as-of {pd.Timestamp(as_of).date()}: {len(out)} vintages; missing {[r['id'] for r in report if r['status']=='no_vintage']}")
        return out, report

    # ---------------------------------------------------------------- reference
    def update_reference(self):
        """Optional: top holdings of PFF for concentration display (Yahoo, top-10 only)."""
        try:
            import yfinance as yf
            th = yf.Ticker("PFF").funds_data.top_holdings
            th.to_csv(self.dir / "reference" / "PFF_top_holdings.csv")
            save_json({"asof": dt.date.today().isoformat(), "source": "Yahoo Finance funds_data (top 10)"},
                      self.dir / "reference" / "PFF_top_holdings_meta.json")
        except Exception as e:
            self.log(f"reference: PFF holdings unavailable ({str(e)[:80]})")

    def load_reference(self):
        p = self.dir / "reference" / "PFF_top_holdings.csv"
        if p.exists():
            m = self.dir / "reference" / "PFF_top_holdings_meta.json"
            meta = json.loads(m.read_text(encoding="utf-8")) if m.exists() else {}
            return pd.read_csv(p, index_col=0), meta
        return None, {}
