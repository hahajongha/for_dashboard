"""STEP ⑫~⑭ 실보유 CSV → Target 비교 → 주문.  예) python rebalance_cli.py --actual my_holdings.csv [--month 2026-10] [--pv 1000000]"""
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from qpm.pipeline import submit_actual
ap = argparse.ArgumentParser(); ap.add_argument("--actual", required=True); ap.add_argument("--month"); ap.add_argument("--pv", type=float); ap.add_argument("--extra-cash", type=float, default=0.0)
a = ap.parse_args()
rb = submit_actual(month=a.month, csv_text=Path(a.actual).read_text(encoding="utf-8-sig"), pv_override=a.pv, extra_cash=a.extra_cash)
t = rb["totals"]
print(f"매수 {t['n_buy']}건 {t['total_buy']:,.0f} | 매도 {t['n_sell']}건 {t['total_sell']:,.0f} | 순현금 필요 {t['net_cash_requirement']:,.0f} | 회전율 {t['turnover']:.1%}")
for r in rb["rows"]:
    if r["action"] != "HOLD":
        print(f"  {r['action']:5s} {r['ticker']:5s} {r['actual']:.2%} → {r['target']:.2%}  {r['trade_amount']:,.0f}")
