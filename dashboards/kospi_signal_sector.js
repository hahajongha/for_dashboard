/* KOSPI 시그널 랩 — 업종 추세 · 시장 폭 계산 엔진 (순수 함수 · DOM 없음)
   업종별 일별 종가지수로 상대강도(RS) 순위, 추세 템플릿(1~8), 단계(1~4), 시장 폭(2단계 업종 수 · 50·200일선 위 비율 ·
   52주 신고가/신저가 업종 수 · 업종 동일가중 지수), 과거 비슷한 국면과 지수 다이버전스를 계산한다.
   브라우저: window.KSC / Node: module.exports.
   배열 규칙: 업종 s, 날짜 i (전체 이력 기준). 값이 없으면 NaN. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.KSC = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = "1.0.0";
  const SHEET_NAME = "SECTOR";
  const LOOKS = [21, 63, 126, 189, 252]; // 1·3·6·9·12개월 (거래일)
  /* RS 원점수 = 기간 수익률의 가중합 → 그날 업종 사이 백분위 (가장 강한 업종 100) */
  const RS_MODES = [
    { id: "w", name: "가중 — 3·6·9·12개월 40/20/20/20", short: "가중", w: [[63, 0.4], [126, 0.2], [189, 0.2], [252, 0.2]] },
    { id: "m3", name: "3개월 수익률", short: "3개월", w: [[63, 1]] },
    { id: "m6", name: "6개월 수익률", short: "6개월", w: [[126, 1]] },
    { id: "m12", name: "12개월 수익률", short: "12개월", w: [[252, 1]] },
  ];
  const RS_IDS = RS_MODES.map((m) => m.id);
  /* rsMin: 추세 템플릿 8 기준 · low: 52주 최저가 대비 · high: 52주 최고가 대비 · slope: 200일선 상승 비교 거래일 · hilo: 52주 = 거래일 */
  const DEFAULTS = { rs: "w", rsMin: 70, low: 0.3, high: 0.25, slope: 21, hilo: 252 };
  const TT_NAMES = ["가격 > 150일선·200일선", "150일선 > 200일선", "200일선 상승 (21거래일 전보다 높음)", "50일선 > 150일선·200일선",
    "가격 > 50일선", "52주 최저가보다 30% 이상 위", "52주 최고가의 25% 이내", "RS 백분위 70 이상"];
  const STAGE_NAMES = { 0: "판정 전", 1: "1단계 바닥", 2: "2단계 상승", 3: "3단계 천장", 4: "4단계 하락" };

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
  /* 업종명: 앞뒤 공백 제거 · 쉼표는 가운뎃점 (예: '비철,목재등' → '비철·목재등') */
  const normName = (v) => String(v == null ? "" : v).replace(/\s*,\s*/g, "·").replace(/\s+/g, " ").trim();
  const squash = (v) => (v == null ? "" : String(v).replace(/\s+/g, "").toUpperCase());

  /* ---------- 데이터 정규화 ----------
     raw = { dates: [...], sectors: [업종명...], px: [[업종 0 종가...], ...] } (결측 허용)
     → 오름차순 · 같은 날짜는 마지막 행 · 모든 업종 값이 없는 날 제외 · 0 이하/문자 = 결측(NaN) · 같은 이름은 (2)… 붙임 */
  function normalize(raw) {
    raw = raw || {};
    const D = raw.dates || [], P = raw.px || [], used = new Set();
    const names = (raw.sectors || raw.names || []).map((v, s) => {
      const base = normName(v) || "업종 " + (s + 1);
      let n = base, k = 1;
      while (used.has(n)) n = base + " (" + ++k + ")";
      used.add(n);
      return n;
    });
    const byDate = new Map();
    let dropped = 0, duplicates = 0;
    for (let i = 0; i < D.length; i++) {
      const d = toISODate(D[i]);
      if (!d) { dropped++; continue; }
      const any = names.some((_, s) => { const v = toNum((P[s] || [])[i]); return isFinite(v) && v > 0; });
      if (!any) { dropped++; continue; }
      if (byDate.has(d)) duplicates++;
      byDate.set(d, i);
    }
    const dates = Array.from(byDate.keys()).sort(), missing = [];
    const px = names.map((_, s) => {
      const src = P[s] || [], out = new Float64Array(dates.length);
      let miss = 0, seenAny = false;
      for (let j = 0; j < dates.length; j++) {
        const v = toNum(src[byDate.get(dates[j])]);
        out[j] = isFinite(v) && v > 0 ? v : NaN;
        if (out[j] === out[j]) seenAny = true; else if (seenAny) miss++;
      }
      missing.push(miss);
      return out;
    });
    return {
      data: { dates, names, px },
      report: { rows: dates.length, sectors: names.length, dropped, duplicates, missing,
        firstDate: dates.length ? dates[0] : null, lastDate: dates.length ? dates[dates.length - 1] : null },
    };
  }
  /* 저장·발행용 (Float64Array → 배열, NaN → null) */
  function toPlain(data) {
    return { dates: data.dates.slice(), sectors: data.names.slice(), px: data.px.map((a) => Array.from(a, (v) => (v === v ? v : null))) };
  }

  /* ---------- 엑셀 SECTOR 시트 ----------
     머리글 행 = 처음 40행 안에서 'DATE'(공백 무시) 또는 '일자' 칸이 있는 첫 행, 그 아래가 일별 값(머리글 칸이 빈 열은 제외).
     업종명 = 머리글 위에서 날짜 열 칸이 'Name'(또는 '업종명'·'업종')인 행 → 없으면 머리글 행의 이름(서로 다를 때)
     값이 하나도 없는 행(예: 아직 값이 없는 오늘 날짜)은 건너뜀 */
  function findSectorSheet(list) {
    return (list || []).filter((s) => s && Array.isArray(s.rows) && String(s.name).trim().toUpperCase() === SHEET_NAME)[0] || null;
  }
  function parseSheet(rows, date1904) {
    rows = rows || [];
    let hr = -1, dc = -1;
    for (let r = 0; r < Math.min(rows.length, 40) && hr < 0; r++) {
      const row = rows[r] || [];
      for (let j = 0; j < row.length; j++) { const t = squash(row[j]); if (t === "DATE" || t === "일자") { hr = r; dc = j; break; } }
    }
    if (hr < 0) throw new Error("SECTOR 시트의 처음 40행 안에서 날짜 머리글(DATE 또는 일자)을 찾지 못했습니다.");
    const head = rows[hr] || [], cols = [];
    for (let j = dc + 1; j < head.length; j++) if (squash(head[j])) cols.push(j);
    if (cols.length < 2) throw new Error("SECTOR 시트 머리글 오른쪽에 업종 값 열이 2개 이상 있어야 합니다.");
    let names = null, nameRow = -1;
    for (let r = hr - 1; r >= 0 && nameRow < 0; r--) { const t = squash((rows[r] || [])[dc]); if (t === "NAME" || t === "업종명" || t === "업종") nameRow = r; }
    if (nameRow >= 0) names = cols.map((j) => normName((rows[nameRow] || [])[j]));
    else { const hn = cols.map((j) => normName(head[j])); if (new Set(hn).size === hn.length) names = hn; }
    if (!names || names.some((x) => !x)) throw new Error("SECTOR 시트에서 업종명을 찾지 못했습니다. 날짜 머리글 위에 첫 칸이 'Name'인 업종명 행을 두거나 머리글 행에 업종명을 적어 주세요.");
    const raw = { dates: [], sectors: names, px: cols.map(() => []) };
    let badDates = 0, blankRows = 0, emptyRows = 0;
    for (let r = hr + 1; r < rows.length; r++) {
      const row = rows[r] || [], dv = row[dc], vals = cols.map((j) => row[j]);
      const hasVal = vals.some((v) => v != null && v !== "");
      if ((dv == null || dv === "") && !hasVal) { blankRows++; continue; }
      const d = toISODate(dv, date1904);
      if (!d) { badDates++; continue; }
      const nums = vals.map((v) => { const x = toNum(v); return isFinite(x) && x > 0 ? x : null; });
      if (nums.every((x) => x == null)) { emptyRows++; continue; }
      raw.dates.push(d);
      nums.forEach((x, s) => raw.px[s].push(x));
    }
    if (!raw.dates.length) throw new Error("SECTOR 시트에 날짜와 값이 있는 행이 없습니다.");
    const n = normalize(raw);
    Object.assign(n.report, { sheet: SHEET_NAME, headerRow: hr + 1, nameRow: nameRow >= 0 ? nameRow + 1 : null, field: String(head[cols[0]] == null ? "" : head[cols[0]]).trim(),
      badDates, blankRows, emptyRows });
    return n;
  }

  /* ---------- 이동 창 ---------- */
  /* 최근 n개 값이 모두 있을 때의 단순평균 (누적합) */
  function sma(p, n) {
    const T = p.length, out = new Float64Array(T).fill(NaN);
    let sum = 0, cnt = 0;
    const S = new Float64Array(T + 1), C = new Int32Array(T + 1);
    for (let i = 0; i < T; i++) { const v = p[i], ok = v === v; sum += ok ? v : 0; cnt += ok ? 1 : 0; S[i + 1] = sum; C[i + 1] = cnt; }
    for (let i = n - 1; i < T; i++) if (C[i + 1] - C[i + 1 - n] === n) out[i] = (S[i + 1] - S[i + 1 - n]) / n;
    return out;
  }
  /* 최근 n개 값이 모두 있을 때의 최고(또는 최저) — 단조 덱 */
  function rollExt(p, n, isMax) {
    const T = p.length, out = new Float64Array(T).fill(NaN), dq = new Int32Array(Math.max(T, 1));
    let h = 0, t = 0, lastBad = -1;
    for (let i = 0; i < T; i++) {
      const v = p[i];
      if (!(v === v)) { lastBad = i; h = t = 0; continue; }
      while (t > h && (isMax ? p[dq[t - 1]] <= v : p[dq[t - 1]] >= v)) t--;
      dq[t++] = i;
      while (dq[h] <= i - n) h++;
      if (i >= n - 1 && i - n + 1 > lastBad) out[i] = p[dq[h]];
    }
    return out;
  }

  /* ---------- 계산 ----------
     추세 템플릿 (그날 종가 기준, 계산할 수 없는 날은 모두 거짓):
       1 P > SMA150 · P > SMA200   2 SMA150 > SMA200   3 SMA200 > slope거래일 전 SMA200   4 SMA50 > SMA150 · SMA50 > SMA200
       5 P > SMA50   6 P ≥ (1 + low) × 52주 최저   7 P ≥ (1 − high) × 52주 최고   8 RS 백분위 ≥ rsMin
     단계: 2 = 1~7 모두 충족 · 4 = P < SMA150 · P < SMA200 · SMA150 < SMA200 · SMA200 하락
           그 밖 = 직전 확정 단계가 2면 3(천장), 4면 1(바닥), 아직 없으면 0 */
  function compute(data, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const D = data.dates, T = D.length, N = data.names.length, sec = [];
    for (let s = 0; s < N; s++) {
      const p = data.px[s], s50 = sma(p, 50), s150 = sma(p, 150), s200 = sma(p, 200), hi = rollExt(p, o.hilo, true), lo = rollExt(p, o.hilo, false);
      const ret = {};
      LOOKS.forEach((n) => { const r = new Float64Array(T).fill(NaN); for (let i = n; i < T; i++) r[i] = p[i] / p[i - n] - 1; ret[n] = r; });
      const tt = new Uint8Array(T), ttn = new Uint8Array(T), stage = new Int8Array(T), valid = new Uint8Array(T);
      let lastDef = 0;
      for (let i = 0; i < T; i++) {
        const P = p[i], a = s50[i], b = s150[i], c = s200[i], cp = i >= o.slope ? s200[i - o.slope] : NaN, H = hi[i], L = lo[i];
        if (!(P === P && c === c && cp === cp && H === H)) continue;
        valid[i] = 1;
        const f = [P > b && P > c, b > c, c > cp, a > b && a > c, P > a, P >= (1 + o.low) * L, P >= (1 - o.high) * H];
        let bits = 0, n = 0;
        for (let k = 0; k < 7; k++) if (f[k]) { bits |= 1 << k; n++; }
        tt[i] = bits; ttn[i] = n;
        if (n === 7) { lastDef = 2; stage[i] = 2; }
        else if (P < b && P < c && b < c && c < cp) { lastDef = 4; stage[i] = 4; }
        else stage[i] = lastDef === 2 ? 3 : lastDef === 4 ? 1 : 0;
      }
      sec.push({ name: data.names[s], p, s50, s150, s200, hi, lo, ret, tt, ttn, stage, valid });
    }
    // 시장 폭
    const B = { nValid: new Int16Array(T), n2: new Int16Array(T), n4: new Int16Array(T), a50: new Int16Array(T), n50: new Int16Array(T),
      a200: new Int16Array(T), n200: new Int16Array(T), nh: new Int16Array(T), nl: new Int16Array(T), ew: new Float64Array(T) };
    let ew = 1;
    for (let i = 0; i < T; i++) {
      let sr = 0, nr = 0;
      for (const x of sec) {
        const P = x.p[i];
        if (x.valid[i]) B.nValid[i]++;
        if (x.stage[i] === 2) B.n2[i]++;
        if (x.stage[i] === 4) B.n4[i]++;
        if (x.s50[i] === x.s50[i]) { B.n50[i]++; if (P > x.s50[i]) B.a50[i]++; }
        if (x.s200[i] === x.s200[i]) { B.n200[i]++; if (P > x.s200[i]) B.a200[i]++; }
        if (x.hi[i] === x.hi[i] && P >= x.hi[i]) B.nh[i]++;
        if (x.lo[i] === x.lo[i] && P <= x.lo[i]) B.nl[i]++;
        if (i > 0 && P === P && x.p[i - 1] === x.p[i - 1]) { sr += P / x.p[i - 1] - 1; nr++; }
      }
      if (nr > 0) ew *= 1 + sr / nr;
      B.ew[i] = ew;
    }
    return { v: VERSION, o, dates: D, names: data.names, N, T, sec, breadth: B, rs: {} };
  }
  /* RS 원점수·백분위 (기준별로 한 번만 계산) — 동률은 평균 순위, 그날 값이 있는 업종이 2개 이상일 때만 */
  function rsOf(st, mode) {
    mode = RS_IDS.includes(mode) ? mode : DEFAULTS.rs;
    if (st.rs[mode]) return st.rs[mode];
    const M = RS_MODES.find((m) => m.id === mode), T = st.T, N = st.N;
    const raw = st.sec.map((x) => {
      const r = new Float64Array(T);
      for (let i = 0; i < T; i++) { let v = 0; for (const [n, w] of M.w) v += w * x.ret[n][i]; r[i] = v; } // NaN 이 섞이면 NaN
      return r;
    });
    const pct = st.sec.map(() => new Float64Array(T).fill(NaN)), idx = new Int32Array(N);
    for (let i = 0; i < T; i++) {
      let n = 0;
      for (let s = 0; s < N; s++) if (raw[s][i] === raw[s][i]) idx[n++] = s;
      if (n < 2) continue;
      const ord = Array.from(idx.subarray(0, n)).sort((a, b) => raw[a][i] - raw[b][i]);
      for (let k = 0; k < n;) {
        let e = k;
        while (e + 1 < n && raw[ord[e + 1]][i] === raw[ord[k]][i]) e++;
        const p = ((k + e) / 2 / (n - 1)) * 100; // (평균 순위 − 1) / (n − 1) × 100
        for (let q = k; q <= e; q++) pct[ord[q]][i] = p;
        k = e + 1;
      }
    }
    return (st.rs[mode] = { mode, raw, pct });
  }
  /* 현재 단계가 시작된 날 */
  function stageStart(x, i) { let s = i; while (s > 0 && x.stage[s - 1] === x.stage[i]) s--; return s; }
  /* 날짜 i 의 업종별 상태 (RS 순위순) */
  function snapshot(st, i, mode) {
    const R = rsOf(st, mode), o = st.o;
    const rows = st.sec.map((x, s) => {
      const P = x.p[i], pct = R.pct[s][i], v = x.valid[i] === 1, flags = [];
      for (let k = 0; k < 7; k++) flags.push(v && (x.tt[i] & (1 << k)) !== 0);
      flags.push(v && pct === pct && pct >= o.rsMin);
      return {
        s, name: x.name, close: P, r21: x.ret[21][i], r63: x.ret[63][i], r126: x.ret[126][i], r252: x.ret[252][i],
        rsRaw: R.raw[s][i], rs: pct, flags, tt: x.ttn[i], tt8: x.ttn[i] + (flags[7] ? 1 : 0), valid: v, stage: x.stage[i], since: stageStart(x, i),
        s50: x.s50[i], s150: x.s150[i], s200: x.s200[i], hi: x.hi[i], lo: x.lo[i],
        ext50: P / x.s50[i] - 1, ext200: P / x.s200[i] - 1, fromHi: P / x.hi[i] - 1, fromLo: P / x.lo[i] - 1,
      };
    });
    const ranked = rows.filter((r) => r.rsRaw === r.rsRaw).sort((a, b) => b.rsRaw - a.rsRaw || a.s - b.s);
    ranked.forEach((r) => { r.rank = 1 + ranked.filter((q) => q.rsRaw > r.rsRaw).length; });
    return ranked.concat(rows.filter((r) => !(r.rsRaw === r.rsRaw)));
  }
  /* 단계 구간 [{ a, b, stage }] (i0~i1) */
  function stageRuns(st, s, i0, i1) {
    const g = st.sec[s].stage, out = [];
    for (let i = i0; i <= i1; i++) {
      if (out.length && out[out.length - 1].stage === g[i]) out[out.length - 1].b = i;
      else out.push({ a: i, b: i, stage: g[i] });
    }
    return out;
  }
  /* 시장 폭을 계산할 수 있는 첫날 (모든 업종의 200일선·52주 값이 있는 날) */
  function breadthStart(st) { const B = st.breadth; for (let i = 0; i < st.T; i++) if (B.nValid[i] === st.N) return i; return -1; }

  /* ---------- KOSPI 와 비교 ---------- */
  /* 업종 날짜에 맞춘 KOSPI 종가 (없는 날 NaN) */
  function alignClose(dates, kDates, kClose) {
    const m = new Map();
    for (let i = 0; i < kDates.length; i++) m.set(kDates[i], kClose[i]);
    return Float64Array.from(dates, (d) => { const v = m.get(d); return isNum(v) && v > 0 ? v : NaN; });
  }
  /* 과거 비슷한 국면: 200일선 위 업종 수가 maxAbove 이하인 날 (모든 업종을 판정할 수 있는 날만 — 시장 폭과 같은 기간).
     직전 해당일과 gap 거래일보다 멀리 떨어진 첫날을 새 국면의 시작으로 본다 */
  function episodes(st, kc, opts) {
    const o = Object.assign({ maxAbove: 1, gap: 126 }, opts || {}), B = st.breadth, T = st.T, out = [];
    let last = -1e9;
    const fwd = (i, n) => (i + n < T && kc[i] === kc[i] && kc[i + n] === kc[i + n] ? kc[i + n] / kc[i] - 1 : NaN);
    for (let i = 0; i < T; i++) {
      if (B.nValid[i] !== st.N || B.a200[i] > o.maxAbove) continue;
      if (i - last > o.gap) {
        let hi = -Infinity, mn = Infinity, days = 0;
        for (let j = Math.max(0, i - 251); j <= i; j++) if (kc[j] > hi) hi = kc[j];
        for (let j = i; j <= Math.min(T - 1, i + 126); j++) if (kc[j] < mn) mn = kc[j]; // 시작일 포함 → 더 내려가지 않았으면 0
        for (let j = i; j <= Math.min(T - 1, i + 126); j++) if (B.nValid[j] === st.N && B.a200[j] <= o.maxAbove) days++;
        out.push({ i, date: st.dates[i], above: B.a200[i], kospi: kc[i], fromHi: kc[i] === kc[i] && hi > 0 ? kc[i] / hi - 1 : NaN,
          f21: fwd(i, 21), f63: fwd(i, 63), f126: fwd(i, 126), f252: fwd(i, 252), minNext: isFinite(mn) && kc[i] === kc[i] ? mn / kc[i] - 1 : NaN,
          full126: i + 126 < T, days });
      }
      last = i;
    }
    return out;
  }
  /* 다이버전스 점검: 최근 KOSPI 52주 종가 신고가일에 2단계 업종 수가 그 전 1년(252거래일) 최대보다 얼마나 적었나 */
  function divergence(st, kc) {
    const B = st.breadth, T = st.T, n = st.o.hilo;
    let k = -1;
    for (let i = T - 1; i >= n - 1 && k < 0; i--) { // 그날 종가가 최근 n거래일(값이 있는 날) 최고
      if (!(kc[i] === kc[i])) continue;
      let hi = -Infinity;
      for (let j = i - n + 1; j <= i; j++) if (kc[j] > hi) hi = kc[j];
      if (kc[i] >= hi) k = i;
    }
    if (k < 0) return null;
    let mx = -1, mi = -1;
    for (let j = Math.max(0, k - n); j < k; j++) if (B.nValid[j] === st.N && B.n2[j] > mx) { mx = B.n2[j]; mi = j; }
    return { k, date: st.dates[k], kospi: kc[k], n2: B.n2[k], a200: B.a200[k], a50: B.a50[k], prevMax: mx, prevMaxI: mi, prevMaxDate: mi >= 0 ? st.dates[mi] : null,
      prevMaxKospi: mi >= 0 ? kc[mi] : NaN, kospiChg: mi >= 0 ? kc[k] / kc[mi] - 1 : NaN, ewChg: mi >= 0 ? B.ew[k] / B.ew[mi] - 1 : NaN, ago: T - 1 - k };
  }
  /* 월말(그달 마지막 거래일) 인덱스 */
  function monthEnds(dates) {
    const out = [];
    for (let i = 0; i < dates.length; i++) if (i === dates.length - 1 || dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7)) out.push(i);
    return out;
  }
  /* 월말 시장 폭: 월말 값 + 그달 한 번이라도 52주 신고가(신저가)를 낸 업종 수 · 월간 수익률(KOSPI · 동일가중) */
  function monthly(st, kc) {
    const B = st.breadth, out = [];
    let prev = -1;
    for (const i of monthEnds(st.dates)) {
      let hiAny = 0, loAny = 0;
      for (const x of st.sec) {
        let h = false, l = false;
        for (let j = prev + 1; j <= i; j++) { if (x.p[j] >= x.hi[j]) h = true; if (x.p[j] <= x.lo[j]) l = true; } // NaN 비교는 거짓
        if (h) hiAny++;
        if (l) loAny++;
      }
      out.push({ ym: st.dates[i].slice(0, 7), i, kospi: kc ? kc[i] : NaN, kRet: kc && prev >= 0 ? kc[i] / kc[prev] - 1 : NaN, ewRet: prev >= 0 ? B.ew[i] / B.ew[prev] - 1 : NaN,
        n2: B.n2[i], n4: B.n4[i], a50: B.a50[i], n50: B.n50[i], a200: B.a200[i], n200: B.n200[i], nh: B.nh[i], nl: B.nl[i], nValid: B.nValid[i], hiAny, loAny });
      prev = i;
    }
    return out;
  }

  /* ---------- 매매 규칙 (월말 종가로 판단 → 다음 월말 종가까지 보유) ----------
     비중 신호: 월말 200일선 위 업종 비율 ≥ th 이면 보유, 아니면 현금.
     업종 후보: 2단계 + RS 백분위 ≥ rsMin (추세 템플릿 1~8 충족) — 동일 비중, RS 순.
     결합: 비중 신호가 꺼지면 현금 · 켜지면 후보 동일 비중 · 후보가 없으면 KOSPI(fallback "cash" 이면 현금).
     비교용: 비중 신호만(KOSPI↔현금) · 업종 후보만(후보가 없으면 동일가중) · RS 상위 top개 · 4단계 업종 · KOSPI · 업종 동일가중(월 리밸런싱).
     비용: 목표 비중 변화(Σ|Δw|, KOSPI 포함 · 현금 제외)에 편도 costBp — KOSPI·동일가중 기준선은 비용 없음.
     현금: 연 cash% (월 (1+cash)^(1/12)−1). complete = 데이터 마지막 날의 달이 끝났는가 (아니면 그 달은 '진행 중' — 통계에서 뺌). */
  const RULE_IDS = ["combo", "timing", "select", "top5", "st4", "kospi", "ew"];
  const RULE_BENCH = { combo: "kospi", timing: "kospi", select: "ew", top5: "ew", st4: "ew", ew: "kospi", kospi: null };
  /* lag: 체결 시점 — 0 = 신호를 낸 월말 종가, 1 = 다음 거래일 종가 (보유 구간이 하루씩 밀림)
     lastIntraday: 마지막 행이 장중 값(종가 아님)인가 — 다음 거래일 체결이면 그 값으로 끝낸 달은 아직 진행 중으로 봄 */
  const RULE_DEFAULTS = { th: 0.5, rs: "w", rsMin: 70, fallback: "kospi", costBp: 5, cash: 0, top: 5, complete: true, lag: 0, lastIntraday: false };
  function normCdf(z) { // Abramowitz–Stegun 7.1.26 (오차 1.5e-7)
    const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
    const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
  }
  /* 평균과 Newey-West t (Bartlett, lag) */
  function nwT(x, lag) {
    const n = x.length;
    if (n < 3) return NaN;
    let m = 0;
    for (const v of x) m += v;
    m /= n;
    const e = x.map((v) => v - m);
    let v = 0;
    for (const q of e) v += q * q;
    v /= n;
    for (let l = 1; l <= Math.min(lag, n - 1); l++) {
      let g = 0;
      for (let t = l; t < n; t++) g += e[t] * e[t - l];
      v += 2 * (1 - l / (lag + 1)) * (g / n);
    }
    return v > 0 ? m / Math.sqrt(v / n) : NaN;
  }
  function rules(st, kc, opts) {
    const o = Object.assign({}, RULE_DEFAULTS, opts || {});
    const B = st.breadth, N = st.N, T = st.T, D = st.dates, R = rsOf(st, o.rs), ME = monthEnds(D);
    const hasK = !!kc && kc.length === T && kc.some((v) => v > 0); // 날짜가 겹치는 KOSPI 값이 하나도 없으면 데이터 없음과 같게
    const lastDone = o.complete ? ME.length - 1 : ME.length - 2; // 마지막으로 끝난 월말의 위치 (ME 안)
    const cost = o.costBp / 10000, cashM = Math.pow(1 + o.cash / 100, 1 / 12) - 1, L = o.lag === 1 ? 1 : 0;
    const signalAt = (i) => {
      const ok = B.nValid[i] === N && B.n200[i] > 0, cands = [], st4 = [], ord = [];
      for (let s = 0; s < N; s++) {
        const g = st.sec[s].stage[i];
        if (g === 2 && R.pct[s][i] >= o.rsMin) cands.push(s);
        if (g === 4) st4.push(s);
        if (R.raw[s][i] === R.raw[s][i]) ord.push(s);
      }
      const byRs = (a, b) => R.raw[b][i] - R.raw[a][i] || a - b;
      ord.sort(byRs); cands.sort(byRs); st4.sort(byRs);
      return { i, date: D[i], ok, a200: B.a200[i], n200: B.n200[i], share: B.n200[i] ? B.a200[i] / B.n200[i] : NaN,
        inMkt: ok && B.a200[i] >= o.th * B.n200[i] - 1e-9, cands, top: ord.slice(0, o.top), st4, n2: B.n2[i], n4: B.n4[i] };
    };
    /* 규칙별 목표 비중: 길이 N+1 (마지막 칸 = KOSPI) · 합이 1 보다 작으면 나머지는 현금 */
    const eq = (list) => { const w = new Float64Array(N + 1); for (const s of list) w[s] = 1 / list.length; return w; };
    const all = eq(Array.from({ length: N }, (_, s) => s));
    const kosW = () => { const w = new Float64Array(N + 1); w[N] = 1; return w; };
    const weightsOf = (g) => ({
      combo: !g.inMkt ? new Float64Array(N + 1) : g.cands.length ? eq(g.cands) : o.fallback === "kospi" && hasK ? kosW() : new Float64Array(N + 1),
      timing: g.inMkt && hasK ? kosW() : new Float64Array(N + 1),
      select: g.cands.length ? eq(g.cands) : all,
      top5: eq(g.top),
      st4: g.st4.length ? eq(g.st4) : all,
      kospi: hasK ? kosW() : new Float64Array(N + 1),
      ew: all,
    });
    const months = [], prevW = {}, nav = {}, level = {}, needK = { timing: 1, kospi: 1 }, skipped = [];
    RULE_IDS.forEach((id) => { nav[id] = new Float64Array(T).fill(NaN); level[id] = 1; });
    let i0 = -1;
    for (let k = 0; k < ME.length - 1; k++) {
      const i = ME[k], j = ME[k + 1];
      if (B.nValid[i] !== N) { if (i0 >= 0) skipped.push(D[i]); continue; } // 시작 뒤 값이 빠져 판정할 수 없는 월말은 건너뜀
      const a = Math.min(i + L, T - 1), b = Math.min(j + L, T - 1); // 보유 구간 (a, b]: 체결일 종가에 사서 다음 체결일 종가에 판다
      if (i0 < 0) i0 = i;
      // 끝난 달: 달력상 끝났고, 다음 날 체결이면 그 체결일 종가까지 있어야 함 (마지막 행이 장중 값이면 아직)
      const done = k + 1 <= lastDone && j + L <= T - 1 && !(L && j + L === T - 1 && o.lastIntraday);
      const g = signalAt(i), W = weightsOf(g);
      const cashAt = (d) => Math.pow(1 + cashM, done ? (d - a) / (b - a) : (d - a) / 21); // 진행 중인 달은 21거래일 = 한 달로
      const r = new Float64Array(N + 1);
      for (let s = 0; s < N; s++) { const pa = st.sec[s].p[a], pb = st.sec[s].p[b]; r[s] = pa > 0 && pb > 0 ? pb / pa - 1 : NaN; }
      r[N] = hasK && kc[a] > 0 && kc[b] > 0 ? kc[b] / kc[a] - 1 : NaN;
      const ret = {}, turn = {};
      for (const id of RULE_IDS) {
        const w = W[id], pw = prevW[id];
        let gross = 0, wsum = 0, wok = 0, tv = 0;
        for (let q = 0; q <= N; q++) {
          if (!w[q]) continue;
          wsum += w[q];
          if (r[q] === r[q]) { gross += w[q] * r[q]; wok += w[q]; }
        }
        if (wsum > 0 && wok < wsum - 1e-12) gross = wok > 0 ? (gross / wok) * wsum : NaN; // 값이 빠진 종목은 나머지 비중으로 나눔
        gross += (1 - wsum) * (cashAt(b) - 1);
        if (id !== "kospi" && id !== "ew") for (let q = 0; q <= N; q++) tv += Math.abs(w[q] - (pw ? pw[q] : 0));
        turn[id] = tv;
        // KOSPI 를 쓰는 규칙(비중 신호만·KOSPI 보유)은 KOSPI 수익률이 있는 달만 셈 — KOSPI 데이터가 짧아도 현금 달만 남는 치우침이 없게
        ret[id] = needK[id] && !(r[N] === r[N]) ? NaN : (1 - cost * tv) * (1 + gross) - 1; // 비용은 체결일에 기준가에서 뺌
        prevW[id] = w;
        // 일별 기준가: 비용을 뺀 뒤 목표 비중으로 사서 그달 보유 (종목별 가격 비율 · 값이 없으면 그달 직전 비율)
        if (ret[id] === ret[id]) {
          if (b > a && !(nav[id][a] === nav[id][a])) nav[id][a] = level[id]; // 구간 시작점: 첫 달이거나 수익률이 없던 달 다음 (기준가는 그대로 이어감 · 보유일이 없는 달은 점을 찍지 않음)
          const start = level[id] * (1 - cost * tv), last = new Float64Array(N + 1).fill(1);
          for (let d = a + 1; d <= b; d++) {
            let v = 0;
            for (let q = 0; q <= N; q++) {
              if (!w[q]) continue;
              const p0 = q < N ? st.sec[q].p[a] : kc[a], p1 = q < N ? st.sec[q].p[d] : kc[d];
              if (p0 > 0 && p1 > 0) last[q] = p1 / p0;
              v += w[q] * last[q];
            }
            nav[id][d] = start * (v + (1 - wsum) * cashAt(d));
          }
          level[id] *= 1 + ret[id];
          if (b > a) nav[id][b] = level[id]; // 구간 끝은 월 수익률과 정확히 일치 (값이 빠진 종목 처리 차이 제거)
        }
      }
      months.push({ k, i, j, a, b, date: D[i], end: D[j], entry: D[a], exit: D[b], done, sig: g, ret, turn, w: W });
    }
    /* 통계: 끝난 달 중 그 규칙의 수익률이 있는 달 */
    const doneM = months.filter((m) => m.done), stats = {};
    const kEnd = doneM.length ? doneM[doneM.length - 1].k : -1; // 마지막으로 끝난 달 — '최근 2년' = 이 달까지 24개월 (건너뛴 달도 셈)
    for (const id of RULE_IDS) {
      const mm = doneM.filter((m) => m.ret[id] === m.ret[id]);
      if (mm.length < 2) { stats[id] = null; continue; }
      const rs = mm.map((m) => m.ret[id]);
      let eqv = 1, peak = 1, mdd = 0, sum = 0;
      for (const v of rs) { eqv *= 1 + v; peak = Math.max(peak, eqv); mdd = Math.min(mdd, eqv / peak - 1); sum += v; }
      const n = rs.length, mean = sum / n;
      let ss = 0;
      for (const v of rs) ss += (v - mean) * (v - mean);
      const vol = Math.sqrt(ss / (n - 1)) * Math.sqrt(12), cagr = Math.pow(eqv, 12 / n) - 1;
      const inv = mm.filter((m) => { let t = 0; for (const x of m.w[id]) t += x; return t > 1e-9; }).length / n;
      const bid = RULE_BENCH[id], pm = bid ? mm.filter((m) => m.ret[bid] === m.ret[bid]) : []; // 비교 대상도 수익률이 있는 달만 비교
      const out = { n, from: mm[0].date, to: mm[n - 1].end, cagr, mdd, vol, rv: vol > 0 ? cagr / vol : NaN, inv,
        turn: mm.reduce((a, m) => a + m.turn[id], 0) / n, bench: bid, nx: pm.length };
      if (pm.length >= 3) {
        const x = pm.map((m) => m.ret[id] - m.ret[bid]), t = nwT(x, 3), x24 = x.filter((v, q) => pm[q].k <= kEnd - 24);
        const diff = x.filter((v) => Math.abs(v) > 1e-12);
        Object.assign(out, { ex: x.reduce((a, v) => a + v, 0) / x.length, t, p: t === t ? 2 * (1 - normCdf(Math.abs(t))) : NaN,
          hit: diff.length ? diff.filter((v) => v > 0).length / diff.length : NaN,
          ex24: x24.length ? x24.reduce((a, v) => a + v, 0) / x24.length : NaN, t24: nwT(x24, 3) });
      }
      stats[id] = out;
    }
    const gov = lastDone >= 0 && B.nValid[ME[lastDone]] === N ? signalAt(ME[lastDone]) : null;
    let kp = lastDone - 1; // 직전 신호: 바로 앞 월말을 값이 빠져 건너뛰었으면 그 전 신호 (위 비용 계산의 직전 비중과 같은 기준)
    while (kp >= 0 && B.nValid[ME[kp]] !== N) kp--;
    const prevGov = kp >= 0 ? signalAt(ME[kp]) : null;
    const live = !o.complete && B.nValid[T - 1] === N ? signalAt(T - 1) : null;
    return { o, ids: RULE_IDS, bench: RULE_BENCH, i0, months, stats, nav, gov, prevGov, live, hasK, cashM, skipped,
      lastEnd: lastDone >= 0 ? D[ME[lastDone]] : null, weightsOf: (g) => weightsOf(g) };
  }

  return {
    VERSION, SHEET_NAME, LOOKS, RS_MODES, RS_IDS, DEFAULTS, TT_NAMES, STAGE_NAMES,
    toISODate, normName, normalize, toPlain, findSectorSheet, parseSheet, sma, rollExt,
    compute, rsOf, snapshot, stageStart, stageRuns, breadthStart, alignClose, episodes, divergence, monthEnds, monthly,
    RULE_IDS, RULE_BENCH, RULE_DEFAULTS, normCdf, nwT, rules,
  };
});
