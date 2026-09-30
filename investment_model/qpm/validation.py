"""Data and model validation. ERROR stops the monthly run; WARN is shown and recorded."""
from __future__ import annotations
import numpy as np
import pandas as pd
from .config import business_days_between, is_trading_day, last_trading_day_of_month


class Report:
    def __init__(self):
        self.items = []

    def add(self, level, area, check, target, detail):
        self.items.append(dict(level=level, area=area, check=check, target=target, detail=detail))

    @property
    def errors(self):
        return [i for i in self.items if i["level"] == "ERROR"]

    @property
    def warnings(self):
        return [i for i in self.items if i["level"] == "WARN"]

    def summary(self):
        e, w = len(self.errors), len(self.warnings)
        return dict(status="FAIL" if e else ("WARN" if w else "PASS"), errors=e, warnings=w,
                    info=sum(i["level"] == "INFO" for i in self.items))

    def to_dict(self):
        return dict(summary=self.summary(), items=self.items)

    def extend(self, other):
        self.items += other.items
        return self


def validate_data(cfg, mkt, F, fred_report, vint_report, as_of):
    rep, V, as_of = Report(), cfg.settings["validation"], pd.Timestamp(as_of)
    adj, close = mkt["Adj Close"].loc[:as_of], mkt["Close"].loc[:as_of]
    div = mkt["Dividends"].loc[:as_of].fillna(0.0)
    spl = mkt.get("Stock Splits")
    vol = mkt.get("Volume")
    if not is_trading_day(as_of):
        rep.add("WARN", "Market", "기준일 거래일 여부", str(as_of.date()), "data_as_of가 NYSE 거래일이 아닙니다.")
    ltd = last_trading_day_of_month(as_of.year, as_of.month)
    if as_of.date() < ltd:
        rep.add("WARN", "Market", "월말 여부", str(as_of.date()), f"월 마지막 거래일({ltd}) 이전 데이터 — 부분 월 기준 산출(최근 확정 종가 사용)")
    if adj.index.duplicated().any():
        rep.add("ERROR", "Market", "중복 날짜", "all", f"{int(adj.index.duplicated().sum())}개 중복 날짜")
    for t in cfg.tickers + ["^IRX"]:
        if t not in adj.columns or adj[t].dropna().empty:
            rep.add("ERROR", "ETF", "데이터 없음", t, "가격 데이터가 없습니다.")
            continue
        s = adj[t]
        last = s.last_valid_index()
        lag = business_days_between(last, as_of)
        if lag > V["stale_bdays_error"]:
            rep.add("ERROR", "ETF", "마지막 거래일", t, f"마지막 데이터 {last.date()} — 기준일보다 {lag} 거래일 늦음(상장폐지·거래정지 확인)")
        elif lag >= V["stale_bdays_warn"]:
            rep.add("WARN", "ETF", "마지막 거래일", t, f"마지막 데이터 {last.date()} ({lag} 거래일 지연)")
        if t == "^IRX":
            continue
        first = s.first_valid_index()
        months = (as_of - first).days / 30.44
        if months < V["min_history_months"]:
            rep.add("WARN", "ETF", "상장 기간", t, f"이력 {months:.0f}개월 < {V['min_history_months']} — Insufficient Sample")
        recent = s.loc[first:].iloc[-252:]
        nmiss = int(recent.isna().sum())
        if nmiss:
            rep.add("ERROR" if nmiss > 0.05 * len(recent) else "WARN", "ETF", "결측치", t, f"최근 252거래일 중 {nmiss}일 결측")
        sd = s.dropna()
        r = (sd / sd.shift(1) - 1).iloc[-504:]
        split_days = set(spl[t][spl[t].fillna(0) > 0].index) if (spl is not None and t in spl) else set()
        big = r[(r.abs() > V["price_jump_warn"]) & (~r.index.isin(split_days))]
        if len(big):
            lvl = "ERROR" if (big.abs() > V["price_jump_error"]).any() else "WARN"
            rep.add(lvl, "ETF", "가격 이상치", t, "일간 변동 " + ", ".join(f"{d.date()} {v:+.1%}" for d, v in big.items()))
        d = div[t]
        if (d < 0).any():
            rep.add("ERROR", "ETF", "분배금 이상치", t, "음수 분배금")
        dy = (d / close[t]).loc[d > 0]
        dy = dy[dy.index >= as_of - pd.DateOffset(years=3)]
        hi = dy[dy > V["dividend_warn_pct"]]
        if len(hi):
            rep.add("WARN", "ETF", "분배금 이상치", t, "최근 3년 가격 대비 5% 초과 분배: " + ", ".join(f"{i.date()} {v:.1%}" for i, v in hi.items()))
        if vol is not None and t in vol:
            av = float(vol[t].loc[:as_of].tail(20).mean())
            if av < V["min_avg_volume"]:
                rep.add("WARN", "ETF", "최근 거래량", t, f"20일 평균 {av:,.0f}주 < {V['min_avg_volume']:,}")
        c = close[t].dropna().iloc[-253:]
        a = adj[t].reindex(c.index)
        dd = div[t].reindex(c.index).fillna(0.0)
        if len(c) > 200 and a.notna().all():
            recon = float(((c + dd) / c.shift(1)).iloc[1:].prod())
            adjr = float(a.iloc[-1] / a.iloc[0])
            if abs(recon - adjr) > V["tr_check_tol"]:
                rep.add("WARN", "ETF", "Total Return 검증", t, f"종가+분배 재계산 {recon-1:+.2%} vs 수정종가 {adjr-1:+.2%}")
    by_id = {s["id"]: s for s in cfg.fred["series"]}
    for sid, s in by_id.items():
        if sid not in F or F[sid] is None or F[sid].dropna().empty:
            rep.add("ERROR" if s["required"] else "WARN", "FRED", "시리즈 없음", sid, "데이터를 가져오지 못했습니다.")
            continue
        ser = F[sid].dropna()
        last = ser.index[-1]
        age_d = (as_of - last).days
        fq = s["freq"]
        if fq == "d" and age_d > V["fred_daily_max_age_days"]:
            rep.add("ERROR" if s["required"] and age_d > 30 else "WARN", "FRED", "최근 관측일", sid, f"마지막 {last.date()} ({age_d}일 전)")
        elif fq == "w" and age_d > V["fred_weekly_max_age_days"]:
            rep.add("WARN", "FRED", "최근 관측일", sid, f"마지막 {last.date()} ({age_d}일 전)")
        elif fq == "m" and (as_of.to_period("M") - last.to_period("M")).n > V["fred_monthly_max_age_months"]:
            rep.add("WARN", "FRED", "최근 관측일", sid, f"마지막 관측월 {last:%Y-%m}")
        elif fq == "q" and (as_of.to_period("M") - last.to_period("M")).n > V["fred_quarterly_max_age_months"]:
            rep.add("WARN", "FRED", "최근 관측일", sid, f"마지막 관측 {last:%Y-%m}")
        med = float(pd.Series(ser.index).diff().dt.days.tail(60).median())
        ok = {"d": med <= 5, "w": 6 <= med <= 8, "m": 27 <= med <= 32, "q": 88 <= med <= 93}[fq]
        if not ok:
            rep.add("WARN", "FRED", "빈도", sid, f"선언 빈도 {fq} vs 관측 간격 중앙값 {med:.0f}일")
    for r in fred_report or []:
        if r.get("status") == "fallback_cache":
            rep.add("WARN", "FRED", "업데이트", r["id"], f"다운로드 실패 → 로컬 캐시 사용 ({r.get('error', '')[:60]})")
        elif r.get("status") == "failed":
            rep.add("ERROR" if by_id.get(r["id"], {}).get("required") else "WARN", "FRED", "업데이트", r["id"], r.get("error", "")[:80])
        if r.get("revised"):
            rep.add("INFO", "FRED", "수정치(Revision)", r["id"], f"{r['revised']}개 과거 관측치 수정 감지 (최대 {r.get('revised_max_abs', 0):.4g})")
    got = [r["id"] for r in (vint_report or []) if str(r.get("status", "")).startswith("alfred")]
    miss = [r["id"] for r in (vint_report or []) if r.get("status") == "no_vintage"]
    if vint_report is not None:
        rep.add("INFO" if not miss else "WARN", "FRED", "빈티지(ALFRED as-of)", ", ".join(got) or "-",
                "기준일 시점 공개 데이터로 대체 완료" + (f" · 빈티지 없음 → 발표시차 규칙 적용: {', '.join(miss)}" if miss else ""))
    rep.add("INFO", "FRED", "발표시차 처리", "monthly/weekly", cfg.fred.get("lag_policy", ""))
    return rep


def validate_model(cfg, raw, final, info, P, ev_min, inc_final_calc, inc_final_check):
    rep = Report()
    for name, w in (("원 최적화", raw), ("최종 목표", final)):
        if w.isna().any():
            rep.add("ERROR", "Model", "NaN", name, "비중에 NaN")
        if (w < -1e-9).any():
            rep.add("ERROR", "Model", "음수 비중", name, ", ".join(w[w < -1e-9].index))
        if abs(float(w.sum()) - 1) > 1e-6:
            rep.add("ERROR", "Model", "비중 합계", name, f"합계 {w.sum():.6f}")
    sl, oc = cfg.sleeves, cfg.opt_class
    checks = [("단일 ETF", lambda w: float(w.max()), P["single"], "≤"), ("커버드콜", lambda w: float(w[sl["covered_call"]].sum()), P["cc_cap"], "≤"),
              ("크레딧", lambda w: float(w[sl["credit_risk"]].sum()), P["credit_cap"], "≤"), ("CLO AAA", lambda w: float(w[sl["clo_aaa"]].sum()), P["clo_aaa_cap"], "≤"),
              ("DBMF", lambda w: float(w[[k for k in w.index if oc[k] == "Alt"]].sum()), P["alt_cap"], "≤"),
              ("주식 하한", lambda w: float(w[sl["pure_equity"]].sum()), info["eq_min"], "≥"), ("방어 하한", lambda w: float(w[sl["defensive"]].sum()), info["def_min"], "≥")]
    for name, fn, lim, op in checks:
        for lbl, w, lvl in (("원 최적화", raw, "ERROR"), ("최종 목표", final, "WARN")):
            v = fn(w)
            bad = (v > lim + 1e-4) if op == "≤" else (v < lim - 1e-4)
            if bad:
                rep.add(lvl if not (lbl == "원 최적화" and info["status"] == "floors_dropped") else "WARN", "Model", f"제약 {name}", lbl,
                        f"{v:.2%} {op} {lim:.2%} 위반" + (" (밴드 유지분 영향)" if lbl == "최종 목표" else ""))
    rep.add("WARN" if ev_min < -1e-10 else "INFO", "Model", "공분산 PSD", f"{P['cov_win']}M", f"수축 후 최소 고유값 {ev_min:.2e}" + (" → 고유값 하한(1e-6)으로 보정" if ev_min < 1e-6 else ""))
    lvl = "INFO" if info["solver"] == "optimal" and info["status"] == "ok" else "WARN"
    rep.add(lvl, "Model", "최적화 수렴", "CLARABEL", f"solver={info['solver']} · status={info['status']}")
    if abs(inc_final_calc - inc_final_check) > 1e-9:
        rep.add("ERROR", "Model", "인컴 계산 검증", "final", f"{inc_final_calc:.6f} vs {inc_final_check:.6f}")
    else:
        rep.add("INFO", "Model", "인컴 계산 검증", "final", f"Σ(비중×TTM 수익률) 재계산 일치 {inc_final_calc:.4%}")
    return rep
