'use strict';
/**
 * What a reader sees of a notation, derived from the record: the JavaScript
 * twin of pipeline/python/lib/notation_render.py. Same four views (cells,
 * textGurmukhi, textEnglish, html), same conventions, same bytes -- the
 * fixtures under pipeline/python/fixtures/notations pin both, and a change
 * to either side is made in Python first and regenerated from there.
 *
 * Latin swaras: shuddh S R G M P D N, komal r g d n, tivra m; taar S',
 * mandra S,; held -, rest *, several notes in one beat run together (DN), a
 * kan in braces before its note ({P}M), a khatka with ~.
 */
const { fillDefaults } = require('./notation.js');
const { ROMAN, SWARAS, TAALS, taalMarkers } = require('./notation-vocab.js');

const EXT = '-', REST = '*', UNKNOWN = '?';
const EXT_PA = '—', HELD_PA = 'ऽ';
const KOMAL_MARK = '̲', TIVRA_MARK = '́', TAAR_MARK = '̇', MANDRA_MARK = '̣';

const NOTATION_CSS = `.ntn{font-family:inherit}.ntn-line{border-collapse:collapse;margin:.4em 0}
.ntn-cell{padding:.1em .45em;text-align:center;vertical-align:bottom;white-space:nowrap}
.ntn-vb{border-left:1px solid currentColor}.ntn-line tr:first-child .ntn-cell{padding-top:.6em}
.ntn-row-swar .ntn-cell{font-size:1.25em;line-height:1.1}.ntn-row-mark .ntn-cell{font-size:.85em;opacity:.75}
.ntn-row-m .ntn-cell{font-size:.7em;opacity:.55;font-weight:normal}
.n{position:relative;display:inline-block;padding:0 .05em}
.n-komal{text-decoration:underline;text-underline-offset:.15em}
.n-tivra::after{content:"|";position:absolute;top:-.55em;left:50%;transform:translateX(-50%);font-size:.6em;line-height:1}
.n-taar::before,.n-mandra::after{content:"\\2022";position:absolute;left:50%;transform:translateX(-50%);font-size:.45em;line-height:1}
.n-taar::before{top:-.6em}.n-mandra::after{bottom:-.55em}
.n-taar2::before{content:"\\2022\\2022"}.n-mandra2::after{content:"\\2022\\2022"}
.n-grp{display:inline-block;border-bottom:1px solid currentColor;border-radius:0 0 .5em .5em;padding:0 .1em}
.n-kan{font-size:.6em;vertical-align:super;margin-right:-.1em}.n-khatka::after{content:"~";font-size:.6em;vertical-align:super}
.n-rest,.n-ext{opacity:.7}.n-unknown{color:#b00;border-bottom:1px dotted #b00}
.ntn-unknown{background:rgba(255,0,0,.06)}.b-held{opacity:.6}
.ntn-sam{font-weight:600}.ntn-khali .ntn-cell,.ntn-row-mark .ntn-khali{opacity:.9}
.ntn-sec-label{font-weight:600;margin-top:.8em}.ntn-cont{border-left-style:dashed}
`;

const repeat = (s, n) => (n > 0 ? s.repeat(n) : '');
const octaveSuffix = o => (o > 0 ? repeat("'", o) : repeat(',', -o));
/** Python's html.escape(s, quote=True). */
const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

// ---- one note, one beat ----------------------------------------------------

function noteLatin(note) {
  const s = note.s;
  let letter = s;
  if (note.k && s in SWARAS.latin_komal) letter = SWARAS.latin_komal[s];
  else if (note.t && s in SWARAS.latin_tivra) letter = SWARAS.latin_tivra[s];
  let out = letter + octaveSuffix(note.o || 0);
  if (note.kan) out = '{' + noteLatin({ ...note.kan, kan: null, kh: false }) + '}' + out;
  if (note.kh) out += '~';
  return out;
}

function noteGurmukhi(note, kanna = false) {
  const s = note.s;
  let letter = (kanna ? SWARAS.gurmukhi_kanna : SWARAS.gurmukhi)[s];
  if (note.k) letter += KOMAL_MARK;
  if (note.t) letter += TIVRA_MARK;
  const o = note.o || 0;
  letter += o > 0 ? repeat(TAAR_MARK, o) : repeat(MANDRA_MARK, -o);
  if (note.kan) letter = '{' + noteGurmukhi({ ...note.kan, kan: null, kh: false }, kanna) + '}' + letter;
  if (note.kh) letter += '~';
  return letter;
}

function beatCell(beat, script = 'english', kanna = false) {
  if (beat.ext) return script === 'english' ? EXT : EXT_PA;
  if (beat.rest) return REST;
  const notes = beat.notes;
  if (notes === null || notes === undefined) return UNKNOWN;
  return notes.map(n => (script === 'english' ? noteLatin(n) : noteGurmukhi(n, kanna)) + repeat(EXT, (n.len || 1) - 1)).join('');
}

function bolCell(beat, script = 'english', roman = null) {
  const bol = beat.bol;
  if (bol === null || bol === undefined) return '';
  if (script === 'english') {
    const base = roman != null ? roman : romanOf(bol.g || '');
    return base + repeat(EXT, bol.h || 0);
  }
  return (bol.g || '') + repeat(HELD_PA, bol.h || 0);
}

// ---- roman bol -------------------------------------------------------------

function romanOf(g) {
  const cons = ROMAN.consonants, signs = ROMAN.vowel_signs, ind = ROMAN.independent, nasal = ROMAN.nasal, sub = ROMAN.subjoined;
  const inherent = ROMAN.inherent;
  const chars = [];
  for (const ch of Array.from(g || '')) {
    if (ch === '਼' && chars.length && (chars[chars.length - 1] + ch) in cons) chars[chars.length - 1] += ch;
    else chars.push(ch);
  }
  const out = [];
  let i = 0;
  const n = chars.length;
  while (i < n) {
    const ch = chars[i];
    if (ch in cons) {
      out.push(cons[ch]);
      i += 1;
      while (i + 1 < n && chars[i] === '੍' && chars[i + 1] in cons) {
        out.push(sub[chars[i] + chars[i + 1]] !== undefined ? sub[chars[i] + chars[i + 1]] : cons[chars[i + 1]]);
        i += 2;
      }
      if (i < n && chars[i] in signs) {
        if (!((chars[i] === 'ੁ' || chars[i] === 'ਿ') && i === n - 1)) out.push(signs[chars[i]]);
        i += 1;
      } else if (i < n && chars[i] === 'ੱ') {
        out.push(inherent);
        if (i + 1 < n && chars[i + 1] in cons) out.push(cons[chars[i + 1]][0]);
        i += 1;
      } else if (i < n) {
        out.push(inherent);
      }
      continue;
    }
    if (ch in ind) out.push(ind[ch]);
    else if (ch in nasal) out.push(nasal[ch]);
    else if (ch in signs) out.push(signs[ch]);
    i += 1;
  }
  return out.join('');
}

const DIGITS_SEG = /^[੦-੯0-9\s]+$/u;
const MARKER_SEG = /^\s*ਰਹਾਉ(\s+ਦੂਜਾ)?\s*$/u;

/** [start, end) of every word of a corpus line, in code units, skipping counters and rahao markers. */
function wordSpans(text) {
  const spans = [];
  for (const seg of text.matchAll(/[^।॥]+/gu)) {
    const body = seg[0];
    if (!body.trim() || DIGITS_SEG.test(body) || MARKER_SEG.test(body)) continue;
    for (const m of body.matchAll(/\S+/gu)) spans.push([seg.index + m.index, seg.index + m.index + m[0].length]);
  }
  return spans;
}

function romanForLine(line, corpusLine) {
  const beats = line.beats || [];
  if (!corpusLine || !corpusLine.gurmukhi_uni || !corpusLine.translit_roman) return beats.map(() => null);
  const words = wordSpans(corpusLine.gurmukhi_uni);
  const roman = corpusLine.translit_roman.split(/\s+/).filter(Boolean);
  if (words.length !== roman.length) return beats.map(() => null);
  const bySpan = new Map(words.map((span, i) => [span.join(','), roman[i]]));
  return beats.map(beat => {
    const bol = beat.bol;
    const span = bol && typeof bol === 'object' && bol.span ? bol.span.join(',') : null;
    return span != null && bySpan.has(span) ? bySpan.get(span) : null;
  });
}

// ---- the grid --------------------------------------------------------------

function vibhagStarts(info) {
  const starts = new Set();
  if (!info || !info.vibhag) return starts;
  let m = 1;
  for (const size of info.vibhag) { starts.add(m); m += size; }
  return starts;
}

/** Per printed line, every per-beat list the same length; `corpusLines` maps line_id -> {gurmukhi_uni, translit_roman}. */
function cells(rec, corpusLines = {}, kanna = false) {
  rec = fillDefaults(rec);
  corpusLines = corpusLines || {};
  const topTaal = (rec.heading || {}).taal || null;
  const out = [];
  for (const sec of rec.sections || []) {
    const taal = (typeof sec.taal === 'string' ? { key: sec.taal } : sec.taal) || topTaal;   // a section's taal is its key
    const key = taal ? (taal.key === undefined ? null : taal.key) : null;
    const info = key ? TAALS[key] : null;
    const starts = vibhagStarts(info);
    for (const line of sec.lines || []) {
      const beats = line.beats || [];
      const n = beats.length;
      const start = line.matra_from === undefined ? 1 : line.matra_from;
      const free = line.kind === 'free';
      const marks = free || !info ? new Array(n).fill(null) : taalMarkers(key, start, n);
      const lid = line.line_id;
      const corpusLine = lid == null ? null : (corpusLines[lid] || corpusLines[String(lid)] || null);
      const roman = romanForLine(line, corpusLine);
      out.push({
        section: sec.kind === undefined ? null : sec.kind,
        n: sec.n === undefined ? null : sec.n,
        label: sec.label === undefined ? null : sec.label,
        kind: line.kind === undefined ? null : line.kind,
        avartan: line.avartan === undefined ? null : line.avartan,
        matra_from: start,
        taal: key,
        continues: Boolean(line.continues),
        beats,
        matras: beats.map(b => (free ? null : (b.m === undefined ? null : b.m))),
        marks,
        vibhag: beats.map(b => (free ? false : starts.has(b.m || 0))),
        swar_pa: beats.map(b => beatCell(b, 'gurmukhi', kanna)),
        swar_en: beats.map(b => beatCell(b, 'english')),
        bol_pa: beats.map(b => bolCell(b, 'gurmukhi')),
        bol_en: beats.map((b, i) => bolCell(b, 'english', roman[i])),
        unknown: beats.map(b => 'notes' in b && b.notes === null),
        has_bol: beats.some(b => 'bol' in b),
      });
    }
  }
  return out;
}

function formatLine(row, script = 'english') {
  const swar = script === 'english' ? row.swar_en : row.swar_pa;
  const parts = [];
  swar.forEach((cell, i) => {
    if (row.vibhag[i] && i > 0) parts.push('|');
    parts.push(cell);
  });
  let line = parts.join(' ');
  if (row.kind === 'avartan') {
    if (row.matra_from !== 1) line = `@${row.matra_from} ${line}`;
    line += ' ||';
  }
  return line;
}

function textOf(rec, script, corpusLines) {
  const lines = [];
  let lastSec = null;
  for (const row of cells(rec, corpusLines)) {
    const secKey = `${row.section}/${row.n}`;
    if (secKey !== lastSec) {
      lines.push(`[${row.section}${row.n ? ` ${row.n}` : ''}]`);
      lastSec = secKey;
    }
    lines.push(formatLine(row, script));
    if (row.has_bol) {
      const bol = script === 'english' ? row.bol_en : row.bol_pa;
      lines.push('  ' + bol.map(b => (b ? b : '.')).join(' '));
    }
  }
  return lines.join('\n');
}

const textEnglish = (rec, corpusLines) => textOf(rec, 'english', corpusLines);
const textGurmukhi = (rec, corpusLines) => textOf(rec, 'gurmukhi', corpusLines);

// ---- the text form, inverted -----------------------------------------------

const TOKEN = /(\{[^}]*\})?([SRGMPDNsrgmpdn])([',]*)(~?)/y;

function noteFromLetter(ch) {
  const up = ch.toUpperCase();
  const note = { s: up };
  if (ch !== up) {
    if (up === 'M') note.t = true;
    else note.k = true;
  }
  return note;
}

function parseCell(tok) {
  if (tok === EXT) return { ext: true };
  if (tok === REST) return { rest: true };
  if (tok === UNKNOWN) return { notes: null };
  const notes = [];
  let i = 0;
  while (i < tok.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(tok);
    if (!m) throw new Error(`cannot read swara cell ${JSON.stringify(tok)} at ${i}`);
    const [, kan, letter, oct, kh] = m;
    const note = noteFromLetter(letter);
    const o = (oct.match(/'/g) || []).length - (oct.match(/,/g) || []).length;
    if (o) note.o = o;
    if (kan) {
      const inner = kan.slice(1, -1);
      note.kan = noteFromLetter(inner[0]);
      const ko = (inner.match(/'/g) || []).length - (inner.match(/,/g) || []).length;
      if (ko) note.kan.o = ko;
    }
    if (kh) note.kh = true;
    i = TOKEN.lastIndex;
    let ln = 1;
    while (i < tok.length && tok[i] === EXT) { ln += 1; i += 1; }
    if (ln > 1) note.len = ln;
    notes.push(note);
  }
  const total = notes.reduce((a, n) => a + (n.len || 1), 0);
  const beat = { notes };
  if (total !== 1) beat.div = total;
  return beat;
}

function parseLine(text) {
  let s = text.trim();
  const kind = s.endsWith('||') ? 'avartan' : 'free';
  if (kind === 'avartan') s = s.slice(0, -2).trim();
  let matraFrom = 1;
  const m = /^@(\d+)\s+/.exec(s);
  if (m) { matraFrom = parseInt(m[1], 10); s = s.slice(m[0].length); }
  const beats = s.split(/\s+/).filter(t => t && t !== '|').map(parseCell);
  return { kind, matra_from: matraFrom, beats };
}

// ---- HTML ------------------------------------------------------------------

function noteHtml(note, script, kanna) {
  const classes = ['n'];
  if (note.k) classes.push('n-komal');
  if (note.t) classes.push('n-tivra');
  const o = note.o || 0;
  if (o >= 2) classes.push('n-taar2');
  else if (o === 1) classes.push('n-taar');
  else if (o === -1) classes.push('n-mandra');
  else if (o <= -2) classes.push('n-mandra2');
  if (note.kh) classes.push('n-khatka');
  const ln = note.len || 1;
  if (ln > 1) classes.push(`n-len-${ln}`);
  const s = note.s;
  let letter;
  if (script === 'english') {
    if (note.k) letter = SWARAS.latin_komal[s] || s;
    else if (note.t) letter = SWARAS.latin_tivra[s] || s;
    else letter = s;
    letter += octaveSuffix(o);
  } else {
    letter = (kanna ? SWARAS.gurmukhi_kanna : SWARAS.gurmukhi)[s];
  }
  let body = `<span class="${classes.join(' ')}" data-s="${s}">${escapeHtml(letter)}</span>`;
  if (note.kan) {
    const kan = note.kan;
    const kl = script === 'english' ? noteLatin({ ...kan, kan: null, kh: false }) : SWARAS.gurmukhi[kan.s];
    body = `<sup class="n-kan">${escapeHtml(kl)}</sup>` + body;
  }
  return body + (ln > 1 ? repeat(EXT, ln - 1) : '');
}

function swarHtml(row, script, kanna) {
  return row.beats.map(beat => {
    if (beat.ext) return `<span class="n n-ext">${script === 'english' ? EXT : EXT_PA}</span>`;
    if (beat.rest) return `<span class="n n-rest">${REST}</span>`;
    const notes = beat.notes;
    if (notes === null || notes === undefined) return `<span class="n n-unknown" title="${escapeHtml(String(beat.raw === undefined ? '' : beat.raw))}">${UNKNOWN}</span>`;
    let inner = notes.map(n => noteHtml(n, script, kanna)).join('');
    if (notes.length > 1) inner = `<span class="n-grp n-grp-${Math.min(notes.length, 4)}">${inner}</span>`;
    return inner;
  });
}

function bolHtml(cell, script) {
  const held = script !== 'english' ? HELD_PA : EXT;
  let core = cell;
  while (core.endsWith(held)) core = core.slice(0, -held.length);
  const h = (cell.length - core.length) / held.length;
  let out = escapeHtml(core);
  if (h) out += `<span class="b-held">${escapeHtml(repeat(held, h))}</span>`;
  return out;
}

function html(rec, script = 'gurmukhi', corpusLines = {}, matraRow = true, kanna = false) {
  const rows = cells(rec, corpusLines, kanna);
  const out = [`<div class="ntn" data-id="${escapeHtml(String(rec.notation_id === undefined ? '' : rec.notation_id))}" data-script="${escapeHtml(script)}">`];
  let lastSec = null;
  for (const row of rows) {
    const secKey = `${row.section}/${row.n}`;
    if (secKey !== lastSec) {
      if (lastSec !== null) out.push('</div>');
      const label = row.label || row.section || '';
      out.push(`<div class="ntn-sec" data-kind="${escapeHtml(String(row.section))}" data-n="${escapeHtml(String(row.n || ''))}"><div class="ntn-sec-label">${escapeHtml(label)}</div>`);
      lastSec = secKey;
    }
    const free = row.kind === 'free';
    const cls = 'ntn-line' + (free ? ' ntn-free' : '') + (row.continues ? ' ntn-cont' : '');
    out.push(`<table class="${cls}" data-kind="${escapeHtml(row.kind)}" data-taal="${escapeHtml(row.taal || '')}" data-from="${row.matra_from}">`);
    const n = row.swar_en.length;
    const cellCls = [];
    for (let i = 0; i < n; i += 1) {
      const c = ['ntn-cell'];
      if (row.vibhag[i]) c.push('ntn-vb');
      const mark = row.marks[i];
      if (mark !== null && mark !== undefined) c.push(mark === '×' ? 'ntn-sam' : mark === '0' ? 'ntn-khali' : 'ntn-tali');
      if (row.unknown[i]) c.push('ntn-unknown');
      cellCls.push(c.join(' '));
    }
    const mTxt = row.matras.map(m => (m === null || m === undefined ? '' : String(m)));
    if (matraRow && !free) {
      out.push('<tr class="ntn-row ntn-row-m">' + mTxt.map((t, i) => `<th class="${cellCls[i]}">${t}</th>`).join('') + '</tr>');
    }
    const swarCells = swarHtml(row, script, kanna);
    out.push('<tr class="ntn-row ntn-row-swar">' + swarCells.map((c, i) => `<td class="${cellCls[i]}" data-m="${mTxt[i]}">${c}</td>`).join('') + '</tr>');
    if (row.has_bol) {
      const bol = script === 'english' ? row.bol_en : row.bol_pa;
      out.push('<tr class="ntn-row ntn-row-bol">' + bol.map((b, i) => `<td class="${cellCls[i]}">${bolHtml(b, script)}</td>`).join('') + '</tr>');
    }
    if (!free && row.marks.some(mk => mk !== null && mk !== undefined)) {
      out.push('<tr class="ntn-row ntn-row-mark">' + row.marks.map((mk, i) => `<td class="${cellCls[i]}">${escapeHtml(mk || '')}</td>`).join('') + '</tr>');
    }
    out.push('</table>');
  }
  if (lastSec !== null) out.push('</div>');
  out.push('</div>');
  return out.join('');
}

module.exports = {
  NOTATION_CSS, EXT, REST, UNKNOWN, EXT_PA, HELD_PA,
  noteLatin, noteGurmukhi, beatCell, bolCell, romanOf, wordSpans, romanForLine,
  cells, formatLine, textEnglish, textGurmukhi, parseLine, parseCell, html, escapeHtml,
};
