"""GitHub Actions 실행 진입점 — 데이터 업데이트 → 검증 → (월간/요청 시) 모델 실행 → status.json.

  python scripts/ci_run.py --task data_only  [--as-of YYYY-MM-DD]
  python scripts/ci_run.py --task model_run  [--as-of YYYY-MM-DD] [--force]
  python scripts/ci_run.py --task monthly                         (as_of = 직전 월 마지막 NYSE 거래일, K-2)

원칙
- 모델 계산 코드(qpm/)는 수정하지 않고 CLI(update_data.py, portfolio_engine.py)를 호출만 합니다.
- 모든 작업은 패키지의 **임시 복사본**에서 합니다. 업데이트·가드·패키지 검증·모델 실행이 모두 통과한 경우에만
  data/·history/·output/ 을 교체합니다. 실패하면 기존 정상 데이터는 그대로이고 output/status.json 만 갱신합니다.
- FRED는 키 없는 CSV 경로(fred_mode=csv)를 씁니다. API 키를 쓰지 않으므로 키가 결과 파일에 섞일 수 없습니다.
- 마감된 월(history/<월>/result.json, source=live)은 --force 없이 덮어쓰지 않습니다 (K-4).
- 실보유(actual)가 결과에 들어 있으면 교체하지 않습니다 (K-3).
종료 코드: 0 성공·건너뜀, 1 실패.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PKG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PKG))
sys.path.insert(0, str(PKG / "scripts"))

from qpm.config import Config, last_trading_day_of_month, month_key  # noqa: E402
import ci_guards  # noqa: E402
import fred_pit  # noqa: E402
import peers  # noqa: E402

REPO = os.environ.get("GITHUB_REPOSITORY", "hahajongha/for_dashboard")
WORKFLOW_URL = f"https://github.com/{REPO}/actions/workflows/update-investment-data.yml"
IGNORE = shutil.ignore_patterns(".git", "__pycache__", "*.pyc", "fixtures", "*.xlsx", "csv_*", ".env", "settings.local.json")
UPDATE_TIMEOUT = int(os.environ.get("TAA_UPDATE_TIMEOUT", "1800"))
MODEL_TIMEOUT = int(os.environ.get("TAA_MODEL_TIMEOUT", "900"))


def log(msg):
    print(f"[ci_run] {msg}", flush=True)


def now_utc():
    return dt.datetime.now(dt.timezone.utc)


def monthly_as_of(today: dt.date):
    """직전 월 마지막 NYSE 거래일 (예: 2026-11-02 실행 → 2026-10-30)."""
    y, m = (today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1)
    return last_trading_day_of_month(y, m)


def run(cmd, cwd, timeout):
    log("$ " + " ".join(str(c) for c in cmd))
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONUNBUFFERED="1")
    p = subprocess.run(cmd, cwd=cwd, env=env, timeout=timeout, capture_output=True, text=True)
    tail = (p.stdout + p.stderr)[-4000:]
    print(tail, flush=True)
    return p.returncode, tail


def _redact(s: str) -> str:
    return re.sub(r"(api_key=)[^&\s\"']+", r"\1***", s or "")


def data_dates(pkg: Path) -> dict:
    """현재 공개된(교체 후) 데이터의 기준 날짜들."""
    out = {}
    try:
        m = json.loads((pkg / "data" / "market" / "_meta.json").read_text(encoding="utf-8"))
        out["market_data_date"] = m.get("last_date")
        out["market_downloaded_at"] = m.get("downloaded_at")
    except Exception:
        pass
    try:
        r = json.loads((pkg / "data" / "fred" / "_update_report.json").read_text(encoding="utf-8"))
        lasts = [s.get("last") for s in r.get("series", []) if s.get("last")]
        out["macro_data_date"] = max(lasts) if lasts else None
        out["macro_updated_at"] = r.get("updated_at")
    except Exception:
        pass
    try:
        lu = json.loads((pkg / "data" / "_last_update.json").read_text(encoding="utf-8"))
        out["data_as_of"] = lu.get("as_of")
        vr = lu.get("vintage_report") or []
        out["alfred_vintages"] = sum(1 for v in vr if str(v.get("status", "")).startswith("alfred"))
    except Exception:
        pass
    try:
        lt = json.loads((pkg / "output" / "latest.json").read_text(encoding="utf-8"))["meta"]
        out["model"] = {k: lt.get(k) for k in ("month", "data_as_of", "rebalance_date", "target_month", "status", "run_at")}
    except Exception:
        pass
    return out


def write_status(pkg: Path, st: dict):
    p = pkg / "output" / "status.json"
    prev = {}
    if p.exists():
        try:
            prev = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            prev = {}
    st.update(data_dates(pkg))
    st["workflow_url"] = WORKFLOW_URL
    if os.environ.get("GITHUB_RUN_ID"):
        st["run_url"] = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{REPO}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    if st["status"] == "success":
        st["last_success_at"] = st["updated_at"]
    else:
        st["last_success_at"] = prev.get("last_success_at")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(_redact(json.dumps(st, ensure_ascii=False, indent=1)), encoding="utf-8")
    log(f"status.json: {st['status']} — {st.get('message', '')}")


def swap_dir(src: Path, dst: Path):
    """dst를 src 내용으로 교체. 새 디렉터리를 옆에 먼저 복사한 뒤 이름을 바꿉니다."""
    tmp_new = dst.with_name(dst.name + ".__new")
    tmp_old = dst.with_name(dst.name + ".__old")
    for t in (tmp_new, tmp_old):
        if t.exists():
            shutil.rmtree(t)
    shutil.copytree(src, tmp_new, ignore=IGNORE)
    if dst.exists():
        os.replace(dst, tmp_old)
    os.replace(tmp_new, dst)
    if tmp_old.exists():
        shutil.rmtree(tmp_old)


def publish_checks(work: Path) -> list[str]:
    """교체 전 결과물 점검: 실보유 미포함(K-3), 키 문자열 미포함."""
    errs = []
    lt = work / "output" / "latest.json"
    if lt.exists():
        j = json.loads(lt.read_text(encoding="utf-8"))
        if (j.get("actual") or {}).get("provided"):
            errs.append("latest.json에 실보유(actual)가 들어 있음 (K-3)")
        if j.get("rebalance"):
            errs.append("latest.json에 리밸런싱 주문(실보유 기반)이 들어 있음 (K-3)")
    for d in ("data", "history", "output"):
        for f in (work / d).rglob("*"):
            if f.is_file() and f.suffix in (".json", ".html", ".csv", ".md"):
                t = f.read_text(encoding="utf-8", errors="ignore")
                if "api_key=" in t and not re.search(r"api_key=\*\*\*", t):
                    errs.append(f"{f.relative_to(work)}에 api_key 문자열")
    for f in (work / "history").glob("*/actual_portfolio.csv"):
        errs.append(f"{f.relative_to(work)} 존재 (K-3)")
    return errs


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", choices=["data_only", "model_run", "monthly"], required=True)
    ap.add_argument("--as-of", default="")
    ap.add_argument("--force", action="store_true", help="마감된 월도 다시 계산 (K-4 보호 해제)")
    a = ap.parse_args(argv)

    t0 = time.time()
    st = dict(task=a.task, updated_at=now_utc().isoformat(timespec="seconds"), status="failed", message="",
              guards=None, validation=None, model_ran=False)
    as_of = a.as_of.strip() or None
    if as_of and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", as_of):
        st["message"] = f"as_of 형식 오류: {as_of!r} (YYYY-MM-DD)"
        write_status(PKG, st)
        return 1
    if a.task == "monthly":
        as_of = monthly_as_of(now_utc().date()).isoformat()
        log(f"월간 실행 기준일 = 직전 월 마지막 거래일 {as_of}")
    run_model = a.task in ("model_run", "monthly")

    # 마감 월 보호(K-4): 모델을 돌릴 월이 이미 live로 기록돼 있으면 건너뜀
    if run_model and as_of and not a.force:
        rj = PKG / "history" / month_key(as_of) / "result.json"
        if rj.exists():
            src = json.loads(rj.read_text(encoding="utf-8")).get("meta", {}).get("source")
            if src == "live":
                st.update(status="skipped", message=f"history/{month_key(as_of)} 가 이미 있습니다 (마감 월 보호, --force로 재계산)")
                write_status(PKG, st)
                return 0

    with tempfile.TemporaryDirectory(prefix="taa_ci_") as tmp:
        work = Path(tmp) / "pkg"
        shutil.copytree(PKG, work, ignore=IGNORE)
        (work / "config" / "settings.local.json").write_text(json.dumps({"fred_mode": "csv"}), encoding="utf-8")
        py = sys.executable

        # ①② 데이터 업데이트 (임시 복사본)
        cmd = [py, str(work / "update_data.py"), "--fred-mode", "csv"] + (["--as-of", as_of] if as_of else [])
        try:
            rc, tail = run(cmd, work, UPDATE_TIMEOUT)
        except subprocess.TimeoutExpired:
            rc, tail = 124, f"timeout {UPDATE_TIMEOUT}s"
        if rc != 0:
            st["message"] = "데이터 다운로드 실패: " + _redact(tail.strip().splitlines()[-1] if tail.strip() else f"exit {rc}")
            write_status(PKG, st)
            return 1
        lu = json.loads((work / "data" / "_last_update.json").read_text(encoding="utf-8"))
        as_of = as_of or lu["as_of"]
        st["as_of"] = as_of

        cfg = Config(work)
        # 가드: 기존 정상 데이터(PKG/data)와 비교
        rep = ci_guards.check_all(cfg, PKG / "data", work / "data", as_of)
        st["guards"] = dict(**rep.summary(), items=rep.items[:60])
        for i in rep.items:
            log(f"guard {i['level']} [{i['area']}] {i['msg']}")
        if rep.errors:
            st["message"] = f"데이터 가드 실패 {len(rep.errors)}건 — 기존 데이터 유지"
            write_status(PKG, st)
            return 1

        # ③ 패키지 데이터 검증 (qpm.pipeline.validate)
        code = ("import json,sys; sys.path.insert(0, sys.argv[1]); from qpm.config import Config; "
                "from qpm.pipeline import validate; r = validate(Config(sys.argv[1]), as_of=sys.argv[2], log=lambda *a: None); "
                "print('@@'+json.dumps({'summary': r['summary'], 'items': [i for i in r.get('items', []) if i.get('level') in ('ERROR','WARN')][:40]}, ensure_ascii=False))")
        rc, tail = run([py, "-c", code, str(work), as_of], work, MODEL_TIMEOUT)
        m = re.search(r"@@(\{.*\})", tail)
        val = json.loads(m.group(1)) if m else None
        st["validation"] = val
        if rc != 0 or not val or val["summary"].get("errors", 1):
            st["message"] = "데이터 검증 오류 — 기존 데이터 유지"
            write_status(PKG, st)
            return 1

        # 관측일·이용가능일 로그 (추가 전용)
        added = fred_pit.update(cfg, work / "data", as_of)
        log(f"fred_pit 추가 행: {sum(added.values())}")

        # Peer 비교 가격 (모델과 무관, 실패해도 파이프라인은 계속 — 기존 peer 데이터 유지)
        st["peers"] = peers.update_prices(work, work / "data", as_of, log=log)

        # ④~⑪ 모델 실행
        if run_model:
            month = month_key(as_of)
            rj = work / "history" / month / "result.json"
            if rj.exists() and not a.force:
                src = json.loads(rj.read_text(encoding="utf-8")).get("meta", {}).get("source")
                if src == "live":
                    run_model = False
                    st["message"] = f"history/{month} 가 이미 있어 모델은 건너뜀 (마감 월 보호). "
            if run_model:
                try:
                    rc, tail = run([py, str(work / "portfolio_engine.py"), "--as-of", as_of], work, MODEL_TIMEOUT)
                except subprocess.TimeoutExpired:
                    rc, tail = 124, f"timeout {MODEL_TIMEOUT}s"
                if rc != 0:
                    st["message"] = ("모델 검증 실패(ValidationError)" if rc == 2 else "모델 실행 실패") + " — 기존 데이터·결과 유지"
                    st["model_log_tail"] = _redact(tail[-1500:])
                    write_status(PKG, st)
                    return 1
                st["model_ran"] = True

        # Peer 비교 지표 (모델 결과가 바뀐 경우 그 결과 기준)
        try:
            peers.build(Config(work), work / "data", work / "output" / "peers.json", as_of, log=log)
            st["peers"]["build"] = "ok"
        except Exception as e:
            st["peers"]["build"] = f"failed: {str(e)[:120]}"
            log(f"peers.json 생성 실패 (기존 파일 유지): {e}")

        errs = publish_checks(work)
        if errs:
            st["message"] = "게시 전 점검 실패: " + "; ".join(errs)
            write_status(PKG, st)
            return 1

        # 교체: 모든 단계를 통과한 경우에만
        swap_dir(work / "data", PKG / "data")
        if st["peers"].get("build") == "ok":
            shutil.copy2(work / "output" / "peers.json", PKG / "output" / "peers.json")
        if st["model_ran"]:
            swap_dir(work / "history", PKG / "history")
            for f in ("latest.json", "taa_pm_dashboard_v1.0_latest.html"):
                shutil.copy2(work / "output" / f, PKG / "output" / f)

    st["status"] = "success"
    st["message"] = (st["message"] + ("데이터 + 모델 갱신" if st["model_ran"] else "데이터 갱신")).strip()
    st["runtime_sec"] = round(time.time() - t0, 1)
    write_status(PKG, st)
    return 0


if __name__ == "__main__":
    sys.exit(main())
