"""골든(회귀) 테스트 — 2026-09-29 기준 재실행 결과가 기준값(tests/golden_2026-09.json)과 같은지 확인.
- 저장소를 임시 폴더에 복사해서 실행하므로 원본 history/·output/은 바뀌지 않습니다.
- 캐시(data/)와 ALFRED 빈티지(data/alfred/*_20260929.csv)만 사용 → 네트워크 불필요.
사용: python tests/check_golden.py"""
import json, pathlib, shutil, sys, tempfile
ROOT = pathlib.Path(__file__).resolve().parent.parent
tmp = pathlib.Path(tempfile.mkdtemp()) / "repo"
shutil.copytree(ROOT, tmp, ignore=shutil.ignore_patterns(".git", "__pycache__", "output"))
sys.path.insert(0, str(tmp))
from qpm.config import Config
from qpm.pipeline import run_model
G = json.loads((ROOT / "tests" / "golden_2026-09.json").read_text(encoding="utf-8"))
res = run_model(cfg=Config(tmp), as_of=G["as_of"], log=lambda m: None, make_html=False)
w = {r["ticker"]: r["target"] for r in res["portfolio"]["rows"]}
dw = max(abs(w[k] - v) for k, v in G["target"].items())
dm = max(abs(res["metrics"][k] - v) for k, v in G["metrics"].items())
ok = dw < 1e-6 and dm < 1e-6 and res["constraints"]["binding_order"] == G["binding_order"]
print(f"max |Δ target weight| = {dw:.2e} · max |Δ metric| = {dm:.2e} · binding order match = {res['constraints']['binding_order'] == G['binding_order']}")
print("GOLDEN TEST:", "PASS" if ok else "FAIL")
shutil.rmtree(tmp.parent, ignore_errors=True)
sys.exit(0 if ok else 1)
