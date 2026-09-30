"""FRED 관측일·이용가능일·값 저장소 (point-in-time log, 추가 전용).

data/fred_pit/<ID>.csv  열: observation_date, value, available_from, available_basis, first_seen
  - observation_date : 관측 기준일 (FRED date)
  - value            : 그 시점에 받은 값
  - available_from   : 이 값을 투자 판단에 쓸 수 있는 가장 이른 날짜
  - available_basis  : available_from의 근거
        alfred_vintage   — ALFRED as-of 빈티지(키 불필요 경로)에 있던 값 → vintage_date 기준 공개 확인
        release_rule_est — config/fred_series.json의 통상 발표일 규칙(추정값, K-8)
        first_seen       — 수정치(revision): 처음 받은 날짜 (실제 공개일 이후임이 보장되는 보수적 값)
  - first_seen       : 이 (관측일, 값)을 처음 받은 날짜(UTC)

행은 지우거나 고치지 않고 추가만 합니다. 같은 관측일에 값이 바뀌면 새 행이 붙으므로 수정 이력이 남습니다.
관측일 t의 as-of 값 = available_from ≤ as_of 인 행 중 마지막 행.

범위: 일간 시리즈(금리·스프레드·VIX 등, 당일 종가 기준 공개)는 제외하고 주간·월간·분기 시리즈만 기록합니다.
모델(qpm/)은 이 저장소를 읽지 않습니다 — 모델의 look-ahead 통제는 기존 방식(ALFRED 빈티지 + 발표시차 규칙) 그대로입니다.
이 저장소를 백테스트에 쓰는 것은 methodology 변경이므로 사용자 승인 사항입니다 (CLAUDE.md §FRED [계획]).
"""
from __future__ import annotations
import datetime as dt
from pathlib import Path

import pandas as pd

COLS = ["observation_date", "value", "available_from", "available_basis", "first_seen"]


def release_estimate(obs: pd.Timestamp, s: dict) -> pd.Timestamp:
    """qpm/macro.py의 발표시차 규칙과 같은 근사. 추정값입니다."""
    f = s.get("freq")
    if f == "w":
        return obs + pd.Timedelta(days=int(s.get("weekly_lag_days") or 0) or 1)
    if f == "m":
        lag = int(s.get("lag_months") or 0)
        start = (obs + pd.offsets.MonthBegin(0)) if obs.day == 1 else obs.replace(day=1)
        base = start + pd.DateOffset(months=lag)
        rd = s.get("release_day")
        if rd:
            last = (base + pd.offsets.MonthEnd(0)).day
            return base + pd.Timedelta(days=min(int(rd), last) - 1)
        return base + pd.offsets.MonthEnd(0)
    if f == "q":
        qend = obs + pd.offsets.QuarterEnd(0)
        rd = s.get("release_day")
        return qend + pd.Timedelta(days=int(rd)) if rd else qend + pd.offsets.MonthEnd(int(s.get("lag_months") or 1))
    return obs + pd.offsets.BDay(1)


def _load(p: Path) -> pd.DataFrame:
    if p.exists():
        return pd.read_csv(p, dtype={"available_basis": str})
    return pd.DataFrame(columns=COLS)


def update(cfg, data_dir: Path, as_of, today: dt.date | None = None) -> dict:
    """data_dir(새로 받은 데이터)의 fred/·alfred/를 fred_pit/ 로그에 반영. 반환: 시리즈별 추가 행 수."""
    data_dir = Path(data_dir)
    today = pd.Timestamp(today or dt.datetime.now(dt.timezone.utc).date())
    tag = pd.Timestamp(as_of).strftime("%Y%m%d")
    out_dir = data_dir / "fred_pit"
    out_dir.mkdir(parents=True, exist_ok=True)
    added = {}
    for s in cfg.fred["series"]:
        if s.get("freq") == "d":
            continue
        sid = s["id"]
        latest_p = data_dir / "fred" / f"{sid}.csv"
        if not latest_p.exists():
            continue
        latest = pd.read_csv(latest_p, index_col=0, parse_dates=True).iloc[:, 0].dropna()
        vint_p = data_dir / "alfred" / f"{sid}_{tag}.csv"
        vint = pd.read_csv(vint_p, index_col=0, parse_dates=True).iloc[:, 0].dropna() if vint_p.exists() else None

        p = out_dir / f"{sid}.csv"
        log = _load(p)
        known = {}
        if len(log):
            lg = log.copy()
            lg["observation_date"] = pd.to_datetime(lg["observation_date"])
            known = lg.groupby("observation_date")["value"].last().to_dict()
        rows = []

        def push(obs, val, avail, basis):
            rows.append(dict(observation_date=obs.date().isoformat(), value=float(val),
                             available_from=pd.Timestamp(avail).date().isoformat(), available_basis=basis,
                             first_seen=today.date().isoformat()))
            known[obs] = float(val)

        # ① as-of 빈티지 값: 기준일(as_of)에 공개돼 있던 값
        if vint is not None:
            for obs, val in vint.items():
                prev = known.get(obs)
                if prev is None or abs(prev - float(val)) > 1e-9:
                    est = release_estimate(obs, s)
                    avail = min(est, pd.Timestamp(as_of)) if prev is None else pd.Timestamp(as_of)
                    push(obs, val, avail, "alfred_vintage")
        # ② 최신값: 처음 보는 관측치는 발표일 규칙(추정), 값이 바뀐 관측치는 수정치(first_seen)
        for obs, val in latest.items():
            prev = known.get(obs)
            if prev is None:
                est = release_estimate(obs, s)
                push(obs, val, max(est, obs), "release_rule_est")
            elif abs(prev - float(val)) > 1e-9:
                push(obs, val, today, "first_seen")
        if rows:
            new = pd.DataFrame(rows, columns=COLS)
            log = new if log.empty else pd.concat([log, new], ignore_index=True)
            log.to_csv(p, index=False)
        added[sid] = len(rows)
    return added


def as_of_view(p: Path, as_of) -> pd.Series:
    """as_of 시점에 실제로 알 수 있었던 값 (available_from ≤ as_of 인 마지막 행)."""
    log = pd.read_csv(p, parse_dates=["observation_date", "available_from"])
    log = log[log["available_from"] <= pd.Timestamp(as_of)]
    return log.groupby("observation_date")["value"].last().sort_index()
