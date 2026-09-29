/* KOSPI 시그널 랩 — 엑셀(xlsx) 읽기 (외부 라이브러리 없음, 브라우저 안에서만 처리)
   zip 목차 → (DecompressionStream 'deflate-raw' 또는 내장 inflate) → workbook/sharedStrings/시트 XML
   결과: { date1904, sheetNames, sheets: [{ name, rows }] }  — rows[r][c] = 셀 값 (숫자·문자열·null)
   브라우저: window.XLSXLite / Node: module.exports */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.XLSXLite = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- raw DEFLATE (RFC 1951) — DecompressionStream 이 없을 때 ---------- */
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function inflateRaw(src, sizeHint) {
    let pos = 0, bitBuf = 0, bitCnt = 0, op = 0;
    let out = new Uint8Array(Math.max(sizeHint || 0, src.length * 3, 1024));
    const need = (n) => {
      if (op + n <= out.length) return;
      const nb = new Uint8Array(Math.max(out.length * 2, op + n));
      nb.set(out); out = nb;
    };
    const bits = (n) => {
      while (bitCnt < n) {
        if (pos >= src.length) throw new Error("압축 데이터가 중간에 끝났습니다");
        bitBuf |= src[pos++] << bitCnt; bitCnt += 8;
      }
      const v = bitBuf & ((1 << n) - 1);
      bitBuf >>>= n; bitCnt -= n;
      return v;
    };
    const huff = (lengths, n) => {
      const count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(n);
      for (let i = 0; i < n; i++) count[lengths[i]]++;
      count[0] = 0;
      for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
      for (let i = 0; i < n; i++) if (lengths[i]) sym[offs[lengths[i]]++] = i;
      return { count, sym };
    };
    const decode = (h) => {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len < 16; len++) {
        code |= bits(1);
        const c = h.count[len];
        if (code < first + c) return h.sym[index + (code - first)];
        index += c; first += c; first <<= 1; code <<= 1;
      }
      throw new Error("잘못된 허프만 코드");
    };
    let fixedL = null, fixedD = null;
    const fixed = () => {
      if (!fixedL) {
        const l = new Uint8Array(288);
        l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
        fixedL = huff(l, 288);
        fixedD = huff(new Uint8Array(30).fill(5), 30);
      }
      return [fixedL, fixedD];
    };
    const codes = (lh, dh) => {
      for (;;) {
        let sym = decode(lh);
        if (sym < 256) { need(1); out[op++] = sym; continue; }
        if (sym === 256) return;
        sym -= 257;
        if (sym >= 29) throw new Error("잘못된 길이 코드");
        const len = LBASE[sym] + bits(LEXT[sym]), ds = decode(dh);
        if (ds >= 30) throw new Error("잘못된 거리 코드");
        const dist = DBASE[ds] + bits(DEXT[ds]);
        if (dist > op) throw new Error("잘못된 거리");
        need(len);
        for (let k = 0; k < len; k++) { out[op] = out[op - dist]; op++; }
      }
    };
    let last;
    do {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitBuf = 0; bitCnt = 0;
        if (pos + 4 > src.length) throw new Error("저장 블록 오류");
        const len = src[pos] | (src[pos + 1] << 8);
        pos += 4;
        if (pos + len > src.length) throw new Error("저장 블록 길이 오류");
        need(len); out.set(src.subarray(pos, pos + len), op); op += len; pos += len;
      } else if (type === 1) {
        const f = fixed(); codes(f[0], f[1]);
      } else if (type === 2) {
        const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
        const ch = huff(cl, 19), lens = new Uint8Array(nlen + ndist);
        let i = 0;
        while (i < nlen + ndist) {
          const sym = decode(ch);
          if (sym < 16) { lens[i++] = sym; continue; }
          let len = 0, rep;
          if (sym === 16) { if (i === 0) throw new Error("반복 코드 오류"); len = lens[i - 1]; rep = 3 + bits(2); }
          else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > nlen + ndist) throw new Error("코드 길이 초과");
          while (rep--) lens[i++] = len;
        }
        codes(huff(lens.subarray(0, nlen), nlen), huff(lens.subarray(nlen), ndist));
      } else throw new Error("잘못된 블록 형식");
    } while (!last);
    return out.subarray(0, op);
  }

  async function inflate(bytes, size, forceFallback) {
    if (!forceFallback && typeof DecompressionStream !== "undefined" && typeof Blob !== "undefined" && typeof Response !== "undefined") {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (e) { /* 내장 디코더로 */ }
    }
    return inflateRaw(bytes, size);
  }

  /* ---------- zip 목차 ---------- */
  function readZip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("엑셀(xlsx) 파일 형식이 아닙니다");
    const total = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = new Map(), dec = new TextDecoder("utf-8");
    for (let n = 0; n < total; n++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("zip 목차가 손상되었습니다");
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      entries.set(dec.decode(u8.subarray(p + 46, p + 46 + nl)), { method, csize, usize, off });
      p += 46 + nl + xl + cl;
    }
    return entries;
  }
  async function entryText(u8, entries, name, force) {
    const en = entries.get(name) || entries.get(name.replace(/^\//, ""));
    if (!en) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(en.off, true) !== 0x04034b50) throw new Error("zip 항목 머리글 오류: " + name);
    const start = en.off + 30 + dv.getUint16(en.off + 26, true) + dv.getUint16(en.off + 28, true);
    const raw = u8.subarray(start, start + en.csize);
    let bytes;
    if (en.method === 0) bytes = raw;
    else if (en.method === 8) bytes = await inflate(raw, en.usize, force);
    else throw new Error("지원하지 않는 압축 방식(" + en.method + ")");
    return new TextDecoder("utf-8").decode(bytes);
  }

  /* ---------- XML ---------- */
  function unesc(s) {
    return s.indexOf("&") < 0 ? s : s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&amp;/g, "&");
  }
  function attr(tag, name) {
    const m = new RegExp("\\s" + name + '="([^"]*)"').exec(tag);
    return m ? unesc(m[1]) : null;
  }
  function textOf(inner) { // <t> 조각을 이어 붙임 (서식 있는 문자열 <r><t>…</t></r> 포함, 발음 <rPh> 제외)
    let t = "", m;
    const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
    inner = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    while ((m = re.exec(inner))) t += m[1] || "";
    return unesc(t);
  }
  function sharedStrings(xml) {
    const out = [];
    if (!xml) return out;
    const re = /<si>([\s\S]*?)<\/si>|<si\/>/g;
    let m;
    while ((m = re.exec(xml))) out.push(m[1] ? textOf(m[1]) : "");
    return out;
  }
  function colIndex(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }
  /* 시트 XML → rows (행·열 번호는 r="B12" 기준, r 이 없으면 순서대로) */
  function sheetRows(xml, sst) {
    const rows = [];
    const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let rm, nextRow = 0;
    while ((rm = rowRe.exec(xml))) {
      const rAttr = attr(rm[1], "r"), r = rAttr ? +rAttr - 1 : nextRow;
      nextRow = r + 1;
      if (!rm[2]) continue;
      const row = [];
      let cm, nextCol = 0;
      cellRe.lastIndex = 0;
      while ((cm = cellRe.exec(rm[2]))) {
        const ref = attr(cm[1], "r"), c = ref ? colIndex(ref.replace(/\d+/g, "")) : nextCol;
        nextCol = c + 1;
        const inner = cm[2];
        if (inner == null) continue;
        const t = attr(cm[1], "t") || "n";
        let val = null;
        if (t === "inlineStr") val = textOf(inner);
        else {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (!vm) continue;
          const raw = unesc(vm[1]);
          if (t === "s") val = sst[+raw] != null ? sst[+raw] : null;
          else if (t === "str" || t === "d") val = raw;
          else if (t === "b") val = raw === "1";
          else if (t === "e") val = null;
          else { const x = +raw; val = raw.trim() !== "" && isFinite(x) ? x : raw; }
        }
        if (val === null || val === "") continue;
        row[c] = val;
      }
      for (let j = 0; j < row.length; j++) if (row[j] === undefined) row[j] = null;
      rows[r] = row;
    }
    for (let j = 0; j < rows.length; j++) if (!rows[j]) rows[j] = [];
    return rows;
  }

  /* ---------- 통합 문서 ---------- */
  /* opts.sheets: 해석할 시트 이름 목록 (없으면 전부). 나머지 시트는 rows 없이 이름만 */
  async function readWorkbook(arrayBuffer, opts) {
    opts = opts || {};
    const force = !!opts.forceFallback;
    const u8 = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    if (u8.length >= 8 && u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0)
      throw new Error("예전 엑셀(.xls) 형식은 읽을 수 없습니다. 엑셀에서 .xlsx로 저장해 올려 주세요");
    const entries = readZip(u8);
    const wb = await entryText(u8, entries, "xl/workbook.xml", force);
    if (!wb) throw new Error("엑셀 통합 문서(workbook.xml)를 찾을 수 없습니다");
    const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wb);
    const rels = (await entryText(u8, entries, "xl/_rels/workbook.xml.rels", force)) || "";
    const relMap = new Map();
    (rels.match(/<Relationship\b[^>]*>/g) || []).forEach((tag) => relMap.set(attr(tag, "Id"), attr(tag, "Target")));
    const list = (wb.match(/<sheet\b[^>]*>/g) || []).map((tag) => {
      let target = relMap.get(attr(tag, "r:id") || attr(tag, "[\\w]+:id"));
      if (target) target = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
      return { name: attr(tag, "name") || "", path: target };
    });
    const want = opts.sheets ? new Set(opts.sheets.map((s) => String(s).trim().toUpperCase())) : null;
    let sst = null;
    const sheets = [];
    for (const s of list) {
      if (want && !want.has(s.name.trim().toUpperCase())) { sheets.push({ name: s.name, rows: null }); continue; }
      const xml = s.path ? await entryText(u8, entries, s.path, force) : null;
      if (xml == null) { sheets.push({ name: s.name, rows: [] }); continue; }
      if (sst === null) sst = sharedStrings(await entryText(u8, entries, "xl/sharedStrings.xml", force));
      sheets.push({ name: s.name, rows: sheetRows(xml, sst) });
    }
    return { date1904, sheetNames: list.map((s) => s.name), sheets };
  }

  return { readWorkbook, inflateRaw, readZip, sheetRows, sharedStrings };
});
