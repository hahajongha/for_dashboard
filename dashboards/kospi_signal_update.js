/* KOSPI 시그널 랩 — [Drive에서 업데이트] 버튼
 *
 * for_data 저장소의 'kospi-drive-sync.yml' 워크플로(Drive 최신 엑셀 → kospi_signal.json 발행)를
 * GitHub API로 실행하고, 실행 → 발행 → 사이트 반영까지 추적한다.
 *
 * - 토큰: fine-grained PAT (저장소 for_data 한 곳, 권한 Actions: Read and write).
 *   이 브라우저의 localStorage 에만 저장하며 페이지 코드·저장소에는 들어가지 않는다.
 * - 토큰이 없으면 GitHub Actions 실행 페이지로 안내한다 (거기서 Run workflow).
 *
 * 사용: KSU.init({ panel, badge, onPublished(json), dataUrl })  →  KSU.run()
 */
(function (root) {
  "use strict";

  var OWNER = "hahajongha", REPO = "for_data", WORKFLOW = "kospi-drive-sync.yml";
  var API = "https://api.github.com";
  var ACTIONS_PAGE = "https://github.com/" + OWNER + "/" + REPO + "/actions/workflows/" + WORKFLOW;
  var TOKEN_KEY = "kospiSignal.ghToken.v1";
  var PUBLISH_STEP = "Publish"; // kospi-drive-sync.yml 의 발행 단계 이름 (success=갱신, skipped=변경 없음)

  var STAGES = [["request", "요청"], ["run", "실행"], ["publish", "발행"], ["site", "사이트 반영"]];

  var opt = { pollMs: 4000, sitePollMs: 5000, runTimeoutMs: 15 * 60e3, siteTimeoutMs: 5 * 60e3,
              dataUrl: "../data/kospi_signal.json", onPublished: null, panel: null, badge: null };
  var busy = false;
  var ui = {};

  // ---------- 저장소 (try/catch 필수: 사생활 보호 모드 등에서 예외) ----------
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); return true; } catch (e) { return false; } }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }

  // ---------- GitHub API ----------
  function gh(path, init) {
    init = init || {};
    var h = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
              "Authorization": "Bearer " + getToken() };
    if (init.body) h["Content-Type"] = "application/json";
    return fetch(API + path, { method: init.method || "GET", headers: h, body: init.body, cache: "no-store" });
  }
  function apiError(res, what) {
    var m = {
      401: "토큰이 올바르지 않거나 만료되었습니다. 아래 '토큰 설정'에서 새 토큰을 저장해 주세요.",
      403: "토큰 권한이 부족합니다. for_data 저장소에 Actions: Read and write 권한이 있는 토큰인지 확인해 주세요.",
      404: "워크플로를 찾을 수 없습니다. 토큰의 저장소 범위(for_data)와 워크플로가 기본 브랜치에 병합되었는지 확인해 주세요.",
      422: "워크플로 실행 요청이 거부되었습니다 (브랜치/입력값 확인 필요).",
    };
    return new Error((m[res.status] || ("GitHub API 오류 " + res.status)) + " [" + what + "]");
  }

  // ---------- 화면 ----------
  var CSS =
    ".ksu{display:grid;gap:10px}" +
    ".ksu .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}" +
    ".ksu .stages{display:flex;flex-wrap:wrap;gap:6px}" +
    ".ksu .stage{border:1px solid var(--border);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--muted)}" +
    ".ksu .stage[data-s=active]{color:var(--ink);border-color:var(--s1);box-shadow:inset 0 0 0 1px var(--s1)}" +
    ".ksu .stage[data-s=done]{color:var(--ink);background:var(--grid)}" +
    ".ksu .stage[data-s=fail]{color:var(--up);border-color:var(--up)}" +
    ".ksu .msg{font-size:13px;color:var(--ink-2);min-height:1.5em}" +
    ".ksu .msg[data-kind=error]{color:var(--up)}" +
    ".ksu .msg a,.ksu .hint a{color:var(--s1)}" +
    ".ksu .hint{font-size:12px;color:var(--muted)}" +
    ".ksu input[type=password]{flex:1 1 220px;min-width:0;background:var(--surface);color:var(--ink);" +
    "border:1px solid var(--border);border-radius:8px;padding:5px 8px;font-size:13px}" +
    ".ksu button:disabled{opacity:.55;cursor:progress}" +
    ".ksu-badge{font-size:12px;color:var(--ink-2)}" +
    ".ksu-badge[data-kind=error]{color:var(--up)}";

  function injectCss() {
    if (document.getElementById("ksuCss")) return;
    var s = el("style", { id: "ksuCss" }); s.textContent = CSS; document.head.appendChild(s);
  }

  function buildPanel(host) {
    host.textContent = "";
    var wrap = el("div", { "class": "ksu" });
    var p = el("p", { "class": "hint" });
    p.textContent = "Drive 폴더에 새 엑셀(BOP 시트 포함)을 올린 뒤 실행하면, 가장 최근 파일로 공개 데이터(최근 3년)를 " +
      "다시 만들어 사이트에 반영합니다. 보통 1~3분 걸립니다.";
    wrap.appendChild(p);

    var row = el("div", { "class": "row" });
    ui.runBtn = el("button", { "class": "theme-btn", type: "button", id: "ksuRun" }, "Drive에서 업데이트 실행");
    ui.runBtn.addEventListener("click", function () { run(); });
    row.appendChild(ui.runBtn);
    ui.logLink = el("a", { href: ACTIONS_PAGE, target: "_blank", rel: "noopener", "class": "hint", id: "ksuLog" },
      "GitHub에서 실행 기록 보기 ↗");
    row.appendChild(ui.logLink);
    wrap.appendChild(row);

    ui.stages = el("div", { "class": "stages", "aria-live": "polite" });
    ui.stageEls = {};
    STAGES.forEach(function (s) {
      var c = el("span", { "class": "stage", "data-s": "idle" }, s[1]);
      ui.stageEls[s[0]] = c; ui.stages.appendChild(c);
    });
    wrap.appendChild(ui.stages);
    ui.msg = el("div", { "class": "msg", id: "ksuMsg", role: "status" });
    wrap.appendChild(ui.msg);

    // 토큰 설정
    var det = el("details", { id: "ksuTokenBox" });
    det.appendChild(el("summary", null, "토큰 설정 (이 브라우저에만 저장)"));
    var tokRow = el("div", { "class": "row", style: "margin-top:8px" });
    ui.tokInput = el("input", { type: "password", id: "ksuToken", autocomplete: "off",
      placeholder: "github_pat_… (for_data · Actions: Read and write)", "aria-label": "GitHub 토큰" });
    var save = el("button", { "class": "theme-btn", type: "button", id: "ksuTokenSave" }, "저장");
    var del = el("button", { "class": "theme-btn", type: "button", id: "ksuTokenDel" }, "삭제");
    save.addEventListener("click", function () {
      var t = ui.tokInput.value.trim();
      if (!t) { say("토큰을 입력해 주세요.", "error"); return; }
      say(setToken(t) ? "토큰을 이 브라우저에 저장했습니다." : "이 브라우저에서는 저장소를 쓸 수 없어 토큰을 저장하지 못했습니다.",
          getToken() ? "" : "error");
      ui.tokInput.value = ""; refreshTokenState();
    });
    del.addEventListener("click", function () { setToken(""); say("저장된 토큰을 삭제했습니다."); refreshTokenState(); });
    tokRow.appendChild(ui.tokInput); tokRow.appendChild(save); tokRow.appendChild(del);
    det.appendChild(tokRow);
    ui.tokState = el("p", { "class": "hint", id: "ksuTokenState" });
    det.appendChild(ui.tokState);
    var help = el("p", { "class": "hint" });
    help.appendChild(document.createTextNode("GitHub → Settings → Developer settings → Fine-grained tokens에서 " +
      "저장소를 for_data 하나만 선택하고 권한 Actions를 Read and write로 만든 토큰입니다. " +
      "토큰이 없어도 "));
    help.appendChild(el("a", { href: ACTIONS_PAGE, target: "_blank", rel: "noopener" }, "Actions 페이지"));
    help.appendChild(document.createTextNode("에서 Run workflow로 같은 작업을 실행할 수 있습니다."));
    det.appendChild(help);
    wrap.appendChild(det);
    ui.tokBox = det;

    host.appendChild(wrap);
    refreshTokenState();
  }

  function refreshTokenState() {
    if (!ui.tokState) return;
    var t = getToken();
    ui.tokState.textContent = t ? "저장된 토큰: " + t.slice(0, 11) + "…" + t.slice(-4) : "저장된 토큰이 없습니다.";
    if (!t && ui.tokBox) ui.tokBox.open = true;
  }

  function stage(key, state) {
    if (!ui.stageEls) return;
    if (key === "reset") { for (var k in ui.stageEls) ui.stageEls[k].setAttribute("data-s", "idle"); return; }
    if (ui.stageEls[key]) ui.stageEls[key].setAttribute("data-s", state);
  }
  function say(text, kind, link) {
    [ui.msg, opt.badge].forEach(function (n) {
      if (!n) return;
      n.textContent = text;
      n.setAttribute("data-kind", kind || "");
      if (link && n === ui.msg) {
        n.appendChild(document.createTextNode(" "));
        n.appendChild(el("a", { href: link, target: "_blank", rel: "noopener" }, "실행 기록 ↗"));
      }
    });
  }
  function setBusy(b) { busy = b; if (ui.runBtn) ui.runBtn.disabled = b; }

  // ---------- 실행 흐름 ----------
  function defaultBranch() {
    return gh("/repos/" + OWNER + "/" + REPO).then(function (r) {
      if (!r.ok) throw apiError(r, "저장소 조회");
      return r.json();
    }).then(function (j) { return j.default_branch; });
  }

  function findRun(t0) {
    var q = "/repos/" + OWNER + "/" + REPO + "/actions/workflows/" + WORKFLOW + "/runs?event=workflow_dispatch&per_page=10";
    return gh(q).then(function (r) {
      if (!r.ok) throw apiError(r, "실행 조회");
      return r.json();
    }).then(function (j) {
      var runs = (j.workflow_runs || []).filter(function (x) { return Date.parse(x.created_at) >= t0 - 30e3; });
      runs.sort(function (a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at); });
      return runs[0] || null;
    });
  }

  function publishStep(runId) {
    return gh("/repos/" + OWNER + "/" + REPO + "/actions/runs/" + runId + "/jobs").then(function (r) {
      if (!r.ok) throw apiError(r, "작업 조회");
      return r.json();
    }).then(function (j) {
      var steps = [];
      (j.jobs || []).forEach(function (job) { steps = steps.concat(job.steps || []); });
      var s = steps.filter(function (x) { return x.name === PUBLISH_STEP; })[0];
      return s ? s.conclusion : null;
    });
  }

  function waitForSite(t0iso) {
    var end = Date.now() + opt.siteTimeoutMs;
    function tick() {
      var sep = opt.dataUrl.indexOf("?") >= 0 ? "&" : "?";
      return fetch(opt.dataUrl + sep + "t=" + Date.now(), { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (j) {
          if (j && j.meta && j.meta.generated_at && j.meta.generated_at >= t0iso) return j;
          if (Date.now() > end) return null;
          return sleep(opt.sitePollMs).then(tick);
        });
    }
    return tick();
  }

  function run() {
    if (busy) return Promise.resolve();
    if (!getToken()) {
      stage("reset");
      say("토큰이 없어 이 페이지에서 바로 실행할 수 없습니다. '토큰 설정'에서 저장하거나, GitHub Actions 페이지에서 Run workflow를 눌러 주세요.",
          "error", ACTIONS_PAGE);
      refreshTokenState();
      return Promise.resolve();
    }
    setBusy(true); stage("reset");
    var t0 = Date.now();
    var t0iso = new Date(t0 - 5e3).toISOString().replace(/\.\d{3}Z$/, "Z"); // 생성시각 비교용(초 단위)
    var runUrl = ACTIONS_PAGE;
    stage("request", "active"); say("실행을 요청하는 중…");

    return defaultBranch().then(function (ref) {
      return gh("/repos/" + OWNER + "/" + REPO + "/actions/workflows/" + WORKFLOW + "/dispatches", {
        method: "POST", body: JSON.stringify({ ref: ref, inputs: { force: "false" } }),
      });
    }).then(function (r) {
      if (r.status !== 204 && !r.ok) throw apiError(r, "실행 요청");
      stage("request", "done"); stage("run", "active"); say("GitHub Actions에서 실행을 기다리는 중…");
      var end = Date.now() + opt.runTimeoutMs;
      function poll() {
        return findRun(t0).then(function (runObj) {
          if (runObj) {
            runUrl = runObj.html_url || runUrl;
            if (runObj.status === "completed") return runObj;
            say(runObj.status === "queued" ? "대기열에 들어갔습니다…" : "Drive에서 파일을 받아 데이터를 만드는 중…", "", runUrl);
          }
          if (Date.now() > end) throw new Error("실행이 제한 시간 안에 끝나지 않았습니다.");
          return sleep(opt.pollMs).then(poll);
        });
      }
      return poll();
    }).then(function (runObj) {
      if (runObj.conclusion !== "success") {
        stage("run", "fail");
        throw Object.assign(new Error("워크플로가 실패했습니다 (" + runObj.conclusion + "). Drive 폴더 공유·시크릿 설정·엑셀 양식을 확인해 주세요."),
          { link: runUrl });
      }
      stage("run", "done"); stage("publish", "active");
      return publishStep(runObj.id);
    }).then(function (pub) {
      if (pub === "skipped") {
        stage("publish", "done"); stage("site", "done");
        say("변경 없음 — Drive 최신 파일의 데이터가 이미 사이트에 반영되어 있습니다.", "", runUrl);
        return null;
      }
      stage("publish", "done"); stage("site", "active");
      say("발행 완료. 사이트(GitHub Pages)에 반영되기를 기다리는 중… (보통 1분 내외)", "", runUrl);
      return waitForSite(t0iso).then(function (json) {
        if (!json) {
          stage("site", "fail");
          throw Object.assign(new Error("발행은 되었지만 사이트 반영 확인이 늦어지고 있습니다. 잠시 후 새로고침해 주세요."), { link: runUrl });
        }
        stage("site", "done");
        say("업데이트 완료 — 데이터 기준일 " + (json.meta.latest_data_date || "?") + ".", "", runUrl);
        if (typeof opt.onPublished === "function") opt.onPublished(json);
        return json;
      });
    }).catch(function (e) {
      if (ui.stageEls) for (var k in ui.stageEls) if (ui.stageEls[k].getAttribute("data-s") === "active") stage(k, "fail");
      say(e.message || String(e), "error", e.link || runUrl);
      return null;
    }).then(function (res) { setBusy(false); return res; });
  }

  function init(o) {
    for (var k in o) if (o[k] !== undefined) opt[k] = o[k];
    injectCss();
    if (opt.panel) buildPanel(opt.panel);
  }

  root.KSU = { init: init, run: run, hasToken: function () { return !!getToken(); },
               ACTIONS_PAGE: ACTIONS_PAGE, _opt: opt };
})(typeof window !== "undefined" ? window : this);
