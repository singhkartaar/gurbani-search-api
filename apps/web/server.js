'use strict';
/**
 * Server for the Gurbani app.
 *
 * Any number of meaning indexes load side by side and the client picks one per
 * request (?index=<name>). An index is a directory under artifacts/ with a
 * manifest (the English one at the root); the manifest says what text it
 * embedded, with which model, what it is called, which scripts a query may be
 * in and what it is for -- see registry.js. Nothing here knows an index by
 * name: adding one is adding a directory. The server builds each index's query
 * encoder from its manifest, sharing one ONNX session per model.
 *
 * Semantic endpoints degrade to 503 when an index is absent -- lexical search
 * must never depend on them. That isolation is asserted in search-core's tests
 * and mirrored here.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../packages/search-core/src/index-node.js');

const ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACTS = process.env.ARTIFACTS_DIR || path.join(ROOT, 'artifacts');
// The slim shipping database: everything a client searches, and nothing it
// does not. Translations live in their own file (below) because they are read
// a shabad at a time rather than searched.
const DB_PATH = process.env.DB_PATH || path.join(ARTIFACTS, 'gurbani.sqlite');
const MODELS_DIR = process.env.MODELS_DIR || path.join(ROOT, 'vendor', 'models');
// English and Punjabi translations, kept out of the shipping database because
// they are read a shabad at a time rather than searched. Two readers: the ask
// feature, which hands a shabad's meaning to the language model, and the reader
// who turns on translations beside the Gurmukhi (?tr=en,pa). Absent -> ask is
// off and the translation toggle is not offered.
const TRANSLATIONS_PATH = process.env.TRANSLATIONS_PATH || path.join(ARTIFACTS, 'translations.sqlite');
// The prose corpora. artifacts/corpora/ is one level deeper than an index
// directory so that registry.discoverIndexDirs never finds it: their ids are
// passage rows, not lines of the Granth, and an index that addressed the wrong
// thing would render the wrong verse rather than fail.
//
// Each is a body of prose ABOUT Gurbani with its own id space, its own model
// and its own database. A reader searches them by meaning (/api/writings/search)
// and, where a language model is configured, puts questions to them.
// They are listed rather than hardcoded so that another costs a row here and
// nothing else; one that is not on disk is simply absent.
const CORPORA_DIR = path.join(ARTIFACTS, 'corpora');
const WRITINGS_PATH = process.env.WRITINGS_PATH || path.join(ARTIFACTS, 'writings.sqlite');
const TREATISES_PATH = process.env.TREATISES_PATH || path.join(ARTIFACTS, 'treatises.sqlite');
const AKJ_PATH = process.env.AKJ_PATH || path.join(ARTIFACTS, 'akj.sqlite');
const PURAN_PATH = process.env.PURAN_PATH || path.join(ARTIFACTS, 'puran.sqlite');
const VIRSINGH_PATH = process.env.VIRSINGH_PATH || path.join(ARTIFACTS, 'virsingh.sqlite');
const RAGHBIR_PATH = process.env.RAGHBIR_PATH || path.join(ARTIFACTS, 'raghbir.sqlite');
// The order is the order a reader is offered them, so it is editorial rather
// than alphabetical: Bau Ji first, because his is the corpus this began with,
// then Sahib Singh's commentary, then the four bodies of English prose.
const CORPORA = [
  { key: 'writings', dir: 'writings-en', db: WRITINGS_PATH },
  { key: 'akj', dir: 'akj-en', db: AKJ_PATH },
  { key: 'puran', dir: 'puran-en', db: PURAN_PATH },
  { key: 'virsingh', dir: 'virsingh-en', db: VIRSINGH_PATH },
  { key: 'raghbir', dir: 'raghbir-en', db: RAGHBIR_PATH },
];
const DEFAULT_CORPUS = 'writings';
// A search returns whole passages, at most this many. Both floors are off by
// default and are kept only as knobs: see /api/writings/search for the three
// that were measured and why none of them can tell relevant from irrelevant.
const WRITINGS_SEARCH_MAX = Math.max(1, Math.min(50, Number(process.env.WRITINGS_SEARCH_MAX) || 10));
const WRITINGS_MIN_SCORE = Number(process.env.WRITINGS_MIN_SCORE) || 0;
const WRITINGS_MIN_RATIO = Math.max(0, Math.min(1, Number(process.env.WRITINGS_MIN_RATIO) || 0));
const PORT = Number(process.env.PORT || 5173);
const PUBLIC_DIR = path.resolve(__dirname, 'public');
// When set, every route except /api/health requires HTTP Basic auth with this
// password (any username). Unset for local development.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const IS_PROD = process.env.NODE_ENV === 'production';
// The API's version, from one source of truth, reported on every response and in
// /api/health so a client can tell what it is talking to without guessing.
//
// There is deliberately no /api/v1/ path prefix. A prefix that silently maps to
// "whatever is current" is worse than no prefix at all, because a client
// believes it is pinned and is not. The compatibility promise is in docs/api.md:
// within a major version, fields are added and never removed or repurposed. If
// that ever has to break, a real /api/v2/ is what earns the prefix.
const API_VERSION = require('./package.json').version;

// Indexes are discovered, not listed: every directory under artifacts/ with a
// manifest, the English one at the root. A manifest with `roles: []` is a lab
// candidate and never loads; INDEXES=a,b in the environment restricts the set.
const registry = require('./registry.js');
// The index a request gets when it names none. Resolved after loading rather
// than fixed here, because a deployment that restricts INDEXES (a semantic-API
// microservice ships one index, not five) would otherwise 400 every unnamed
// request against a default that was never loaded.
const CONFIGURED_DEFAULT = process.env.DEFAULT_INDEX || 'en-ss';
let DEFAULT_INDEX = CONFIGURED_DEFAULT;
const ONLY = (process.env.INDEXES || '').split(',').map(x => x.trim()).filter(Boolean);

// Refuse to start without the database. A server that answers /api/health
// with 200 and every search with 503 would pass the host's health check while
// being useless -- fail here so a bad deploy is visible.
if (!fs.existsSync(DB_PATH)) {
  console.error(`database not found: ${DB_PATH}\n`
    + 'build it with: node pipeline/node/src/05-build-shipping-db.js');
  process.exit(1);
}
// Optional multi-process mode, off by default. Placed AFTER the database check
// so a misconfiguration fails once here rather than in every forked worker, and
// before anything is loaded so the supervisor never holds an index or a model.
// Returns true only in a supervisor, which has nothing else to do.
if (require('./cluster.js').startCluster()) return;

const db = core.openNodeAdapter(DB_PATH);

/** name -> { art, encoder, meta } for every index that loaded; `known` also holds the eligible ones that did not. */
const indexes = {};
const known = new Set();
let tdb = null;          // translations.sqlite, when it is on disk
// key -> { store, ask }, one per corpus in CORPORA that is on disk; `ask` is
// null where no language model is configured, and the search still works
const corpora = new Map();

// Who is asking, and how much they have left. The limiter above stays the
// burst guard -- in memory, per minute -- while the durable daily counters
// live in accounts/quota.js, because this machine stops when it is idle.
// The public export swaps identity.js for a Basic-auth-only file of the same
// shape and the same path, so the credential gate below needs no change.
const identify = require('./accounts/identity.js').createIdentifier();

// Cross-origin access, off unless CORS_ORIGINS is set. With it unset this adds
// no header to any response and leaves OPTIONS a 405, exactly as before.
const cors = require('./cors.js').createCors();

// Per-client request limits, off unless RATE_LIMIT_PER_MINUTE is set.
const limits = require('./limits.js').createLimits();

// Access logging, off unless LOG_REQUESTS is set. Search terms are omitted
// unless LOG_QUERIES=1 -- see logging.js for why that is the default.
const logger = require('./logging.js').createLogger();

async function tryLoadIndex(name, dir) {
  try {
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) return null;
    const art = await core.loadArtifacts(core.nodeReadFile(dir));
    console.log(`index "${name}": ${art.lines.n} lines, ${art.shabads.n} shabads, `
      + `${art.rahao.n} rahao, dim ${art.manifest.index_dim}, ${art.manifest.model}`);
    // per-line translator agreement, when 09_agreement.py has run for this index:
    // agreement.<against>.f32, one float per line, NaN where either side is missing
    const agreement = {};
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^agreement\.(.+)\.f32$/);
      if (m) agreement[m[1]] = new Float32Array(fs.readFileSync(path.join(dir, f)).buffer.slice(0));
    }
    if (Object.keys(agreement).length) console.log(`index "${name}": agreement vs ${Object.keys(agreement).join(', ')}`);
    return { art, encoder: null, agreement };
  } catch (err) {
    console.warn(`index "${name}" unavailable:`, err.message);
    return null;
  }
}

/**
 * The query encoder an index's manifest asks for; null means free text is off
 * for it. Indexes built with the same model share one ONNX session -- the
 * session is the memory, the index is only the prefixes and pooling around it.
 */
const encoders = new Map();      // model dir -> encoder
async function tryLoadEncoder(name, entry) {
  try {
    const { encoderOptions } = require('../../packages/query-encoder/src/index.js');
    const { createNodeEncoder } = require('../../packages/query-encoder/src/factory-node.js');
    const opts = encoderOptions(entry.art.manifest);
    const modelDir = path.join(MODELS_DIR, opts.modelDir || 'bge-small-en-v1.5');
    if (!fs.existsSync(path.join(modelDir, 'model_quantized.onnx'))) {
      console.warn(`index "${name}": model ${path.relative(ROOT, modelDir)} missing, free-text search off`);
      return null;
    }
    // max_len is a truncation bound inside the encoder, not a property of the
    // model, so it is deliberately NOT in the key: the Gurbani indexes say 160
    // and the prose corpora 256, and keying on it loaded each model twice. The
    // shared session takes the larger bound; a query is capped at 300 characters
    // long before either matters.
    const key = JSON.stringify([modelDir, opts.tokenizer, opts.pooling, opts.queryPrefix]);
    if (!encoders.has(key)) {
      encoders.set(key, await createNodeEncoder(modelDir, { ...opts, maxLen: Math.max(opts.maxLen || 0, 256) }));
      console.log(`index "${name}": query encoder loaded (${opts.tokenizer}, ${opts.pooling} pooling)`);
    } else {
      console.log(`index "${name}": query encoder shared`);
    }
    return encoders.get(key);
  } catch (err) {
    console.warn(`index "${name}": query encoder unavailable:`, err.message);
    return null;
  }
}

const lineCols = `line_id, verse_id, shabad_id, ang, position_in_shabad,
                  gurmukhi_uni, gurmukhi_ascii, translit_roman, first_letters_ascii,
                  kind, rahao_kind, writer, raag`;

// Views a reader can ask to see beside a line (?tr=en,pa,pad,fk), each a list
// of translator ids, best first: a line takes the first one that has it.
//   en   English translation -- BaniDB's corrected edition of Sant Singh Khalsa,
//        else Manmohan Singh. The uncorrected `ssk` text stays in the file but
//        is not shown: where the two differ, the correction is the point.
//   pa   Punjabi arth -- Sahib Singh's Darpan, the standard exegesis, which
//        stops short of 5,300 lines where Manmohan Singh's Punjabi fills in
//   pad  Sahib Singh's pad-arth: the hard words of the line, each with its meaning
//   fk   Faridkot Teeka -- the sampradayak reading
//
// The Darpan's machine English (en-ss-mt, en-ss-pad-mt) is deliberately NOT a
// view. A machine rendering of Sahib Singh is good enough to retrieve with and
// to hand a model as context, and not good enough to put in front of a reader
// as his words. It serves the English meaning indexes and Ask, both of which
// read translations.sqlite directly, and it stops there.
const TRANSLATORS = { en: ['bdb', 'ms'], pa: ['pa-ss', 'pa-ms'], pad: ['pa-ss-pad'], fk: ['pa-fk'] };

/** Views a request asked to see beside the Gurmukhi: ?tr=en,pa,pad,fk */
function parseLangs(url) {
  if (!tdb) return [];
  const raw = (url.searchParams.get('tr') || '').split(',').map(x => x.trim()).filter(Boolean);
  return raw.filter(l => l in TRANSLATORS);
}

/**
 * Add `tr_en` / `tr_pa` to line rows, in place, for the languages asked for.
 * One query for a whole page of results; a line with no translation simply
 * carries none.
 */
function attachTranslations(rows, langs) {
  if (!langs.length || !rows.length) return rows;
  const wanted = new Set(langs.flatMap(l => TRANSLATORS[l]));
  const ids = rows.map(r => r.line_id);
  const found = tdb.all(
    `SELECT line_id, translator, text FROM translations WHERE line_id IN (${ids.map(() => '?').join(',')})`, ids);
  const byLine = new Map();
  for (const t of found) {
    if (!wanted.has(t.translator)) continue;
    if (!byLine.has(t.line_id)) byLine.set(t.line_id, {});
    byLine.get(t.line_id)[t.translator] = t.text;
  }
  for (const row of rows) {
    const got = byLine.get(row.line_id) || {};
    for (const lang of langs) {
      const pick = TRANSLATORS[lang].find(t => got[t]);
      if (pick) row[`tr_${lang}`] = got[pick];
    }
  }
  return rows;
}

/**
 * Add `agreement: {<against>: cosine}` to line rows from an index that has
 * measured how far its translators sit apart on each line. A low value is
 * the one place a reader should not trust any single translation.
 */
function attachAgreement(rows, entry) {
  if (!entry || !entry.agreement || !Object.keys(entry.agreement).length) return rows;
  for (const row of rows) {
    const out = {};
    for (const [against, arr] of Object.entries(entry.agreement)) {
      const v = arr[row.line_id];
      if (Number.isFinite(v)) out[against] = Math.round(v * 1000) / 1000;
    }
    if (Object.keys(out).length) row.agreement = out;
  }
  return rows;
}

// translations.sqlite is built in stages, so ask before reading: a file built
// before 09-ingest-darpan.js ran has neither of these tables.
const tdbTables = new Map();
function tdbHas(table) {
  if (!tdb) return false;
  if (!tdbTables.has(table)) {
    tdbTables.set(table, tdb.all(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [table]).length > 0);
  }
  return tdbTables.get(table);
}

/**
 * What the Darpan says ABOUT a shabad, as opposed to line by line: the ਭਾਵ
 * gist Sahib Singh wrote for it, the arth of each stanza, and the subject he
 * filed it under in his ਗੁਰਮਤਿ ਅੰਗ ਸੰਗ੍ਰਹਿ index. All three exist only for the
 * shabads the docx reaches; a shabad without them simply gets nulls.
 */
function darpanContext(shabadId) {
  if (!tdbHas('darpan_units')) return null;
  const units = tdb.all(
    "SELECT unit_id, kind, stanza, is_rahao, en, en_covers, text FROM darpan_units"
    + " WHERE shabad_id = ? AND kind IN ('arth','bhav') ORDER BY rowid", [shabadId]);
  const bhav = units.find(u => u.kind === 'bhav') || null;
  const stanzas = units.filter(u => u.kind === 'arth').map(u => ({
    stanza: u.stanza, is_rahao: Boolean(u.is_rahao), pa: u.text, en: u.en,
    covers: Math.max(1, Number(u.en_covers) || 1),
  }));
  const topics = tdbHas('darpan_topics')
    ? tdb.all('SELECT topic, sub, gist, gist_en FROM darpan_topics WHERE shabad_id = ? ORDER BY code', [shabadId])
    : [];
  if (!bhav && !stanzas.length && !topics.length) return null;
  return {
    bhav: bhav ? { pa: bhav.text, en: bhav.en } : null,
    stanzas,
    topics: topics.map(t => ({ topic: t.topic, sub: t.sub, pa: t.gist, en: t.gist_en })),
  };
}

/** Which languages this build can show, for /api/health. */
function availableLangs() {
  if (!tdb) return {};
  return Object.fromEntries(Object.keys(TRANSLATORS).map(lang => [lang, tdb.all(
    `SELECT 1 FROM translations WHERE translator IN (${TRANSLATORS[lang].map(() => '?').join(',')}) LIMIT 1`,
    TRANSLATORS[lang]).length > 0]));
}

const linesByIds = ids => {
  if (!ids.length) return [];
  const rows = db.all(
    `SELECT ${lineCols} FROM lines WHERE line_id IN (${ids.map(() => '?').join(',')})`, ids);
  const byId = new Map(rows.map(r => [r.line_id, r]));
  return ids.map(id => byId.get(id)).filter(Boolean);
};

const shabadsByIds = ids => {
  if (!ids.length) return [];
  const rows = db.all(
    `SELECT s.shabad_id, s.writer, s.raag, s.ang_start, s.line_count, s.has_rahao,
            (SELECT gurmukhi_uni FROM lines l WHERE l.shabad_id=s.shabad_id AND l.kind='rahao'
              ORDER BY position_in_shabad LIMIT 1) AS rahao_line,
            (SELECT gurmukhi_uni FROM lines l WHERE l.shabad_id=s.shabad_id AND l.kind IN ('line','rahao')
              ORDER BY position_in_shabad LIMIT 1) AS first_line
     FROM shabads s WHERE s.shabad_id IN (${ids.map(() => '?').join(',')})`, ids);
  const byId = new Map(rows.map(r => [r.shabad_id, r]));
  return ids.map(id => byId.get(id)).filter(Boolean);
};

// A PARAMETER THAT IS NOT THERE IS NOT A ZERO. `URLSearchParams.get` answers
// null for an absent key, and `Number(null)` and `Number('')` are both 0, which
// `Number.isInteger` happily accepts. So these two read a missing parameter as
// the number zero and never reached the branch written for it: the clamp below
// returned `min`, and every route with an optional bound answered with ONE
// result instead of its default -- /api/text, /api/similar, /api/writings/search
// and /api/fl's `limit`, all of them, for any caller that left the parameter
// out. The browser app always sends one, so it showed up only through the API.
// Likewise a missing `id` became id 0, and the "invalid or missing id" branch
// below was dead code behind a 404 about shabad zero.
const absent = val => val === null || val === undefined || val === '';

function parseBoundedInt(val, min, max, fallback) {
  if (absent(val)) return fallback;
  const n = Number(val);
  return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function parseNonNegativeInt(val) {
  if (absent(val)) return null;
  const n = Number(val);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The index a request asks for, or an error body: 400 for a name nobody has, 503 for one that did not load. */
function pickIndex(url) {
  const name = url.searchParams.get('index') || DEFAULT_INDEX;
  const entry = indexes[name];
  if (entry) return { name, entry };
  if (known.has(name)) return { error: `semantic index "${name}" not built`, code: 503 };
  return { error: `unknown index "${name}"`, code: 400 };
}

/**
 * `index=all`: every loaded index with the role, in display order.
 * `index=a,b,c`: those, fused the same way -- what the reader's "Gurmukhi" and
 * "English" groups send, so the switch can offer a language rather than a list
 * of build names.
 * `index=a`: that one alone.
 * Returns { names, entries } or an error body.
 */
function pickIndexes(url, role) {
  const name = url.searchParams.get('index') || DEFAULT_INDEX;
  if (name !== 'all' && name.includes(',')) {
    const wanted = [...new Set(name.split(',').map(x => x.trim()).filter(Boolean))];
    const missing = wanted.filter(n => !indexes[n]);
    if (missing.length) {
      const unbuilt = missing.filter(n => known.has(n));
      return unbuilt.length
        ? { error: `semantic index "${unbuilt[0]}" not built`, code: 503 }
        : { error: `unknown index "${missing[0]}"`, code: 400 };
    }
    const names = registry.orderIndexes(indexes).filter(n => wanted.includes(n)
      && indexes[n].meta.roles.includes(role));
    if (!names.length) return { error: `none of those indexes serve ${role}`, code: 400 };
    return { names, entries: names.map(n => indexes[n]), all: true };
  }
  if (name !== 'all') {
    const one = pickIndex(url);
    if (one.error) return one;
    // 'all' filters by role; one index by name did not, so a caller could ask
    // pa-ft for neighbours -- the role its own manifest says it does not serve,
    // because contrastive training left it last of ten at finding them
    if (!one.entry.meta.roles.includes(role)) {
      return { error: `index "${one.name}" does not serve ${role}`, code: 400 };
    }
    return { names: [one.name], entries: [one.entry], all: false };
  }
  const names = registry.orderIndexes(indexes).filter(n => indexes[n].meta.roles.includes(role));
  if (!names.length) return { error: `no loaded index serves ${role}`, code: 503 };
  return { names, entries: names.map(n => indexes[n]), all: true };
}

/**
 * A similar-* route: one index, or all of them fused by reciprocal rank
 * (`run(art, depth)` is the per-index lookup). Fused results carry `votes`,
 * how many sources agreed, in place of a cosine.
 */
const similar = (run, resolve) => url => {
  const picked = pickIndexes(url, 'neighbours');
  if (picked.error) return picked;
  const id = parseNonNegativeInt(url.searchParams.get('id'));
  if (id === null) return { error: 'invalid or missing id parameter', code: 400 };
  const k = parseBoundedInt(url.searchParams.get('k'), 1, 50, 10);
  if (!picked.all) return run.one(picked.names[0], picked.entries[0], id, k, url);
  const fused = core.fuseSimilar({ entries: picked.entries.map(e => ({ name: e.meta.name, art: e.art, weight: 1 })),
                                   run: (art, depth) => run.many(art, id, depth), k });
  const rows = resolve(fused.map(f => f.id), url);
  const byId = new Map(fused.map(f => [f.id, f]));
  return { index: 'all', indexes: picked.names, score_kind: 'rrf',
           results: rows.map(r => ({ ...r, score: byId.get(r.line_id ?? r.shabad_id).score, votes: byId.get(r.line_id ?? r.shabad_id).hits.length })) };
};

/**
 * The prose corpus a request asked for.
 *
 * An unknown name is a 400 and a known one that is not built is a 503, the
 * same distinction /api/text draws between a name nobody has and a name whose
 * index is missing -- a reader who mistypes should be told so, and one whose
 * server simply lacks the file should not be told they mistyped.
 */
function corpusByKey(key) {
  if (!CORPORA.some(c => c.key === key)) return { error: `unknown corpus "${key}"`, code: 400 };
  const held = corpora.get(key);
  if (!held) return { error: `the "${key}" corpus is not on this server`, code: 503 };
  return { key, store: held.store, ask: held.ask };
}
function pickCorpus(url) {
  return corpusByKey(url.searchParams.get('corpus') || DEFAULT_CORPUS);
}

/**
 * `corpus=all`: every corpus on this server, in the order CORPORA declares;
 * `corpus=a,b`: those; `corpus=a` or nothing: one. Returns { all, keys,
 * entries } or an error body.
 */
function pickCorpora(url) {
  const raw = url.searchParams.get('corpus') || DEFAULT_CORPUS;
  if (raw === 'all') {
    const keys = CORPORA.filter(c => corpora.has(c.key)).map(c => c.key);
    if (!keys.length) return { error: 'no corpus is on this server', code: 503 };
    return { all: true, keys, entries: keys.map(k => corpusByKey(k)) };
  }
  const keys = [...new Set(raw.split(',').map(x => x.trim()).filter(Boolean))];
  const entries = [];
  for (const key of keys) {
    const one = corpusByKey(key);
    if (one.error) return one;
    entries.push(one);
  }
  return { all: keys.length > 1, keys, entries };
}


const routes = {
  '/api/health': () => {
    const sources = registry.orderIndexes(indexes);
    const summary = Object.fromEntries([...new Set([...known, ...sources])].map(name =>
      [name, indexes[name] ? registry.summarize(indexes[name]) : { loaded: false }]));
    return {
      ok: true,
      lines: db.all('SELECT COUNT(*) c FROM lines')[0].c,
      indexes: summary,
      // the reader's switch: loaded indexes in display order, and the one used when none is named
      sources,
      default_index: indexes[DEFAULT_INDEX] ? DEFAULT_INDEX : (sources[0] || null),
      translations: availableLangs(),
      // Reported because the alternative is a browser console message that does
      // not say whether the server was configured or the origin was refused.
      api_version: API_VERSION,
      cors: cors.summary(),
      logging: logger.summary(),
      // the numbers, so a deploy can be checked; not which header names the
      // client, which is the one detail that would help someone evade them
      rate_limit: (({ trust_proxy, client_ip_header, ...rest }) => rest)(limits.summary()),
      // `writings` keeps its shape for the client that already reads it; the
      // rest of the corpora are listed beside it, the default one included.
      writings: corpora.has(DEFAULT_CORPUS)
        ? { ...corpora.get(DEFAULT_CORPUS).store.summary(), ask: Boolean(corpora.get(DEFAULT_CORPUS).ask) }
        : { enabled: false },
      // `shipped: false` separates the two ways a corpus can be missing. Without
      // it a deliberately parked corpus reads exactly like a failed build, and
      // the owner goes looking for a file that is sitting right there.
      corpora: CORPORA.map(c => (corpora.has(c.key)
        ? { key: c.key, ...corpora.get(c.key).store.summary(), ask: Boolean(corpora.get(c.key).ask) }
        : { key: c.key, enabled: false, ...(c.ship === false ? { shipped: false } : {}) })),
      // legacy summary fields, for the default index
      semantic: Boolean(indexes[DEFAULT_INDEX]),
      freeText: Boolean(indexes[DEFAULT_INDEX] && indexes[DEFAULT_INDEX].encoder),
    };
  },

  '/api/fl': url => {
    const q = url.searchParams.get('q') || '';
    if (q.length > MAX_QUERY_CHARS) return { error: `query longer than ${MAX_QUERY_CHARS} characters`, code: 400 };
    const limit = parseBoundedInt(url.searchParams.get('limit'), 1, 100, 25);
    const mode = url.searchParams.get('mode') === 'start' ? 'start' : 'anywhere';
    const fn = mode === 'start' ? core.firstLetterStart : core.firstLetterAnywhere;
    const t = Date.now();
    const found = fn(db, q, { limit });
    const order = new Map(found.map((f, i) => [f.line_id, i]));
    const results = found.length
      ? db.all(`SELECT ${lineCols} FROM lines WHERE line_id IN (${found.map(() => '?').join(',')})`,
               found.map(r => r.line_id)).sort((a, b) => order.get(a.line_id) - order.get(b.line_id))
      : [];
    return {
      query: q, mode, ms: Date.now() - t,
      total: mode === 'anywhere' ? core.firstLetterAnywhereCount(db, q) : results.length,
      results: attachTranslations(results.map(r => ({
        ...r,
        highlight: core.keyboard.highlightWords(r.gurmukhi_ascii, r.first_letters_ascii, q),
      })), parseLangs(url)),
    };
  },

  '/api/shabad': url => {
    const id = parseNonNegativeInt(url.searchParams.get('id'));
    if (id === null) return { error: 'invalid or missing id parameter', code: 400 };
    const lines = db.all(
      `SELECT ${lineCols} FROM lines WHERE shabad_id=? ORDER BY position_in_shabad`, [id]);
    // The rahao is the refrain, sung after every stanza. BaniDB marks only the
    // verse that carries the marker, which is its LAST line; flag the whole
    // stanza so the reader sees the refrain entire.
    const inRahao = core.rahaoStanzaFlags(lines);
    lines.forEach((l, i) => { l.rahao_stanza = inRahao[i]; });
    const meta = db.all('SELECT * FROM shabads WHERE shabad_id=?', [id])[0] || null;
    // A shabad that does not exist is a 404, not a 200 carrying nulls: a client
    // cannot tell "no such shabad" from "a shabad with no lines" otherwise, and
    // the difference is a typo versus a corrupt database.
    if (!meta && !lines.length) return { error: `no shabad with id ${id}`, code: 404 };
    // agreement comes from the index named (?index=), else the default one
    const agreeFrom = indexes[url.searchParams.get('index')] || indexes[DEFAULT_INDEX];
    return { shabad: meta, darpan: darpanContext(id),
             lines: attachAgreement(attachTranslations(lines, parseLangs(url)), agreeFrom) };
  },

  '/api/similar/line': similar({
    one: (name, entry, id, k, url) => {
      // a source that has no text for this line (a translation that skips it,
      // a heading) has no vector for it either; say so rather than 503
      if (id < entry.art.lines.n && entry.art.lines.mask && entry.art.lines.mask[id] === 0) {
        return { index: name, results: [], note: 'this line has no text in this source' };
      }
      const hits = core.similarLines(entry.art, id, k);
      const rows = linesByIds(hits.map(h => h.id));
      return { index: name, results: attachAgreement(attachTranslations(
        rows.map((r, i) => ({ ...r, score: hits[i].score })), parseLangs(url)), entry) };
    },
    many: (art, id, depth) => (id < art.lines.n && art.lines.mask && art.lines.mask[id] === 0) ? [] : core.similarLines(art, id, depth),
  }, (ids, url) => attachTranslations(linesByIds(ids), parseLangs(url))),

  '/api/similar/shabad': similar({
    one: (name, entry, id, k) => {
      const hits = core.similarShabads(entry.art, id, k);
      const rows = shabadsByIds(hits.map(h => h.id));
      return { index: name, results: rows.map((r, i) => ({ ...r, score: hits[i].score })) };
    },
    many: (art, id, depth) => core.similarShabads(art, id, depth),
  }, ids => shabadsByIds(ids)),

  '/api/similar/rahao': similar({
    one: (name, entry, id, k) => {
      const hits = core.similarByRahao(entry.art, id, k);
      if (!hits.length) return { index: name, results: [], note: 'this shabad has no rahao line' };
      const rows = shabadsByIds(hits.map(h => h.id));
      return { index: name, results: rows.map((r, i) => ({ ...r, score: hits[i].score })) };
    },
    many: (art, id, depth) => core.similarByRahao(art, id, depth),
  }, ids => shabadsByIds(ids)),

  // keymap: physical key -> letter, derived from the same AnmolLipi mapping the
  // index uses (q=ਤ, t=ਟ ...), so typing on a real keyboard matches what
  // BaniDB users already know. Nukta letters fold to their base and so never
  // claim a key a base letter already holds.
  '/api/keyboard': () => ({
    rows: core.keyboard.PAINTI,
    nukta: core.keyboard.NUKTA_ROW,
    matras: core.keyboard.MATRA_ROW,
    keymap: core.keyboard.physicalKeymap(),
    // the same layout named in Roman, for a reader who knows the language but
    // not the script, with the physical keys that mode answers to
    roman: core.keyboard.ROMAN,
    romanKeymap: core.keyboard.ROMAN_KEYMAP,
  }),

  // The prose corpora: each has an id space of its own, and its own routes, so
  // that a passage row can never reach a route that resolves ids against
  // gurbani.sqlite. `?corpus=` picks one; omitting it means the writings.
  '/api/writings': url => {
    const picked = pickCorpus(url);
    if (picked.error) return picked;
    const { store } = picked;
    return {
      ...store.summary(),
      corpus_key: picked.key,
      works: store.works.map(w => ({
        work: w.work_id, title: w.title, title_en: w.title_en || null, author: w.author,
        parts: JSON.parse(w.parts),
        units: w.units, original: Boolean(w.original), quote_policy: w.quote_policy,
      })),
    };
  },

  /**
   * Search the writings by meaning: the passages nearest the query, whole,
   * with the shabads they cite. At most WRITINGS_SEARCH_MAX, best first.
   *
   * THERE IS NO RELEVANCE FILTER HERE, and that is a measured decision rather
   * than an omission. Three were tried against all five corpora on 2026-09-16,
   * eight on-topic queries against six off-topic ones:
   *
   *   absolute cosine  "python list comprehension syntax" scores 0.50 against
   *                    Puran Singh; "ego and humility", which he wrote about at
   *                    length, tops out at 0.35. No threshold orders these two
   *                    the right way round.
   *   z-score of the   how far the best passage stands out from the whole
   *   top hit          corpus, free because the scan computes every cosine
   *                    anyway. On-topic 4.48..6.14, off-topic 4.03..5.79.
   *                    Overlapping, so no cut.
   *   relative floor   keep what scores within a ratio of the best. This one is
   *                    worse than nothing: at 0.75 it kept 77% of on-topic rows
   *                    and 87% of off-topic ones, and it was backwards at every
   *                    ratio tried. An off-topic query matches nothing in
   *                    particular, so its scores are flat and the ratio spares
   *                    them all; an on-topic query has a peak and a tail, and
   *                    the ratio cuts the tail. It removed good passages faster
   *                    than bad ones, which is why it now defaults to off.
   *
   * bge-small's cosines say which passage is nearest. They do not say whether
   * anything is near, and no arrangement of them does. Rejecting an off-topic
   * question needs a reranker that reads the question and the passage together
   * -- which is exactly what Ask does, and why Ask reranks and this does not.
   * So the ranking is returned honestly with its scores, capped at
   * WRITINGS_SEARCH_MAX, and judging it is the reader's. WRITINGS_MIN_RATIO and
   * WRITINGS_MIN_SCORE remain as env knobs, both off, for anyone who measures
   * something better on a corpus of their own.
   */
  '/api/writings/search': async url => {
    const picked = pickCorpora(url);
    if (picked.error) return picked;
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length > MAX_QUERY_CHARS) return { error: `query longer than ${MAX_QUERY_CHARS} characters`, code: 400 };
    const k = parseBoundedInt(url.searchParams.get('k'), 1, WRITINGS_SEARCH_MAX, Math.min(10, WRITINGS_SEARCH_MAX));
    const work = url.searchParams.get('work') || null;
    const withSources = url.searchParams.get('cites') === '1';
    const label = picked.all ? 'all' : picked.keys[0];
    if (work && picked.all) return { error: 'a work narrows one corpus; name it with corpus=', code: 400 };
    if (work && !picked.entries[0].store.hasWork(work)) return { error: `unknown work "${work}"`, code: 400 };
    if (!q) return { corpus: label, corpora: picked.keys, results: [] };
    const able = picked.entries.filter(e => e.store.encoder && e.store.canRead(q));
    if (!able.length) {
      if (picked.all) return { error: 'no corpus on this server can read this query', code: 503 };
      const one = picked.entries[0];
      return one.store.encoder
        ? { error: `the "${one.key}" corpus cannot read this query's script`, code: 400 }
        : { error: `no query encoder for "${one.key}" on this server`, code: 503 };
    }
    const t0 = Date.now();
    const floor = hits => {
      if (!hits.length) return hits;
      const top = hits[0].score;
      return hits.filter(h => h.score >= WRITINGS_MIN_SCORE && h.score >= top * WRITINGS_MIN_RATIO);
    };
    const passage = (key, r, extra) => ({
      corpus: key, unit_row: r.unit_row, unit_id: r.unit_id, work: r.work_id,
      title: r.title, title_en: r.title_en || null, author: r.author, original: r.original,
      part: r.part, page: r.page, marker: r.marker, ...extra, text: r.text,
      cites: r.cites.map(c => ({ shabad_id: c.shabad_id, line_id: c.line_id, ang: c.ang })),
    });
    const finish = results => ({
      corpus: label, corpora: able.map(e => e.key), query: q, work: work || null,
      // What the score IS, not what the request asked for. `corpus=all` on a
      // deployment carrying one corpus fuses nothing, so calling it `rrf` and
      // handing back 1/(60+rank) threw away the cosines it actually had and
      // told the caller they were something else. A public deployment that
      // fetched a single writings pack is exactly that deployment.
      score_kind: able.length > 1 ? 'rrf' : 'cosine', min_ratio: WRITINGS_MIN_RATIO, min_score: WRITINGS_MIN_SCORE,
      ms: Date.now() - t0, results,
      // the shabads those passages cite, whole, for a client that draws them
      ...(withSources ? { sources: shabadsByIds([...new Set(results.flatMap(r => r.cites.map(c => c.shabad_id)))]) } : {}),
    });

    // One corpus answers the same way whether it was asked for by name or as
    // part of `all`: there is nothing to fuse with, and its cosines are
    // comparable to each other, which is the whole point of reporting them.
    if (!picked.all || able.length === 1) {
      const { key, store } = able[0];
      const hits = floor(store.nearest(await store.encode(q), k, { work }));
      const score = new Map(hits.map(h => [h.unit_row, h.score]));
      return finish(store.load(hits.map(h => h.unit_row)).map(r => passage(key, r, { score: score.get(r.unit_row) })));
    }
    // Several corpora, each in its own PCA space, so their cosines are not
    // comparable: each list is floored on its own and the lists are fused by
    // rank, as /api/text?index=all does. Keys are integers because fuseBy
    // breaks ties numerically: corpus position above the row.
    const lists = [];
    for (let i = 0; i < able.length; i += 1) {
      const { key, store } = able[i];
      const hits = floor(store.nearest(await store.encode(q), k * 2));
      lists.push({ index: key, via: 'search', weight: 1,
                   items: hits.map(h => ({ id: i * 2 ** 20 + h.unit_row, score: h.score })) });
    }
    const fused = core.fuseBy(lists, k, item => item.id);
    const byCorpus = new Map();
    for (const f of fused) {
      const i = Math.floor(f.key / 2 ** 20), unit_row = f.key % 2 ** 20;
      if (!byCorpus.has(i)) byCorpus.set(i, []);
      byCorpus.get(i).push(unit_row);
    }
    const loaded = new Map();
    for (const [i, rows] of byCorpus) {
      for (const r of able[i].store.load(rows)) loaded.set(i * 2 ** 20 + r.unit_row, passage(able[i].key, r, {}));
    }
    // no `votes` here: a passage belongs to exactly one corpus, so every
    // fused row would say "1 source" and mean nothing by it
    return finish(fused.map(f => ({ ...loaded.get(f.key), score: f.score })).filter(r => r.unit_row !== undefined));
  },


  // Free-text search: English against the "en" index, Gurmukhi against "pa".
  // The query is embedded on this machine with the index's own model. Results
  // are Gurmukhi lines; a translation comes back only when ?tr= asks for one.
  '/api/text': async url => {
    const picked = pickIndexes(url, 'text');
    if (picked.error) return picked;
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length > MAX_QUERY_CHARS) return { error: `query longer than ${MAX_QUERY_CHARS} characters`, code: 400 };
    const level = url.searchParams.get('level') === 'shabads' ? 'shabads' : 'lines';
    const k = parseBoundedInt(url.searchParams.get('k'), 1, 50, 15);
    if (picked.all) {
      // every source that has a model and can read this script votes; the
      // fused list is ranked by agreement, not by any one model's cosine
      const able = picked.entries.filter(e => e.encoder && registry.canRead(e.meta, q));
      if (!q) return { index: 'all', results: [] };
      if (!able.length) return { error: 'no loaded index can read this query', code: 503 };
      const t0 = Date.now();
      const vecs = new Map();
      for (const e of able) vecs.set(e.meta.name, core.projectQuery(e.art.pca, await e.encoder.encodeQuery(q)));
      const fused = core.fuseSimilar({ entries: able.map(e => ({ name: e.meta.name, art: e.art, weight: 1 })),
                                       run: (art, depth) => core.searchText(art, vecs.get([...able].find(e => e.art === art).meta.name), level, depth), k });
      const rows = level === 'lines' ? attachTranslations(linesByIds(fused.map(f => f.id)), parseLangs(url)) : shabadsByIds(fused.map(f => f.id));
      const byId = new Map(fused.map(f => [f.id, f]));
      return { index: 'all', indexes: able.map(e => e.meta.name), score_kind: 'rrf', query: q, level, ms: Date.now() - t0,
               results: rows.map(r => ({ ...r, score: byId.get(r.line_id ?? r.shabad_id).score, votes: byId.get(r.line_id ?? r.shabad_id).hits.length })) };
    }
    const name = picked.names[0], entry = picked.entries[0];
    if (!entry.encoder) return { error: `query encoder for index "${name}" not available`, code: 503 };
    if (!q) return { index: name, results: [] };
    // index=all already filters by this; one index by name did not, so a
    // Gurmukhi query against an English index reached a WordPiece tokenizer
    // that renders every letter [UNK] and returned nonsense ranked as results
    if (!registry.canRead(entry.meta, q)) {
      return { error: `index "${name}" cannot read this query's script`, code: 400 };
    }
    const t = Date.now();
    const vec = core.projectQuery(entry.art.pca, await entry.encoder.encodeQuery(q));
    const hits = core.searchText(entry.art, vec, level, k);
    const rows = level === 'lines' ? linesByIds(hits.map(h => h.id)) : shabadsByIds(hits.map(h => h.id));
    const results = rows.map((r, i) => ({ ...r, score: hits[i].score }));
    return { index: name, query: q, level, ms: Date.now() - t,
             results: level === 'lines' ? attachTranslations(results, parseLangs(url)) : results };
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Longer than any real search, shorter than anything a tokenizer should be
// handed whole: the encoder truncates TOKENS, after tokenizing the lot.
const MAX_QUERY_CHARS = 200;

// The page's script and style are files, not inline blocks, so the policy can
// refuse inline script outright -- which is the only thing a CSP is for here.
const SECURITY_HEADERS = {
  'X-API-Version': API_VERSION,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Fly redirects http to https; this is what stops the first request from
  // going out in the clear next time. Harmless on localhost: browsers ignore it.
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self';",
};

/**
 * Every request. Async, and wrapped below, so that a throw anywhere in the
 * dispatch -- a file removed after start, a manifest entry without a hash --
 * is a 500 for that request and not an unhandled rejection that ends the
 * process for everyone.
 */
async function handleRequest(req, res) {
  // Access logging, when it is on. Everything here is inside the `if` so a
  // deployment that does not want logs pays nothing for them -- no clock read,
  // no wrapped method, no listener.
  if (logger.enabled) {
    const started = Date.now();
    // the same key the limiter uses, so the log and the limit agree on who this
    // is rather than deriving it twice and disagreeing
    req.client = limits.clientKey(req);
    let bytes = 0;
    const end = res.end.bind(res);
    res.end = (chunk, ...rest) => {
      if (chunk) bytes += Buffer.byteLength(chunk);
      return end(chunk, ...rest);
    };
    res.on('finish', () => logger(req, res.statusCode, Date.now() - started, bytes));
  }

  // A CORS preflight is an OPTIONS the method gate below would refuse, so it is
  // answered first. With CORS_ORIGINS unset this does nothing and OPTIONS falls
  // through to the same 405 it always got.
  if (cors.preflight(req, res, SECURITY_HEADERS)) return;
  // Every response carries the cross-origin headers this request earned, which
  // is nothing at all unless CORS_ORIGINS is set.
  const H = { ...SECURITY_HEADERS, ...cors.headers(req) };

  // Method restriction: everything is GET, except a question may be POSTed
  // and a reader token is only ever POSTed
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...H, 'allow': 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return;
  }

  // Safe host header parsing to prevent uncaught exception DoS
  let url;
  try {
    const host = req.headers.host || '127.0.0.1';
    url = new URL(req.url, `http://${host}`);
  } catch {
    res.writeHead(400, { ...H, 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }

  // Charged before the credential check, so a flood of unauthenticated requests
  // is refused as cheaply as possible. /api/health is never counted. The
  // bundle is counted too: it is the largest thing this server sends, and a
  // downloader needs a few dozen requests, not a few hundred a minute.
  const rate = limits.check(url.pathname, req);
  if (rate && rate.code === 429) {
    const { headers: rh, ...body } = rate;
    res.writeHead(429, { ...H, ...rh, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
    return;
  }
  if (rate && rate.headers) Object.assign(H, rate.headers);


  // /api/health stays open so host health checks do not require credentials,
  // and so does /api/token, which is how a reader gets a credential at all.
  // In readers mode only the routes that spend money are gated -- search and
  // the page itself are open, cheap, and under the limiter above.
  const gated = url.pathname !== '/api/health' && url.pathname !== '/api/token'
    && (!identify.readers || url.pathname.startsWith('/api/ask') || url.pathname === '/api/me');
  if (gated) {
    const ident = await identify(req).catch(() => null);
    if (!ident) {
      res.writeHead(401, {
        ...H,
        // Basic makes a browser show its password box; Bearer must not, or the
        // owner gets a dialog that cannot possibly satisfy it.
        'www-authenticate': identify.challenge(req),
        'content-type': 'text/plain; charset=utf-8',
      });
      res.end('credentials required');
      return;
    }
    req.identity = ident;
  }

  const handler = routes[url.pathname];
  if (handler) {
    let body;
    try {
      body = await handler(url, req);
    } catch (err) {
      console.error(`Error handling ${url.pathname}:`, err);
      body = { error: IS_PROD ? 'Internal Server Error' : err.message, code: 500 };
    }
    // an oversize POST destroyed its own socket; there is nobody to answer
    if (res.destroyed || res.writableEnded) return;
    const { headers: extra, ...json } = body || {};
    const code = json && json.code ? json.code : 200;
    res.writeHead(code, {
      ...H,
      ...(extra || {}),
      // a body that was never read to its end must not be followed by another
      // request on the same connection
      ...(code === 413 ? { connection: 'close' } : {}),
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify(json));
    return;
  }

  // Static file serving with strict path traversal prevention
  let decodedRel;
  try {
    decodedRel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { ...H, 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  if (decodedRel.includes('\0')) {
    res.writeHead(400, { ...H, 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }
  const rel = decodedRel === '/' ? 'index.html' : decodedRel.replace(/^[\/\\]+/, '');
  const file = path.resolve(PUBLIC_DIR, '.' + path.sep + rel);

  // Assert resolved path is within PUBLIC_DIR
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    res.writeHead(403, { ...H, 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { ...H, 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      ...H,
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error(`Error handling ${req.url}:`, err);
    if (res.destroyed || res.writableEnded) return;
    try {
      if (!res.headersSent) res.writeHead(500, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: IS_PROD ? 'Internal Server Error' : String(err && err.message || err), code: 500 }));
    } catch { res.destroy(); }
  });
});
// A slow-loris client holding a socket open costs the one shared vCPU nothing,
// but it does hold a connection slot; nothing here needs more than a few
// seconds of headers or half a minute of body.
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.on('clientError', (err, socket) => {
  if (err.code === 'ECONNRESET' || !socket.writable) return;
  socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
});

function shutdown() {
  console.log('\nShutting down server gracefully...');
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

(async () => {
  for (const d of registry.discoverIndexDirs(ARTIFACTS)) {
    if (d.warning) console.warn(`index "${d.name}": ${d.warning}`);
    if (!d.manifest) continue;
    const meta = registry.normalizeManifest(d.manifest);
    if (!meta.roles.length) { console.log(`index "${d.name}": lab candidate, not loaded`); continue; }
    if (ONLY.length && !ONLY.includes(d.name)) { console.log(`index "${d.name}": not in INDEXES, skipped`); continue; }
    known.add(d.name);
    const entry = await tryLoadIndex(d.name, d.dir);
    if (!entry) continue;
    entry.meta = meta;
    // an index that only serves neighbours never needs its model in memory
    entry.encoder = meta.roles.includes('text') || meta.roles.includes('ask') ? await tryLoadEncoder(d.name, entry) : null;
    indexes[d.name] = entry;
  }
  if (!indexes[DEFAULT_INDEX]) {
    const first = registry.orderIndexes(indexes)[0] || null;
    if (first) {
      console.warn(`default index "${DEFAULT_INDEX}" is not loaded; using "${first}"`);
      DEFAULT_INDEX = first;
    }
  }
  if (fs.existsSync(TRANSLATIONS_PATH)) {
    try {
      tdb = core.openNodeAdapter(TRANSLATIONS_PATH);
      const langs = Object.entries(availableLangs()).filter(([, on]) => on).map(([l]) => l);
      console.log(`translations: ${langs.join(' ') || 'none'}`);
    } catch (err) {
      console.warn('translations unavailable:', err.message);
      tdb = null;
    }
  }
  // the prose corpora: each with its own store and ids, sharing this process's
  // ONNX encoders. A corpus that is not on disk is simply absent -- the rest of
  // the app does not depend on any of them, and a missing one silences its
  // tab rather than the server.
  for (const c of CORPORA) {
    if (c.ship === false) continue;      // built, deliberately not served
    try {
      const corpusDir = path.join(CORPORA_DIR, c.dir);
      if (!fs.existsSync(path.join(corpusDir, 'manifest.json')) || !fs.existsSync(c.db)) continue;
      const art = await core.loadCorpus(core.nodeReadFile(corpusDir));
      // keyed on the corpus, but tryLoadEncoder caches per model, so a corpus
      // whose model an index already loaded costs no second copy
      const encoder = await tryLoadEncoder(c.dir, { art });
      if (!encoder) continue;
      const store = new core.CorpusStore({ art, db: core.openNodeAdapter(c.db), encoder });
      corpora.set(c.key, { store, ask: null });
      const sum = store.summary();
      console.log(`${c.key}: ${sum.units} passages from ${sum.work_count} works, ${sum.citations} citations`);
    } catch (err) {
      console.warn(`${c.key} unavailable:`, err.message);
      corpora.delete(c.key);
    }
  }
  const state = [...new Set([...known, ...Object.keys(indexes)])].sort()
    .map(n => `${n}:${indexes[n] ? (indexes[n].encoder ? 'on+text' : 'on') : 'off'}`).join(' ');
  const mode = identify.readers ? 'readers' : (APP_PASSWORD ? 'password' : 'open');
  // `typeof`, because the answer cache is a private feature the public export strips
  const cacheNote = typeof askCache !== 'undefined' && askCache ? ', ask cache on' : '';
  server.listen(PORT, () => console.log(
    `http://localhost:${PORT}  (indexes ${state}, access: ${mode}${cacheNote})  `
    + `db: ${path.relative(ROOT, DB_PATH)}`));
})();
