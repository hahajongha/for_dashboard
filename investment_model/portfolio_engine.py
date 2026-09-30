"""STEP ③~⑪ 검증 → 매크로 → 점수 → 리스크 → 최적화 → 다음 달 목표.
예) python portfolio_engine.py --update          (데이터 업데이트 후 실행, 기준일 자동)
    python portfolio_engine.py --as-of 2026-10-30  (저장된 데이터로 실행)"""
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from qpm.pipeline import update_data, run_model, ValidationError
ap = argparse.ArgumentParser()
ap.add_argument("--as-of"); ap.add_argument("--update", action="store_true"); ap.add_argument("--fred-mode", choices=["api", "csv", "cache"])
ap.add_argument("--basis", choices=["model", "actual"], default="model"); ap.add_argument("--llm", action="store_true")
a = ap.parse_args()
try:
    if a.update:
        r = update_data(as_of=a.as_of, fred_mode=a.fred_mode)
        a.as_of = a.as_of or r["as_of"]
    res = run_model(as_of=a.as_of, current_basis=a.basis, llm=(True if a.llm else None))
    print("목표 월:", res["meta"]["target_month"], "| 결과: history/" + res["meta"]["month"])
except ValidationError as e:
    print("검증 실패:")
    for i in e.report["items"]:
        if i["level"] == "ERROR":
            print(" -", i["area"], i["check"], i["target"], i["detail"])
    sys.exit(2)
