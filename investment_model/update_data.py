"""STEP ①② yfinance + FRED 업데이트.  예) python update_data.py            (기준일 자동 인식)
                                     python update_data.py --as-of 2026-10-30 --fred-mode csv"""
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from qpm.pipeline import update_data
ap = argparse.ArgumentParser(); ap.add_argument("--as-of"); ap.add_argument("--fred-mode", choices=["api", "csv", "cache"])
a = ap.parse_args()
r = update_data(as_of=a.as_of, fred_mode=a.fred_mode)
print("Data As Of:", r["as_of"])
