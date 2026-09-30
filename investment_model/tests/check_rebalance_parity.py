"""대시보드 JS 주문 엔진 ↔ qpm/rebalance.py 동일성 테스트 (Node 필요).
입력: history/2026-09/result.json + sample/actual_portfolio_sample.csv(가상 보유). 파일을 쓰지 않습니다.
사용: python tests/check_rebalance_parity.py"""
import json, pathlib, shutil, subprocess, sys, tempfile
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import pandas as pd
from qpm.config import Config, load_json
from qpm.rebalance import parse_actual_csv, normalize_actual, compare
cfg, P = Config(ROOT), None
P = cfg.engine_params()
res = load_json(ROOT / "history" / "2026-09" / "result.json")
csv_text = (ROOT / "sample" / "actual_portfolio_sample.csv").read_text(encoding="utf-8")
rows = {r["ticker"]: r for r in res["portfolio"]["rows"]}
lp = {k: v["price"] for k, v in rows.items()}
beta = {k: (v["beta_eq"] or 0.0) for k, v in rows.items()}
dur = {k: (v["duration"] or 0.0) for k, v in rows.items()}
df, pv, _ = normalize_actual(parse_actual_csv(csv_text), cfg, lp)
py = compare(cfg, pd.Series({k: v["target"] for k, v in rows.items()}), df, pv, P["band"], P["tc_bps"], beta, dur, lp)
html = (ROOT / "dashboard" / "taa_pm_dashboard_v1.0.html").read_text(encoding="utf-8")
a, b = html.index("// ==== REBALANCE ENGINE START ===="), html.index("// ==== REBALANCE ENGINE END ====")
tmp = pathlib.Path(tempfile.mkdtemp())
(tmp / "rb.js").write_text(html[a:b] + "\nmodule.exports = RB;\n", encoding="utf-8")
(tmp / "res.json").write_text(json.dumps(res), encoding="utf-8")
(tmp / "act.csv").write_text(csv_text, encoding="utf-8")
(tmp / "t.js").write_text("""const fs=require('fs'),d=process.argv[2];const RB=require(d+'/rb.js');const R=JSON.parse(fs.readFileSync(d+'/res.json','utf8'));
const rows=RB.parseCSV(fs.readFileSync(d+'/act.csv','utf8'));const lp={},tg={},beta={},dur={};
R.portfolio.rows.forEach(r=>{lp[r.ticker]=r.price;tg[r.ticker]=r.target;beta[r.ticker]=r.beta_eq||0;dur[r.ticker]=r.duration||0;});
const n=RB.normalize(rows,R.universe.tickers,lp,null,0);
console.log(JSON.stringify(RB.compare(R.universe,tg,n.df,n.pv,R.meta.params.band,R.meta.params.tc_bps,beta,dur,lp)));""", encoding="utf-8")
out = subprocess.run(["node", str(tmp / "t.js"), str(tmp)], capture_output=True, text=True)
shutil.rmtree(tmp, ignore_errors=True)
if out.returncode:
    print(out.stderr); sys.exit(1)
js = json.loads(out.stdout)
pr = {r["ticker"]: r for r in py["rows"]}
d_amt = max(abs(r["trade_amount"] - pr[r["ticker"]]["trade_amount"]) for r in js["rows"])
mis = sum((r["action"] != pr[r["ticker"]]["action"]) + (r["trade_shares"] != pr[r["ticker"]]["trade_shares"]) for r in js["rows"])
d_tot = max(abs(js["totals"][k] - py["totals"][k]) for k in ("total_buy", "total_sell", "net_cash_requirement", "est_cost", "turnover"))
d_exp = max(abs(x["actual"] - y["actual"]) + abs(x["post"] - y["post"]) for x, y in zip(js["exposure_risk"] + js["exposure_class"], py["exposure_risk"] + py["exposure_class"]))
ok = d_amt < 1e-6 and mis == 0 and d_tot < 1e-6 and d_exp < 1e-9 and len(js["rows"]) == len(py["rows"])
print(f"rows {len(js['rows'])}/{len(py['rows'])} · max|Δamount| {d_amt:.2e} · action/share mismatches {mis} · max|Δtotals| {d_tot:.2e} · max|Δexposure| {d_exp:.2e}")
print("PARITY TEST:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
