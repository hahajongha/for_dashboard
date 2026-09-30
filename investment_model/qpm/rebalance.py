"""Actual portfolio input (CSV / manual), Target vs Actual comparison and rebalancing orders.
The same algorithm is implemented in the dashboard (JavaScript) for static mode."""
from __future__ import annotations
import csv
import io
import math
import numpy as np
import pandas as pd

CASH_ALIASES = {"CASH", "USD", "현금", "예수금", "DEPOSIT"}
ALIAS = {"ticker": {"ticker", "symbol", "종목", "종목코드", "티커", "code"},
         "quantity": {"quantity", "qty", "shares", "수량", "보유수량", "주수"},
         "price": {"price", "현재가", "가격", "종가", "close", "lastprice"},
         "market_value": {"marketvalue", "mv", "평가금액", "value", "amount", "평가액"},
         "weight": {"weight", "비중", "wt", "weights"}}


def _nk(k):
    return str(k).strip().lower().replace(" ", "").replace("_", "").replace("(%)", "").replace("%", "").replace("($)", "")


def _num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return None if (isinstance(v, float) and math.isnan(v)) else float(v)
    s = str(v).strip().replace(",", "").replace("$", "").replace("%", "").replace("₩", "")
    if s in ("", "-", "nan", "None", "null"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_actual_csv(text):
    text = text.lstrip("\ufeff")
    head = text[:2000]
    delim = ";" if head.count(";") > head.count(",") else ("\t" if head.count("\t") > head.count(",") else ",")
    rows = []
    for r in csv.DictReader(io.StringIO(text), delimiter=delim):
        rec = {}
        for k, v in r.items():
            if k is None:
                continue
            for field, al in ALIAS.items():
                if _nk(k) in al:
                    rec[field] = v
        if rec.get("ticker") and str(rec["ticker"]).strip():
            rows.append(rec)
    return rows


def normalize_actual(rows, cfg, last_prices, pv_override=None, extra_cash=0.0):
    U = set(cfg.tickers)
    recs = []
    for r in rows:
        raw_t = str(r.get("ticker", "")).strip()
        tk = raw_t.upper()
        if not tk:
            continue
        is_cash = tk in CASH_ALIASES or raw_t in CASH_ALIASES
        if is_cash:
            tk = "CASH"
        q, p, mv, w = _num(r.get("quantity")), _num(r.get("price")), _num(r.get("market_value")), _num(r.get("weight"))
        if is_cash and p is None:
            p = 1.0
        if p is None and tk in last_prices:
            p = float(last_prices[tk])
        if mv is None and q is not None and p is not None:
            mv = q * p
        recs.append(dict(ticker=tk, quantity=q, price=p, market_value=mv, weight_in=w))
    if not recs:
        raise ValueError("실보유 데이터가 비어 있습니다.")
    df = pd.DataFrame(recs)
    agg = df.groupby("ticker", sort=False).agg(quantity=("quantity", lambda s: s.sum(min_count=1)), price=("price", "first"),
                                               market_value=("market_value", lambda s: s.sum(min_count=1)),
                                               weight_in=("weight_in", lambda s: s.sum(min_count=1))).reset_index()
    notes = []
    miss = agg["market_value"].isna()
    if miss.any():
        wsum = agg["weight_in"].sum(skipna=True)
        scale = 100.0 if wsum > 1.5 else 1.0
        if agg.loc[miss, "weight_in"].isna().any():
            raise ValueError("수량·가격·평가금액·비중이 모두 없는 종목이 있습니다: " + ", ".join(agg.loc[miss & agg["weight_in"].isna(), "ticker"]))
        if pv_override:
            pv = float(pv_override)
        else:
            known = agg.loc[~miss]
            if len(known) and known["weight_in"].notna().all() and known["weight_in"].sum() > 0:
                pv = float(known["market_value"].sum() / (known["weight_in"].sum() / scale))
                notes.append("총 평가금액을 금액이 있는 종목의 비중으로 역산했습니다.")
            else:
                raise ValueError("비중만 입력된 종목이 있습니다. 총 평가금액(Portfolio Value)을 입력하세요.")
        agg.loc[miss, "market_value"] = agg.loc[miss, "weight_in"] / scale * pv
    if extra_cash:
        if (agg["ticker"] == "CASH").any():
            agg.loc[agg["ticker"] == "CASH", "market_value"] += float(extra_cash)
        else:
            agg = pd.concat([agg, pd.DataFrame([dict(ticker="CASH", quantity=None, price=1.0, market_value=float(extra_cash), weight_in=None)])], ignore_index=True)
        notes.append(f"추가 입금/출금 {extra_cash:,.0f} 반영")
    pv_total = float(agg["market_value"].sum())
    if pv_total <= 0:
        raise ValueError("총 평가금액이 0 이하입니다.")
    agg["weight"] = agg["market_value"] / pv_total
    agg["in_universe"] = agg["ticker"].isin(U)
    agg["is_cash"] = agg["ticker"] == "CASH"
    return agg, pv_total, notes


def exposures(cfg, w, beta_eq, durations):
    sl = cfg.sleeves

    def g(names):
        return float(sum(float(w.get(k, 0.0)) for k in names))

    risk = {"Effective Equity Beta": float(sum(float(w.get(k, 0.0)) * float(beta_eq.get(k, 0.0) or 0.0) for k in cfg.tickers)),
            "Duration (yrs)": float(sum(float(w.get(k, 0.0)) * float(durations.get(k, 0.0) or 0.0) for k in cfg.tickers)),
            "Covered Call": g(sl["covered_call"]), "Credit (VCIT·USHY·JBBB·PFF)": g(sl["credit_risk"]), "CLO AAA": g(sl["clo_aaa"]),
            "Pure Equity": g(sl["pure_equity"]), "Dividend": g(sl["dividend"]), "Defensive": g(sl["defensive"]),
            "Alternative": g(sl["alternative"]), "Real Asset": g(sl["real_asset"]),
            "Cash (SGOV + 미투자 현금)": g(sl["cash"]) + float(w.get("CASH", 0.0))}
    ac = cfg.asset_class
    cls = {c: float(sum(float(w.get(t, 0.0)) for t in cfg.tickers if ac[t] == c)) for c in cfg.universe["asset_class_order"]}
    cls["미투자 현금"] = float(w.get("CASH", 0.0))
    cls["유니버스 외 종목"] = float(w.get("_OTHER", 0.0))
    return cls, risk


def compare(cfg, target, actual_df, pv, band, tc_bps, beta_eq, durations, last_prices):
    U = cfg.tickers
    aw = actual_df.set_index("ticker")["weight"]
    ap = actual_df.set_index("ticker")["price"]
    rows, tb, ts = [], 0.0, 0.0
    for e in U:
        tg, ac = float(target.get(e, 0.0)), float(aw.get(e, 0.0))
        diff = ac - tg
        action = "SELL" if diff > band + 1e-12 else ("BUY" if diff < -band - 1e-12 else "HOLD")
        amt = (tg - ac) * pv if action != "HOLD" else 0.0
        price = ap.get(e) if (e in ap.index and ap.get(e) is not None and not pd.isna(ap.get(e))) else last_prices.get(e)
        shares = int(amt / price) if (price and action != "HOLD") else 0
        if amt > 0:
            tb += amt
        else:
            ts += -amt
        rows.append(dict(ticker=e, asset_class=cfg.asset_class[e], target=tg, actual=ac, active=diff, abs_dev=abs(diff), band=band,
                         action=action, trade_amount=amt, trade_shares=shares, price=(None if price is None else float(price)),
                         actual_value=ac * pv, post_weight=ac + amt / pv))
    other = actual_df[(~actual_df["in_universe"]) & (~actual_df["is_cash"])]
    for _, r in other.iterrows():
        amt = -float(r["market_value"])
        ts += -amt
        px = None if (r["price"] is None or pd.isna(r["price"])) else float(r["price"])
        rows.append(dict(ticker=r["ticker"], asset_class="유니버스 외", target=0.0, actual=float(r["weight"]), active=float(r["weight"]),
                         abs_dev=float(r["weight"]), band=band, action="SELL (유니버스 외)", trade_amount=amt,
                         trade_shares=(int(amt / px) if px else 0), price=px, actual_value=float(r["market_value"]), post_weight=0.0))
    cash_amt = float(aw.get("CASH", 0.0)) * pv
    cost = (tb + ts) * tc_bps / 1e4
    totals = dict(portfolio_value=pv, total_buy=tb, total_sell=ts, cash_available=cash_amt, est_cost=cost,
                  net_cash_requirement=tb - ts - cash_amt + cost, post_trade_cash=cash_amt + ts - tb - cost,
                  turnover=(tb + ts) / pv, n_buy=sum(r["action"] == "BUY" for r in rows),
                  n_sell=sum(r["action"].startswith("SELL") for r in rows), n_hold=sum(r["action"] == "HOLD" for r in rows))
    w_t = pd.Series({e: float(target.get(e, 0.0)) for e in U})
    w_a = pd.Series({e: float(aw.get(e, 0.0)) for e in U})
    w_a["CASH"] = float(aw.get("CASH", 0.0))
    w_a["_OTHER"] = float(other["weight"].sum()) if len(other) else 0.0
    w_p = pd.Series({r["ticker"]: r["post_weight"] for r in rows if r["ticker"] in U})
    w_p["CASH"] = totals["post_trade_cash"] / pv
    ct, rt = exposures(cfg, w_t, beta_eq, durations)
    ca, ra = exposures(cfg, w_a, beta_eq, durations)
    cp_, rp = exposures(cfg, w_p, beta_eq, durations)
    exp_cls = [dict(name=k, target=ct[k], actual=ca[k], post=cp_[k], delta=ca[k] - ct[k]) for k in ct]
    exp_risk = [dict(name=k, target=rt[k], actual=ra[k], post=rp[k], delta=ra[k] - rt[k]) for k in rt]
    return dict(rows=rows, totals=totals, exposure_class=exp_cls, exposure_risk=exp_risk, band=band, tc_bps=tc_bps)
