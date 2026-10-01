"""실보유 평가용 최신 종가 — 데이터 갱신(data_only·model_run·monthly)이 통과할 때마다 output/latest_prices.json 작성.

대시보드 [실보유 입력] 표의 현재가·평가금액 모니터링에만 씁니다. 모델·목표 비중·리밸런싱 주문 계산은
모델 기준일(Data As Of) 종가를 그대로 씁니다 (qpm/ 변경 없음).
가격 = data/market/close.csv.gz 의 Close(분할 반영·분배 미반영 → 보유 수량 × 종가 = 평가금액), 기준일 이하 종목별 마지막 값.
모델의 가격(qpm/pipeline.py: ctx.P["close"] ffill 후 기준일 값)과 같은 열이라, 날짜가 같으면 값도 같습니다.

  python scripts/latest_prices.py [data_dir] [as_of]   # 수동 생성 (기본: 패키지 data/, 데이터 마지막 날짜)
"""
from __future__ import annotations
import datetime as dt
import json
import sys
from pathlib import Path

import pandas as pd


def build(cfg, data_dir: Path, as_of, out_path: Path, log=print) -> dict:
    close = pd.read_csv(Path(data_dir) / "market" / "close.csv.gz", index_col=0, parse_dates=True)
    if as_of:
        close = close.loc[:pd.Timestamp(as_of)]
    prices = {}
    for t in cfg.tickers:
        if t not in close.columns:
            continue
        s = close[t].dropna()
        s = s[s > 0]
        if s.empty:
            continue
        prices[t] = {"close": float(s.iloc[-1]), "date": str(s.index[-1].date())}
    if not prices:
        raise ValueError("유니버스 종목의 종가가 없습니다")
    date = max(v["date"] for v in prices.values())
    lagging = sorted(t for t, v in prices.items() if v["date"] < date)
    missing = [t for t in cfg.tickers if t not in prices]
    out = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "as_of": str(pd.Timestamp(as_of).date()) if as_of else date,
        "date": date,
        "source": "yfinance Close (data/market/close.csv.gz)",
        "note": "실보유 평가 모니터링 전용. 모델·목표·주문 계산은 모델 기준일(Data As Of) 종가를 씁니다.",
        "prices": prices,
    }
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"latest_prices.json: {len(prices)}종목 · {date}" + (f" · 늦은 종목 {lagging}" if lagging else "") + (f" · 없음 {missing}" if missing else ""))
    return {"date": date, "tickers": len(prices), "lagging": lagging, "missing": missing}


if __name__ == "__main__":
    pkg = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg))
    from qpm.config import Config
    data = Path(sys.argv[1]) if len(sys.argv) > 1 else pkg / "data"
    print(build(Config(pkg), data, sys.argv[2] if len(sys.argv) > 2 else None, pkg / "output" / "latest_prices.json"))
