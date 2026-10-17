/* Knowledge Graph — for_kg 연구 지식 Vault 뷰어 (dashboards/kg.html)
 *
 * 데이터: 비공개 저장소 for_kg 의 vault/_build/graph.json 을 열람용 PAT로 GitHub API에서 직접 읽는다.
 *        노트 전문(vault/_build/notes/<id>.json)은 사용자가 노드를 열 때만 받는다 (최소 컨텍스트).
 *        공개 저장소(for_dashboard)에는 이 화면 코드만 있고 데이터는 없다.
 *
 * 물리엔진: 노드 = 질점(질량 = 1 + 0.15·연결 수), 모든 노드 쌍에 척력, 간선 = 스프링(관계 유형별 자연 길이 L·강성 k).
 *   장력 T = k·(d − L)
 *     T > 0  늘어남: 다른 힘 때문에 자연 길이보다 멀어진 연결 (두 노드를 당기는 중)
 *     T < 0  눌림  : 자연 길이보다 가까이 붙들린 연결 (예: 충돌 관계인데 인용·같은 방법론이 끌어당김)
 *     표시값(소수 둘째 자리)이 0.00 이면 '평형'
 *   노드 응력 = 보이는(필터로 숨기지 않은) 간선 |T| 의 합. 장력은 진위가 아니라 연결·보완·충돌·공백을 찾기 위한 표시다.
 */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const API = "https://api.github.com";
  const KEY = { token: "kg.token", repo: "kg.repo", ui: "kg.ui", theme: "theme" };
  const DEFAULT_REPO = { owner: "hahajongha", repo: "for_kg", ref: "" };

  const storage = (kind) => ({
    get(k) { try { return window[kind].getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window[kind].setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { window[kind].removeItem(k); } catch (e) { /* 저장소 차단 */ } },
  });
  const ss = storage("sessionStorage"), ls = storage("localStorage");

  /* ---------- 간선 묶음·스타일·스프링 ---------- */
  const GROUPS = [
    { id: "complement", label: "보완", keys: ["extends", "supports"], sample: "supports" },
    { id: "method", label: "같은 방법론", keys: ["same_method"] },
    { id: "conflict", label: "충돌", keys: ["challenges", "refutes"], sample: "refutes" },
    { id: "cites", label: "인용", keys: ["cites"] },
    { id: "similar", label: "유사도", keys: ["similar"] },
    { id: "gap", label: "공백", keys: ["gap"] },
  ];
  // color: pos(보완·파랑) / neg(충돌·빨강) / neu(가운데 회색) / muted(보조 회색). 극성 안의 유형은 선 모양으로 구분.
  const ESTYLE = {
    extends:     { color: "pos", dash: [],     w: 2.2, arrow: true,  label: "확장" },
    supports:    { color: "pos", dash: [7, 5], w: 2.2, arrow: true,  label: "지지" },
    same_method: { color: "neu", dash: [2, 4], w: 2.0, arrow: false, label: "같은 방법론" },
    challenges:  { color: "neg", dash: [7, 5], w: 2.2, arrow: true,  label: "한계 제기" },
    refutes:     { color: "neg", dash: [],     w: 2.6, arrow: true,  label: "반박" },
    cites:       { color: "muted", dash: [],   w: 1.2, arrow: true,  label: "인용" },
    similar:     { color: "muted", dash: [],   w: 1.0, arrow: false, label: "유사도" },
    gap:         { color: "muted", dash: [3, 4], w: 1.2, arrow: true, label: "공백 문헌 인용" },
  };
  const SPRING = { // 자연 길이(px)·강성. 충돌은 자연 길이가 길어 다른 연결과 겨루며 장력이 생긴다
    extends: { L: 150, k: 0.05 }, supports: { L: 150, k: 0.05 }, same_method: { L: 175, k: 0.035 },
    challenges: { L: 280, k: 0.035 }, refutes: { L: 320, k: 0.045 },
    cites: { L: 200, k: 0.025 }, similar: { L: 240, k: 0.02 }, gap: { L: 120, k: 0.03 },
  };
  const PHYS = { repulse: 7000, gravity: 0.015, damp: 0.85, maxV: 24 };
  const AREA_ORDER = ["portfolio-theory", "asset-pricing", "active-management", "fixed-income", "credit", "currency", "macro", "econometrics"];
  const SHAPES = ["circle", "square", "diamond", "triangle", "hexagon", "triangleDown", "pentagon", "octagon"];
  const CONF = { high: "높음", medium: "중간", low: "낮음" };
  const ACCESS = { private: "비공개 (열람 토큰 보유자만)", shareable: "교환 가능 (요약·키워드 캡슐)" };

  const S = {
    token: null, repo: { ...DEFAULT_REPO }, graph: null,
    nodes: [], edges: [], byId: new Map(), edgeById: new Map(), detail: new Map(),
    sel: null, hover: null, tab: "sel",
    filters: Object.fromEntries(GROUPS.map((g) => [g.id, true])), tension: true, search: "", hits: null,
    view: { cx: 0, cy: 0, k: 1 }, size: { w: 0, h: 0, dpr: 1 }, ctx: null, colors: null, font: "sans-serif",
    running: false, calm: 0, steps: 0, fitted: false, drag: null, pointers: new Map(), loadSeq: 0, tip: null,
    ptr: null, panelView: "", notice: "",
  };
  const TOKEN_RE = /^github_pat_[A-Za-z0-9_]{20,}$/; // 읽기 전용 fine-grained PAT 만
  const reduceMotion = (() => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } })();

  /* ---------- DOM 도우미 (데이터는 항상 textContent) ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }
  const svgNS = "http://www.w3.org/2000/svg";
  function lineKey(sk) { // 범례·칩용 선 견본
    const st = ESTYLE[sk], svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "26"); svg.setAttribute("height", "10"); svg.setAttribute("aria-hidden", "true");
    const ln = document.createElementNS(svgNS, "line");
    Object.entries({ x1: 1, y1: 5, x2: st.arrow ? 19 : 25, y2: 5, "stroke-width": Math.max(1.5, st.w) }).forEach(([k, v]) => ln.setAttribute(k, v));
    ln.style.stroke = `var(--${st.color === "muted" ? "edge-muted" : st.color})`;
    if (st.dash.length) ln.setAttribute("stroke-dasharray", st.dash.map((d) => d * 0.7).join(" "));
    svg.append(ln);
    if (st.arrow) {
      const p = document.createElementNS(svgNS, "path");
      p.setAttribute("d", "M18 1.5 L25 5 L18 8.5 Z"); p.style.fill = ln.style.stroke; svg.append(p);
    }
    return svg;
  }
  function shapeKey(shape, dashed) {
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "14"); svg.setAttribute("height", "14"); svg.setAttribute("viewBox", "-7 -7 14 14"); svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(svgNS, "path");
    p.setAttribute("d", shapeD(shape, 0, 0, 5.5)); p.style.fill = "var(--surface)";
    p.style.stroke = dashed ? "var(--edge-muted)" : "var(--ink-2)"; p.setAttribute("stroke-width", "1.4");
    if (dashed) p.setAttribute("stroke-dasharray", "2 2");
    svg.append(p); return svg;
  }

  /* ---------- 모양 ---------- */
  function shapeOf(area) { const i = AREA_ORDER.indexOf(area); return SHAPES[i < 0 ? 0 : i]; }
  function polyPts(n, r, rot) { return Array.from({ length: n }, (_, i) => { const a = rot + (2 * Math.PI * i) / n; return [Math.cos(a) * r, Math.sin(a) * r]; }); }
  function shapePts(shape, r) {
    switch (shape) {
      case "square": return [[-r * .86, -r * .86], [r * .86, -r * .86], [r * .86, r * .86], [-r * .86, r * .86]];
      case "diamond": return polyPts(4, r * 1.12, -Math.PI / 2);
      case "triangle": return polyPts(3, r * 1.18, -Math.PI / 2);
      case "triangleDown": return polyPts(3, r * 1.18, Math.PI / 2);
      case "hexagon": return polyPts(6, r * 1.02, 0);
      case "pentagon": return polyPts(5, r * 1.06, -Math.PI / 2);
      case "octagon": return polyPts(8, r * 1.0, Math.PI / 8);
      default: return null;
    }
  }
  function shapeD(shape, x, y, r) {
    const pts = shapePts(shape, r);
    if (!pts) return `M${x - r} ${y} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0`;
    return "M" + pts.map(([px, py]) => `${x + px} ${y + py}`).join(" L") + " Z";
  }
  function shapePath(ctx, shape, x, y, r) {
    ctx.beginPath();
    const pts = shapePts(shape, r);
    if (!pts) { ctx.arc(x, y, r, 0, Math.PI * 2); return; }
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(x + px, y + py) : ctx.moveTo(x + px, y + py)));
    ctx.closePath();
  }

  /* ---------- GitHub API ---------- */
  class HttpError extends Error { constructor(status, path, detail) { super(`HTTP ${status}`); this.status = status; this.path = path; this.detail = detail; } }
  // vault/_build 아래 생성물만 읽는다 (graph.json 의 detail 값이 다른 API 경로를 가리키지 못하게)
  const BUILD_PATH = /^vault\/_build\/(?:graph|notes\/[a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;
  async function gh(path) {
    if (typeof path !== "string" || !BUILD_PATH.test(path)) throw new Error(`vault/_build 밖의 경로는 읽지 않습니다 (${String(path).slice(0, 80)})`);
    if (!S.token) throw new HttpError(401, path, "locked"); // 잠근 뒤에는 요청을 보내지 않는다
    const { owner, repo, ref } = S.repo;
    const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/` +
      path.split("/").map(encodeURIComponent).join("/") + (ref ? `?ref=${encodeURIComponent(ref)}` : "");
    let res;
    try { // 헤더는 둘뿐: Accept 값은 CORS 안전 목록이라, 사전 요청(preflight)은 Authorization 하나만 허가받으면 된다
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${S.token}`, Accept: "application/vnd.github.raw+json" },
        cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
      });
    } catch (e) { throw new HttpError(0, path, "network"); }
    if (!res.ok) throw new HttpError(res.status, path, res.headers.get("x-ratelimit-remaining") === "0" ? "ratelimit" : "");
    return res.json();
  }
  function errorText(err) {
    if (!(err instanceof HttpError)) return `불러오지 못했습니다: ${err && err.message ? err.message : err}`;
    const repo = `${S.repo.owner}/${S.repo.repo}`;
    switch (err.status) {
      case 0: return "GitHub에 연결하지 못했습니다. 네트워크를 확인하세요.";
      case 401: return "토큰이 올바르지 않거나 만료되었습니다. 새 열람용 토큰을 넣어 주세요.";
      case 403: return err.detail === "ratelimit" ? "GitHub API 요청 한도를 넘었습니다. 잠시 뒤 다시 시도하세요."
        : `토큰에 ${repo}의 Contents 읽기 권한이 없습니다.`;
      case 404: return err.path.endsWith("graph.json")
        ? `${repo}에서 vault/_build/graph.json을 찾지 못했습니다. 토큰의 Repository access에 ${S.repo.repo}가 들어 있는지, 브랜치에 그래프가 생성됐는지 확인하세요.`
        : `노트 파일(${err.path})을 찾지 못했습니다. 새로고침해 보세요.`;
      default: return `GitHub 오류 (HTTP ${err.status}).`;
    }
  }

  /* ---------- 모델 ---------- */
  function hash01(s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return ((x >>> 0) % 10007) / 10007; }
  function seedPos(id, i, n) { const a = (2 * Math.PI * i) / Math.max(1, n) + hash01(id) * 0.6, r = 150 + hash01(id + "r") * 90; return [Math.cos(a) * r, Math.sin(a) * r]; }
  function styleKey(e) { return e.kind === "relation" ? e.type : e.kind === "gap" ? "gap" : e.kind === "cites" ? "cites" : "similar"; }
  function groupOf(e) { const sk = e.sk; return GROUPS.find((g) => g.keys.includes(sk)).id; }

  // vocab.yml 에 새 관계 유형이 생기면 극성이 같은 기존 유형의 묶음·선 모양·스프링을 빌려 쓴다
  function ensureRelStyle(type, rv) {
    if (ESTYLE[type]) return;
    const base = rv && rv.polarity === "positive" ? "supports" : rv && rv.polarity === "negative" ? "challenges" : "same_method";
    ESTYLE[type] = { ...ESTYLE[base], label: (rv && rv.label) || type };
    SPRING[type] = SPRING[base];
    GROUPS.find((x) => x.keys.includes(base)).keys.push(type);
  }
  const REL_TYPES = () => Object.keys(ESTYLE).filter((k) => !["cites", "similar", "gap"].includes(k));

  function buildModel(g) {
    for (const [type, rv] of Object.entries((g.vocab && g.vocab.relations) || {})) ensureRelStyle(type, rv);
    const prev = new Map(S.nodes.map((n) => [n.id, n]));
    S.nodes = g.nodes.map((n, i) => {
      const p = prev.get(n.id), [x, y] = p ? [p.x, p.y] : seedPos(n.id, i, g.nodes.length);
      const claims = (n.counts && n.counts.claims) || 1;
      return { ...n, x, y, vx: 0, vy: 0, fx: 0, fy: 0, r: n.kind === "gap" ? 8 : 13 + Math.min(8, Math.sqrt(claims) * 1.6),
        m: 1, deg: 0, stress: 0, pinned: p ? p.pinned : false };
    });
    S.byId = new Map(S.nodes.map((n) => [n.id, n]));
    S.edges = g.edges.filter((e) => S.byId.has(e.source) && S.byId.has(e.target) && e.source !== e.target)
      .map((e) => ({ ...e, sk: styleKey(e), T: 0, L: 0, d: 0, curve: 0 }))
      .filter((e) => ESTYLE[e.sk]);
    S.edgeById = new Map(S.edges.map((e) => [e.id, e]));
    const pairs = new Map();
    for (const e of S.edges) {
      const key = [e.source, e.target].sort().join("|");
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(e);
    }
    for (const list of pairs.values()) {
      list.sort((a, b) => (a.sk === "similar") - (b.sk === "similar") || a.id.localeCompare(b.id));
      list.forEach((e, i) => { e.curve = (i - (list.length - 1) / 2) * 15; e.pair = list; });
    }
    for (const e of S.edges) { S.byId.get(e.source).deg++; S.byId.get(e.target).deg++; }
    for (const n of S.nodes) n.m = 1 + 0.15 * n.deg;
    if (S.sel && !(S.sel.kind === "node" ? S.byId.has(S.sel.id) : S.edgeById.has(S.sel.id))) S.sel = null;
  }
  const nodeOn = (n) => n.kind !== "gap" || S.filters.gap;
  const edgeOn = (e) => S.filters[groupOf(e)] && nodeOn(S.byId.get(e.source)) && nodeOn(S.byId.get(e.target));
  const touches = (e, id) => e.source === id || e.target === id;
  const degOn = (n) => S.edges.reduce((c, e) => c + (edgeOn(e) && touches(e, n.id) ? 1 : 0), 0); // 화면에 보이는 연결 수

  function springOf(e) {
    const s = SPRING[e.sk];
    if (e.sk === "similar") { const w = Math.min(1, (e.weight || 0) / 0.3); return { L: s.L * (1.15 - 0.45 * w), k: s.k * (0.4 + 1.6 * w) }; }
    if (e.kind === "relation") { const w = e.weight || 0.7; return { L: s.L * (1.1 - 0.15 * w), k: s.k * (0.5 + 0.5 * w) }; }
    return s;
  }

  /* ---------- 물리엔진 ---------- */
  function step() {
    const ns = S.nodes.filter(nodeOn), es = [];
    for (const e of S.edges) { if (edgeOn(e)) es.push(e); else { e.T = 0; e.L = 0; e.d = 0; } }
    for (const n of ns) { n.fx = 0; n.fy = 0; }
    for (let i = 0; i < ns.length; i++) {
      const a = ns[i];
      for (let j = i + 1; j < ns.length; j++) {
        const b = ns[j];
        let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) { dx = hash01(a.id + b.id) - 0.5; dy = hash01(b.id + a.id) - 0.5; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2), f = (PHYS.repulse * a.m * b.m) / Math.max(d2, 400), ux = dx / d, uy = dy / d;
        a.fx -= f * ux; a.fy -= f * uy; b.fx += f * ux; b.fy += f * uy;
      }
    }
    for (const e of es) {
      const a = S.byId.get(e.source), b = S.byId.get(e.target), sp = springOf(e);
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1, Math.hypot(dx, dy)), T = sp.k * (d - sp.L), ux = dx / d, uy = dy / d;
      e.T = T; e.L = sp.L; e.d = d;
      a.fx += T * ux; a.fy += T * uy; b.fx -= T * ux; b.fy -= T * uy;
    }
    let energy = 0;
    for (const n of ns) {
      n.fx -= PHYS.gravity * n.x * n.m; n.fy -= PHYS.gravity * n.y * n.m;
      if (n.pinned || (S.drag && S.drag.id === n.id)) { n.vx = n.vy = 0; continue; }
      n.vx = (n.vx + n.fx / n.m) * PHYS.damp; n.vy = (n.vy + n.fy / n.m) * PHYS.damp;
      const v = Math.hypot(n.vx, n.vy);
      if (v > PHYS.maxV) { n.vx *= PHYS.maxV / v; n.vy *= PHYS.maxV / v; }
      n.x += n.vx; n.y += n.vy; energy += n.vx * n.vx + n.vy * n.vy;
    }
    for (const n of S.nodes) n.stress = 0;
    for (const e of es) { const t = Math.abs(e.T); S.byId.get(e.source).stress += t; S.byId.get(e.target).stress += t; }
    return energy / Math.max(1, ns.length);
  }
  function measure() { // 노드를 움직이지 않고 지금 위치에서 보이는 간선의 장력·응력만 다시 잰다 (칩 전환·새로고침 직후)
    for (const n of S.nodes) n.stress = 0;
    for (const e of S.edges) {
      if (!edgeOn(e)) { e.T = 0; e.L = 0; e.d = 0; continue; }
      const a = S.byId.get(e.source), b = S.byId.get(e.target), sp = springOf(e);
      const d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      e.T = sp.k * (d - sp.L); e.L = sp.L; e.d = d;
      a.stress += Math.abs(e.T); b.stress += Math.abs(e.T);
    }
  }
  function settle() { // 움직임 줄이기 설정이면 화면에 그리지 않고 바로 수렴시킨다
    for (let i = 0; i < 4000; i++) { if (step() < 0.002 && i > 200) break; }
    measure(); // step()은 움직이기 전 위치의 장력을 남기므로 멈춘 위치에서 다시 잰다
    S.running = false; if (!S.fitted) S.fitted = fitView(); // 캔버스 크기를 아직 모르면 크기가 정해질 때 맞춘다
    rehover(true);
    draw(); if (S.tab !== "sel") renderPanel(); else refreshLive();
  }
  function tick() {
    if (!S.running) return;
    let e = 0;
    for (let i = 0; i < 2; i++) e = step();
    S.steps += 2;
    S.calm = e < 0.01 ? S.calm + 1 : 0;
    measure(); // 그릴 위치(이동 후)에서 장력·응력을 다시 잰다 — 표시값이 화면의 길이와 같은 순간을 가리킨다
    if (!S.fitted && (S.steps > 140 || S.calm > 40)) S.fitted = fitView(); // 첫 화면 맞춤: 140걸음째, 또는 그 전에 잠잠해져 멈출 때
    rehover(true); // 노드가 움직여도 멈춰 있는 포인터 아래 항목을 다시 찾는다
    if (S.calm > 40 || S.steps > 3000) { S.running = false; if (S.tab === "tension" || S.tab === "list") renderPanel(); else refreshLive(); }
    else refreshLive(); // 매 프레임 — 노드를 끄는 동안(kick이 steps를 되돌려도) 값이 멈추지 않는다
    draw();
    if (S.running) requestAnimationFrame(tick);
  }
  function kick(shake) {
    if (shake) for (const n of S.nodes) if (!n.pinned) { n.vx += (hash01(n.id + S.steps) - 0.5) * 30; n.vy += (hash01(S.steps + n.id) - 0.5) * 30; }
    S.calm = 0; S.steps = 0;
    if (reduceMotion) { settle(); return; }
    if (!S.running) { S.running = true; requestAnimationFrame(tick); }
  }

  /* ---------- 화면 좌표 ---------- */
  const toWorld = (sx, sy) => [S.view.cx + (sx - S.size.w / 2) / S.view.k, S.view.cy + (sy - S.size.h / 2) / S.view.k];
  function fitView() {
    const ns = S.nodes.filter(nodeOn);
    if (!ns.length || !S.size.w) return false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of ns) { x0 = Math.min(x0, n.x - n.r); x1 = Math.max(x1, n.x + n.r); y0 = Math.min(y0, n.y - n.r); y1 = Math.max(y1, n.y + n.r); }
    // 여백은 화면 px 기준: 라벨(노드 아래 고정 크기 글자)과 위쪽 통계 줄 자리를 남긴다
    const lg = $("legend"), overlay = lg && getComputedStyle(lg).position === "absolute";
    const padX = 64, padTop = 44, padBottom = Math.max(40, overlay ? lg.offsetHeight + 26 : 0);
    S.view.k = Math.max(0.3, Math.min(1.6, (S.size.w - padX * 2) / Math.max(1, x1 - x0), (S.size.h - padTop - padBottom) / Math.max(1, y1 - y0)));
    S.view.cx = (x0 + x1) / 2; S.view.cy = (y0 + y1) / 2 + (padBottom - padTop) / (2 * S.view.k);
    return true;
  }
  function zoomAt(sx, sy, f) {
    const [wx, wy] = toWorld(sx, sy);
    S.view.k = Math.max(0.25, Math.min(3.5, S.view.k * f));
    S.view.cx = wx - (sx - S.size.w / 2) / S.view.k; S.view.cy = wy - (sy - S.size.h / 2) / S.view.k;
    draw();
  }

  /* ---------- 그리기 ---------- */
  function readColors() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    S.colors = { surface: v("--surface"), surface2: v("--surface-2"), ink: v("--ink"), ink2: v("--ink-2"), pos: v("--pos"), neg: v("--neg"), neu: v("--neu"), muted: v("--edge-muted"), focus: v("--focus") };
    S.font = v("--font") || "sans-serif";
  }
  function edgeColor(sk) { const c = ESTYLE[sk].color; return S.colors[c === "muted" ? "muted" : c]; }
  function geom(e) {
    const a = S.byId.get(e.source), b = S.byId.get(e.target);
    const [p, q] = a.id < b.id ? [a, b] : [b, a];
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.max(1, Math.hypot(dx, dy)), nx = -dy / d, ny = dx / d;
    const cx = (a.x + b.x) / 2 + nx * e.curve * 2, cy = (a.y + b.y) / 2 + ny * e.curve * 2;
    const trim = (n, r) => { const tx = cx - n.x, ty = cy - n.y, td = Math.max(1e-6, Math.hypot(tx, ty)); return [n.x + (tx / td) * r, n.y + (ty / td) * r]; };
    const [sx, sy] = trim(a, a.r + 1), [ex, ey] = trim(b, b.r + (ESTYLE[e.sk].arrow ? 2.5 : 1));
    return { sx, sy, cx, cy, ex, ey };
  }
  function focusSet() {
    const f = S.hover || S.sel;
    if (f) {
      if (f.kind === "edge") { const e = S.edgeById.get(f.id); return e ? new Set([e.source, e.target]) : null; }
      const set = new Set([f.id]);
      for (const e of S.edges) if (edgeOn(e)) { if (e.source === f.id) set.add(e.target); if (e.target === f.id) set.add(e.source); }
      return set;
    }
    return S.hits;
  }
  const isSel = (kind, id) => S.sel && S.sel.kind === kind && S.sel.id === id;
  const isHover = (kind, id) => S.hover && S.hover.kind === kind && S.hover.id === id;

  function draw() {
    const { w, h, dpr } = S.size, ctx = S.ctx;
    if (!w || !ctx || !S.colors) return;
    const C = S.colors, k = S.view.k;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.surface; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.scale(k, k); ctx.translate(-S.view.cx, -S.view.cy);
    const focus = focusSet(), es = S.edges.filter(edgeOn), ns = S.nodes.filter(nodeOn);
    const maxT = Math.max(1e-9, ...es.map((e) => Math.abs(e.T))), maxS = Math.max(1e-9, ...ns.map((n) => n.stress));
    const order = es.slice().sort((a, b) => (b.sk === "similar") - (a.sk === "similar"));
    for (const e of order) drawEdge(ctx, e, focus, maxT, C, k);
    for (const n of ns) drawNode(ctx, n, focus, maxS, C, k);
    for (const n of ns) drawLabel(ctx, n, focus, C, k);
    ctx.restore();
  }
  function curvePath(ctx, g) { ctx.beginPath(); ctx.moveTo(g.sx, g.sy); ctx.quadraticCurveTo(g.cx, g.cy, g.ex, g.ey); }
  function drawEdge(ctx, e, focus, maxT, C, k) {
    const st = ESTYLE[e.sk], g = geom(e), col = edgeColor(e.sk), sel = isSel("edge", e.id) || isHover("edge", e.id);
    const dim = focus && !sel && !(focus.has(e.source) && focus.has(e.target)) ? true : false;
    const tn = Math.abs(e.T) / maxT;
    let alpha = dim ? 0.12 : 1;
    if (e.sk === "similar") alpha *= 0.35 + 0.65 * Math.min(1, (e.weight || 0) / 0.3);
    const width = (st.w + (S.tension ? 2.4 * tn : 0)) / k;
    ctx.save();
    if (S.tension && tn > 0.04 && !dim && e.sk !== "similar") { // 장력 후광: 굵을수록 장력이 큼
      ctx.globalAlpha = 0.08 + 0.2 * tn; ctx.strokeStyle = col; ctx.lineWidth = width + (9 * tn) / k; ctx.setLineDash([]); ctx.lineCap = "round";
      curvePath(ctx, g); ctx.stroke();
    }
    if (sel) { ctx.globalAlpha = 1; ctx.strokeStyle = C.ink; ctx.lineWidth = width + 3 / k; ctx.setLineDash([]); curvePath(ctx, g); ctx.stroke(); }
    ctx.globalAlpha = alpha; ctx.strokeStyle = col; ctx.lineWidth = width; ctx.lineCap = "butt";
    ctx.setLineDash(st.dash.map((x) => x / k)); curvePath(ctx, g); ctx.stroke(); ctx.setLineDash([]);
    if (st.arrow) {
      const ang = Math.atan2(g.ey - g.cy, g.ex - g.cx), L = (7 + width * k * 0.8) / k, W = (4 + width * k * 0.4) / k;
      ctx.beginPath(); ctx.moveTo(g.ex, g.ey);
      ctx.lineTo(g.ex - L * Math.cos(ang) + W * Math.sin(ang), g.ey - L * Math.sin(ang) - W * Math.cos(ang));
      ctx.lineTo(g.ex - L * Math.cos(ang) - W * Math.sin(ang), g.ey - L * Math.sin(ang) + W * Math.cos(ang));
      ctx.closePath(); ctx.fillStyle = col; ctx.fill();
    }
    ctx.restore();
  }
  function drawNode(ctx, n, focus, maxS, C, k) {
    const dim = focus && !focus.has(n.id), sel = isSel("node", n.id), hov = isHover("node", n.id), gap = n.kind === "gap";
    ctx.save(); ctx.globalAlpha = dim ? 0.25 : 1;
    if (S.tension && !gap && n.stress > 0) { // 응력 고리: 클수록 여러 방향으로 당겨지는 노드
      const sn = n.stress / maxS;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + (3 + 7 * sn) / Math.sqrt(k), 0, Math.PI * 2);
      ctx.strokeStyle = C.ink2; ctx.globalAlpha = (dim ? 0.25 : 1) * (0.12 + 0.3 * sn); ctx.lineWidth = (1 + 3 * sn) / k; ctx.stroke();
      ctx.globalAlpha = dim ? 0.25 : 1;
    }
    if (S.hits && S.hits.has(n.id)) { ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 5 / k, 0, Math.PI * 2); ctx.strokeStyle = C.focus; ctx.lineWidth = 2.5 / k; ctx.stroke(); }
    shapePath(ctx, gap ? "circle" : shapeOf(n.area), n.x, n.y, n.r);
    ctx.fillStyle = sel || hov ? C.surface2 : C.surface; ctx.fill();
    ctx.lineWidth = (sel ? 3 : hov ? 2.2 : 1.6) / k; ctx.strokeStyle = gap ? C.muted : sel ? C.ink : C.ink2;
    ctx.setLineDash(gap ? [3 / k, 3 / k] : []); ctx.stroke(); ctx.setLineDash([]);
    if (n.pinned) { ctx.beginPath(); ctx.arc(n.x + n.r * 0.72, n.y - n.r * 0.72, 2.6 / k, 0, Math.PI * 2); ctx.fillStyle = C.ink2; ctx.fill(); }
    ctx.restore();
  }
  function drawLabel(ctx, n, focus, C, k) {
    const dim = focus && !focus.has(n.id), gap = n.kind === "gap", fs = (gap ? 11 : 12.5) / k;
    ctx.save(); ctx.globalAlpha = dim ? 0.35 : 1;
    ctx.font = `${gap ? 400 : 600} ${fs}px ${S.font}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
    const y = n.y + n.r + 4 / k;
    ctx.lineJoin = "round"; ctx.lineWidth = 3.5 / k; ctx.strokeStyle = C.surface; ctx.strokeText(n.label, n.x, y);
    ctx.fillStyle = gap ? C.ink2 : C.ink; ctx.fillText(n.label, n.x, y);
    ctx.restore();
  }

  /* ---------- 맞히기 ---------- */
  function distToQuad(px, py, g) {
    let best = Infinity, x0 = g.sx, y0 = g.sy;
    for (let i = 1; i <= 20; i++) {
      const t = i / 20, mt = 1 - t;
      const x1 = mt * mt * g.sx + 2 * mt * t * g.cx + t * t * g.ex, y1 = mt * mt * g.sy + 2 * mt * t * g.cy + t * t * g.ey;
      const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1, u = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / L2));
      best = Math.min(best, Math.hypot(px - (x0 + u * dx), py - (y0 + u * dy)));
      x0 = x1; y0 = y1;
    }
    return best;
  }
  function hit(sx, sy) {
    const [wx, wy] = toWorld(sx, sy), k = S.view.k;
    let best = null, bd = Infinity;
    for (const n of S.nodes) {
      if (!nodeOn(n)) continue;
      const d = Math.hypot(n.x - wx, n.y - wy), hr = Math.max(n.r * k + 6, 14) / k; // 최소 28px 지름
      if (d <= hr && d < bd) { bd = d; best = { kind: "node", id: n.id }; }
    }
    if (best) return best;
    const tol = 7 / k;
    for (const e of S.edges) {
      if (!edgeOn(e)) continue;
      const d = distToQuad(wx, wy, geom(e));
      if (d < tol && d < bd) { bd = d; best = { kind: "edge", id: e.id }; }
    }
    return best;
  }

  /* ---------- 상호작용 ---------- */
  function canvasPoint(ev) { const r = S.canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }
  function setupCanvas() {
    const cv = $("graph"); S.canvas = cv; S.ctx = cv.getContext("2d");
    const ro = new ResizeObserver(() => {
      const r = $("graphWrap").getBoundingClientRect(), dpr = Math.min(2.5, window.devicePixelRatio || 1);
      S.size = { w: r.width, h: r.height, dpr };
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      if (!S.fitted && S.graph && !S.running) S.fitted = fitView(); // 움직임 줄이기: 첫 배치를 크기가 정해진 뒤 화면에 맞춘다
      draw(); rehover(); // 크기가 바뀌면 화면↔그래프 좌표가 달라지므로 멈춰 있는 포인터 아래를 다시 찾는다
    });
    ro.observe($("graphWrap"));

    cv.addEventListener("pointerdown", (ev) => {
      cv.setPointerCapture(ev.pointerId);
      const [sx, sy] = canvasPoint(ev);
      S.pointers.set(ev.pointerId, { sx, sy });
      if (S.pointers.size === 2) { S.drag = null; const p = [...S.pointers.values()]; S.pinch = { d: Math.hypot(p[0].sx - p[1].sx, p[0].sy - p[1].sy), k: S.view.k }; return; }
      const t = hit(sx, sy);
      S.drag = t && t.kind === "node" ? { id: t.id, sx, sy, moved: false, target: t } : { pan: true, sx, sy, cx: S.view.cx, cy: S.view.cy, moved: false, target: t };
      cv.classList.add("dragging");
    });
    cv.addEventListener("pointermove", (ev) => {
      const [sx, sy] = canvasPoint(ev);
      if (ev.pointerType !== "touch") S.ptr = { x: ev.clientX, y: ev.clientY }; // 마우스가 멈춰 있어도 화면이 움직이면 hover를 다시 찾는다 (창 기준 좌표)
      if (S.pointers.has(ev.pointerId)) S.pointers.set(ev.pointerId, { sx, sy });
      if (S.pinch && S.pointers.size === 2) {
        const p = [...S.pointers.values()], d = Math.hypot(p[0].sx - p[1].sx, p[0].sy - p[1].sy);
        const mx = (p[0].sx + p[1].sx) / 2, my = (p[0].sy + p[1].sy) / 2, want = Math.max(0.25, Math.min(3.5, S.pinch.k * (d / Math.max(1, S.pinch.d))));
        zoomAt(mx, my, want / S.view.k); return;
      }
      const dg = S.drag;
      if (dg) {
        if (Math.hypot(sx - dg.sx, sy - dg.sy) > 4) dg.moved = true;
        if (!dg.moved) return;
        if (dg.pan) { S.view.cx = dg.cx - (sx - dg.sx) / S.view.k; S.view.cy = dg.cy - (sy - dg.sy) / S.view.k; draw(); }
        else { const n = S.byId.get(dg.id), [wx, wy] = toWorld(sx, sy); n.x = wx; n.y = wy; n.vx = n.vy = 0; kick(false); if (reduceMotion) draw(); }
        hideTip(); return;
      }
      hoverAt(sx, sy);
    });
    const end = (ev) => {
      S.pointers.delete(ev.pointerId);
      if (S.pointers.size < 2) S.pinch = null;
      const dg = S.drag; S.drag = null; cv.classList.remove("dragging");
      if (!dg) return;
      if (!dg.moved) select(dg.target || null);
      else if (!dg.pan) { S.byId.get(dg.id).pinned = true; kick(false); }
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    cv.addEventListener("pointerleave", () => { S.ptr = null; if (S.hover) { S.hover = null; draw(); } hideTip(); });
    cv.addEventListener("dblclick", (ev) => {
      const [sx, sy] = canvasPoint(ev), t = hit(sx, sy);
      if (t && t.kind === "node") { const n = S.byId.get(t.id); n.pinned = !n.pinned; kick(false); }
    });
    cv.addEventListener("wheel", (ev) => { ev.preventDefault(); const [sx, sy] = canvasPoint(ev); zoomAt(sx, sy, Math.exp(-ev.deltaY * 0.0015)); if (!S.drag) hoverAt(sx, sy); }, { passive: false });
    cv.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") select(null);
      else if (ev.key === "+" || ev.key === "=") zoomAt(S.size.w / 2, S.size.h / 2, 1.2);
      else if (ev.key === "-") zoomAt(S.size.w / 2, S.size.h / 2, 1 / 1.2);
      else if (ev.key === "0") { fitView(); draw(); }
      else return;
      rehover();
      ev.preventDefault();
    });
  }
  function hoverAt(sx, sy, noDraw) { // 포인터 아래 항목을 hover로 두고 툴팁을 띄운다
    const t = hit(sx, sy), prev = S.hover;
    S.hover = t;
    S.canvas.classList.toggle("on-item", !!t);
    if (!noDraw && (prev && prev.id) !== (t && t.id)) draw();
    if (t) showTip(t, sx, sy); else hideTip();
  }
  // 확대·화면 맞춤·배치로 그림이 움직인 뒤, 멈춰 있는 마우스 아래 항목을 다시 찾는다 (끄는 중·두 손가락 확대 중에는 안 함)
  const rehover = (noDraw) => {
    if (!S.ptr || S.drag || S.pinch || !S.graph) return;
    const r = S.canvas.getBoundingClientRect(); hoverAt(S.ptr.x - r.left, S.ptr.y - r.top, noDraw);
  };
  function showTip(t, sx, sy) {
    S.tip = { t, sx, sy };
    const tip = $("tip"), kids = [];
    if (t.kind === "node") {
      const n = S.byId.get(t.id);
      kids.push(h("b", null, n.label), h("span", { class: "t2" }, n.kind === "gap" ? `vault 밖 문헌 · ${n.cited_by.length}편이 인용` : n.title));
      if (n.kind === "note" && S.tension) kids.push(h("div", { class: "t2" }, `응력(보이는 간선 장력 절댓값 합) ${n.stress.toFixed(2)} · 연결 ${degOn(n)}`));
    } else {
      const e = S.edgeById.get(t.id), a = S.byId.get(e.source), b = S.byId.get(e.target);
      kids.push(h("b", null, `${ESTYLE[e.sk].label}${e.confidence ? ` · 신뢰도 ${CONF[e.confidence]}` : e.sk === "similar" ? ` · ${e.weight.toFixed(2)}` : ""}`),
        h("span", { class: "t2" }, `${a.label} ${e.sk === "similar" ? "↔" : "→"} ${b.label}`),
        h("div", { class: "t2" }, tensionText(e)));
    }
    if (tip.hidden || tip.textContent !== kids.map((k) => k.textContent).join("")) tip.replaceChildren(...kids); // 같은 내용이면 그대로 둔다
    tip.hidden = false;
    const W = S.size.w, tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.min(W - tw - 8, sx + 14)}px`; tip.style.top = `${Math.max(8, Math.min(S.size.h - th - 8, sy + 14))}px`;
  }
  function hideTip() { S.tip = null; $("tip").hidden = true; }
  // 열린 툴팁도 패널처럼 지금 값으로 다시 쓴다. 가리키던 항목이 필터로 숨겨졌으면 닫는다
  function refreshTip() {
    const tp = S.tip;
    if (!tp || $("tip").hidden) return;
    const t = tp.t, on = t.kind === "node" ? S.byId.has(t.id) && nodeOn(S.byId.get(t.id)) : S.edgeById.has(t.id) && edgeOn(S.edgeById.get(t.id));
    if (on) { showTip(t, tp.sx, tp.sy); return; }
    hideTip();
    if (S.hover && S.hover.id === t.id) { S.hover = null; S.canvas.classList.remove("on-item"); draw(); }
  }
  // 상태는 표시값의 부호로: 0.00으로 보이면 평형, 그 밖에는 + 늘어남 · 당김 / − 눌림 · 밀어냄 ('-0.00' 표기 없음)
  const fmtT = (T) => { const s = T.toFixed(2); return s === "0.00" || s === "-0.00" ? "0.00" : T > 0 ? `+${s}` : s; };
  function tensionText(e) {
    if (!e.L) return "장력 계산 전";
    const s = fmtT(e.T), state = s === "0.00" ? "평형" : e.T > 0 ? "늘어남 · 당김" : "눌림 · 밀어냄";
    return `장력 ${s} (${state}) · 길이 ${Math.round(e.d)} / 자연 ${Math.round(e.L)}`;
  }
  // 패널에 보이는 장력·응력 값을 지금 값으로 바꾼다 (패널을 다시 그리지 않으므로 스크롤·열어 둔 노트 전문이 그대로)
  function refreshLive() {
    for (const el of $("panelBody").querySelectorAll("[data-live]")) {
      const id = el.dataset.id;
      let v = null;
      if (el.dataset.live === "stress") { const n = S.byId.get(id); if (n) v = n.stress.toFixed(2); }
      else { const e = S.edgeById.get(id); if (e) v = el.dataset.live === "tension" ? tensionText(e) : e.L ? fmtT(e.T) : "-"; }
      if (v !== null && el.textContent !== v) el.textContent = v; // 값이 그대로면 건드리지 않는다 (선택한 글자가 풀리지 않게)
    }
    refreshTip();
  }
  function select(t) {
    S.sel = t; S.tab = "sel"; S.notice = ""; renderTabs(); renderPanel(); draw();
  }

  /* ---------- 패널 ---------- */
  function renderTabs() { document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab))); }
  function renderPanel() {
    const body = $("panelBody"), view = S.tab === "sel" ? `sel|${S.sel ? `${S.sel.kind}:${S.sel.id}` : ""}` : S.tab;
    const same = view === S.panelView, act = document.activeElement, fk = same && act && act !== body && body.contains(act) ? focusKey(body, act) : null, top = body.scrollTop;
    S.panelView = view; body.replaceChildren();
    if (!S.graph) return;
    if (S.tab === "tension") body.append(...panelTension());
    else if (S.tab === "gaps") body.append(...panelGaps());
    else if (S.tab === "list") body.append(...panelList());
    else if (S.sel && S.sel.kind === "node" && S.byId.has(S.sel.id)) body.append(...panelNode(S.byId.get(S.sel.id)));
    else if (S.sel && S.sel.kind === "edge" && S.edgeById.has(S.sel.id)) body.append(...panelEdge(S.edgeById.get(S.sel.id)));
    else body.append(...panelOverview());
    if (S.notice) body.prepend(h("p", { class: "notice" }, S.notice)); // 토큰 보관 안내: 다른 화면으로 옮길 때까지 남긴다
    if (same) { body.scrollTop = top; if (fk) restoreFocus(body, fk); } // 같은 패널을 다시 그리면 스크롤·키보드 포커스를 지킨다
    refreshTip();
  }
  // 버튼은 data-k(노드·간선 id)로, 그 밖에는 태그·글자로 찾고, 같은 것이 여럿이면 몇 번째인지로 고른다
  const focusSig = (el) => el.dataset.k ? `k:${el.dataset.k}` : `${el.tagName}|${el.textContent}`;
  function focusKey(body, el) { const sig = focusSig(el); return { sig, tag: el.tagName, i: [...body.querySelectorAll(el.tagName)].filter((x) => focusSig(x) === sig).indexOf(el) }; }
  function restoreFocus(body, k) { const c = [...body.querySelectorAll(k.tag)].filter((x) => focusSig(x) === k.sig); const el = c[k.i] || c[0]; if (el) el.focus({ preventScroll: true }); }
  const vocab = (kind, key) => (S.graph.vocab && S.graph.vocab[kind] && S.graph.vocab[kind][key]) || key;
  const relLabel = (type) => (S.graph.vocab.relations[type] || {}).label || ESTYLE[type]?.label || type;
  const nodeBtn = (id) => { const n = S.byId.get(id); return h("button", { class: "rowbtn", type: "button", "data-k": `n:${id}`, onclick: () => select({ kind: "node", id }) }, n ? n.label : id); };
  const edgeBtn = (e, text) => h("button", { class: "rowbtn", type: "button", "data-k": `e:${e.id}`, onclick: () => select({ kind: "edge", id: e.id }) }, text);
  function polTag(e) { const c = ESTYLE[e.sk].color; return h("span", { class: `tag ${c === "pos" ? "pos" : c === "neg" ? "neg" : "strong"}` }, ESTYLE[e.sk].label); }
  const hiddenNote = (n) => n > 0 ? h("p", { class: "dim", style: "font-size:12px;margin:4px 0 0" }, `필터로 숨긴 간선 ${n}개는 목록에서 뺐습니다.`) : null;
  const hiddenSelf = (what) => h("p", { class: "notice" }, `이 ${what} 지금 필터로 숨겨져 있습니다. 위쪽 간선 종류 버튼으로 다시 켜면 장력이 다시 계산됩니다.`);
  function quote(ev) { return h("blockquote", { class: "q" }, `“${ev.quote}”`, h("span", { class: "src" }, `PDF p.${ev.page}${ev.printed_page != null ? ` · 인쇄 p.${ev.printed_page}` : ""}${ev.section ? ` · ${ev.section}` : ""}`)); }
  function relationCounts(pred) { // pred(예: edgeOn)를 주면 그 간선만 센다
    const c = { relation: 0, cites: 0, similar: 0, gap: 0 };
    for (const e of S.edges) if (!pred || pred(e)) c[e.kind] = (c[e.kind] || 0) + 1;
    return c;
  }

  function panelOverview() {
    const notes = S.nodes.filter((n) => n.kind === "note").sort((a, b) => a.year - b.year), c = relationCounts(edgeOn);
    const hidden = S.edges.filter((e) => !edgeOn(e)).length, g = S.graph.gaps;
    return [
      h("div", { class: "explain" }, "노드(논문)를 누르면 출처·권한·키워드가 담긴 캡슐이, 간선을 누르면 관계의 원문 근거가 보입니다. 노드를 끌어 옮기면 그 자리에 고정되고, 두 번 누르면 풀립니다."),
      h("section", { class: "sec" }, h("h3", null, "Vault"),
        h("dl", { class: "kv" },
          h("dt", null, "노트"), h("dd", null, `${notes.length}편`),
          h("dt", null, "관계"), h("dd", null, `근거 있는 관계 ${c.relation} · 인용 ${c.cites} · 유사도 ${c.similar}`, hidden ? h("span", { class: "dim" }, ` (필터로 숨긴 간선 ${hidden}개는 세지 않음)`) : null),
          h("dt", null, "공백"), h("dd", null, `${S.filters.gap ? `vault 밖 공통 인용 ${g.missing_references.length}` : "vault 밖 공통 인용 (필터로 숨김)"} · 열린 질문 ${g.open_questions.length}`),
          h("dt", null, "갱신"), h("dd", null, S.graph.meta.updated || "-"))),
      h("section", { class: "sec" }, h("h3", null, "노트 (연도순)"),
        h("ul", { style: "padding-left:18px;margin:0" }, notes.map((n) => h("li", null, nodeBtn(n.id), h("span", { class: "dim" }, ` — ${n.title}`))))),
    ];
  }

  function panelNode(n) {
    if (n.kind === "gap") {
      const on = nodeOn(n);
      return [
        on ? null : hiddenSelf("노드는"),
        h("span", { class: "tag" }, "공백 후보 — vault 밖 문헌"),
        h("h2", { class: "n-title" }, n.label), h("p", { class: "n-meta" }, n.title),
        on ? h("section", { class: "sec" }, h("h3", null, `인용한 노트 ${n.cited_by.length}편`), h("ul", { style: "padding-left:18px;margin:0" }, n.cited_by.map((id) => h("li", null, nodeBtn(id)))))
          : h("section", { class: "sec" }, hiddenNote(n.cited_by.length)),
        h("div", { class: "explain" }, "여러 노트가 함께 인용하지만 아직 vault에 없는 문헌입니다. 이 논문을 Drive kg 폴더에 올리고 정리하면 공백이 연결로 바뀝니다."),
      ].filter(Boolean); // DOM append는 null·false를 글자로 넣으므로 뺀다
    }
    const out = [];
    out.push(h("div", { class: "tags" }, h("span", { class: "tag strong" }, vocab("areas", n.area)), h("span", { class: "tag" }, n.access === "private" ? "비공개" : "교환 가능"), n.reviewed && h("span", { class: "tag" }, n.reviewed.status === "verified" ? `검증됨 ${n.reviewed.at}` : `초안 ${n.reviewed.at}`)));
    out.push(h("h2", { class: "n-title" }, n.title), h("p", { class: "n-meta" }, `${n.authors.join(", ")} · ${n.year} · ${n.venue}`));
    out.push(h("p", { class: "summary" }, n.summary));
    out.push(h("div", { class: "tags", "aria-label": "토픽" }, n.topics.map((t) => h("span", { class: "tag" }, vocab("topics", t)))));
    const src = n.source || {};
    out.push(h("dl", { class: "kv" },
      h("dt", null, "출처"), h("dd", null, /^[A-Za-z0-9_-]+$/.test(src.drive_file_id || "")
        ? h("a", { href: `https://drive.google.com/file/d/${src.drive_file_id}/view`, target: "_blank", rel: "noopener noreferrer" }, `${src.drive_file_name} ↗`) : (src.drive_file_name || "-")),
      h("dt", null, "권한"), h("dd", null, ACCESS[n.access] || n.access),
      h("dt", null, "방법론"), h("dd", null, n.methods.map((m) => vocab("methods", m)).join(", ")),
      h("dt", null, "키워드"), h("dd", null, n.keywords.join(", ")),
      h("dt", null, "구성"), h("dd", null, `주장 ${n.counts.claims} · 근거 ${n.counts.evidence} · 수식 ${n.counts.equations} · 참고문헌 ${n.counts.references}`),
      S.tension && h("dt", null, "응력"), S.tension && h("dd", null, h("span", { "data-live": "stress", "data-id": n.id }, n.stress.toFixed(2)), " (보이는 간선 장력 절댓값의 합)")));

    const mine = S.edges.filter((e) => touches(e, n.id)), shown = mine.filter(edgeOn);
    const rel = shown.filter((e) => e.kind === "relation"), relHidden = mine.filter((e) => e.kind === "relation").length - rel.length;
    const sec = h("section", { class: "sec" }, h("h3", null, `근거 있는 관계 ${rel.length}`));
    if (!rel.length) sec.append(h("p", { class: "empty" }, relHidden ? "근거 있는 관계가 모두 필터로 숨겨져 있습니다." : "아직 근거가 붙은 관계가 없습니다."));
    for (const e of rel) {
      const out_ = e.source === n.id, other = out_ ? e.target : e.source;
      sec.append(h("div", { class: "rel" },
        h("div", { class: "rel-head" }, polTag(e), h("span", { class: "who" }, out_ ? "→ " : "← ", nodeBtn(other)), h("span", { class: "dim" }, `신뢰도 ${CONF[e.confidence] || e.confidence}`), edgeBtn(e, "근거 보기")),
        h("p", null, e.note)));
    }
    if (rel.length && relHidden) sec.append(hiddenNote(relHidden));
    out.push(sec);
    const others = shown.filter((e) => e.kind !== "relation"), othersHidden = mine.filter((e) => e.kind !== "relation").length - others.length;
    if (othersHidden && !others.length) out.push(h("section", { class: "sec" }, h("h3", null, "인용·유사도"), hiddenNote(othersHidden)));
    if (others.length) {
      out.push(h("section", { class: "sec" }, h("h3", null, "인용·유사도"), h("ul", { style: "padding-left:18px;margin:0" }, others.map((e) => {
        const o = e.source === n.id ? e.target : e.source;
        const what = e.kind === "similar" ? `유사도 ${e.weight.toFixed(2)}` : e.kind === "gap" ? "vault 밖 문헌 인용" : e.source === n.id ? "인용함" : "인용됨";
        return h("li", null, edgeBtn(e, what), " · ", nodeBtn(o));
      })), hiddenNote(othersHidden)));
    }
    const holder = h("div");
    const btn = h("button", { class: "btn", type: "button", onclick: () => openDetail(n, holder, btn) }, "노트 전문 열기");
    out.push(h("section", { class: "sec" }, btn), holder);
    if (S.detail.has(n.id)) { btn.remove(); holder.replaceChildren(...renderDetail(S.detail.get(n.id))); } // 받아 둔 전문은 바로 다시 그린다 (스크롤·포커스 복원 전에)
    return out;
  }

  async function openDetail(n, holder, btn) {
    let d = S.detail.get(n.id);
    if (!d) {
      btn.disabled = true; btn.textContent = "불러오는 중…";
      const seq = S.loadSeq;
      try { d = await gh(n.detail); if (seq !== S.loadSeq) return; S.detail.set(n.id, d); } // 그사이 잠갔거나 다시 불러왔으면 버린다
      catch (err) { btn.disabled = false; btn.textContent = "노트 전문 열기"; holder.replaceChildren(h("p", { class: "notice" }, errorText(err))); return; }
    }
    btn.remove();
    holder.replaceChildren(...renderDetail(d));
  }

  function renderDetail(d) {
    const m = d.meta, out = [], refs = new Map();
    const jump = (id) => { const el = refs.get(id); if (el) { el.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" }); el.animate?.([{ background: "var(--surface-3)" }, { background: "transparent" }], { duration: 1200 }); } };
    const titles = {};
    for (const c of m.claims) titles[c.id] = c.text;
    for (const e of m.evidence) titles[e.id] = e.quote;
    for (const q of m.equations) titles[q.id] = q.label;
    const ctx = { jump, titles };
    const ev = new Map(m.evidence.map((e) => [e.id, e]));

    out.push(h("p", { class: "n-meta" }, m.citation, m.doi && /^10\.\d{4,9}\/\S+$/.test(m.doi) ? [" · ", h("a", { href: `https://doi.org/${encodeURI(m.doi)}`, target: "_blank", rel: "noopener noreferrer" }, `doi:${m.doi}`)] : null));
    const cs = h("section", { class: "sec" }, h("h3", null, `핵심 주장 ${m.claims.length}`));
    for (const c of m.claims) {
      const el = h("div", { class: "claim" }, h("span", { class: "cid" }, c.id), c.text, c.evidence.map((id) => ev.get(id)).filter(Boolean).map(quote));
      refs.set(c.id, el); cs.append(el);
    }
    out.push(cs);
    for (const e of m.evidence) if (!refs.has(e.id)) refs.set(e.id, [...cs.querySelectorAll("blockquote")].find((b) => b.textContent.includes(e.quote.slice(0, 40))) || cs);
    if (m.equations.length) {
      const es = h("section", { class: "sec" }, h("h3", null, `핵심 수식 ${m.equations.length}`));
      for (const q of m.equations) {
        const el = h("div", { class: "eqn" }, h("div", { class: "lbl" }, h("span", { class: "cid" }, q.id), q.label), tex(q.latex),
          h("div", { class: "meta" }, `PDF p.${q.page}${q.printed_page != null ? ` · 인쇄 p.${q.printed_page}` : ""} · ${q.section}${q.number ? ` · 식 ${q.number}` : ""}`),
          q.note ? h("div", { class: "meta" }, q.note) : null);
        refs.set(q.id, el); es.append(el);
      }
      out.push(es);
    }
    out.push(h("section", { class: "sec" }, h("h3", null, "본문"), renderMarkdown(d.body || "", ctx)));
    if (m.references.length) {
      const inVault = new Map(S.nodes.filter((x) => x.kind === "note").map((x) => [x.cite_key, x.id]));
      const gaps = new Set(S.graph.gaps.missing_references.map((r) => r.key));
      out.push(h("section", { class: "sec" }, h("h3", null, `참고문헌 (주요 ${m.references.length})`),
        h("ul", { style: "padding-left:18px;margin:0;font-size:12.5px" }, m.references.map((r) => h("li", null, r.cite, " ",
          inVault.has(r.key) ? nodeBtn(inVault.get(r.key)) : gaps.has(r.key) && S.filters.gap ? h("button", { class: "ref-tag", type: "button", onclick: () => select({ kind: "node", id: `ref:${r.key}` }) }, "공백 후보") : null)))));
    }
    if (m.open_questions.length) out.push(h("section", { class: "sec" }, h("h3", null, "열린 질문"), h("ul", { style: "padding-left:18px;margin:0;font-size:12.5px" }, m.open_questions.map((q) => h("li", null, q)))));
    if (m.reviewed) out.push(h("section", { class: "sec" }, h("h3", null, "검토"), h("p", { class: "dim", style: "font-size:12.5px;margin:0" }, `${m.reviewed.by} · ${m.reviewed.at} · ${m.reviewed.status === "verified" ? "검증됨" : "초안"}${m.reviewed.checks ? ` — ${m.reviewed.checks.join(", ")}` : ""}`)));
    return out;
  }
  function tex(latex) {
    const el = h("div", { class: "tex" });
    if (window.katex) {
      try { window.katex.render(latex, el, { displayMode: true, throwOnError: false, strict: "ignore", trust: false, output: "htmlAndMathml" }); return el; }
      catch (e) { /* 아래 원문 표시 */ }
    }
    el.append(h("code", null, latex)); return el;
  }

  /* 노트 본문용 최소 Markdown — 제목·문단·목록(2단)·인용·굵게·코드·[[링크]]·[c1] 태그. HTML은 해석하지 않는다. */
  // 링크는 검증기 WIKILINK_RE와 같은 식으로 찾는다 ([[ 바로 뒤가 | 나 # 이면 링크가 아니다). 굵게·코드 구간에는 완전한 링크만 들어갈 수 있고,
  // 구간 끝이 링크 중간에 걸리면 그 구간은 서식으로 보지 않는다 — 검증기가 읽는 링크는 언제나 링크로 보인다
  const LINK = String.raw`\[\[[^\]|#\n]+(?:[|#][^\]\n]*)?\]\]`, NOT_LINK = String.raw`\[(?!\[[^\]|#\n]+(?:[|#][^\]\n]*)?\]\])`, TAG = String.raw`\[(?:c|e|eq)\d+\]`;
  const INLINE = new RegExp(`(\\*\\*(?:${LINK}|${NOT_LINK}|[^*\\[])+\\*\\*|\`(?:${LINK}|${NOT_LINK}|[^\`\\[])+\`|${LINK}|${TAG})`, "g");
  const REFS = new RegExp(`(${LINK}|${TAG})`, "g"); // 코드 안에서는 링크·태그만
  // 검증기(Python str.strip)와 같은 공백 집합으로 링크 대상의 앞뒤를 자른다 — JS trim()과는 U+0085·U+001C–1F·U+FEFF가 다르다
  const PY_WS = "[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
  const PY_STRIP = new RegExp(`^${PY_WS}+|${PY_WS}+$`, "g");
  function inline(text, ctx, refsOnly) {
    const out = []; let last = 0;
    for (const m of text.matchAll(refsOnly ? REFS : INLINE)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const t = m[0];
      if (t.startsWith("**")) out.push(h("strong", null, inline(t.slice(2, -2), ctx)));
      else if (t.startsWith("`")) out.push(h("code", null, inline(t.slice(1, -1), ctx, true)));
      else if (t.startsWith("[[")) { const id = t.slice(2, -2).split(/[|#]/)[0].replace(PY_STRIP, ""); /* [[id]] [[id|별칭]] [[id#절]] — 검증기 WIKILINK_RE와 같은 규칙 */ out.push(S.byId.has(id) ? nodeBtn(id) : t); }
      else { const id = t.slice(1, -1); out.push(h("button", { class: "ref-tag", type: "button", title: (ctx.titles[id] || id).slice(0, 160), onclick: () => ctx.jump(id) }, id)); }
      last = m.index + t.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function renderMarkdown(src, ctx) {
    const root = h("div", { class: "md" }), lines = src.replace(/\r\n/g, "\n").split("\n");
    let list = null, para = [], item = null; // item: 글을 아직 넣지 않은 목록 항목 — 이어지는 줄까지 모아 한 번에 그린다
    const flushItem = () => { if (item) { item.el.prepend(...inline(item.text, ctx)); item = null; } };
    // 줄은 \n으로 이어 붙인다 (화면에는 공백으로 보임): 링크는 검증기처럼 한 줄 안에서만 찾는다
    const flush = () => { flushItem(); if (para.length) { root.append(h("p", null, inline(para.join("\n"), ctx))); para = []; } };
    for (const raw of lines) {
      const line = raw.trimEnd(); let m;
      if (!line.trim()) { flush(); list = null; continue; }
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flush(); list = null; root.append(h(`h${Math.min(3, m[1].length)}`, null, inline(m[2], ctx))); continue; }
      if ((m = line.match(/^>\s?(.*)$/))) { flush(); list = null; root.append(h("blockquote", null, inline(m[1], ctx))); continue; }
      if ((m = raw.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/))) {
        flush();
        const ordered = /\d/.test(m[2]), li = h("li");
        if (m[1].length >= 2 && list && list.lastElementChild) {
          const parent = list.lastElementChild;
          let sub = [...parent.children].find((c) => c.tagName === "UL" || c.tagName === "OL");
          if (!sub) { sub = h(ordered ? "ol" : "ul"); parent.append(sub); }
          sub.append(li);
        } else {
          if (!list || list.tagName !== (ordered ? "OL" : "UL")) { list = h(ordered ? "ol" : "ul"); root.append(list); }
          list.append(li);
        }
        item = { el: li, text: m[3] };
        continue;
      }
      if (list && /^\s{2,}\S/.test(raw) && item) { item.text += "\n" + line.trim(); continue; }
      flushItem(); list = null; para.push(line.trim());
    }
    flush();
    return root;
  }

  function panelEdge(e) {
    const a = S.byId.get(e.source), b = S.byId.get(e.target), out = [];
    out.push(h("div", { class: "tags" }, polTag(e), e.confidence && h("span", { class: "tag" }, `신뢰도 ${CONF[e.confidence]}`)));
    out.push(h("h2", { class: "n-title" }, nodeBtn(a.id), e.sk === "similar" ? " ↔ " : " → ", nodeBtn(b.id)));
    if (!edgeOn(e)) out.push(hiddenSelf("간선은"));
    else if (S.tension) out.push(h("p", { class: "n-meta", "data-live": "tension", "data-id": e.id }, tensionText(e)));
    if (e.kind === "relation") {
      const rv = S.graph.vocab.relations[e.type];
      if (rv) out.push(h("p", { class: "dim", style: "font-size:12.5px;margin:4px 0 8px" }, `${rv.label}: ${rv.desc}`));
      out.push(h("section", { class: "sec" }, h("h3", null, "관계 설명"), h("p", { style: "margin:0;font-size:13px" }, e.note)));
      out.push(h("section", { class: "sec" }, h("h3", null, `주장 (${a.label} ${e.claim.id})`), h("p", { style: "margin:0;font-size:13px" }, e.claim.text),
        e.target_claim ? [h("h4", null, `대상 주장 (${b.label} ${e.target_claim.id})`), h("p", { style: "margin:0;font-size:13px" }, e.target_claim.text)] : null));
      out.push(h("section", { class: "sec" }, h("h3", null, `원문 근거 (${a.label})`), e.evidence.map(quote)));
      out.push(h("p", { class: "dim", style: "font-size:12px" }, `이 관계는 ${a.label} 노트가 근거와 함께 주장합니다. 각 노트는 서로의 내용을 복사하지 않고 id로만 연결됩니다.`));
    } else if (e.kind === "cites") {
      out.push(h("section", { class: "sec" }, h("h3", null, "인용"), h("p", { style: "margin:0;font-size:13px" }, `${a.label}의 참고문헌에 ${b.label}가 있습니다.`), e.cite ? h("p", { class: "dim", style: "font-size:12.5px" }, e.cite) : null));
    } else if (e.kind === "gap") {
      out.push(h("section", { class: "sec" }, h("h3", null, "공백 후보 인용"), h("p", { style: "margin:0;font-size:13px" }, `${a.label}가 vault에 없는 ${b.label}를 인용합니다.${edgeOn(e) ? ` 이 문헌을 인용한 노트: ${b.cited_by.length}편.` : ""}`)));
    } else {
      const sh = e.shared || {}, p = e.parts || {};
      const row = (name, key, lab) => h("li", null, `${name} ${((p[key] || 0) * 100).toFixed(0)}% — `, (sh[key] || []).length ? (sh[key] || []).map((x) => lab ? vocab(lab, x) : x).join(", ") : "공통 없음");
      out.push(h("section", { class: "sec" }, h("h3", null, `유사도 ${e.weight.toFixed(3)}`), h("p", { class: "dim", style: "font-size:12.5px;margin:0 0 6px" }, "토픽·키워드 각 35%, 방법론·참고문헌 각 15% 가중의 Jaccard 합 (자동 계산, 방향 없음)"),
        h("ul", { style: "padding-left:18px;margin:0;font-size:12.5px" }, row("토픽", "topics", "topics"), row("키워드", "keywords"), row("방법론", "methods", "methods"), row("참고문헌", "references"))));
    }
    const same = (e.pair || []).filter((x) => x !== e && edgeOn(x));
    if (same.length) out.push(h("section", { class: "sec" }, h("h3", null, "같은 두 노트 사이의 다른 간선"), h("ul", { style: "padding-left:18px;margin:0;font-size:12.5px" }, same.map((x) => h("li", null, edgeBtn(x, ESTYLE[x.sk].label), S.tension ? [" · ", h("span", { "data-live": "tension", "data-id": x.id }, tensionText(x))] : "")))));
    return out;
  }

  function panelTension() {
    const es = S.edges.filter(edgeOn).filter((e) => e.L), out = [];
    out.push(h("div", { class: "explain" },
      "간선은 스프링입니다. 관계 유형마다 자연 길이와 강성이 다르고(보완은 짧고 단단, 충돌은 길게), 모든 노드는 서로 밀어냅니다. ",
      h("b", null, "늘어남(+)"), "은 다른 힘 때문에 원하는 거리보다 멀어진 연결이고, ", h("b", null, "눌림(−)"),
      "은 원하는 거리보다 가까이 붙들린 연결입니다(예: 충돌 관계인데 인용·같은 방법론이 끌어당김). 값이 0.00으로 보이면 평형입니다. 장력은 진위가 아니라 살펴볼 지점을 가리킵니다."));
    if (!es.length) { out.push(h("p", { class: "empty" }, "표시 중인 간선이 없습니다.")); return out; }
    if (S.running) out.push(h("p", { class: "notice" }, "배치가 아직 움직이는 중입니다 — 멈춘 뒤 값이 안정됩니다."));
    const pol = (e) => ESTYLE[e.sk].color;
    const pairs = new Map();
    for (const e of es) { const k = [e.source, e.target].sort().join("|"); if (!pairs.has(k)) pairs.set(k, []); pairs.get(k).push(e); }
    const tense = [...pairs.values()].filter((l) => l.some((e) => pol(e) === "neg") && l.some((e) => pol(e) !== "neg"));
    if (tense.length) {
      out.push(h("section", { class: "sec" }, h("h3", null, `긴장 쌍 ${tense.length} — 충돌과 연결이 함께 있는 노트 쌍`),
        tense.map((l) => {
          const [p, q] = [S.byId.get(l[0].source), S.byId.get(l[0].target)];
          return h("div", { class: "rel" }, h("div", { class: "rel-head" }, nodeBtn(p.id), " ↔ ", nodeBtn(q.id)),
            h("ul", { style: "padding-left:18px;margin:4px 0 0;font-size:12.5px" }, l.map((e) => h("li", null, edgeBtn(e, ESTYLE[e.sk].label), " · ", h("span", { "data-live": "tension", "data-id": e.id }, tensionText(e))))));
        })));
    }
    const top = es.slice().sort((a, b) => Math.abs(b.T) - Math.abs(a.T)).slice(0, 12);
    out.push(h("section", { class: "sec" }, h("h3", null, "장력 큰 간선"),
      h("table", { class: "list" }, h("thead", null, h("tr", null, h("th", null, "간선"), h("th", null, "두 노트"), h("th", { class: "num" }, "장력"))),
        h("tbody", null, top.map((e) => h("tr", null, h("td", null, edgeBtn(e, ESTYLE[e.sk].label)), h("td", null, `${S.byId.get(e.source).label} ${e.sk === "similar" ? "↔" : "→"} ${S.byId.get(e.target).label}`),
          h("td", { class: "num", "data-live": "T", "data-id": e.id }, fmtT(e.T))))))));
    const ns = S.nodes.filter((n) => n.kind === "note" && nodeOn(n)).sort((a, b) => b.stress - a.stress);
    out.push(h("section", { class: "sec" }, h("h3", null, "응력 큰 노드"), h("p", { class: "dim", style: "font-size:12.5px;margin:0 0 6px" }, "보이는 간선 장력 절댓값의 합 — 여러 방향에서 당겨지는 노트"),
      h("table", { class: "list" }, h("tbody", null, ns.map((n) => h("tr", null, h("td", null, nodeBtn(n.id)), h("td", { class: "num", "data-live": "stress", "data-id": n.id }, n.stress.toFixed(2))))))));
    return out;
  }

  function panelGaps() {
    const g = S.graph.gaps, out = [];
    out.push(h("div", { class: "explain" }, "공백은 vault가 아직 다루지 않는 곳입니다: 여러 노트가 함께 인용하지만 vault에 없는 문헌, 노트 한 편에만 있는 토픽, 근거 있는 연결이 없는 노트, 각 노트가 남긴 열린 질문. 'vault 밖 공통 인용'은 위쪽 '공백' 간선 필터를 따르고, 나머지는 필터와 관계없이 vault 전체 기준입니다."));
    out.push(h("section", { class: "sec" }, h("h3", null, S.filters.gap ? `vault 밖 공통 인용 ${g.missing_references.length}` : "vault 밖 공통 인용"),
      !S.filters.gap ? h("p", { class: "notice" }, "공백 간선이 필터로 숨겨져 있습니다. 위쪽 간선 종류의 '공백'을 켜면 목록이 보입니다.")
      : g.missing_references.length ? g.missing_references.map((r) => h("div", { class: "rel" },
        h("div", { class: "rel-head" }, h("button", { class: "rowbtn", type: "button", onclick: () => select({ kind: "node", id: `ref:${r.key}` }) }, r.label), h("span", { class: "dim" }, `${r.cited_by.length}편이 인용`)),
        h("p", null, r.cite), h("p", null, "인용: ", r.cited_by.map((id, i) => [i ? ", " : "", nodeBtn(id)]))))
        : h("p", { class: "empty" }, "없음")));
    out.push(h("section", { class: "sec" }, h("h3", null, `근거 있는 연결이 없는 노트 ${g.isolated_notes.length}`),
      g.isolated_notes.length ? h("ul", { style: "padding-left:18px;margin:0" }, g.isolated_notes.map((id) => h("li", null, nodeBtn(id)))) : h("p", { class: "empty" }, "없음 — 모든 노트가 관계나 인용으로 이어져 있습니다.")));
    out.push(h("section", { class: "sec" }, h("h3", null, `노트 한 편에만 있는 토픽 ${g.singleton_topics.length}`),
      g.singleton_topics.length ? h("ul", { style: "padding-left:18px;margin:0;font-size:12.5px" }, g.singleton_topics.map((t) => h("li", null, `${t.label} — `, nodeBtn(t.note)))) : h("p", { class: "empty" }, "없음")));
    const byNote = new Map();
    for (const q of g.open_questions) { if (!byNote.has(q.note)) byNote.set(q.note, []); byNote.get(q.note).push(q.text); }
    out.push(h("section", { class: "sec" }, h("h3", null, `열린 질문 ${g.open_questions.length}`),
      [...byNote.entries()].map(([id, qs]) => [h("h4", null, nodeBtn(id)), h("ul", { style: "padding-left:18px;margin:0;font-size:12.5px" }, qs.map((q) => h("li", null, q)))])));
    return out;
  }

  function panelList() { // 그래프의 표 보기 (색·도형 없이 같은 정보)
    const ns = S.nodes.filter((n) => n.kind === "note").sort((a, b) => a.year - b.year);
    const es = S.edges.filter(edgeOn).sort((a, b) => GROUPS.findIndex((g) => g.id === groupOf(a)) - GROUPS.findIndex((g) => g.id === groupOf(b)) || a.id.localeCompare(b.id));
    return [
      h("section", { class: "sec" }, h("h3", null, `노트 ${ns.length}`),
        h("table", { class: "list" }, h("thead", null, h("tr", null, h("th", null, "노트"), h("th", null, "분야"), h("th", { class: "num" }, "연결"), h("th", { class: "num" }, "응력"))),
          h("tbody", null, ns.map((n) => h("tr", null, h("td", null, nodeBtn(n.id)), h("td", null, vocab("areas", n.area)), h("td", { class: "num" }, degOn(n)), h("td", { class: "num", "data-live": "stress", "data-id": n.id }, n.stress.toFixed(2))))))),
      h("section", { class: "sec" }, h("h3", null, `간선 ${es.length}`), hiddenNote(S.edges.length - es.length),
        h("table", { class: "list" }, h("thead", null, h("tr", null, h("th", null, "유형"), h("th", null, "원천 → 대상"), h("th", { class: "num" }, "강도"), h("th", { class: "num" }, "장력"))),
          h("tbody", null, es.map((e) => h("tr", null, h("td", null, edgeBtn(e, ESTYLE[e.sk].label)), h("td", null, `${S.byId.get(e.source).label} ${e.sk === "similar" ? "↔" : "→"} ${S.byId.get(e.target).label}`),
            h("td", { class: "num" }, e.confidence ? CONF[e.confidence] : (e.weight || 0).toFixed(2)), h("td", { class: "num", "data-live": "T", "data-id": e.id }, e.L ? fmtT(e.T) : "-")))))),
    ];
  }

  /* ---------- 범례·필터·통계 ---------- */
  function renderChrome() {
    const fs = $("edgeFilters"); fs.replaceChildren(h("legend", { class: "sr-only", style: "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)" }, "간선 종류"));
    for (const g of GROUPS) {
      fs.append(h("button", { class: "chip", type: "button", "aria-pressed": String(S.filters[g.id]), title: g.keys.map((k) => ESTYLE[k].label).join(" · "),
        onclick: (ev) => { S.filters[g.id] = !S.filters[g.id]; ev.currentTarget.setAttribute("aria-pressed", String(S.filters[g.id])); saveUi(); measure(); kick(false); draw(); renderStat(); renderPanel(); } },
        lineKey(g.sample || g.keys[g.keys.length - 1]), g.label));
    }
    const lg = $("legend"); lg.replaceChildren();
    lg.append(h("div", { class: "lg-row" }, h("span", { class: "lg-title" }, "관계"),
      REL_TYPES().map((k) => h("span", { class: "lg-item" }, lineKey(k), ESTYLE[k].label))));
    lg.append(h("div", { class: "lg-row" }, h("span", { class: "lg-title" }, "자동"),
      ["cites", "similar", "gap"].map((k) => h("span", { class: "lg-item" }, lineKey(k), ESTYLE[k].label))));
    const areas = [...new Set(S.nodes.filter((n) => n.kind === "note").map((n) => n.area))].sort((a, b) => AREA_ORDER.indexOf(a) - AREA_ORDER.indexOf(b));
    lg.append(h("div", { class: "lg-row" }, h("span", { class: "lg-title" }, "분야"),
      areas.map((a) => h("span", { class: "lg-item" }, shapeKey(shapeOf(a)), vocab("areas", a))),
      h("span", { class: "lg-item" }, shapeKey("circle", true), "vault 밖 문헌")));
    renderStat();
    $("repoInfo").textContent = `${S.repo.owner}/${S.repo.repo}${S.repo.ref ? ` @ ${S.repo.ref}` : ""}`;
  }
  function renderStat() { // 맨 위 통계 줄: 보이는 것만 세고, 필터로 숨긴 간선이 있으면 그 수를 따로 밝힌다
    const c = relationCounts(edgeOn), hidden = S.edges.filter((e) => !edgeOn(e)).length;
    $("stat").textContent = `노트 ${S.nodes.filter((n) => n.kind === "note").length} · 관계 ${c.relation} · 인용 ${c.cites} · 유사도 ${c.similar} · 공백 문헌 ${S.nodes.filter((n) => n.kind === "gap" && nodeOn(n)).length}${hidden ? ` · 숨긴 간선 ${hidden}` : ""} · 갱신 ${S.graph.meta.updated || "-"}`;
  }
  function saveUi() { ls.set(KEY.ui, JSON.stringify({ filters: S.filters, tension: S.tension })); }
  function loadUi() {
    try { const u = JSON.parse(ls.get(KEY.ui) || "null"); if (u) { if (u.filters) for (const g of GROUPS) if (typeof u.filters[g.id] === "boolean") S.filters[g.id] = u.filters[g.id]; if (typeof u.tension === "boolean") S.tension = u.tension; } }
    catch (e) { /* 무시 */ }
  }

  /* ---------- 흐름 ---------- */
  function showGate(msg) {
    $("app").hidden = true; $("gate").hidden = false; hideTip(); S.hover = null;
    $("lockBtn").hidden = !S.token; $("reloadBtn").hidden = !S.token; // 연결 실패로 돌아온 경우에도 저장된 토큰을 잠글 수 있게
    $("gateMsg").textContent = msg || "";
    $("gateRepo").textContent = `${S.repo.owner}/${S.repo.repo}`;
    $("repoIn").value = `${S.repo.owner}/${S.repo.repo}`; $("refIn").value = S.repo.ref || "";
    setTimeout(() => $("tokenIn").focus(), 0);
  }
  function showApp() { $("gate").hidden = true; $("app").hidden = false; $("lockBtn").hidden = false; $("reloadBtn").hidden = false; $("gateMsg").textContent = ""; }
  async function load() {
    const seq = ++S.loadSeq; // 잠그기·다시 불러오기가 끼어들면 늦게 온 응답은 버린다
    $("panelBody").classList.add("loading");
    try {
      const g = await gh("vault/_build/graph.json");
      if (seq !== S.loadSeq) return false;
      if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges) || !g.gaps || !g.vocab) throw new Error("graph.json 형식이 올바르지 않습니다");
      S.graph = g; S.detail.clear();
      buildModel(g); measure(); showApp(); readColors(); renderChrome(); renderTabs(); renderPanel();
      if (!S.nodes.length) { $("panelBody").replaceChildren(...(S.notice ? [h("p", { class: "notice" }, S.notice)] : []), h("p", { class: "empty" }, "아직 노트가 없습니다. for_kg에 노트를 추가하면 여기에 나타납니다.")); }
      S.fitted = false; kick(false);
      return true;
    } catch (err) {
      if (seq !== S.loadSeq) return false;
      if (err instanceof HttpError && (err.status === 401 || err.status === 404 || (err.status === 403 && err.detail !== "ratelimit"))) { forgetToken(); showGate(errorText(err)); }
      else if (S.graph && !$("app").hidden) { $("panelBody").prepend(h("p", { class: "notice" }, errorText(err))); } // 그래프를 보는 중일 때만 패널에 (게이트가 떠 있으면 게이트에)
      else showGate(errorText(err));
      return false;
    } finally { $("panelBody").classList.remove("loading"); }
  }
  // 토큰 보관: 기억이면 기기(localStorage), 아니면 이 탭(sessionStorage). 기기에 저장되지 않으면(용량·차단) 이 탭에 두고 기억을 끈다.
  // 이 탭 저장소도 막혀 있으면 토큰은 이 페이지에만 있으므로 그렇게 알린다
  const SAVE_FAIL = "이 기기에 저장하지 못해(저장 공간 부족 또는 차단) 이 탭에만 보관합니다.";
  const KEEP_FAIL = "브라우저가 저장소를 막고 있어 토큰을 보관하지 못했습니다. 페이지를 새로 고치면 다시 넣어야 합니다.";
  function keepToken(tok, remember) {
    if (remember && ls.set(KEY.token, tok)) { ss.del(KEY.token); return ""; }
    const kept = ss.set(KEY.token, tok); ls.del(KEY.token);
    if (remember) $("rememberIn").checked = false;
    return !kept ? KEEP_FAIL : remember ? SAVE_FAIL : "";
  }
  function forgetToken() { S.token = null; ss.del(KEY.token); ls.del(KEY.token); $("rememberIn").checked = false; }
  function parseRepo(text) {
    const m = String(text || "").trim().match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/);
    return m ? { owner: m[1], repo: m[2] } : null;
  }

  function init() {
    // 테마 (다른 대시보드와 같은 'theme' 키)
    const saved = ls.get(KEY.theme);
    if (saved === "dark" || saved === "light") document.documentElement.dataset.theme = saved;
    $("themeBtn").addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next; ls.set(KEY.theme, next); readColors(); draw();
    });
    try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readColors(); draw(); }); } catch (e) { /* 구형 브라우저 */ }

    try { const r = JSON.parse(ls.get(KEY.repo) || "null"); if (r && parseRepo(`${r.owner}/${r.repo}`)) S.repo = { owner: r.owner, repo: r.repo, ref: typeof r.ref === "string" ? r.ref : "" }; }
    catch (e) { /* 기본값 */ }
    loadUi();
    $("tensionIn").checked = S.tension;
    setupCanvas(); readColors();

    $("gateForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const tok = $("tokenIn").value.trim();
      if (!TOKEN_RE.test(tok)) { $("gateMsg").textContent = "토큰 형식이 아닙니다. github_pat_로 시작하는 fine-grained 토큰을 붙여넣으세요."; return; }
      const r = parseRepo($("repoIn").value || "hahajongha/for_kg");
      if (!r) { $("gateMsg").textContent = "저장소는 소유자/이름 형식으로 적어 주세요 (예: hahajongha/for_kg)."; return; }
      S.repo = { ...r, ref: $("refIn").value.trim() };
      ls.set(KEY.repo, JSON.stringify(S.repo));
      S.token = tok; $("tokenIn").value = "";
      S.notice = keepToken(tok, $("rememberIn").checked);
      $("gateMsg").textContent = S.notice || "불러오는 중…";
      await load();
    });
    $("rememberIn").addEventListener("change", (ev) => { // 기억 여부를 바로 반영: 끄면 기기 저장소에서 지우고 이 탭에만 둔다
      if (!S.token) return;
      const msg = keepToken(S.token, ev.currentTarget.checked);
      S.notice = msg; // 다음에 열릴 때 보일 안내도 지금 상태를 따른다
      if (msg) $("gateMsg").textContent = msg;
      else if ([SAVE_FAIL, KEEP_FAIL].includes($("gateMsg").textContent)) $("gateMsg").textContent = ""; // 다시 저장되면 실패 문구를 지운다
    });
    $("lockBtn").addEventListener("click", () => { S.loadSeq++; forgetToken(); S.notice = ""; S.graph = null; S.nodes = []; S.edges = []; S.detail.clear(); S.sel = null; $("panelBody").replaceChildren(); showGate("잠갔습니다. 이 기기에 저장된 토큰도 지웠습니다."); });
    $("reloadBtn").addEventListener("click", () => load());
    $("reheatBtn").addEventListener("click", () => { for (const n of S.nodes) n.pinned = false; kick(true); });
    $("fitBtn").addEventListener("click", () => { fitView(); draw(); rehover(); });
    $("tensionIn").addEventListener("change", (ev) => { S.tension = ev.currentTarget.checked; saveUi(); draw(); renderPanel(); });
    $("searchIn").addEventListener("input", (ev) => {
      const q = ev.currentTarget.value.trim().toLowerCase(); S.search = q;
      S.hits = q ? new Set(S.nodes.filter((n) => [n.label, n.title, ...(n.keywords || []), ...(n.topics || []).flatMap((t) => [t, vocab("topics", t)])].some((s) => String(s).toLowerCase().includes(q))).map((n) => n.id)) : null;
      draw();
    });
    document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { S.tab = b.dataset.tab; S.notice = ""; renderTabs(); renderPanel(); }));
    $("panelBody").addEventListener("keydown", (ev) => { if (ev.key === "Escape") select(null); });

    S.token = ss.get(KEY.token) || ls.get(KEY.token);
    if (S.token && !TOKEN_RE.test(S.token)) forgetToken(); // 저장된 값도 같은 형식만 쓴다
    $("rememberIn").checked = !!ls.get(KEY.token);
    if (S.token) { $("gate").hidden = true; load(); } else showGate("");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
