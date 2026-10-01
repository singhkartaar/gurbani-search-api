'use strict';
/**
 * Raags, taals and notation symbols, keyed: the JavaScript twin of
 * pipeline/python/lib/notation_vocab.py over the same JSON (notation-vocab.json
 * here is a byte-for-byte mirror of the pipeline's notation_vocab.json;
 * tools/sync-notation-vocab.mjs keeps them so).
 *
 * The web app needs this for two things only: to name a raag or taal key
 * (the roster, the facets) and to derive the markers of a taal when it
 * renders a grid. The normalisers are ported as well so that both sides
 * agree on what a printed name means, and the shared vectors in
 * pipeline/python/fixtures/notations/vocab-vectors.json prove it.
 *
 * Nothing here touches node: builtins; the phone bundles it.
 */
const VOCAB = require('./notation-vocab.json');

const VERSION = VOCAB.version;
const RAAGS = Object.fromEntries(VOCAB.raags.map(r => [r.key, r]));
const TAALS = Object.fromEntries(VOCAB.taals.map(t => [t.key, t]));
const LAYA = VOCAB.laya;
const SECTIONS = VOCAB.sections;
const SWARAS = VOCAB.swaras;
const SYMBOLS = VOCAB.symbols;
const ROMAN = VOCAB.roman_map;
const STOP = VOCAB.stopwords;

const SWARA_ORDER = SWARAS.order.slice();
const KOMAL_ALLOWED = new Set(SWARAS.komal_allowed);
const TIVRA_ALLOWED = new Set(SWARAS.tivra_allowed);

const FUZZY_RAAG = 0.85;
const FUZZY_TAAL = 0.80;
const FUZZY_MARGIN = 0.05;
const FUZZY_MIN_LEN = 4;

const GURMUKHI_LETTER = 'ਅ-ਊਏਐਓ-ਨਪ-ਰਲਲ਼ਵਸ਼ਸਹਖ਼-ੜਫ਼ੲ-ੴ';
const VOWEL_SIGN = 'ਾ-ੂੇੈੋੌ';
const KEEP_PA = new RegExp(`[^${GURMUKHI_LETTER}${VOWEL_SIGN}ੰ ]`, 'gu');
const INDEPENDENT_VOWEL = /[ਅ-ਊਏਐਓਔੲ-ੴ]/gu;
const VOWEL_SIGNS_RX = new RegExp(`[${VOWEL_SIGN}ੰ]`, 'gu');
const ZW = /[​‌‍­﻿]/gu;
const FINAL_SHORT = /[ੁਿ]$/u;
const REPEAT = /(.)\1+/gu;
const EN_KEEP = /[^a-z]+/g;
const EN_VOWEL = /[aeiou]/g;
const SKEL_PA = { 'ਟ': 'ਤ', 'ਠ': 'ਥ', 'ਡ': 'ਦ', 'ਢ': 'ਧ', 'ੜ': 'ਦ', 'ਣ': 'ਨ', 'ਵ': 'ਬ', 'ਯ': 'ਜ' };
const SKEL_EN = { w: 'v', z: 'j' };

const translate = (s, map) => Array.from(s, ch => (ch in map ? map[ch] : ch)).join('');

function foldPaToken(tok) {
  return tok.replace(/਼/gu, '').replace(/ੱ/gu, '').replace(/ਂ/gu, 'ੰ').replace(/੍/gu, '').replace(FINAL_SHORT, '');
}

/** The comparable form of a printed Gurmukhi name (see the Python docstring). Idempotent. */
function foldPa(text, stop = 'pa_raag') {
  let s = String(text || '').normalize('NFC').replace(ZW, '');
  s = s.replace(/਼/gu, '').replace(/ੱ/gu, '').replace(/ਂ/gu, 'ੰ').replace(/੍/gu, '');
  s = s.replace(KEEP_PA, ' ');
  const stops = new Set((STOP[stop] || []).map(foldPaToken));
  const out = [];
  for (const raw of s.split(/\s+/)) {
    const tok = foldPaToken(raw);
    if (!tok || stops.has(tok)) continue;
    out.push(tok);
  }
  return out.join(' ');
}

function skelPa(folded) {
  let s = folded.replace(VOWEL_SIGNS_RX, '').replace(INDEPENDENT_VOWEL, '');
  s = translate(s.replace(/ /g, ''), SKEL_PA);
  return s.replace(REPEAT, '$1');
}

function foldEn(text, stop = 'en_raag') {
  let s = String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  s = s.replace(EN_KEEP, ' ');
  const stops = new Set(STOP[stop] || []);
  return s.split(' ').filter(w => w && !stops.has(w)).join(' ');
}

function skelEn(folded) {
  const s = translate(folded.replace(/ /g, ''), SKEL_EN).replace(EN_VOWEL, '');
  return s.replace(REPEAT, '$1');
}

/** 1 - (|a|+|b|-2·LCS)/(|a|+|b|), over code points. */
function indelRatio(a, b) {
  const A = Array.from(a), B = Array.from(b);
  if (!A.length && !B.length) return 1;
  if (!A.length || !B.length) return 0;
  let prev = new Array(B.length + 1).fill(0);
  for (const ca of A) {
    const cur = [0];
    for (let j = 1; j <= B.length; j += 1) cur.push(ca === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]));
    prev = cur;
  }
  const lcs = prev[B.length];
  return 1 - (A.length + B.length - 2 * lcs) / (A.length + B.length);
}

class Index {
  constructor(entries, script, stop) {
    this.script = script;
    this.stop = stop;
    this.alias = {};
    this.aliasNospace = {};
    this.names = [];
    const skel = {};
    for (const [key, e] of Object.entries(entries)) {
      const spellings = (e.aliases[script] || []).slice();
      if (script === 'en') spellings.push(e.en, e.banidb || '');
      else spellings.push(e.pa || '');
      for (const sp of spellings) {
        const f = this.fold(sp);
        if (!f) continue;
        if (!(f in this.alias)) this.alias[f] = key;
        const ns = f.replace(/ /g, '');
        if (!(ns in this.aliasNospace)) this.aliasNospace[ns] = key;
        this.names.push([f, key]);
        const sk = this.skel(f);
        (skel[sk] = skel[sk] || new Set()).add(key);
      }
    }
    this.skelIndex = {};
    this.collisions = {};
    for (const [sk, keys] of Object.entries(skel)) {
      if (keys.size === 1) this.skelIndex[sk] = [...keys][0];
      else this.collisions[sk] = [...keys].sort();
    }
  }

  fold(s) { return this.script === 'pa' ? foldPa(s, this.stop) : foldEn(s, this.stop); }

  skel(f) { return this.script === 'pa' ? skelPa(f) : skelEn(f); }

  lookup(text, fuzzy) {
    const folded = this.fold(text);
    if (!folded) return { key: null, confidence: 0, method: null };
    const key = this.alias[folded] || this.aliasNospace[folded.replace(/ /g, '')];
    if (key) return { key, confidence: 1, method: 'alias' };
    const sk = this.skel(folded);
    const compact = folded.replace(/ /g, '');
    if (Array.from(sk).length >= 3 && sk in this.skelIndex) {
      return { key: this.skelIndex[sk], confidence: 0.9, method: 'skeleton' };
    }
    if (fuzzy != null && Array.from(compact).length >= FUZZY_MIN_LEN) {
      const best = this.fuzzy(folded, fuzzy);
      if (best) return best;
    }
    const toks = folded.split(' ');
    if (fuzzy != null && toks.length >= 2) {
      for (let n = toks.length - 1; n > 0; n -= 1) {
        for (let i = 0; i + n <= toks.length; i += 1) {
          const sub = toks.slice(i, i + n).join(' ');
          const ssk = this.skel(sub);
          let k = this.alias[sub];
          if (!k && Array.from(ssk).length >= 3) k = this.skelIndex[ssk];
          if (k) return { key: k, confidence: 0.8, method: 'partial' };
        }
      }
    }
    return { key: null, confidence: 0, method: null };
  }

  fuzzy(folded, accept) {
    // the same order Python's sorted() of (score, key) descending gives: score, then key, descending
    const scored = this.names.map(([name, key]) => [indelRatio(folded, name), key])
      .sort((x, y) => (y[0] - x[0]) || (x[1] < y[1] ? 1 : x[1] > y[1] ? -1 : 0));
    if (!scored.length || scored[0][0] < accept) return null;
    const [best, key] = scored[0];
    const other = (scored.find(([, k]) => k !== key) || [0])[0];
    if (best - other < FUZZY_MARGIN) return null;
    return { key, confidence: Math.round(best * 1000) / 1000, method: 'fuzzy' };
  }
}

const RAAG_PA = new Index(RAAGS, 'pa', 'pa_raag');
const RAAG_EN = new Index(RAAGS, 'en', 'en_raag');
const TAAL_PA = new Index(TAALS, 'pa', 'pa_taal');
const TAAL_EN = new Index(TAALS, 'en', 'en_taal');
const BANIDB = Object.fromEntries(Object.values(RAAGS).filter(r => r.banidb).map(r => [r.banidb, r.key]));
const GURMUKHI_RX = /[਀-੿]/u;

const scriptOf = text => (GURMUKHI_RX.test(text || '') ? 'pa' : 'en');
const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** {key, parent, confidence, method}; the bracketed variant first, the bare name as parent. */
function normaliseRaag(text, script) {
  script = script || scriptOf(text);
  const index = script === 'pa' ? RAAG_PA : RAAG_EN;
  const fuzzy = script === 'pa' ? FUZZY_RAAG : null;
  const inner = [...String(text || '').matchAll(/\(([^()]+)\)/g)].map(m => m[1]);
  const outer = String(text || '').replace(/\([^()]*\)/g, ' ');
  let hit = null;
  for (const cand of inner.concat([outer])) {
    const r = index.lookup(cand, fuzzy);
    if (r.key) { hit = r; break; }
  }
  if (!hit) hit = index.lookup(text || '', fuzzy);
  const key = hit.key;
  let parent = key ? (RAAGS[key].parent || null) : null;
  if (key && inner.length) {
    const base = index.lookup(outer, null).key;
    if (base && base !== key && !parent) parent = base;
  }
  return { key, parent, confidence: hit.confidence, method: hit.method };
}

/** ['madh', 'ਤਿੰਨਤਾਲ '] from 'ਤਿੰਨਤਾਲ (ਮੱਧ ਲਯ)'. */
function splitLaya(text, script = 'pa') {
  let found = null;
  let rest = text;
  for (const entry of LAYA) {
    const aliases = (entry[script === 'en' ? 'en' : 'pa'] || []).slice().sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      const pattern = new RegExp('(?<![\\u0a00-\\u0a7fA-Za-z])\\(?\\s*' + escapeRx(alias) + '\\s*\\)?(?![\\u0a00-\\u0a7fA-Za-z])', 'giu');
      if (pattern.test(rest)) {
        found = entry.key;
        rest = rest.replace(pattern, ' ');
      }
    }
  }
  return [found, rest];
}

/** {key, laya, matras, confidence, method}. */
function normaliseTaal(text, script) {
  script = script || scriptOf(text);
  const [laya, rest] = splitLaya(text || '', script);
  const index = script === 'pa' ? TAAL_PA : TAAL_EN;
  const hit = index.lookup(rest, script === 'pa' ? FUZZY_TAAL : null);
  return { key: hit.key, laya, matras: hit.key ? TAALS[hit.key].matras : null, confidence: hit.confidence, method: hit.method };
}

/** The key of a shabads.raag value: BaniDB's own spelling first, then the English aliases. */
function raagKeyFromCorpus(name) {
  if (!name) return null;
  if (name in BANIDB) return BANIDB[name];
  return RAAG_EN.lookup(name, null).key;
}

function taalInfo(key) { return key ? TAALS[key] || null : null; }

/** The marker over each matra of an avartan (null where none), cut to the row's matras. */
function taalMarkers(key, matraFrom = 1, count = null) {
  const t = TAALS[key];
  if (!t || !t.vibhag) return new Array(count || 0).fill(null);
  const marks = [];
  t.vibhag.forEach((size, i) => {
    marks.push(t.markers && i < t.markers.length ? t.markers[i] : null);
    for (let k = 1; k < size; k += 1) marks.push(null);
  });
  const start = Math.max(0, matraFrom - 1);
  const end = count != null ? start + count : marks.length;
  return marks.slice(start, end);
}

/** 'sam' | 'khali' | 'tali' | null for a printed marker glyph. */
function markerKind(glyph) {
  const g = String(glyph || '').trim();
  if (SYMBOLS.sam.includes(g)) return 'sam';
  if (SYMBOLS.khali.includes(g)) return 'khali';
  for (const glyphs of Object.values(SYMBOLS.tali)) if (glyphs.includes(g)) return 'tali';
  return null;
}

/** The one taal whose matras and sam/khali positions fit a printed marker row, else null. */
function taalFromMarkers(nBeats, markers) {
  const hits = [];
  for (const [key, t] of Object.entries(TAALS)) {
    if (t.matras !== nBeats || !t.vibhag) continue;
    let ok = true;
    for (const [mStr, mark] of Object.entries(markers)) {
      const m = Number(mStr);
      const kind = markerKind(mark);
      if (kind === 'sam' && m !== t.sam) ok = false;
      else if (kind === 'khali' && !t.khali.includes(m)) ok = false;
      else if (kind === 'tali' && !t.tali.includes(m)) ok = false;
    }
    if (ok) hits.push(key);
  }
  return hits.length === 1 ? hits[0] : null;
}

function gurmukhiDigits(s) {
  return Array.from(String(s || ''), c => (c >= '੦' && c <= '੯' ? String(c.charCodeAt(0) - 0x0a66) : c)).join('');
}

/** ['antara', 2] from 'ਅੰਤਰਾ ੨'; ['sthai', null] from 'ਸਥਾਈ'; null otherwise. */
function sectionLabel(text) {
  const s = String(text || '').trim();
  for (const [kind, labels] of Object.entries(SECTIONS)) {
    for (const label of labels) {
      const core = label.replace(/[: -]+$/, '');
      if (s.startsWith(core)) {
        const tail = s.slice(core.length);
        const m = tail.match(/([0-9੦-੯]+)/u);
        const n = m ? parseInt(gurmukhiDigits(m[1]), 10) : null;
        if (tail.replace(/^[ :\-.()]+|[ :\-.()]+$/g, '').length > 6 && !m) return null;
        return [kind, n];
      }
    }
  }
  return null;
}

/** The canonical swara of one printed cell token ('ਸਾ' -> 'S'), or null. */
function swaraRead(token, script = 'gurmukhi') {
  let t = String(token || '').trim();
  if (!t) return null;
  if (script === 'gurmukhi') {
    t = t.replace(/਼/gu, '');
    return SWARAS.gurmukhi_read[t] || null;
  }
  if (script === 'devanagari') return SWARAS.devanagari_read[t] || null;
  const u = t.toUpperCase();
  return SWARA_ORDER.includes(u) && t.length === 1 ? u : null;
}

module.exports = {
  VOCAB, VERSION, RAAGS, TAALS, LAYA, SECTIONS, SWARAS, SYMBOLS, ROMAN, STOP,
  SWARA_ORDER, KOMAL_ALLOWED, TIVRA_ALLOWED,
  foldPa, skelPa, foldEn, skelEn, indelRatio,
  normaliseRaag, normaliseTaal, splitLaya, raagKeyFromCorpus,
  taalInfo, taalMarkers, taalFromMarkers, markerKind, gurmukhiDigits, sectionLabel, swaraRead,
  _indexes: { RAAG_PA, RAAG_EN, TAAL_PA, TAAL_EN },
};
