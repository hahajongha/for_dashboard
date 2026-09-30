"""Embed a run result into the dashboard HTML (static / offline mode)."""
from __future__ import annotations
import json
from .config import jsonable

TEMPLATE_NAME = "taa_pm_dashboard_v1.0.html"
START = '<script id="seed-data" type="application/json">'
END = "</script><!--/seed-data-->"


def embed(html, result, index=None):
    payload = json.dumps(jsonable({"result": result, "index": index}), ensure_ascii=False).replace("</", "<\\/")
    i = html.index(START) + len(START)
    j = html.index(END, i)
    return html[:i] + payload + html[j:]


def write_dashboard(cfg, result, index=None, out=None):
    tpl = cfg.root / "dashboard" / TEMPLATE_NAME
    if not tpl.exists():
        return None
    out = out or cfg.path("output_dir") / TEMPLATE_NAME.replace(".html", "_latest.html")
    out.write_text(embed(tpl.read_text(encoding="utf-8"), result, index), encoding="utf-8")
    return out
