"""CI용 골든 테스트 — 현재 코드 + v1.0 고정 데이터로 tests/check_golden.py, check_rebalance_parity.py 실행.

데이터(data/, history/)는 CI가 계속 갱신하므로, 원본 v1.0 패키지(tests/fixtures/taa_pm_repo_v1.0.zip)의
data/·history/·params/ 를 임시 복사본에 넣고 테스트합니다. 테스트 파일과 모델 코드는 수정하지 않습니다.
  python scripts/golden_ci.py            # 둘 다
  python scripts/golden_ci.py --no-parity
"""
from __future__ import annotations
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

PKG = Path(__file__).resolve().parents[1]
FIXTURE = PKG / "tests" / "fixtures" / "taa_pm_repo_v1.0.zip"
FROZEN = ("data/", "history/", "params/")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-parity", action="store_true")
    a = ap.parse_args(argv)
    with tempfile.TemporaryDirectory(prefix="taa_golden_") as tmp:
        root = Path(tmp) / "pkg"
        shutil.copytree(PKG, root, ignore=shutil.ignore_patterns(".git", "__pycache__", "fixtures", "data", "history", "params", "output"))
        with zipfile.ZipFile(FIXTURE) as z:
            for n in z.namelist():
                rel = n.split("/", 1)[1] if "/" in n else ""
                if rel.startswith(FROZEN) and not n.endswith("/"):
                    dst = root / rel
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    dst.write_bytes(z.read(n))
        (root / "output").mkdir(exist_ok=True)
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        tests = ["tests/check_golden.py"] + ([] if a.no_parity else ["tests/check_rebalance_parity.py"])
        rc = 0
        for t in tests:
            print(f"== {t}", flush=True)
            rc |= subprocess.run([sys.executable, str(root / t)], cwd=root, env=env).returncode
    return rc


if __name__ == "__main__":
    sys.exit(main())
