'use strict';
/**
 * The notation record's rules, in JavaScript: the twin of
 * pipeline/python/lib/notation.py. validate() returns the same error codes at
 * the same paths, fillDefaults()/stripDefaults() the same shapes, and the
 * fixtures under pipeline/python/fixtures/notations prove it.
 *
 * contentHash() needs sha1 and lives in notation-node.js, so this file stays
 * free of node: builtins for the phone.
 */
const { KOMAL_ALLOWED, RAAGS, SWARA_ORDER, TAALS, TIVRA_ALLOWED } = require('./notation-vocab.js');

const SCHEMA_VERSION = 1;
const KINDS = ['notation', 'partial', 'reet-ref', 'non-gurbani'];
const SCRIPTS = ['gurmukhi', 'latin', 'devanagari'];
const SECTION_KINDS = ['sthai', 'antara', 'sanchari', 'abhog', 'alaap', 'taan', 'tihai', 'other'];
const LINE_KINDS = ['avartan', 'free'];
const DIVS = [1, 2, 3, 4, 6, 8];
const SOURCES = ['G', 'D', 'B', 'K', 'N'];
const RESOLVE_METHODS = ['stream+ref+bol', 'stream+ref', 'stream+bol', 'stream', 'ref-window', 'ref+bol', 'bol', 'book-ref', 'index', 'manual', 'none'];
const FLAGS = new Set([
  'unresolved-shabad', 'weak-shabad', 'ref-conflict', 'no-shabad-text', 'no-section-label',
  'taal-mismatch', 'taal-unknown', 'raag-unknown', 'style-contradiction', 'continues-next-page',
  'continued-from-prev', 'empty-beat', 'unread-cell', 'tick-on-non-ma', 'diagonal-watermark',
  'partial-grid', 'unmatched-text', 'taal-changes', 'raag-differs', 'shabad-by-book-ref',
  'shabad-inherited', 'span-capped', 'shabad-by-bol', 'shabad-by-index', 'index-conflict', 'long-span',
]);
const ID_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*):(\d{4}):(\d+)$/;
const NOTE_DEFAULTS = { o: 0, k: false, t: false, len: 1, kh: false };

const clone = obj => JSON.parse(JSON.stringify(obj));
const isInt = v => Number.isInteger(v);

function makeId(bookKey, page, seq) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bookKey)) throw new Error(`book key ${JSON.stringify(bookKey)} is not a slug`);
  return `${bookKey}:${String(page).padStart(4, '0')}:${seq}`;
}

function parseId(id) {
  const m = ID_RE.exec(id || '');
  return m ? [m[1], parseInt(m[2], 10), parseInt(m[3], 10)] : null;
}

function imageName(id, n, thumb = false) {
  return `${id.replace(/:/g, '-')}-${n}${thumb ? '.thumb' : ''}.png`;
}

/** The record with every omitted default present (a deep copy). */
function fillDefaults(rec) {
  const out = clone(rec);
  for (const sec of out.sections || []) {
    for (const line of sec.lines || []) {
      if (line.matra_from === undefined) line.matra_from = 1;
      if (line.continues === undefined) line.continues = false;
      for (const beat of line.beats || []) {
        if (beat.div === undefined) beat.div = 1;
        for (const note of beat.notes || []) {
          for (const [k, v] of Object.entries(NOTE_DEFAULTS)) if (note[k] === undefined) note[k] = v;
          if (note.kan) for (const [k, v] of Object.entries(NOTE_DEFAULTS)) if (k !== 'len' && note.kan[k] === undefined) note.kan[k] = v;
        }
        if (beat.bol && typeof beat.bol === 'object' && beat.bol.h === undefined) beat.bol.h = 0;
      }
    }
  }
  return out;
}

/** The inverse: defaults removed (a deep copy). */
function stripDefaults(rec) {
  const out = clone(rec);
  for (const sec of out.sections || []) {
    for (const line of sec.lines || []) {
      if (line.matra_from === 1) delete line.matra_from;
      if (line.continues === false) delete line.continues;
      for (const beat of line.beats || []) {
        if (beat.div === 1) delete beat.div;
        for (const note of beat.notes || []) {
          for (const [k, v] of Object.entries(NOTE_DEFAULTS)) if (note[k] === v) delete note[k];
          if (note.kan) for (const [k, v] of Object.entries(NOTE_DEFAULTS)) if (note.kan[k] === v) delete note.kan[k];
        }
        if (beat.bol && typeof beat.bol === 'object' && beat.bol.h === 0) delete beat.bol.h;
      }
    }
  }
  return out;
}

/** Sorted keys, no spaces: the same bytes Python's canonical_json gives. */
function canonicalJson(obj) {
  const sortKeys = v => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
    return v;
  };
  return JSON.stringify(sortKeys(obj));
}

/** Every rule the record breaks: [{code, path, detail}]; empty when sound. */
function validate(rec) {
  const errs = [];
  const err = (code, path, detail = '') => errs.push({ code, path, detail });

  if (rec.schema_version !== SCHEMA_VERSION) err('schema.version', 'schema_version', `expected ${SCHEMA_VERSION}`);
  const nid = rec.notation_id || '';
  const parsed = parseId(nid);
  if (!parsed) err('id.format', 'notation_id', nid);
  else if (parsed[0] !== rec.book_key || parsed[1] !== rec.page || parsed[2] !== rec.seq) err('id.format', 'notation_id', 'id disagrees with book_key/page/seq');
  if (!KINDS.includes(rec.kind)) err('enum.kind', 'kind', String(rec.kind));
  if (!SCRIPTS.includes(rec.script)) err('enum.script', 'script', String(rec.script));
  if (!Array.isArray(rec.pages) || !rec.pages.length || !rec.pages.includes(rec.page)) err('pages.list', 'pages', 'must list every page and include `page`');
  for (const f of rec.flags || []) if (!FLAGS.has(f)) err('flags.unknown', 'flags', f);

  const heading = rec.heading || {};
  const topTaal = heading.taal || null;
  const rk = (heading.raag || {}).key;
  if (rk != null && !(rk in RAAGS)) err('vocab.key', 'heading.raag.key', rk);
  if (topTaal && topTaal.key != null && !(topTaal.key in TAALS)) err('vocab.key', 'heading.taal.key', topTaal.key);
  if (rec.raag_shabad != null && !(rec.raag_shabad in RAAGS)) err('vocab.key', 'raag_shabad', rec.raag_shabad);
  const shabad = rec.shabad || {};
  if (shabad.source != null && !SOURCES.includes(shabad.source)) err('enum.source', 'shabad.source', String(shabad.source));
  if (!RESOLVE_METHODS.includes(shabad.method)) err('enum.method', 'shabad.method', String(shabad.method));
  if (shabad.shabad_id == null && !['none', 'manual'].includes(shabad.method)) err('shabad.unresolved', 'shabad', 'no shabad_id but method says it was resolved');

  const sections = rec.sections;
  if (rec.kind === 'notation' && (!Array.isArray(sections) || !sections.length)) err('sections.empty', 'sections');
  if (rec.kind === 'partial' && !(sections || []).length && !(rec.flags || []).includes('partial-grid')) err('sections.empty', 'sections', 'a partial record without sections must say partial-grid');
  const seen = new Set();
  (sections || []).forEach((sec, si) => {
    const sp = `sections[${si}]`;
    if (!SECTION_KINDS.includes(sec.kind)) err('enum.section', `${sp}.kind`, String(sec.kind));
    if (sec.n != null) {
      const key = `${sec.kind}/${sec.n}`;
      if (seen.has(key)) err('section.n', `${sp}.n`, `duplicate ${sec.kind} ${sec.n}`);
      seen.add(key);
    }
    // a section's taal (a partaal's override) is written as its key; a heading's taal is an object
    const own = sec.taal;
    const ownKey = own && typeof own === 'object' ? own.key : own;
    if (ownKey != null && !(ownKey in TAALS)) err('vocab.key', `${sp}.taal`, String(ownKey));
    const secTaal = (typeof own === 'string' ? { key: own } : own) || topTaal;
    const taalKey = secTaal ? secTaal.key : undefined;
    const matras = taalKey in TAALS ? TAALS[taalKey].matras : (secTaal || {}).matras;
    const lines = sec.lines;
    if (!Array.isArray(lines) || !lines.length) { err('lines.empty', `${sp}.lines`); return; }
    lines.forEach((line, li) => {
      const lp = `${sp}.lines[${li}]`;
      const kind = line.kind;
      if (!LINE_KINDS.includes(kind)) err('enum.line', `${lp}.kind`, String(kind));
      const beats = line.beats;
      if (!Array.isArray(beats) || !beats.length) { err('beats.empty', `${lp}.beats`); return; }
      if (kind === 'avartan' && !secTaal) err('line.taal', lp, 'an avartan line needs a taal');
      let expect = line.matra_from === undefined ? 1 : line.matra_from;
      const spans = [];
      beats.forEach((beat, bi) => {
        const bp = `${lp}.beats[${bi}]`;
        validateBeat(beat, bp, err);
        if (kind === 'avartan') {
          const m = beat.m;
          if (m !== expect) err('line.matras', `${bp}.m`, `expected ${expect}, got ${m}`);
          expect = (isInt(m) ? m : expect) + 1;
        } else if ('m' in beat) {
          err('line.matras', `${bp}.m`, 'a free line has no matras');
        }
        const bol = beat.bol;
        if (bol && typeof bol === 'object' && bol.span != null) {
          const span = bol.span;
          if (line.line_id == null) err('bol.span', `${bp}.bol.span`, "a span needs the line's line_id");
          else if (!Array.isArray(span) || span.length !== 2 || span[0] >= span[1] || (spans.length && span[0] < spans[spans.length - 1][1])) err('bol.span', `${bp}.bol.span`, 'spans must be increasing and non-overlapping');
          else spans.push([span[0], span[1]]);
        }
      });
      if (kind === 'avartan' && matras && expect - 1 > matras) err('line.matras', lp, `last matra ${expect - 1} exceeds the taal's ${matras}`);
    });
  });
  return errs;
}

function validateBeat(beat, bp, err) {
  const hasNotes = 'notes' in beat;
  const modes = [hasNotes, Boolean(beat.ext), Boolean(beat.rest)].filter(Boolean).length;
  if (modes !== 1) err('beat.exclusive', bp, 'exactly one of notes / ext / rest');
  const div = beat.div === undefined ? 1 : beat.div;
  if (!DIVS.includes(div)) err('beat.div', `${bp}.div`, String(div));
  if (hasNotes) {
    const notes = beat.notes;
    if (notes === null) {
      if (!beat.raw || beat.c == null) err('beat.unknown_raw', bp, 'an unreadable beat keeps its raw text and confidence');
    } else if (!Array.isArray(notes) || !notes.length) {
      err('beat.exclusive', `${bp}.notes`, 'notes must be a non-empty list or null');
    } else {
      let total = 0;
      notes.forEach((note, ni) => { total += validateNote(note, `${bp}.notes[${ni}]`, err, true); });
      if (total !== div) err('beat.len_sum', bp, `lengths sum to ${total}, div is ${div}`);
    }
  }
  const bol = beat.bol;
  if (bol != null && 'bol' in beat) {
    if (typeof bol !== 'object' || (bol.g !== undefined && typeof bol.g !== 'string')) err('bol.shape', `${bp}.bol`);
    else if (bol.h !== undefined && (!isInt(bol.h) || bol.h < 0)) err('bol.shape', `${bp}.bol.h`);
  }
}

function validateNote(note, path, err, allowLen) {
  const s = note.s;
  if (!SWARA_ORDER.includes(s)) {
    err('note.swar', `${path}.s`, String(s));
    return isInt(note.len === undefined ? 1 : note.len) ? (note.len === undefined ? 1 : note.len) : 1;
  }
  if (note.k && !KOMAL_ALLOWED.has(s)) err('note.komal', path, `${s} has no komal`);
  if (note.t && !TIVRA_ALLOWED.has(s)) err('note.tivra', path, `${s} has no tivra`);
  const o = note.o === undefined ? 0 : note.o;
  if (!isInt(o) || o < -2 || o > 2) err('note.octave', `${path}.o`, String(o));
  let ln = note.len === undefined ? 1 : note.len;
  if (!allowLen && 'len' in note) err('note.kan', path, 'a kan has no length');
  if (!isInt(ln) || ln < 1) { err('beat.len_sum', `${path}.len`, String(ln)); ln = 1; }
  const kan = note.kan;
  if (kan != null) {
    if (typeof kan !== 'object') err('note.kan', `${path}.kan`);
    else {
      validateNote(kan, `${path}.kan`, err, false);
      if (kan.kan != null) err('note.kan', `${path}.kan`, 'a kan has no kan');
    }
  }
  return ln;
}

module.exports = {
  SCHEMA_VERSION, KINDS, SCRIPTS, SECTION_KINDS, LINE_KINDS, DIVS, SOURCES, RESOLVE_METHODS, FLAGS,
  makeId, parseId, imageName, fillDefaults, stripDefaults, canonicalJson, validate,
};
