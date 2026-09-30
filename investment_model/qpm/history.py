"""Monthly run history: history/<YYYY-MM>/ (data month) with result.json, CSV tables, actual & orders."""
from __future__ import annotations
import pandas as pd
from .config import load_json, save_json


class History:
    def __init__(self, cfg):
        self.cfg = cfg
        self.dir = cfg.path("history_dir")
        self.index_path = self.dir / "index.json"

    def index(self):
        return load_json(self.index_path) if self.index_path.exists() else {"months": [], "income_history": {}}

    def save_index(self, idx):
        save_json(idx, self.index_path)

    def mdir(self, month):
        p = self.dir / month
        p.mkdir(parents=True, exist_ok=True)
        return p

    def months(self):
        return sorted(m["month"] for m in self.index()["months"])

    def latest_month(self):
        ms = [m["month"] for m in self.index()["months"] if m.get("source") != "seed_v3.0"]
        ms = ms or self.months()
        return sorted(ms)[-1] if ms else None

    def load_result(self, month):
        p = self.dir / month / "result.json"
        return load_json(p) if p.exists() else None

    def load_target(self, month):
        p = self.dir / month / "target_portfolio.csv"
        if not p.exists():
            return None
        df = pd.read_csv(p, index_col=0)
        return df["target"].astype(float)

    def previous(self, month):
        for m in sorted(self.index()["months"], key=lambda x: x["month"], reverse=True):
            if m["month"] >= month:
                continue
            tg = self.load_target(m["month"])
            if tg is not None:
                return dict(month=m["month"], as_of=m["as_of"], target=tg, source=m.get("source"))
        return None

    def income_history_before(self, month):
        ih = self.index().get("income_history", {})
        return [float(ih[k]) for k in sorted(ih) if k < month]

    def save_run(self, result, tables, texts=None):
        meta = result["meta"]
        month = meta["month"]
        d = self.mdir(month)
        save_json(result, d / "result.json")
        for name, df in tables.items():
            df.to_csv(d / f"{name}.csv", encoding="utf-8-sig")
        for name, txt in (texts or {}).items():
            (d / name).write_text(txt, encoding="utf-8")
        idx = self.index()
        idx["months"] = [m for m in idx["months"] if m["month"] != month]
        idx["months"].append(dict(month=month, as_of=meta["data_as_of"], rebalance_date=meta["rebalance_date"],
                                  target_month=meta["target_month"], regime=result["macro"]["composite_long"],
                                  income=result["metrics"]["IncomeYield"], status=meta["status"], source=meta["source"],
                                  class_weights=result["portfolio"]["class_weights"],
                                  weights={r["ticker"]: r["target"] for r in result["portfolio"]["rows"]}))
        idx["months"].sort(key=lambda m: m["month"])
        idx.setdefault("income_history", {})[month] = result["metrics"]["IncomeYield"]
        self.save_index(idx)
        save_json(result, self.cfg.path("output_dir") / "latest.json")

    def load_actual(self, month):
        p = self.dir / month / "actual_portfolio.csv"
        return pd.read_csv(p) if p.exists() else None

    def save_actual(self, month, actual_df, rb):
        d = self.mdir(month)
        actual_df.to_csv(d / "actual_portfolio.csv", index=False, encoding="utf-8-sig")
        pd.DataFrame(rb["rows"]).to_csv(d / "rebalancing_order.csv", index=False, encoding="utf-8-sig")
        res = self.load_result(month)
        if res is not None:
            res["actual"] = dict(provided=True, rows=actual_df.to_dict(orient="records"), portfolio_value=rb["totals"]["portfolio_value"])
            res["rebalance"] = rb
            save_json(res, d / "result.json")
            if month == self.latest_month():
                save_json(res, self.cfg.path("output_dir") / "latest.json")
        return res
