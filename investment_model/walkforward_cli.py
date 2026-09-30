"""연 1회 파라미터 재선정(제안만 저장).  예) python walkforward_cli.py [--quick]   (전체 그리드는 수 분 소요)"""
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from qpm.pipeline import run_walkforward_job
ap = argparse.ArgumentParser(); ap.add_argument("--as-of"); ap.add_argument("--quick", action="store_true"); a = ap.parse_args()
p = run_walkforward_job(as_of=a.as_of, quick=a.quick)
print("제안:", {k: p[k] for k in ("L", "cfg", "kappa", "lam")})
