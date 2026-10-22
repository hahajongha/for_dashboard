/* KOSPI 시그널 랩 — 업종 2등주 전략 계산 엔진 (순수 함수 · DOM 없음)
   TIGER 반도체 · TIGER 헬스케어 · TIGER 2차전지테마 중 지난달(순위 기준 기간) 수익률 2등을 이번 달 보유하는 전략과
   1등·3등·1+2등(50:50), 벤치마크 TIGER 200을 월말 종가로 비교한다.
   브라우저: window.KST / Node: module.exports.
   인덱스 규칙: 일별 배열은 전체 이력 기준 i, 월 배열은 월 번호 m (months[m].i = 그달 마지막 거래일 i). */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.KST = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = "1.0.0";
  const SECTORS = [
    { key: "semi", code: "091230", name: "TIGER 반도체", short: "반도체" },
    { key: "health", code: "143860", name: "TIGER 헬스케어", short: "헬스케어" },
    { key: "batt", code: "305540", name: "TIGER 2차전지테마", short: "2차전지" },
  ];
  const BENCH = { key: "bm", code: "102110", name: "TIGER 200", short: "TIGER200" };
  const ASSETS = SECTORS.concat([BENCH]);
  const SECTOR_KEYS = SECTORS.map((a) => a.key);
  const ASSET_KEYS = ASSETS.map((a) => a.key);
  /* 전략: 순위 자리(rank) 또는 고정 자산(asset)의 비중 */
  const STRATS = [
    { id: "R2", name: "2등주", desc: "지난달 2등 업종 100%", w: { 1: 1 } },
    { id: "R1", name: "1등주", desc: "지난달 1등 업종 100%", w: { 0: 1 } },
    { id: "R3", name: "3등주", desc: "지난달 3등 업종 100%", w: { 2: 1 } },
    { id: "R12", name: "1+2등주", desc: "지난달 1등·2등 업종 50:50 (매월 재조정)", w: { 0: 0.5, 1: 0.5 } },
    { id: "BM", name: "TIGER 200", desc: "벤치마크 계속 보유", asset: "bm" },
    { id: "semi", name: "반도체 보유", desc: "TIGER 반도체 계속 보유", asset: "semi" },
    { id: "health", name: "헬스케어 보유", desc: "TIGER 헬스케어 계속 보유", asset: "health" },
    { id: "batt", name: "2차전지 보유", desc: "TIGER 2차전지테마 계속 보유", asset: "batt" },
  ];
  const STRAT_IDS = STRATS.map((s) => s.id);
  const DEFAULTS = { look: 1, costBp: 0, base: 100 };
  const LOOKS = [1, 2, 3, 6];

  const isNum = (v) => typeof v === "number" && isFinite(v);
  function toNum(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string") { const s = v.replace(/[,\s]/g, ""); return s === "" ? NaN : Number(s); }
    return NaN;
  }
  const pad2 = (x) => (x < 10 ? "0" : "") + x;
  function ymd(y, m, d) {
    if (!(y >= 1000 && y <= 9999 && m >= 1 && m <= 12 && d >= 1)) return null;
    if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
    return y + "-" + pad2(m) + "-" + pad2(d);
  }
  const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
  /* KOSPI 엔진 toISODate 와 같은 규칙: 엑셀 serial(1900/1904) · YYYYMMDD 숫자 · 날짜 문자열 · Date */
  function toISODate(v, date1904) {
    if (v == null) return null;
    if (typeof v === "number") {
      if (!isFinite(v)) return null;
      if (v >= 10000101 && v <= 99991231 && v === Math.floor(v)) return ymd(Math.floor(v / 10000), Math.floor(v / 100) % 100, v % 100);
      if (v < (date1904 ? 0 : 1) || v >= 2958466) return null;
      const dt = new Date(EXCEL_EPOCH + (v + (date1904 ? 1462 : 0)) * 864e5);
      return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    if (Object.prototype.toString.call(v) === "[object Date]") {
      if (isNaN(v.getTime())) return null;
      return ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
    }
    if (typeof v === "string") {
      const s = v.trim();
      const m = /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\s*\.?(?:[ T].*)?$/.exec(s) || /^(\d{4})(\d{2})(\d{2})$/.exec(s);
      return m ? ymd(+m[1], +m[2], +m[3]) : null;
    }
    return null;
  }

  /* ---------- 데이터 정규화 ----------
     raw = { dates: [...], px: { semi: [...], health: [...], batt: [...], bm: [...] } } (자산별 종가, 결측 허용)
     → 오름차순 · 같은 날짜는 마지막 행 · 네 자산 모두 종가가 없는 날 제외 · 0 이하/문자 = 결측(NaN) */
  function normalize(raw) {
    raw = raw || {};
    const D = raw.dates || [], P = raw.px || {}, byDate = new Map();
    let dropped = 0, duplicates = 0;
    for (let i = 0; i < D.length; i++) {
      const d = toISODate(D[i]);
      if (!d) { dropped++; continue; }
      const any = ASSET_KEYS.some((k) => { const v = toNum((P[k] || [])[i]); return isFinite(v) && v > 0; });
      if (!any) { dropped++; continue; }
      if (byDate.has(d)) duplicates++;
      byDate.set(d, i);
    }
    const dates = Array.from(byDate.keys()).sort(), px = {}, first = {}, last = {}, missing = {};
    ASSET_KEYS.forEach((k) => {
      const src = P[k] || [], out = new Array(dates.length);
      let miss = 0;
      for (let j = 0; j < dates.length; j++) {
        const v = toNum(src[byDate.get(dates[j])]);
        out[j] = isFinite(v) && v > 0 ? v : NaN;
        if (out[j] === out[j]) { if (first[k] == null) first[k] = dates[j]; last[k] = dates[j]; } else if (first[k] != null) miss++;
      }
      px[k] = out; missing[k] = miss;
    });
    return {
      data: { dates, px },
      report: { rows: dates.length, dropped, duplicates, first, last, missing,
        firstDate: dates.length ? dates[0] : null, lastDate: dates.length ? dates[dates.length - 1] : null },
    };
  }

  /* ---------- 월말 ---------- */
  const CLOSE_MIN = 15 * 60 + 30; // 한국거래소 정규장 마감 15:30 (KST)
  /* as-of(엑셀 저장 시각, ISO 문자열·epoch ms·Date) → 한국 시각 { ymd, min } (모르면 null) */
  function kstOf(asOf) {
    if (asOf == null || asOf === "") return null;
    const t = asOf instanceof Date ? asOf.getTime() : typeof asOf === "number" ? asOf : Date.parse(asOf);
    if (!isFinite(t)) return null;
    const k = new Date(t + 9 * 3600e3);
    return { ymd: k.toISOString().slice(0, 10), min: k.getUTCHours() * 60 + k.getUTCMinutes() };
  }
  /* 마지막 행이 장중 값인가: 그날 15:30 전에 저장된 엑셀 */
  function intradayAt(lastDate, asOf) { const a = kstOf(asOf); return !!a && a.ymd === lastDate && a.min < CLOSE_MIN; }
  /* 연말 휴장일 = 12월의 마지막 평일 (31일이 주말이면 그 전 평일) */
  function yearEndClosed(y) {
    for (let d = 31; d > 24; d--) { const wd = new Date(Date.UTC(y, 11, d)).getUTCDay(); if (wd !== 0 && wd !== 6) return d; }
    return 31;
  }
  /* 데이터 마지막 날의 달이 끝났는가.
     저장 시각(as-of)을 알면: 다음 달 이후에 저장 → 끝남, 마지막 날 장중에 저장 → 진행 중.
     그 밖에는 달력으로: 그 뒤에 평일(연말 휴장일 제외)이 남아 있으면 진행 중 — 설·추석 등 월말 휴장은 알 수 없어
     다음 달 데이터가 올 때까지 '진행 중'으로 둔다(보유 종목은 잠정 순위로 보임) */
  function monthComplete(lastDate, asOf) {
    const a = kstOf(asOf);
    if (a && a.ymd.slice(0, 7) > lastDate.slice(0, 7)) return true;
    if (intradayAt(lastDate, asOf)) return false;
    const y = +lastDate.slice(0, 4), mo = +lastDate.slice(5, 7), d = +lastDate.slice(8, 10);
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate(), ye = mo === 12 ? yearEndClosed(y) : 0;
    for (let k = d + 1; k <= dim; k++) {
      const wd = new Date(Date.UTC(y, mo - 1, k)).getUTCDay();
      if (wd === 0 || wd === 6 || k === ye) continue;
      return false;
    }
    return true;
  }
  const prevYm = (ym) => { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return m === 1 ? (y - 1) + "-12" : y + "-" + pad2(m - 1); };
  /* 월 목록: 그달 마지막 거래일 i 와 자산별 월말 종가(그날까지의 마지막 유효 종가, 그달 안에서만).
     맨 앞에 '데이터 첫날'을 직전 월말처럼 둔다(base) → 첫 달 수익률 = 첫날 종가 대비, 첫 달 순위도 계산 */
  function monthsOf(data, asOf) {
    const D = data.dates, out = [];
    if (D.length > 1 && D[1].slice(0, 7) === D[0].slice(0, 7)) { // 첫날이 그달 마지막 거래일이면 그 월말이 곧 기준
      const ym0 = D[0].slice(0, 7), px = {};
      ASSET_KEYS.forEach((k) => {
        const a = data.px[k];
        let v = NaN;
        for (let j = 0; j < D.length && D[j].slice(0, 7) === ym0; j++) if (a[j] === a[j]) { v = a[j]; break; }
        px[k] = v;
      });
      out.push({ ym: prevYm(ym0), i: 0, date: D[0], px, complete: true, base: true });
    }
    for (let i = 0; i < D.length; i++) {
      if (i + 1 < D.length && D[i + 1].slice(0, 7) === D[i].slice(0, 7)) continue;
      const ym = D[i].slice(0, 7), px = {};
      ASSET_KEYS.forEach((k) => {
        const a = data.px[k];
        let v = NaN;
        for (let j = i; j >= 0 && D[j].slice(0, 7) === ym; j--) if (a[j] === a[j]) { v = a[j]; break; }
        px[k] = v;
      });
      out.push({ ym, i, date: D[i], px, complete: true });
    }
    if (out.length) out[out.length - 1].complete = monthComplete(D[D.length - 1], asOf);
    return out;
  }
  /* 일별 종가: 결측일은 직전 유효 종가 (NAV 계산용) */
  function ffill(a) {
    const o = new Array(a.length);
    let last = NaN;
    for (let i = 0; i < a.length; i++) { if (a[i] === a[i]) last = a[i]; o[i] = last; }
    return o;
  }
  const nextYm = (ym) => { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return m === 12 ? (y + 1) + "-01" : y + "-" + pad2(m + 1); };

  /* 순위: 월 m 기준 look개월 수익률 내림차순 (같으면 SECTORS 순서) — 셋 중 하나라도 계산 불가면 null */
  function rankAt(M, m, look) {
    if (m - look < 0) return null;
    const sc = {};
    for (const k of SECTOR_KEYS) {
      const v = M[m].px[k] / M[m - look].px[k] - 1;
      if (!isFinite(v)) return null;
      sc[k] = v;
    }
    const order = SECTOR_KEYS.slice().sort((a, b) => sc[b] - sc[a] || SECTOR_KEYS.indexOf(a) - SECTOR_KEYS.indexOf(b));
    return { order, score: sc };
  }
  function weightsOf(st, rk) {
    const w = {};
    if (st.asset) { w[st.asset] = 1; return w; }
    if (!rk) return null;
    for (const pos in st.w) w[rk.order[+pos]] = (w[rk.order[+pos]] || 0) + st.w[pos];
    return w;
  }
  function turnover(w, prev) {
    let t = 0;
    const keys = new Set(Object.keys(w).concat(Object.keys(prev || {})));
    keys.forEach((k) => { t += Math.abs((w[k] || 0) - ((prev || {})[k] || 0)); });
    return t;
  }

  /* 표본 평균·표준편차(n−1) */
  function meanSd(a) {
    const n = a.length;
    if (!n) return { mean: NaN, sd: NaN };
    const mean = a.reduce((s, v) => s + v, 0) / n;
    if (n < 2) return { mean, sd: NaN };
    const ss = a.reduce((s, v) => s + (v - mean) * (v - mean), 0);
    return { mean, sd: Math.sqrt(ss / (n - 1)) };
  }

  /* ---------- 백테스트 ----------
     opts: { look(순위 기준 개월, 기본 1), costBp(편도 bp, 기본 0), start('YYYY-MM' 첫 보유 월), end('YYYY-MM' 마지막 보유 월),
             asOf(엑셀 저장 시각 — 마지막 달이 끝났는지·장중 값인지 판단, 없으면 달력만) }
     보유 월 h 의 비중은 월말 h−1 의 순위로 정하고 h 월말까지 유지(월중 재조정 없음, 1+2등주는 월초 50:50).
     비용 = 편도 bp × 비중 변화량 합 (직전 월말 실제 비중 대비, 전량 교체 = 매도+매수 2배) — 월초에 차감. */
  function run(data, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const look = LOOKS.indexOf(+o.look) >= 0 ? +o.look : DEFAULTS.look, c = Math.max(0, toNum(o.costBp) || 0) / 1e4, base = DEFAULTS.base;
    const M = monthsOf(data, o.asOf), D = data.dates;
    const ranks = M.map((_, m) => rankAt(M, m, look));
    const mret = M.map((mm, m) => {
      const r = {};
      ASSET_KEYS.forEach((k) => { r[k] = m > 0 ? mm.px[k] / M[m - 1].px[k] - 1 : NaN; if (!isFinite(r[k])) r[k] = NaN; });
      return r;
    });
    // 보유 가능한 첫 월: 직전 월말 순위와 그달 네 자산 수익률이 모두 있는 달
    const usable = (h) => h >= 1 && !!ranks[h - 1] && ASSET_KEYS.every((k) => mret[h][k] === mret[h][k]);
    let h0 = -1, h1 = -1;
    for (let h = 1; h < M.length; h++) if (usable(h) && (!o.start || M[h].ym >= o.start)) { h0 = h; break; }
    if (h0 < 0) return { ok: false, reason: "보유 기간을 만들 수 없습니다 (네 ETF의 월말 종가가 모두 있는 기간이 부족하거나 시작 월이 데이터보다 늦습니다).", M, ranks, mret, look };
    for (let h = h0; h < M.length; h++) { if (o.end && M[h].ym > o.end) break; if (!usable(h)) break; h1 = h; }
    if (h1 < h0) return { ok: false, reason: `마지막 보유 월이 계산 가능한 첫 보유 월(${M[h0].ym})보다 빠릅니다.`, M, ranks, mret, look };
    const pxF = {};
    ASSET_KEYS.forEach((k) => { pxF[k] = ffill(data.px[k]); });
    const i0 = M[h0 - 1].i, i1 = M[h1].i, nDays = i1 - i0 + 1;
    const res = {};
    for (const st of STRATS) {
      const nav = new Float64Array(nDays), mr = [], ws = [];
      nav[0] = base;
      let prev = null, navM = base;
      for (let h = h0; h <= h1; h++) {
        const w = weightsOf(st, ranks[h - 1]), to = turnover(w, prev), cost = c * to, a = M[h - 1].i, b = M[h].i;
        const start = navM * (1 - cost);
        for (let i = a + 1; i <= b; i++) {
          let g = 0;
          for (const k in w) g += w[k] * pxF[k][i] / pxF[k][a];
          nav[i - i0] = start * g;
        }
        let gm = 0;
        for (const k in w) gm += w[k] * (1 + mret[h][k]);
        const r = (1 - cost) * gm - 1;
        navM = navM * (1 + r);
        nav[b - i0] = navM; // 월말 값은 월 수익률과 정확히 일치하게
        mr.push(r); ws.push({ w, turnover: to, cost });
        prev = {}; // 월말 실제 비중 (1+2등주는 한 달 동안 벌어진 비중 → 다음 달 초 50:50 재조정도 비용에 반영)
        for (const k in w) prev[k] = (w[k] * (1 + mret[h][k])) / gm;
      }
      res[st.id] = { nav, mret: mr, weights: ws };
    }
    // 낙폭 (일별)
    for (const id of STRAT_IDS) {
      const nav = res[id].nav, dd = new Float64Array(nav.length);
      let pk = -Infinity;
      for (let k = 0; k < nav.length; k++) { if (nav[k] > pk) pk = nav[k]; dd[k] = nav[k] / pk - 1; }
      res[id].dd = dd;
    }
    const lastPartial = !M[h1].complete;
    const hs = []; for (let h = h0; h <= h1; h++) hs.push(h);
    const full = hs.filter((h) => M[h].complete); // 월 통계는 끝난 달만
    const nFull = full.length;
    const stats = {};
    for (const st of STRATS) {
      const r = res[st.id].mret.slice(0, nFull), bm = res.BM.mret.slice(0, nFull), ms = meanSd(r);
      const cum = r.reduce((p, v) => p * (1 + v), 1) - 1, logCum = r.reduce((s, v) => s + Math.log(1 + v), 0);
      const kEnd = nFull ? M[full[nFull - 1]].i - i0 : 0;
      let mdd = 0;
      for (let k = 0; k <= kEnd; k++) if (res[st.id].dd[k] < mdd) mdd = res[st.id].dd[k];
      const ex = r.map((v, j) => v - bm[j]), exs = meanSd(ex);
      const l12 = r.length >= 12 ? r.slice(-12).reduce((p, v) => p * (1 + v), 1) - 1 : NaN;
      stats[st.id] = {
        n: r.length, mean: ms.mean, sd: ms.sd, cum, logCum, cagr: r.length ? Math.pow(1 + cum, 12 / r.length) - 1 : NaN,
        sharpe: ms.sd > 0 ? (ms.mean / ms.sd) * Math.sqrt(12) : NaN, mdd,
        hitBM: st.id === "BM" || !r.length ? NaN : ex.filter((v) => v > 0).length / r.length,
        excess: st.id === "BM" ? NaN : exs.mean, ir: st.id === "BM" || !(exs.sd > 0) ? NaN : (exs.mean / exs.sd) * Math.sqrt(12),
        best: r.length ? Math.max.apply(null, r) : NaN, worst: r.length ? Math.min.apply(null, r) : NaN, last12: l12,
        mtd: lastPartial ? res[st.id].mret[hs.length - 1] : NaN,
        turnover: res[st.id].weights.slice(0, nFull).reduce((s, x) => s + x.turnover, 0) / Math.max(1, nFull),
      };
    }
    // TIGER 200 대비 상회 업종 수 분포 (보유 월 = 각 달 수익률)
    const beat = [0, 0, 0, 0], beatBy = {};
    SECTOR_KEYS.forEach((k) => { beatBy[k] = 0; });
    full.forEach((h) => {
      let n = 0;
      SECTOR_KEYS.forEach((k) => { if (mret[h][k] > mret[h].bm) { n++; beatBy[k]++; } });
      beat[n]++;
    });
    // 전월 순위 → 이번 달 수익률 순위 (보유 월 기준)
    const trans = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], first = [0, 0, 0];
    full.forEach((h) => {
      const prevO = ranks[h - 1].order, cur = SECTOR_KEYS.slice().sort((a, b) => mret[h][b] - mret[h][a] || SECTOR_KEYS.indexOf(a) - SECTOR_KEYS.indexOf(b));
      prevO.forEach((k, p) => { const q = cur.indexOf(k); trans[p][q]++; });
      // 그달 세 순위 자리 중 수익률 1위였던 자리
      first[prevO.indexOf(cur[0])]++;
    });
    return {
      ok: true, look, costBp: c * 1e4, M, ranks, mret, h0, h1, i0, i1, dates: D.slice(i0, i1 + 1), res, stats,
      nFull, lastPartial, beat, beatBy, trans, first, hs,
    };
  }

  /* 현재 상태: 마지막으로 끝난 달의 순위 → 보유 중(또는 보유 예정) 종목, 진행 중인 달의 잠정 순위 */
  function status(data, look, asOf) {
    look = LOOKS.indexOf(+look) >= 0 ? +look : DEFAULTS.look;
    const M = monthsOf(data, asOf);
    if (!M.length) return null;
    const last = M.length - 1, partial = !M[last].complete, mc = partial ? last - 1 : last;
    const rk = mc >= 0 ? rankAt(M, mc, look) : null, rkNow = partial ? rankAt(M, last, look) : null;
    const ret = (m, k) => (m >= 1 ? M[m].px[k] / M[m - 1].px[k] - 1 : NaN);
    const rows = ASSETS.map((a) => ({
      key: a.key, prev: mc >= 1 ? ret(mc, a.key) : NaN, prevScore: rk ? rk.score[a.key] : NaN,
      prevRank: rk && rk.order.indexOf(a.key) >= 0 ? rk.order.indexOf(a.key) + 1 : null,
      mtd: partial ? ret(last, a.key) : NaN, nowScore: rkNow ? rkNow.score[a.key] : NaN,
      nowRank: rkNow && rkNow.order.indexOf(a.key) >= 0 ? rkNow.order.indexOf(a.key) + 1 : null,
      close: M[last].px[a.key],
    }));
    return {
      look, lastDate: data.dates[data.dates.length - 1], partial, rankYm: mc >= 0 ? M[mc].ym : null,
      asOf: kstOf(asOf), intraday: intradayAt(data.dates[data.dates.length - 1], asOf),
      holdYm: mc >= 0 ? nextYm(M[mc].ym) : null, curYm: M[last].ym, rank: rk, rankNow: rkNow, rows,
      hold: rk ? rk.order[1] : null, nextHold: rkNow ? rkNow.order[1] : null, nextYm: nextYm(M[last].ym),
    };
  }

  /* ---------- 엑셀 'TIGER' 시트 (Infomax IMDH 내보내기) ----------
     1행 조회 조건 · 2행 종목 이름(IMDH 수식 결과 = Title) · 3행 머리글(일자 | 수정가 현재가 …) · 4행부터 날짜 오름차순.
     머리글 행 = 처음 20행 안에서 '일자' 셀이 있는 첫 행. 종목 이름(또는 6자리 코드)은 그 위 행에서 찾고,
     이름이 있는 열부터 오른쪽으로 아직 배정되지 않은 첫 값 열에 대응한다(첫 종목 이름은 일자 열 위에 있음).
     for_data scripts/build_kospi_tiger_data.py 와 같은 규칙. */
  const SHEET_NAME = "TIGER";
  const squash = (v) => (v == null ? "" : String(v).replace(/\s+/g, "").toUpperCase());
  function assetOfCell(v) {
    const s = squash(v);
    if (!s) return null;
    for (const a of ASSETS) if (s === squash(a.name) || s.indexOf(a.code) >= 0) return a.key;
    return null;
  }
  function findTigerSheet(list) {
    return (list || []).filter((s) => s && Array.isArray(s.rows) && String(s.name).trim().toUpperCase() === SHEET_NAME)[0] || null;
  }
  function parseSheet(rows, date1904) {
    rows = rows || [];
    let hr = -1, dc = -1;
    for (let r = 0; r < Math.min(rows.length, 20) && hr < 0; r++) {
      const row = rows[r] || [];
      for (let j = 0; j < row.length; j++) if (squash(row[j]) === "일자") { hr = r; dc = j; break; }
    }
    if (hr < 0) throw new Error("TIGER 시트의 처음 20행 안에서 '일자' 머리글을 찾지 못했습니다.");
    const head = rows[hr] || [], width = Math.max.apply(null, rows.slice(0, hr + 2).map((r) => (r || []).length).concat([head.length]));
    const valCols = [];
    for (let j = 0; j < width; j++) if (j !== dc && squash(head[j])) valCols.push(j);
    const col = {}, used = new Set();
    let nr = hr - 1; // 종목 이름 행 = 머리글 바로 위에서 가장 가까운, 종목 이름이 있는 행 (조회 조건 행의 글자에 끌려가지 않게)
    while (nr >= 0 && !(rows[nr] || []).some((v) => assetOfCell(v))) nr--;
    for (let r = Math.max(nr, 0); r <= nr; r++) {
      const row = rows[r] || [];
      for (let j = 0; j < row.length; j++) {
        const k = assetOfCell(row[j]);
        if (!k || k in col) continue;
        const c = valCols.filter((x) => x >= j && !used.has(x))[0];
        if (c == null) continue;
        col[k] = c; used.add(c);
      }
    }
    const miss = ASSETS.filter((a) => !(a.key in col));
    if (miss.length) throw new Error("TIGER 시트에서 " + miss.map((a) => a.name + "(" + a.code + ")").join(", ") + " 열을 찾지 못했습니다. 머리글 위 행에 종목 이름이 있어야 합니다.");
    const raw = { dates: [], px: {} };
    ASSET_KEYS.forEach((k) => { raw.px[k] = []; });
    let badDates = 0;
    for (let r = hr + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (ASSET_KEYS.every((k) => row[col[k]] == null || row[col[k]] === "") && (row[dc] == null || row[dc] === "")) continue;
      const d = toISODate(row[dc], date1904);
      if (!d) { badDates++; continue; }
      raw.dates.push(d);
      ASSET_KEYS.forEach((k) => raw.px[k].push(row[col[k]]));
    }
    const norm = normalize(raw);
    if (!norm.data.dates.length) throw new Error("TIGER 시트에 유효한 데이터 행이 없습니다.");
    norm.report.headerRow = hr + 1;
    norm.report.columns = col;
    norm.report.badDates = badDates;
    norm.report.priceField = String(head[col.semi] == null ? "" : head[col.semi]).trim();
    return norm;
  }

  return {
    VERSION, SECTORS, BENCH, ASSETS, SECTOR_KEYS, ASSET_KEYS, STRATS, STRAT_IDS, DEFAULTS, LOOKS, SHEET_NAME,
    toISODate, normalize, monthsOf, monthComplete, intradayAt, kstOf, rankAt, run, status, nextYm, findTigerSheet, parseSheet,
  };
});
