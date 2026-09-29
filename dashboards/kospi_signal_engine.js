/* KOSPI 시그널 랩 — 계산 엔진 (순수 함수 · DOM 없음)
   브라우저: window.KSE / Node: module.exports. 규칙은 SPEC §2–§10, §14.
   인덱스 규칙: data·지표·신호는 전체 이력 기준 i, 백테스트 배열(nav·pos·tgt·daily)은 기간 기준 k = i − i0. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.KSE = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = "1.1.0";
  const DEFAULTS = {
    bopMa: 14, dispMa: 50, buyThr: -0.20, sellThr: 120, holdBuy: 60, holdSell: 60,
    dualMax: 95, maxWait: 0, gap: 10, exec: "nextOpen", costBp: 5, cashRate: 0, swingInit: 1, base: 1000,
    horizons: [5, 20, 60, 120], iters: 2000, seed: 42, maeH: 60,
  };
  const EXEC_MODES = ["nextOpen", "nextClose", "close"];
  const EXEC_LABELS = { nextOpen: "익일 시가", nextClose: "익일 종가", close: "당일 종가" };
  const STRATEGIES = [
    { id: "BH", name: "KOSPI Buy & Hold", short: "B&H", init: 1,
      desc: "기간 시작부터 끝까지 KOSPI를 계속 보유하는 패시브 기준선." },
    { id: "S1", name: "BOP 매수 (N일 보유)", short: "BOP 매수", init: 0,
      desc: "평소 현금. B(BOP 평균이 매수 임계치 아래로 진입)에 매수해 '매수 후 보유(일)' 동안 보유 후 청산. 보유 중 새 B가 나오면 보유 기간을 연장." },
    { id: "S2", name: "이격도 매도 (N일 회피)", short: "이격도 매도", init: 1,
      desc: "평소 보유. S(이격도가 매도 임계치 위로 진입)에 매도해 '매도 후 회피(일)' 동안 현금, 이후 재매수. 회피 중 새 S가 나오면 회피 기간을 연장." },
    { id: "S3", name: "스윙: BOP 매수 ↔ 이격도 매도", short: "스윙", init: null,
      desc: "B에 매수해 다음 S까지 보유, S에 매도해 다음 B까지 현금. 'B 신호 최대 대기'(0 = 무기한, 기본)를 두면 그 기간 안에 B가 없을 때 자동 재매수 — 최대 대기 = 매도 후 현금 대기이면 S5와 같은 규칙. 시작 상태는 '스윙 시작' 설정(보유/현금)." },
    { id: "S4", name: "BOP 매수 + 과열 조기청산", short: "매수+조기청산", init: 0,
      desc: "S1과 같되 보유 중 S가 나오면 보유 기간과 관계없이 즉시 청산." },
    { id: "S5", name: "이격도 매도 + BOP 조기재진입", short: "매도+조기재진입", init: 1,
      desc: "S2와 같되 회피 중 B가 나오면 회피 기간과 관계없이 즉시 재매수." },
    { id: "S6", name: "이중확인(B⁺) 매수 + 과열 청산", short: "이중확인", init: 0,
      desc: "평소 현금. B⁺(BOP 평균 ≤ 매수 기준선이면서 이격도 ≤ '이중 확인 이격도 상한'이 함께 처음 충족된 날)에 매수해 '매수 후 보유(일)' 동안 보유. 보유 중 새 B⁺면 연장, S가 나오면 즉시 청산." },
  ];
  const STRATEGY_IDS = STRATEGIES.map((s) => s.id);
  const SIGNAL_IDS = STRATEGY_IDS.filter((id) => id !== "BH");
  const METRIC_KEYS = ["final", "totalRet", "years", "cagr", "vol", "sharpe", "mdd", "calmar", "exposure",
    "nTrades", "nClosed", "winRate", "avgTrade", "nSwitches", "excessTotal", "excessCagr", "alphaAnn", "beta", "te", "ir"];
  const MIX_METRICS = ["sharpe", "excessCagr", "calmar", "alphaAnn"];
  const SQ252 = Math.sqrt(252);

  /* ---------- 공통 유틸 ---------- */
  function toNum(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const s = v.replace(/[,\s]/g, "");
      return s === "" ? NaN : Number(s);
    }
    return NaN;
  }
  function numOr(v, d) {
    const x = typeof v === "string" && v.trim() === "" ? NaN : toNum(v);
    return isFinite(x) ? x : d;
  }
  function intOr(v, d, min) {
    const x = Math.round(numOr(v, NaN));
    return isFinite(x) && x >= min ? x : d;
  }

  /* 파라미터 정규화: 빠진 값은 DEFAULTS, 잘못된 값은 기본값으로 */
  function withDefaults(p) {
    const q = Object.assign({}, DEFAULTS, p || {});
    q.bopMa = intOr(q.bopMa, DEFAULTS.bopMa, 1);
    q.dispMa = intOr(q.dispMa, DEFAULTS.dispMa, 1);
    q.buyThr = numOr(q.buyThr, DEFAULTS.buyThr);
    q.sellThr = numOr(q.sellThr, DEFAULTS.sellThr);
    q.holdBuy = intOr(q.holdBuy, DEFAULTS.holdBuy, 1);
    q.holdSell = intOr(q.holdSell, DEFAULTS.holdSell, 1);
    // dualMax: 이전 이름 dipLevel 도 받음
    q.dualMax = numOr(p && p.dualMax != null ? p.dualMax : p && p.dipLevel != null ? p.dipLevel : undefined, DEFAULTS.dualMax);
    delete q.dipLevel;
    q.maxWait = intOr(q.maxWait, DEFAULTS.maxWait, 0);
    q.gap = intOr(q.gap, DEFAULTS.gap, 1);
    q.exec = EXEC_MODES.indexOf(q.exec) >= 0 ? q.exec : DEFAULTS.exec;
    q.costBp = Math.max(0, numOr(q.costBp, DEFAULTS.costBp));
    q.cashRate = numOr(q.cashRate, DEFAULTS.cashRate);
    q.swingInit = typeof q.swingInit === "boolean" ? +q.swingInit : numOr(q.swingInit, DEFAULTS.swingInit) ? 1 : 0;
    q.base = numOr(q.base, 0) > 0 ? numOr(q.base, 0) : DEFAULTS.base;
    const hz = Array.isArray(q.horizons) ? q.horizons.map((h) => intOr(h, 0, 1)).filter((h) => h >= 1) : [];
    q.horizons = hz.length ? hz : DEFAULTS.horizons.slice();
    q.iters = intOr(q.iters, DEFAULTS.iters, 1);
    q.seed = numOr(q.seed, DEFAULTS.seed);
    q.maeH = intOr(q.maeH, DEFAULTS.maeH, 1);
    return q;
  }

  /* 표본 평균·표준편차(n−1). 값이 모두 같으면 표준편차는 정확히 0 */
  function meanSd(a, from, to) {
    const n = to - from + 1;
    if (n < 1) return { mean: NaN, sd: NaN };
    let s = 0, mn = Infinity, mx = -Infinity;
    for (let i = from; i <= to; i++) { const v = a[i]; s += v; if (v < mn) mn = v; if (v > mx) mx = v; }
    const mean = s / n;
    if (n < 2) return { mean, sd: NaN };
    if (mn === mx) return { mean, sd: 0 };
    let ss = 0;
    for (let i = from; i <= to; i++) { const d = a[i] - mean; ss += d * d; }
    return { mean, sd: Math.sqrt(ss / (n - 1)) };
  }
  function median(arr) {
    const a = arr.filter((v) => v === v).sort((x, y) => x - y);
    if (!a.length) return NaN;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /* ---------- 날짜 ---------- */
  const pad2 = (x) => (x < 10 ? "0" : "") + x;
  function ymd(y, m, d) {
    if (!(y >= 1000 && y <= 9999 && m >= 1 && m <= 12 && d >= 1)) return null;
    if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
    return y + "-" + pad2(m) + "-" + pad2(d);
  }
  const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
  /* 엑셀 serial(1900/1904) · 문자열(YYYY-MM-DD, YYYY.MM.DD, YYYY/MM/DD, YYYYMMDD) · Date → 'YYYY-MM-DD' (불가 시 null) */
  function toISODate(v, date1904) {
    if (v == null) return null;
    if (typeof v === "number") {
      if (!isFinite(v)) return null;
      if (v >= 10000101 && v <= 99991231 && v === Math.floor(v)) // YYYYMMDD 숫자 셀 (serial 범위 밖)
        return ymd(Math.floor(v / 10000), Math.floor(v / 100) % 100, v % 100);
      if (v < (date1904 ? 0 : 1) || v >= 2958466) return null;
      const dt = new Date(EXCEL_EPOCH + (v + (date1904 ? 1462 : 0)) * 864e5);
      return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    if (Object.prototype.toString.call(v) === "[object Date]") {
      if (isNaN(v.getTime())) return null;
      const utcMid = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0;
      return utcMid ? ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate())
        : ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
    }
    if (typeof v === "string") {
      const s = v.trim();
      const m = /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\s*\.?(?:[ T].*)?$/.exec(s) || /^(\d{4})(\d{2})(\d{2})$/.exec(s);
      return m ? ymd(+m[1], +m[2], +m[3]) : null;
    }
    return null;
  }
  const dayNum = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
  function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
  function upperBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; }

  /* ---------- 데이터 정규화 ---------- */
  /* 오름차순 정렬 · 같은 날짜는 원본 순서상 마지막 행 유지 · 종가 무효 행 제거 · 시/고/저 결측(또는 ≤0)은 종가로 */
  function normalizeData(raw, opts) {
    raw = raw || {};
    const date1904 = !!(opts && opts.date1904);
    const D = raw.dates || [], O = raw.o || [], H = raw.h || [], Lw = raw.l || [], C = raw.c || [];
    const byDate = new Map();
    let dropped = 0, duplicates = 0;
    for (let i = 0; i < D.length; i++) {
      const d = toISODate(D[i], date1904), c = toNum(C[i]);
      if (!d || !isFinite(c) || c <= 0) { dropped++; continue; }
      if (byDate.has(d)) duplicates++;
      byDate.set(d, i);
    }
    const dates = Array.from(byDate.keys()).sort();
    const o = new Array(dates.length), h = new Array(dates.length), l = new Array(dates.length), c = new Array(dates.length);
    let filledOHL = 0;
    for (let k = 0; k < dates.length; k++) {
      const i = byDate.get(dates[k]), ck = toNum(C[i]);
      let ok = toNum(O[i]), hk = toNum(H[i]), lk = toNum(Lw[i]), filled = false;
      if (!(isFinite(ok) && ok > 0)) { ok = ck; filled = true; }
      if (!(isFinite(hk) && hk > 0)) { hk = ck; filled = true; }
      if (!(isFinite(lk) && lk > 0)) { lk = ck; filled = true; }
      if (filled) filledOHL++;
      o[k] = ok; h[k] = hk; l[k] = lk; c[k] = ck;
    }
    return {
      data: { dates, o, h, l, c },
      report: { rows: dates.length, dropped, duplicates, filledOHL,
        first: dates.length ? dates[0] : null, last: dates.length ? dates[dates.length - 1] : null },
    };
  }

  /* ---------- 지표 §2 ---------- */
  function rollMean(src, w) {
    const n = src.length, out = new Float64Array(n).fill(NaN);
    for (let i = w - 1; i < n; i++) {
      let s = 0;
      for (let j = i - w + 1; j <= i; j++) s += src[j];
      out[i] = s / w;
    }
    return out;
  }
  function bopOf(data) {
    const o = data.o, h = data.h, l = data.l, c = data.c, n = c.length, bop = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const hl = h[i] - l[i], v = (c[i] - o[i]) / hl;
      bop[i] = hl !== 0 && isFinite(hl) && isFinite(v) ? v : 0; // H=L → 0
    }
    return bop;
  }
  function computeIndicators(data, p) {
    const P = withDefaults(p), c = data.c, n = c.length;
    const bop = bopOf(data), bopMa = rollMean(bop, P.bopMa), ma = rollMean(c, P.dispMa);
    const disp = new Float64Array(n);
    for (let i = 0; i < n; i++) { const v = c[i] / ma[i] * 100; disp[i] = isFinite(v) ? v : NaN; }
    return { bop, bopMa, ma, disp, bopMaN: P.bopMa, dispMaN: P.dispMa };
  }

  /* ---------- 신호 §3 ---------- */
  function crossDown(a, thr) { // a[i] ≤ thr 이고 a[i−1] > thr
    const n = a.length, f = new Uint8Array(n);
    if (!isFinite(thr)) return f;
    for (let i = 1; i < n; i++) { const x = a[i], y = a[i - 1]; if (x <= thr && y > thr && isFinite(x) && isFinite(y)) f[i] = 1; }
    return f;
  }
  function crossUp(a, thr) { // a[i] ≥ thr 이고 a[i−1] < thr
    const n = a.length, f = new Uint8Array(n);
    if (!isFinite(thr)) return f;
    for (let i = 1; i < n; i++) { const x = a[i], y = a[i - 1]; if (x >= thr && y < thr && isFinite(x) && isFinite(y)) f[i] = 1; }
    return f;
  }
  /* B⁺: (BOP 평균 ≤ thr 이고 이격도 ≤ dmax) 가 전일 거짓 → 당일 참 (양일 모두 두 값이 유한) */
  function crossDual(bm, disp, thr, dmax) {
    const n = bm.length, f = new Uint8Array(n);
    if (!isFinite(thr) || !isFinite(dmax)) return f;
    for (let i = 1; i < n; i++) {
      const b = bm[i], d = disp[i], pb = bm[i - 1], pd = disp[i - 1];
      if (!(isFinite(b) && isFinite(d) && isFinite(pb) && isFinite(pd))) continue;
      if (b <= thr && d <= dmax && !(pb <= thr && pd <= dmax)) f[i] = 1;
    }
    return f;
  }
  /* 신호 최소 간격: 직전에 채택된 같은 종류 신호와 gap 거래일 이상 떨어진 진입만 채택 (gap 1 = 모두 채택) */
  function gapFilter(f, gap) {
    const g = Math.max(1, gap | 0);
    if (g <= 1) return f;
    const n = f.length, out = new Uint8Array(n);
    let last = -1e9;
    for (let i = 0; i < n; i++) if (f[i] && i - last >= g) { out[i] = 1; last = i; }
    return out;
  }
  function combineSignals(rb, rs, rd) { // 같은 날 B·S → S 우선(B 무시), B⁺도 같은 규칙
    const n = rb.length, buyFlag = new Uint8Array(n), dualFlag = new Uint8Array(n), buy = [], sell = [], dual = [], conflicts = [];
    for (let i = 0; i < n; i++) {
      if (rs[i]) { sell.push(i); if (rb[i] || (rd && rd[i])) conflicts.push(i); continue; }
      if (rb[i]) { buyFlag[i] = 1; buy.push(i); }
      if (rd && rd[i]) { dualFlag[i] = 1; dual.push(i); }
    }
    return { buy, sell, dual, buyFlag, sellFlag: rs, dualFlag, conflicts };
  }
  function rawSignals(ind, P) {
    return {
      b: gapFilter(crossDown(ind.bopMa, P.buyThr), P.gap),
      s: gapFilter(crossUp(ind.disp, P.sellThr), P.gap),
      d: gapFilter(crossDual(ind.bopMa, ind.disp, P.buyThr, P.dualMax), P.gap),
    };
  }
  function detectSignals(ind, p) {
    const r = rawSignals(ind, withDefaults(p));
    return combineSignals(r.b, r.s, r.d);
  }

  /* ---------- 기간 §4 ---------- */
  function defaultPeriod(data, p) {
    const P = withDefaults(p), D = data.dates, n = D.length;
    if (!n) return { start: null, end: null };
    return { start: D[Math.min(n - 1, Math.max(P.bopMa, P.dispMa) - 1)], end: D[n - 1] };
  }
  function periodIndex(data, start, end) {
    const D = data.dates, n = D.length;
    const s = start ? toISODate(start) : null, e = end ? toISODate(end) : null;
    if ((start && !s) || (end && !e)) return { i0: 0, i1: -1, valid: false };
    const i0 = s ? lowerBound(D, s) : 0, i1 = e ? upperBound(D, e) - 1 : n - 1;
    return { i0, i1, valid: n > 0 && i0 < n && i1 >= 0 && i1 - i0 >= 2 };
  }

  /* ---------- 전략 §5–§7 ---------- */
  const STRAT = {};
  STRATEGIES.forEach((s) => { STRAT[s.id] = s; });
  function initOf(id, P) { return id === "S3" ? P.swingInit : STRAT[id].init; }

  /* 목표 포지션: 기간 [i0,i1] 종가마다 결정, 기간 이전 신호는 무시 */
  /* F = { b: B 플래그, s: S 플래그, d: B⁺ 플래그 } (전체 이력 인덱스) */
  function targets(id, F, P, i0, i1, init) {
    const tgt = new Uint8Array(i1 - i0 + 1), Hb = P.holdBuy, Hs = P.holdSell, M = P.maxWait;
    const bf = F.b, sf = F.s, df = F.d;
    let cur = init, until = id === "S3" ? i0 + M : -1; // S3: 현금으로 시작하면 기간 시작일부터 대기 일수를 셈
    for (let t = i0, k = 0; t <= i1; t++, k++) {
      const B = bf[t] === 1, S = sf[t] === 1;
      switch (id) {
        case "BH": cur = 1; break;
        case "S1": if (B) { cur = 1; until = t + Hb; } else if (cur === 1 && t >= until) cur = 0; break;
        case "S2": if (S) { cur = 0; until = t + Hs; } else if (cur === 0 && t >= until) cur = 1; break;
        case "S3": // S에 매도(대기 시작, 현금 중 새 S면 다시 셈) → B 또는 최대 대기(M>0) 경과 시 재매수
          if (S) { cur = 0; until = t + M; } else if (cur === 0 && (B || (M > 0 && t >= until))) cur = 1;
          break;
        case "S4":
        case "S6": {
          const b = id === "S4" ? B : !!df && df[t] === 1;
          if (S) cur = 0; else if (b) { cur = 1; until = t + Hb; } else if (cur === 1 && t >= until) cur = 0;
          break;
        }
        case "S5": if (S) { cur = 0; until = t + Hs; } else if (cur === 0 && (B || t >= until)) cur = 1; break;
        default: break;
      }
      tgt[k] = cur;
    }
    return tgt;
  }

  function stubResult(id, P, init, i0, i1) {
    const nav = new Float64Array(1); nav[0] = P.base;
    const pos = new Uint8Array(1); pos[0] = init;
    return { id, init, i0, i1, valid: false, exec: P.exec, nav, pos, tgt: new Uint8Array(0), daily: new Float64Array(1), trades: [], nSwitches: 0 };
  }

  function simulate(id, data, F, P, i0, i1) {
    if (!STRAT[id]) throw new Error("알 수 없는 전략: " + id);
    const c = data.c, o = data.o, n = c.length, init = initOf(id, P);
    if (!(Number.isInteger(i0) && Number.isInteger(i1) && i0 >= 0 && i1 < n && i1 >= i0)) return stubResult(id, P, init, i0, i1);
    const L = i1 - i0, exec = P.exec;
    const rc = P.cashRate / 100 / 252, cost = P.costBp / 10000;
    const tgt = targets(id, F, P, i0, i1, init);
    const pos = new Uint8Array(L + 1), nav = new Float64Array(L + 1), daily = new Float64Array(L + 1);
    pos[0] = init; nav[0] = P.base;
    // 완전 보유일은 모든 체결 방식에서 f = 1+R (BH와 비트 단위 동일 → 동일 전략의 초과성과는 정확히 0)
    let nSwitches = 0;
    for (let k = 1; k <= L; k++) {
      const d = i0 + k, R = c[d] / c[d - 1] - 1, prev = pos[k - 1];
      let f, w;
      if (exec === "nextOpen") {
        const a = prev, b = tgt[k - 1]; // a: 전일 종가~시가 = tgtAt(d−2), b: 시가~종가 = tgtAt(d−1)
        if (a === 1 && b === 1) f = 1 + R; // (1+g)(1+k) ≡ 1+R
        else {
          const od = o[d] > 0 && isFinite(o[d]) ? o[d] : c[d - 1];
          f = (1 + a * (od / c[d - 1] - 1)) * (1 + b * (c[d] / od - 1)) + (1 - b) * rc;
        }
        w = b;
      } else {
        w = exec === "close" ? tgt[k - 1] : (k >= 2 ? tgt[k - 2] : init);
        f = 1 + w * R + (1 - w) * rc;
      }
      if (w !== prev) { f *= 1 - cost; nSwitches++; } // Δ = 1
      pos[k] = w;
      daily[k] = f - 1;
      nav[k] = nav[k - 1] * f;
    }
    return { id, init, i0, i1, valid: true, exec, nav, pos, tgt, daily, trades: tradesOf(data, pos, init, P, i0, i1), nSwitches };
  }

  /* 매매 내역 §7: 포지션 변화 → 체결(종가 d−1 또는 시가 d) */
  function tradesOf(data, pos, init, P, i0, i1) {
    const c = data.c, o = data.o, D = data.dates, L = i1 - i0, exec = P.exec, cost = P.costBp / 10000;
    const nextOpen = exec === "nextOpen", sigLag = exec === "nextClose" ? 2 : 1;
    const out = [];
    let cur = null;
    const close = (exitIdx, exitPx, exitSig, open, lastDay) => {
      const gross = exitPx / cur.entryPx - 1;
      const net = (1 + gross) * (cur.initial ? 1 : 1 - cost) * (open ? 1 : 1 - cost) - 1;
      out.push({
        entryIdx: cur.entryIdx, entryDate: D[cur.entryIdx], entryPx: cur.entryPx, signalDate: cur.signalDate,
        exitIdx, exitDate: D[exitIdx], exitPx, exitSignalDate: exitSig, open, gross, net,
        days: lastDay - cur.firstDay + 1, initial: cur.initial, label: cur.initial ? "기간 시작" : null,
      });
      cur = null;
    };
    if (init === 1) cur = { entryIdx: i0, entryPx: c[i0], signalDate: null, initial: true, firstDay: i0 + 1 };
    for (let k = 1; k <= L; k++) {
      if (pos[k] === pos[k - 1]) continue;
      const d = i0 + k, xIdx = nextOpen ? d : d - 1;
      const px = nextOpen ? (o[d] > 0 && isFinite(o[d]) ? o[d] : c[d - 1]) : c[d - 1];
      const sigDate = D[d - sigLag];
      if (pos[k] === 1) cur = { entryIdx: xIdx, entryPx: px, signalDate: sigDate, initial: false, firstDay: d };
      else if (cur) close(xIdx, px, sigDate, false, nextOpen ? d : d - 1); // 시가 청산일은 전일 종가~시가 구간까지 노출
    }
    if (cur) close(i1, c[i1], null, true, i1);
    return out;
  }

  const flagsOf = (sig) => ({ b: sig.buyFlag, s: sig.sellFlag, d: sig.dualFlag });
  function runStrategy(id, data, ind, sig, p, i0, i1) {
    return simulate(id, data, flagsOf(sig), withDefaults(p), i0, i1);
  }

  /* ---------- 성과 지표 §8 ---------- */
  function emptyMetrics() {
    const m = {};
    METRIC_KEYS.forEach((k) => { m[k] = NaN; });
    m.nTrades = 0; m.nClosed = 0; m.nSwitches = 0;
    return m;
  }
  function metricsCore(res, bhRes, data, i0, i1, P) {
    const m = emptyMetrics();
    if (!res || !res.valid) return m;
    const L = i1 - i0, nav = res.nav, r = res.daily, base = P.base, rc = P.cashRate / 100 / 252, D = data.dates;
    m.final = nav[L];
    m.totalRet = nav[L] / base - 1;
    m.years = (dayNum(D[i1]) - dayNum(D[i0])) / 365.25;
    const cagrOf = (fin) => (m.years > 0 && fin > 0 ? Math.pow(fin / base, 1 / m.years) - 1 : NaN);
    m.cagr = cagrOf(nav[L]);
    const st = meanSd(r, 1, L);
    m.vol = st.sd * SQ252;
    m.sharpe = st.sd > 0 ? (st.mean - rc) / st.sd * SQ252 : NaN;
    let peak = nav[0], mdd = 0;
    for (let k = 0; k <= L; k++) { const v = nav[k]; if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
    m.mdd = mdd;
    m.calmar = mdd < 0 ? m.cagr / -mdd : NaN;
    let ex = 0;
    for (let k = 1; k <= L; k++) ex += res.pos[k];
    m.exposure = L > 0 ? ex / L : NaN;
    const tr = res.trades;
    let nClosed = 0, wins = 0, sumNet = 0;
    for (let j = 0; j < tr.length; j++) if (!tr[j].open) { nClosed++; sumNet += tr[j].net; if (tr[j].net > 0) wins++; }
    m.nTrades = tr.length; m.nClosed = nClosed;
    m.winRate = nClosed ? wins / nClosed : NaN;
    m.avgTrade = nClosed ? sumNet / nClosed : NaN;
    m.nSwitches = res.nSwitches;
    if (res.id === "BH" || res === bhRes) {
      m.excessTotal = 0; m.excessCagr = 0; m.alphaAnn = 0; m.beta = 1; m.te = 0; m.ir = NaN;
    } else if (bhRes && bhRes.valid && bhRes.i0 === i0 && bhRes.i1 === i1) {
      const b = bhRes.daily, bnav = bhRes.nav;
      m.excessTotal = m.totalRet - (bnav[L] / base - 1);
      m.excessCagr = m.cagr - cagrOf(bnav[L]);
      if (L >= 2) {
        let sx = 0, sy = 0;
        for (let k = 1; k <= L; k++) { sx += b[k] - rc; sy += r[k] - rc; }
        const mx = sx / L, my = sy / L;
        let sxx = 0, sxy = 0;
        for (let k = 1; k <= L; k++) { const dx = (b[k] - rc) - mx; sxx += dx * dx; sxy += dx * ((r[k] - rc) - my); }
        m.beta = sxx > 0 ? sxy / sxx : NaN;
        m.alphaAnn = (my - m.beta * mx) * 252;
        const diff = new Float64Array(L + 1);
        for (let k = 1; k <= L; k++) diff[k] = r[k] - b[k];
        const ds = meanSd(diff, 1, L);
        m.te = ds.sd * SQ252;
        m.ir = m.te > 0 ? ds.mean * 252 / m.te : NaN;
      }
    }
    return m;
  }
  function metrics(res, bhRes, data, i0, i1, p) {
    return metricsCore(res, bhRes, data, i0, i1, withDefaults(p));
  }

  function backtest(data, ind, sig, p, i0, i1, ids) {
    const P = withDefaults(p);
    const list = (ids || STRATEGY_IDS).filter((id) => id !== "BH");
    const F = flagsOf(sig);
    const bh = simulate("BH", data, F, P, i0, i1);
    bh.metrics = metricsCore(bh, bh, data, i0, i1, P);
    const results = { BH: bh };
    list.forEach((id) => {
      const r = simulate(id, data, F, P, i0, i1);
      r.metrics = metricsCore(r, bh, data, i0, i1, P);
      results[id] = r;
    });
    return { i0, i1, valid: bh.valid && i1 - i0 >= 2, params: P, results };
  }

  /* 연도별 수익률: (i0, i1] 안의 각 연도 Π f_d − 1 (첫해는 부분 연도) */
  function yearly(bt, data) {
    const out = [], D = data.dates, i0 = bt.i0, i1 = bt.i1, ids = Object.keys(bt.results);
    if (!bt.results.BH || !bt.results.BH.valid) return out;
    const L = i1 - i0;
    let kPrev = 0;
    for (let k = 1; k <= L; k++) {
      const y = D[i0 + k].slice(0, 4);
      if (k === L || D[i0 + k + 1].slice(0, 4) !== y) {
        const row = { year: +y, from: D[i0 + kPrev + 1], to: D[i0 + k], days: k - kPrev };
        ids.forEach((id) => { const nav = bt.results[id].nav; row[id] = nav[k] / nav[kPrev] - 1; });
        out.push(row);
        kPrev = k;
      }
    }
    return out;
  }

  /* ---------- 이벤트 스터디 §9 ---------- */
  function mulberry32(seed) {
    let a = seed | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function verdictOf(side, excess, p) {
    if (!(isFinite(excess) && isFinite(p))) return "무효";
    const good = side === "sell" ? excess < 0 : excess > 0;
    return good && p < 0.05 ? "유효" : good && p < 0.20 ? "약함" : "무효";
  }
  function eventStudy(data, ind, sigIdx, side, p, i0, i1) {
    const P = withDefaults(p), c = data.c, D = data.dates, n = c.length, sell = side === "sell";
    const ok = Number.isInteger(i0) && Number.isInteger(i1) && i0 >= 0 && i1 < n && i1 >= i0;
    const ev = ok ? Array.from(new Set(sigIdx || [])).filter((t) => t >= i0 && t <= i1).sort((a, b) => a - b) : [];
    const rows = P.horizons.map((h) => {
      const row = { h, n: 0, mean: NaN, median: NaN, base: NaN, excess: NaN, hit: NaN, baseHit: NaN, p: NaN, verdict: "무효", nBase: 0 };
      if (!ok) return row;
      const M = i1 - h - i0 + 1; // 기준 표본: t ∈ [i0, i1−h]
      const pool = new Float64Array(Math.max(0, M));
      let sb = 0, hb = 0;
      for (let j = 0; j < M; j++) {
        const t = i0 + j, v = c[t + h] / c[t] - 1;
        pool[j] = v; sb += v; if (sell ? v < 0 : v > 0) hb++;
      }
      row.nBase = Math.max(0, M);
      if (M > 0) { row.base = sb / M; row.baseHit = hb / M; }
      const fw = [];
      for (let j = 0; j < ev.length; j++) { const t = ev[j]; if (t + h <= i1) fw.push(c[t + h] / c[t] - 1); }
      const nh = fw.length;
      row.n = nh;
      if (!nh) return row;
      let s = 0, hit = 0;
      for (let j = 0; j < nh; j++) { s += fw[j]; if (sell ? fw[j] < 0 : fw[j] > 0) hit++; }
      row.mean = s / nh;
      row.median = median(fw);
      row.excess = row.mean - row.base;
      row.hit = hit / nh;
      // 순열검정: 같은 개수의 임의 거래일 평균과 비교 (부분 Fisher–Yates, 동률은 극단으로 계산)
      const rng = mulberry32(P.seed + h), perm = new Int32Array(M), iters = P.iters;
      for (let j = 0; j < M; j++) perm[j] = j;
      const eps = 1e-12 * (1 + Math.abs(row.mean));
      let cnt = 0;
      for (let it = 0; it < iters; it++) {
        let rs = 0;
        for (let j = 0; j < nh; j++) {
          const r = j + Math.floor(rng() * (M - j)), tmp = perm[j];
          perm[j] = perm[r]; perm[r] = tmp;
          rs += pool[perm[j]];
        }
        const rm = rs / nh;
        if (sell ? rm <= row.mean + eps : rm >= row.mean - eps) cnt++;
      }
      row.p = (1 + cnt) / (iters + 1);
      row.verdict = verdictOf(side, row.excess, row.p);
      return row;
    });
    const events = ev.map((t) => {
      const fwd = {};
      P.horizons.forEach((h) => { fwd[h] = t + h <= i1 ? c[t + h] / c[t] - 1 : null; });
      let mae = null, mfe = null;
      const J = Math.min(P.maeH, i1 - t);
      for (let j = 1; j <= J; j++) {
        const v = c[t + j] / c[t] - 1;
        if (mae === null || v < mae) mae = v;
        if (mfe === null || v > mfe) mfe = v;
      }
      const bm = ind && ind.bopMa ? ind.bopMa[t] : NaN, dp = ind && ind.disp ? ind.disp[t] : NaN;
      return { i: t, date: D[t], close: c[t], bopMa: isFinite(bm) ? bm : null, disp: isFinite(dp) ? dp : null, fwd, mae, mfe };
    });
    return { side: sell ? "sell" : "buy", rows, events };
  }

  /* 신호 후 평균 경로: 신호일 종가 기준 0~H거래일 누적 수익률 평균 (t+H ≤ i1 인 신호만) */
  function avgPath(data, sigIdx, i0, i1, H) {
    const c = data.c, path = new Float64Array(H + 1);
    let cnt = 0;
    (sigIdx || []).forEach((t) => {
      if (t < i0 || t > i1 || t + H > i1) return;
      cnt++;
      for (let d = 0; d <= H; d++) path[d] += c[t + d] / c[t] - 1;
    });
    for (let d = 0; d <= H; d++) path[d] = cnt ? path[d] / cnt : NaN;
    return { path, cnt };
  }
  function basePath(data, i0, i1, H) {
    const idx = [];
    for (let t = i0; t + H <= i1; t++) idx.push(t);
    return avgPath(data, idx, i0, i1, H);
  }
  /* 방향 판정: 이벤트 스터디 한 행(보통 +20일)의 평균·적중률을 평상시(무조건부)와 비교
     매수: 평균 +0.5%p 이상 & 적중률 +3%p 이상 → 작동 · 둘 다 유리 → 미약 · 하나만 → 엇갈림 · 둘 다 불리 → 작동 안 함
     매도는 평균이 낮을수록·하락 비율이 높을수록 유리. 신호 10회 미만 → 표본 부족 */
  function judge(side, row, minN) {
    if (!row || !(row.n >= (minN || 10))) return "표본 부족";
    const da = side === "sell" ? row.base - row.mean : row.mean - row.base, dh = row.hit - row.baseHit;
    if (!(isFinite(da) && isFinite(dh))) return "표본 부족";
    if (da >= 0.005 && dh >= 0.03) return "작동";
    if (da > 0 && dh > 0) return "미약";
    if (da > 0 || dh > 0) return "엇갈림";
    return "작동 안 함";
  }

  /* ---------- 임계치 그리드 · 최적 조합 §14 ---------- */
  function numList(list) {
    return (Array.isArray(list) ? list : []).map((v) => numOr(v, NaN)).filter((v) => isFinite(v));
  }
  function uniq(list) { const out = []; list.forEach((v) => { if (out.indexOf(v) < 0) out.push(v); }); return out; }
  /* 기간 안에서만 S 우선 규칙 적용한 B·B⁺ 플래그 (전략은 [i0,i1] 플래그만 읽음) */
  function pairFlags(rb, rs, rd, i0, i1) {
    const n = rb.length, bf = new Uint8Array(n), df = new Uint8Array(n);
    let conflict = 0;
    for (let t = Math.max(0, i0); t <= i1 && t < n; t++) {
      if (rs[t]) { if (rb[t] || (rd && rd[t])) conflict++; continue; }
      if (rb[t]) bf[t] = 1;
      if (rd && rd[t]) df[t] = 1;
    }
    return { F: { b: bf, s: rs, d: df }, conflict };
  }
  const cntIn = (f, i0, i1) => { let s = 0; for (let t = Math.max(0, i0); t <= i1 && t < f.length; t++) s += f[t]; return s; };

  /* 임계치 그리드: 행 = BOP 매수 임계치, 열 = 이격도 매도 임계치 (colKind "sell", 기본)
     또는 B⁺ 이격도 상한 (colKind "dual": S6만, 매도 임계치는 현재 설정) */
  function grid(data, ind, p, i0, i1, opts) {
    opts = opts || {};
    const P = withDefaults(p), disp = ind.disp, dualCols = opts.colKind === "dual";
    const bopList = numList(opts.bopList), dispList = numList(opts.dispList);
    const ids = dualCols ? ["S6"] : (opts.ids || SIGNAL_IDS).filter((id) => id !== "BH" && STRAT[id]);
    const none = new Uint8Array(data.c.length);
    const bh = simulate("BH", data, { b: none, s: none, d: none }, P, i0, i1);
    const bhM = metricsCore(bh, bh, data, i0, i1, P);
    const g = P.gap;
    const rawB = bopList.map((t) => gapFilter(crossDown(ind.bopMa, t), g));
    const curS = gapFilter(crossUp(disp, P.sellThr), g);
    const rawS = dualCols ? dispList.map(() => curS) : dispList.map((t) => gapFilter(crossUp(disp, t), g));
    const needD = ids.indexOf("S6") >= 0;
    const rawD = bopList.map((bt) => dispList.map((ct) => (!needD ? null
      : gapFilter(crossDual(ind.bopMa, disp, bt, dualCols ? ct : P.dualMax), g))));
    const cacheS1 = [], cacheS2 = [];
    const run = (id, F) => { const r = simulate(id, data, F, P, i0, i1); return metricsCore(r, bh, data, i0, i1, P); };
    const cells = bopList.map((bt, bi) => dispList.map((st, di) => {
      const pf = pairFlags(rawB[bi], rawS[di], rawD[bi][di], i0, i1), cell = {};
      ids.forEach((id) => {
        if (id === "S2") cell.S2 = cacheS2[di] || (cacheS2[di] = run("S2", pf.F));
        else if (id === "S1" && !pf.conflict) cell.S1 = cacheS1[bi] || (cacheS1[bi] = run("S1", pf.F));
        else cell[id] = run(id, pf.F);
      });
      return cell;
    }));
    return {
      bopList, dispList, ids, colKind: dualCols ? "dual" : "sell", bh: bhM,
      counts: {
        buy: rawB.map((f) => cntIn(f, i0, i1)),
        sell: dualCols ? null : rawS.map((f) => cntIn(f, i0, i1)),
        dual: needD ? rawD.map((row) => row.map((f) => cntIn(f, i0, i1))) : null,
      },
      cells,
    };
  }

  function bestMix(data, ind, p, i0, iSplit, i1, opts) {
    opts = opts || {};
    const P = withDefaults(p), disp = ind.disp, n = data.c.length;
    const metric = MIX_METRICS.indexOf(opts.metric) >= 0 ? opts.metric : "sharpe";
    const bops = uniq(numList(opts.bopList)), disps = uniq(numList(opts.dispList));
    const g = P.gap;
    const rawB = bops.map((t) => gapFilter(crossDown(ind.bopMa, t), g)), rawS = disps.map((t) => gapFilter(crossUp(disp, t), g));
    const rawD = bops.map((t) => gapFilter(crossDual(ind.bopMa, disp, t, P.dualMax), g));
    const curB = gapFilter(crossDown(ind.bopMa, P.buyThr), g), curS = gapFilter(crossUp(disp, P.sellThr), g);
    const curD = gapFilter(crossDual(ind.bopMa, disp, P.buyThr, P.dualMax), g);
    const none = new Uint8Array(n);
    const win = (a, b) => {
      const bh = simulate("BH", data, { b: none, s: none, d: none }, P, a, b);
      return { a, b, bh, bhM: metricsCore(bh, bh, data, a, b, P), valid: bh.valid && b - a >= 2 };
    };
    const FULL = win(i0, i1), IS = win(i0, iSplit), OOS = win(iSplit, i1);
    const evalAt = (W, id, rb, rs, rd) => {
      if (!W.valid) return emptyMetrics();
      const pf = pairFlags(rb, rs, rd, W.a, W.b);
      const r = simulate(id, data, pf.F, P, W.a, W.b);
      return metricsCore(r, W.bh, data, W.a, W.b, P);
    };
    return SIGNAL_IDS.map((id) => {
      const cands = [];
      if (id === "S1") bops.forEach((t, bi) => cands.push({ buyThr: t, sellThr: null, rb: rawB[bi], rs: curS, rd: rawD[bi] }));
      else if (id === "S2") disps.forEach((t, di) => cands.push({ buyThr: null, sellThr: t, rb: curB, rs: rawS[di], rd: curD }));
      else bops.forEach((bt, bi) => disps.forEach((st, di) => cands.push({ buyThr: bt, sellThr: st, rb: rawB[bi], rs: rawS[di], rd: rawD[bi] })));
      let best = null, beat = 0;
      const vals = [];
      cands.forEach((cd) => {
        const m = evalAt(IS, id, cd.rb, cd.rs, cd.rd), v = m[metric];
        vals.push(v);
        if (m.excessCagr > 0) beat++;
        if (isFinite(v) && (best === null || v > best.value)) best = { cd, value: v, metrics: m };
      });
      const cur = evalAt(FULL, id, curB, curS, curD);
      const oosM = best ? evalAt(OOS, id, best.cd.rb, best.cd.rs, best.cd.rd) : emptyMetrics();
      return {
        id, name: STRAT[id].name, metric, valid: IS.valid && OOS.valid,
        cur: { buyThr: P.buyThr, sellThr: P.sellThr, value: cur[metric], metrics: cur },
        isBest: best ? { buyThr: best.cd.buyThr, sellThr: best.cd.sellThr, value: best.value, metrics: best.metrics }
          : { buyThr: null, sellThr: null, value: NaN, metrics: emptyMetrics() },
        oos: { value: oosM[metric], excessCagr: oosM.excessCagr, metrics: oosM },
        oosBH: { cagr: OOS.bhM.cagr, value: OOS.bhM[metric], metrics: OOS.bhM },
        robust: { shareBeatBH: cands.length ? beat / cands.length : NaN, median: median(vals), n: cands.length },
      };
    });
  }

  /* ---------- 엑셀 파싱 (SheetJS sheet_to_json header:1 결과) ---------- */
  const OHLC_HEADERS = ["일자", "시가", "고가", "저가", "종가"];
  const hkey = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
  const loose = (s) => s.toLowerCase().replace(/\s+/g, "");
  function headerMap(row) {
    const idx = Object.create(null);
    if (!row) return idx;
    for (let j = 0; j < row.length; j++) { const k = hkey(row[j]); if (k && !(k in idx)) idx[k] = j; }
    return idx;
  }
  function findCol(idx, name) {
    if (name in idx) return idx[name];
    const want = loose(name);
    for (const k in idx) if (loose(k) === want) return idx[k];
    return -1;
  }
  function findOHLC(rows) {
    const lim = Math.min(rows.length, 20);
    for (let r = 0; r < lim; r++) {
      const idx = headerMap(rows[r]);
      if (OHLC_HEADERS.every((k) => k in idx)) return { row: r, idx };
    }
    return null;
  }
  const isBlank = (v) => v == null || (typeof v === "string" && v.trim() === "");
  function sheetList(sheets) {
    if (Array.isArray(sheets)) return sheets.filter((s) => s && Array.isArray(s.rows)).map((s) => ({ name: String(s.name), rows: s.rows }));
    return Object.keys(sheets || {}).filter((k) => Array.isArray(sheets[k])).map((k) => ({ name: k, rows: sheets[k] }));
  }

  function parseWorkbookRows(sheets, opts) {
    const date1904 = !!(opts && opts.date1904), list = sheetList(sheets);
    let pick = null;
    const bopSheet = list.filter((s) => s.name === "BOP")[0] || list.filter((s) => s.name.trim().toUpperCase() === "BOP")[0];
    if (bopSheet) { const hd = findOHLC(bopSheet.rows); if (hd) pick = { s: bopSheet, hd }; }
    for (let j = 0; !pick && j < list.length; j++) { const hd = findOHLC(list[j].rows); if (hd) pick = { s: list[j], hd }; }
    if (!pick) throw new Error("엑셀에서 KOSPI 시세 시트를 찾지 못했습니다. 첫 20행 안에 '일자 · 시가 · 고가 · 저가 · 종가' 머리글이 있는 원본 양식(BOP 시트)을 그대로 올려 주세요.");
    const rows = pick.s.rows, idx = pick.hd.idx;
    const cD = idx["일자"], cO = idx["시가"], cH = idx["고가"], cL = idx["저가"], cC = idx["종가"];
    const cBop = findCol(idx, "Balance of Power"), cB14 = findCol(idx, "BOP(14MA)");
    const raw = { dates: [], o: [], h: [], l: [], c: [] }, cacheBop = new Map(), cacheB14 = new Map();
    let badDates = 0, blankRows = 0;
    for (let r = pick.hd.row + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (isBlank(row[cD]) && isBlank(row[cO]) && isBlank(row[cH]) && isBlank(row[cL]) && isBlank(row[cC])) { blankRows++; continue; }
      const d = toISODate(row[cD], date1904);
      if (!d) { badDates++; continue; }
      raw.dates.push(d); raw.o.push(row[cO]); raw.h.push(row[cH]); raw.l.push(row[cL]); raw.c.push(row[cC]);
      const cv = toNum(row[cC]);
      if (isFinite(cv) && cv > 0) { // 정규화와 같은 규칙(마지막 유효 행)으로 캐시값 대응
        if (cBop >= 0) cacheBop.set(d, row[cBop]);
        if (cB14 >= 0) cacheB14.set(d, row[cB14]);
      }
    }
    const norm = normalizeData(raw);
    const data = norm.data, D = data.dates;
    if (!D.length) throw new Error("'" + pick.s.name + "' 시트에 유효한 데이터 행이 없습니다. 일자와 종가 열을 확인해 주세요.");
    const bop = bopOf(data), b14 = rollMean(bop, 14);
    const cmp = (cache, arr) => {
      if (!cache.size) return { max: null, n: 0 };
      let mx = 0, cnt = 0;
      for (let i = 0; i < D.length; i++) {
        const v = cache.get(D[i]);
        if (typeof v !== "number" || !isFinite(v) || !isFinite(arr[i])) continue;
        const df = Math.abs(arr[i] - v);
        if (df > mx) mx = df;
        cnt++;
      }
      return { max: cnt ? mx : null, n: cnt };
    };
    const cb = cmp(cacheBop, bop), c14 = cmp(cacheB14, b14);
    const report = {
      sheet: pick.s.name, headerRow: pick.hd.row + 1, rows: D.length, first: D[0], last: D[D.length - 1],
      droppedRows: badDates + norm.report.dropped, badDates, badClose: norm.report.dropped, blankRows,
      duplicates: norm.report.duplicates, filledOHL: norm.report.filledOHL, date1904,
      cachedBopMaxDiff: cb.max, cachedBopCompared: cb.n, cachedBop14MaxDiff: c14.max, cachedBop14Compared: c14.n,
      indexCheck: indexCheck(list, data, date1904), sheets: list.map((s) => s.name),
    };
    return { data, report };
  }

  /* INDEX 시트의 'KOSPI' 열 종가와 대조 */
  function indexCheck(list, data, date1904) {
    const s = list.filter((x) => x.name === "INDEX")[0] || list.filter((x) => x.name.trim().toUpperCase() === "INDEX")[0];
    if (!s) return null;
    const rows = s.rows;
    let tr = -1, tc = -1, hr = -1, dc = -1;
    for (let r = 0; r < Math.min(rows.length, 10) && tc < 0; r++) {
      const row = rows[r] || [];
      for (let j = 0; j < row.length; j++) if (hkey(row[j]) === "KOSPI") { tr = r; tc = j; break; }
    }
    if (tc < 0) return null;
    for (let r = 0; r < Math.min(rows.length, 10) && dc < 0; r++) {
      const row = rows[r] || [];
      for (let j = 0; j < row.length; j++) if (hkey(row[j]) === "일자") { hr = r; dc = j; break; }
    }
    if (dc < 0) dc = 0;
    const map = new Map();
    data.dates.forEach((d, i) => map.set(d, i));
    let matched = 0, mismatches = 0, maxDiff = 0;
    for (let r = Math.max(tr, hr) + 1; r < rows.length; r++) {
      const row = rows[r] || [], d = toISODate(row[dc], date1904), v = toNum(row[tc]);
      if (!d || !isFinite(v) || !map.has(d)) continue;
      const df = Math.abs(v - data.c[map.get(d)]);
      matched++;
      if (df > 0.005) mismatches++;
      if (df > maxDiff) maxDiff = df;
    }
    return { sheet: s.name, matched, mismatches, maxDiff: matched ? maxDiff : null };
  }

  return {
    VERSION, DEFAULTS, STRATEGIES, STRATEGY_IDS, SIGNAL_IDS, EXEC_MODES, EXEC_LABELS, METRIC_KEYS, MIX_METRICS,
    withDefaults, toISODate, normalizeData, computeIndicators, detectSignals, defaultPeriod, periodIndex,
    runStrategy, backtest, metrics, yearly, eventStudy, avgPath, basePath, judge, grid, bestMix, parseWorkbookRows, mulberry32,
    verdict: verdictOf, median,
  };
});
