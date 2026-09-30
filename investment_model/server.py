"""Local backend for the dashboard. Binds to 127.0.0.1 only.  Run:  python server.py  (--no-browser)"""
import json, sys, threading, time, traceback, urllib.parse, uuid, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from qpm import SYSTEM_VERSION, MODEL_VERSION
from qpm.config import Config, jsonable, load_json
from qpm import pipeline
from qpm.history import History
from qpm.export import export_excel
from qpm.dashboard import TEMPLATE_NAME

JOBS = {}


def start_job(name, fn, **kw):
    jid = uuid.uuid4().hex[:8]
    job = dict(id=jid, name=name, status="running", log=[], error=None, result=None, validation=None, started=time.strftime("%H:%M:%S"))

    def log(msg):
        job["log"].append(f"[{time.strftime('%H:%M:%S')}] {msg}")

    def run():
        try:
            res = fn(log=log, **kw)
            job["result"] = ({"month": res["meta"]["month"], "status": res["meta"]["status"]} if name == "run" else res)
            job["status"] = "done"
            log("완료")
        except pipeline.ValidationError as e:
            job.update(status="error", error=str(e), validation=e.report)
            log(str(e))
        except Exception as e:
            job.update(status="error", error=f"{type(e).__name__}: {e}")
            log(traceback.format_exc()[-1500:])
    JOBS[jid] = job
    threading.Thread(target=run, daemon=True).start()
    return job


class Handler(BaseHTTPRequestHandler):
    server_version = "TAA-PM/" + SYSTEM_VERSION

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(jsonable(obj), ensure_ascii=False).encode("utf-8"))

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        cfg = Config()
        hist = History(cfg)
        try:
            if u.path in ("/", "/index.html", "/" + TEMPLATE_NAME):
                return self._send(200, (ROOT / "dashboard" / TEMPLATE_NAME).read_bytes(), "text/html; charset=utf-8")
            if u.path == "/api/status":
                lu_p = cfg.path("data_dir") / "_last_update.json"
                lu = load_json(lu_p) if lu_p.exists() else {}
                return self._json(dict(backend=True, system_version=SYSTEM_VERSION, model_version=MODEL_VERSION, fred_mode=cfg.settings.get("fred_mode"),
                                       use_alfred_vintage=cfg.settings.get("use_alfred_vintage"), fred_api_key=bool(cfg.env.get("FRED_API_KEY")),
                                       llm_key=bool(cfg.env.get("ANTHROPIC_API_KEY")), latest_month=hist.latest_month(),
                                       running=[j["name"] for j in JOBS.values() if j["status"] == "running"],
                                       last_update=dict(as_of=lu.get("as_of"), updated_at=lu.get("updated_at"), fred_mode=lu.get("fred_mode"))))
            if u.path == "/api/history":
                return self._json(hist.index())
            if u.path.startswith("/api/result/"):
                m = u.path.rsplit("/", 1)[-1]
                m = hist.latest_month() if m == "latest" else m
                res = hist.load_result(m) if m else None
                return self._json(res if res else {"error": "결과 없음"}, 200 if res else 404)
            if u.path.startswith("/api/jobs/"):
                j = JOBS.get(u.path.rsplit("/", 1)[-1])
                return self._json(j if j else {"error": "unknown job"}, 200 if j else 404)
            if u.path == "/api/validation/latest":
                p = cfg.path("output_dir") / "validation_latest.json"
                return self._json(load_json(p) if p.exists() else {})
            if u.path == "/api/export/excel":
                m = q.get("month") or hist.latest_month()
                res = hist.load_result(m)
                path = cfg.path("output_dir") / f"taa_pm_report_{m}_v1.0.xlsx"
                export_excel(res, path, hist.index())
                return self._send(200, path.read_bytes(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                  {"Content-Disposition": f'attachment; filename="{path.name}"'})
            return self._json({"error": "not found"}, 404)
        except Exception as e:
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        cfg = Config()
        try:
            n = int(self.headers.get("Content-Length") or 0)
            b = json.loads((self.rfile.read(n) if n else b"{}").decode("utf-8") or "{}")
            if u.path == "/api/config":
                mode = b.get("fred_mode")
                if mode not in ("api", "csv", "cache"):
                    return self._json({"error": "fred_mode는 api / csv / cache 중 하나"}, 400)
                if mode == "api" and not cfg.env.get("FRED_API_KEY"):
                    return self._json({"error": ".env에 FRED_API_KEY가 없습니다."}, 400)
                cfg.save_local_settings(fred_mode=mode)
                return self._json({"ok": True, "fred_mode": mode})
            if u.path.startswith("/api/jobs/"):
                name = u.path.rsplit("/", 1)[-1]
                if any(j["status"] == "running" for j in JOBS.values()):
                    return self._json({"error": "다른 작업이 실행 중입니다. 끝난 뒤 다시 시도하세요."}, 409)
                a = b.get("as_of") or None
                fns = {"update": (pipeline.update_data, dict(as_of=a, fred_mode=b.get("fred_mode") or None)),
                       "validate": (pipeline.validate, dict(as_of=a)),
                       "run": (pipeline.run_model, dict(as_of=a, current_basis=b.get("current_basis", "model"), llm=b.get("llm"))),
                       "walkforward": (pipeline.run_walkforward_job, dict(as_of=a, quick=bool(b.get("quick"))))}
                if name not in fns:
                    return self._json({"error": "unknown job"}, 404)
                fn, kw = fns[name]
                return self._json({"job_id": start_job(name, fn, **kw)["id"]})
            if u.path == "/api/actual":
                pv = b.get("portfolio_value")
                rb = pipeline.submit_actual(month=b.get("month"), csv_text=b.get("csv"), rows=b.get("rows"),
                                            pv_override=(float(pv) if pv not in (None, "") else None), extra_cash=float(b.get("extra_cash") or 0))
                return self._json(rb)
            return self._json({"error": "not found"}, 404)
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)


def main():
    cfg = Config()
    host, port = cfg.settings.get("server_host", "127.0.0.1"), int(cfg.settings.get("server_port", 8765))
    srv = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{host}:{port}/"
    print(f"TAA PM 대시보드: {url}   (종료: Ctrl+C)")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
