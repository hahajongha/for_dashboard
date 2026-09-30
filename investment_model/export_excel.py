"""STEP ⑮ Excel 내보내기.  예) python export_excel.py [--month 2026-10]"""
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from qpm.config import Config
from qpm.history import History
from qpm.export import export_excel, export_csv_bundle
ap = argparse.ArgumentParser(); ap.add_argument("--month"); a = ap.parse_args()
cfg = Config(); h = History(cfg); m = a.month or h.latest_month(); res = h.load_result(m)
p = export_excel(res, cfg.path("output_dir") / f"taa_pm_report_{m}_v1.0.xlsx", h.index())
files = export_csv_bundle(res, cfg.path("output_dir") / f"csv_{m}")
print("Excel:", p); print("CSV:", ", ".join(str(v.name) for v in files.values()))
