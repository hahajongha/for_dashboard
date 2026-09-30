"""CI 데이터 가드 — 새로 받은 데이터(new)를 기존 정상 데이터(old)와 비교해 교체해도 되는지 판정합니다.

qpm/validation.py(패키지 검증)를 대체하지 않고 **추가로** 막습니다. 패키지 검증이 통과시키는 다음 경우를 잡습니다:
이력 잘림, proxy·XLF 결측, 과거 관측치 소실, FRED 행 수 감소·빈 파일, ALFRED 빈티지 누락.
모델 코드(qpm/)는 호출만 하고 수정하지 않습니다.
"""
from __future__ import annotations
import sys
from pathlib import Path

import numpy as np
import pandas as pd

FIELDS = ["adj_close", "close", "open", "high", "low", "volume", "dividends", "stock_splits"]


class Report:
    def __init__(self):
        self.items = []

    def add(self, level, area, msg):
        self.items.append(dict(level=level, area=area, msg=msg))

    @property
    def errors(self):
        return [i for i in self.items if i["level"] == "ERROR"]

    @property
    def warnings(self):
        return [i for i in self.items if i["level"] == "WARN"]

    def summary(self):
        return dict(status="FAIL" if self.errors else ("WARN" if self.warnings else "OK"),
                    errors=len(self.errors), warnings=len(self.warnings))


def _read_market(d: Path, f: str):
    p = d / "market" / f"{f}.csv.gz"
    return pd.read_csv(p, index_col=0, parse_dates=True) if p.exists() else None


def _read_series(p: Path):
    if not p.exists():
        return None
    df = pd.read_csv(p, index_col=0)
    try:
        df.index = pd.to_datetime(df.index, format="ISO8601")
    except (ValueError, TypeError):
        pass  # 날짜 인덱스가 아닌 파일(예: PFF 보유 종목)
    return df.iloc[:, 0] if df.shape[1] else pd.Series(dtype=float)


def expected_last_session(as_of):
    """as_of 이하의 마지막 NYSE 거래일 (패키지의 규칙 기반 달력 사용)."""
    from qpm.config import is_trading_day
    d = pd.Timestamp(as_of).normalize()
    while not is_trading_day(d):
        d -= pd.Timedelta(days=1)
    return d


def check_market(cfg, old: Path, new: Path, as_of, rep: Report):
    from qpm.config import business_days_between
    tickers = cfg.market_tickers()
    a = pd.Timestamp(as_of)
    for f in FIELDS:
        if not (new / "market" / f"{f}.csv.gz").exists():
            rep.add("ERROR", "market", f"{f}.csv.gz 파일 없음")
    adj_n, adj_o = _read_market(new, "adj_close"), _read_market(old, "adj_close")
    if adj_n is None:
        return
    # 날짜 인덱스
    if adj_n.index.has_duplicates:
        rep.add("ERROR", "market", "중복 날짜")
    if not adj_n.index.is_monotonic_increasing:
        rep.add("ERROR", "market", "날짜 정렬 오류")
    if (adj_n.index > a).any():
        # 모델은 as_of에서 잘라 쓰므로(.loc[:as_of]) 오류는 아님 — 자동 인식 기준일(90% 커버리지) 뒤의 부분 행
        rep.add("WARN", "market", f"기준일({a.date()}) 이후 행 {int((adj_n.index > a).sum())}개 (모델은 기준일까지만 사용)")
    # 티커 존재 (25 ETF + proxy + ^IRX + XLF)
    missing = [t for t in tickers if t not in adj_n.columns or adj_n[t].notna().sum() == 0]
    if missing:
        rep.add("ERROR", "market", f"데이터 없는 티커: {missing}")
    # 티커별 최신일
    exp = expected_last_session(a)
    for t in tickers:
        if t in missing or t not in adj_n.columns:
            continue
        last = adj_n[t].last_valid_index()
        lag = business_days_between(last, exp) if last < exp else 0
        if lag > 5:
            rep.add("ERROR", "market", f"{t} 최신일 {last.date()} (예상 {exp.date()}, {lag}영업일 지연)")
        elif lag >= 1 and t != "^IRX":
            rep.add("WARN", "market", f"{t} 최신일 {last.date()} (예상 {exp.date()})")
    # 기존 데이터와의 연속성 — 이력이 줄거나 과거 관측치가 사라지면 교체 금지
    if adj_o is not None and len(adj_o):
        if adj_n.index.min() != adj_o.index.min():
            rep.add("ERROR", "market", f"첫 날짜 변경 {adj_o.index.min().date()} → {adj_n.index.min().date()}")
        cut = min(adj_o.index.max(), a)
        o = adj_o.loc[:cut]
        if len(adj_n.loc[:cut]) < len(o):
            rep.add("ERROR", "market", f"행 수 감소 {len(o)} → {len(adj_n.loc[:cut])} (기존 구간)")
        lost = {}
        for t in o.columns.intersection(adj_n.columns):
            had = o[t].notna()
            now = adj_n[t].reindex(o.index).notna()
            k = int((had & ~now).sum())
            if k:
                lost[t] = k
        if lost:
            rep.add("ERROR", "market", f"과거 관측치 소실: {lost}")
        # 겹치는 구간 값 비교: Close는 분할 조정만 반영 → 새 분할이 없으면 거의 같아야 함
        cl_n, cl_o = _read_market(new, "close"), _read_market(old, "close")
        sp_n = _read_market(new, "stock_splits")
        if cl_n is not None and cl_o is not None:
            idx = cl_o.index.intersection(cl_n.index)
            for t in cl_o.columns.intersection(cl_n.columns):
                r = (cl_n.loc[idx, t] / cl_o.loc[idx, t]).replace([np.inf, -np.inf], np.nan).dropna()
                if r.empty:
                    continue
                dev = float((r - 1).abs().max())
                new_split = sp_n is not None and t in sp_n.columns and (sp_n.loc[sp_n.index > cl_o.index.max(), t].fillna(0) != 0).any()
                if dev > 0.05 and not new_split:
                    rep.add("ERROR", "market", f"{t} 과거 Close가 최대 {dev:.1%} 변경 (신규 분할 없음)")
                elif dev > 0.005:
                    rep.add("WARN", "market", f"{t} 과거 Close 최대 {dev:.2%} 재조정{' (신규 분할)' if new_split else ''}")
        idx = adj_o.index.intersection(adj_n.index)
        for t in adj_o.columns.intersection(adj_n.columns):
            r = (adj_n.loc[idx, t] / adj_o.loc[idx, t]).replace([np.inf, -np.inf], np.nan).dropna()
            if len(r) and float((r - 1).abs().max()) > 0.25:
                rep.add("ERROR", "market", f"{t} 과거 Adj Close가 최대 {float((r - 1).abs().max()):.1%} 변경")
    # 가격 이상치: 0 이하 가격, High < Low (최근 2년)
    cl, hi, lo = _read_market(new, "close"), _read_market(new, "high"), _read_market(new, "low")
    if cl is not None:
        px = cl.drop(columns=[c for c in cl.columns if c.startswith("^")])  # ^IRX는 금리(%)라 0 이하 가능
        if (px <= 0).any().any():
            rep.add("ERROR", "market", f"0 이하 종가: {[c for c in px.columns if (px[c] <= 0).any()]}")
    if hi is not None and lo is not None:
        h, l = hi.tail(504), lo.tail(504)
        bad = ((h < l) & h.notna() & l.notna()).sum()
        bad = {k: int(v) for k, v in bad.items() if v}
        if bad:
            rep.add("WARN", "market", f"High < Low 행 (최근 2년): {bad}")


def check_fred(cfg, old: Path, new: Path, as_of, rep: Report):
    tag = pd.Timestamp(as_of).strftime("%Y%m%d")
    for s in cfg.fred["series"]:
        sid = s["id"]
        n = _read_series(new / "fred" / f"{sid}.csv")
        o = _read_series(old / "fred" / f"{sid}.csv")
        lvl = "ERROR" if s.get("required") else "WARN"
        if n is None or n.dropna().empty:
            rep.add(lvl, "fred", f"{sid} 파일 없음 또는 0행")
            continue
        n = n.dropna()
        if n.index.has_duplicates:
            rep.add("ERROR", "fred", f"{sid} 중복 관측일")
        if o is not None and len(o.dropna()):
            o = o.dropna()
            if "3Y history" in (s.get("note") or ""):
                # ICE BofA OAS: FRED가 최근 3년만 제공(이동 창) → 첫 관측일이 매일 뒤로 밀리는 것이 정상.
                # 대신 이력 길이(약 3년)와 행 수가 크게 줄지 않았는지만 확인
                span = (n.index.max() - n.index.min()).days
                if span < 2.5 * 365:
                    rep.add(lvl, "fred", f"{sid} 이력 {span}일 — 3년 이동 창보다 짧음")
                if len(n) < 0.95 * len(o):
                    rep.add(lvl, "fred", f"{sid} 행 수 감소 {len(o)} → {len(n)}")
            else:
                if len(n) < len(o):
                    rep.add(lvl, "fred", f"{sid} 행 수 감소 {len(o)} → {len(n)}")
                if n.index.min() > o.index.min():
                    rep.add(lvl, "fred", f"{sid} 첫 관측일 늦어짐 {o.index.min().date()} → {n.index.min().date()}")
            if n.index.max() < o.index.max():
                rep.add(lvl, "fred", f"{sid} 최근 관측일 후퇴 {o.index.max().date()} → {n.index.max().date()}")
        if s.get("revisable"):
            v = _read_series(new / "alfred" / f"{sid}_{tag}.csv")
            if v is None or v.dropna().empty:
                rep.add("ERROR", "alfred", f"{sid} 빈티지({tag}) 없음 — look-ahead 통제 불가")
    ur = new / "fred" / "_update_report.json"
    if ur.exists():
        import json
        r = json.loads(ur.read_text(encoding="utf-8"))
        fb = [x["id"] for x in r.get("series", []) if x.get("status") not in ("csv", "api", "cache")]
        if fb:
            rep.add("WARN", "fred", f"다운로드 실패로 캐시 사용·실패: {fb}")


def check_all(cfg, old: Path, new: Path, as_of) -> Report:
    rep = Report()
    check_market(cfg, Path(old), Path(new), as_of, rep)
    check_fred(cfg, Path(old), Path(new), as_of, rep)
    ref = _read_series(Path(new) / "reference" / "PFF_top_holdings.csv")
    if ref is None or ref.empty:
        rep.add("WARN", "reference", "PFF 보유 상위 종목 없음")
    return rep


if __name__ == "__main__":  # 수동 점검: python scripts/ci_guards.py <old_data> <new_data> <as_of>
    pkg = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg))
    from qpm.config import Config
    r = check_all(Config(pkg), Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
    for i in r.items:
        print(i["level"], i["area"], i["msg"])
    print(r.summary())
