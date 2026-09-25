'use strict';
/**
 * Integration tests against the real shipped artifacts.
 *
 * Covers the three properties the design actually rests on:
 *   - isolation:    lexical search works with the vector artifacts absent
 *   - determinism:  identical results across calls and cold reloads
 *   - parity:       the JS int8 search agrees with the Python float reference
 *
 * The indexes are discovered the way the server discovers them -- every
 * directory under artifacts/ with a manifest, the English one at the root,
 * lab candidates (roles []) excluded -- and the index-level checks run
 * against each that is present.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/index-node.js');

const ROOT = process.env.ROOT_DIR || path.resolve(__dirname, '..', '..', '..');
const ARTIFACTS = process.env.ARTIFACTS_DIR || path.join(ROOT, 'artifacts');
const CORPUS = process.env.CORPUS_DB || path.join(ROOT, 'data', 'corpus.sqlite');

// The root counts like any other directory, lab filter included: it held the
//  index until en-ss superseded it, and a demoted index must drop out of
// these checks the same way a demoted subdirectory does.
const INDEXES = {};
const shipping = dir => {
  const mp = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mp)) return null;
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (Array.isArray(m.roles) && m.roles.length === 0) return null;
  // a documents index holds passages of prose, not lines of the Granth: it has
  // no lines.i8 and none of what follows is about it
  if (m.kind === 'documents') return null;
  return m;
};
if (fs.existsSync(ARTIFACTS)) {
  const rootManifest = shipping(ARTIFACTS);
  if (rootManifest) INDEXES[rootManifest.index || 'en'] = ARTIFACTS;
  for (const d of fs.readdirSync(ARTIFACTS).sort()) {
    const m = shipping(path.join(ARTIFACTS, d));
    if (m) INDEXES[m.index || d] = path.join(ARTIFACTS, d);
  }
}
// Which shipping index reads English. It was the root `en`; it is en-ss now,
// and naming it by language rather than by id keeps these tests honest through
// the next swap too.
const englishIndex = Object.entries(INDEXES).find(([, dir]) => {
  const m = shipping(dir);
  return m && m.text_lang === 'en';
});
const HAS_ART = Boolean(englishIndex);
const HAS_DB = fs.existsSync(CORPUS);

for (const [name, dir] of Object.entries(INDEXES)) {
  const has = fs.existsSync(path.join(dir, 'manifest.json'));
  let art = null;
  let manifest = null;

  test(`[${name}] artifacts load`, { skip: !has }, async () => {
    art = await core.loadArtifacts(core.nodeReadFile(dir));
    manifest = art.manifest;
    assert.strictEqual(art.lines.n, manifest.lines);
    assert.strictEqual(art.lines.dim, manifest.index_dim);
    assert.strictEqual(art.shabads.n, manifest.shabads);
    assert.strictEqual(art.rahao.n, manifest.rahao_shabads);
  });

  test(`[${name}] manifest records the model and settings needed to reproduce the index`, { skip: !has }, () => {
    // the language of the embedded text decides the model family
    if (manifest.text_lang === 'en') {
      assert.match(manifest.model, /bge-small-en-v1\.5/);
      assert.strictEqual(manifest.pooling, 'cls');
      assert.strictEqual(manifest.tokenizer, 'wordpiece');
      assert.ok(manifest.query_prefix.length > 0, 'BGE needs its query prefix recorded');
    } else {
      assert.match(manifest.model, /multilingual-e5-small/);
      assert.strictEqual(manifest.pooling, 'mean');
      assert.strictEqual(manifest.tokenizer, 'unigram');
      assert.strictEqual(manifest.query_prefix, 'query: ');
      assert.strictEqual(manifest.doc_prefix, 'passage: ');
    }
    // the source is named (ssk,bdb,ms / gurmukhi_uni / a translator id), never the old category
    assert.notStrictEqual(manifest.text_source, 'translations');
    assert.ok(typeof manifest.label === 'string' && Array.isArray(manifest.roles) && manifest.roles.length > 0,
      'a shipping manifest presents itself');
    assert.strictEqual(manifest.embed_dim, 384);
    assert.strictEqual(manifest.index_dim, 256);
    assert.strictEqual(manifest.weighting_scheme, 'per_stanza');
    assert.match(manifest.rahao_weight, /stanzas/);
    assert.ok(manifest.quantization.min_cosine > 0.99,
      `quantization lost too much: ${manifest.quantization.min_cosine}`);
  });

  test(`[${name}] headings and invocations are masked out of semantic results`, { skip: !has || !HAS_DB }, () => {
    const db = core.openNodeAdapter(CORPUS);
    const heading = db.all(`SELECT line_id FROM lines WHERE kind='heading' LIMIT 1`, [])[0].line_id;
    assert.strictEqual(art.lines.mask[heading], 0, 'heading must be masked');
    // and must never surface as a result for any query
    const line = db.all(`SELECT line_id FROM lines WHERE kind='line' LIMIT 1`, [])[0].line_id;
    const ids = core.similarLines(art, line, 50).map(h => h.id);
    const kinds = db.all(
      `SELECT DISTINCT kind FROM lines WHERE line_id IN (${ids.map(() => '?').join(',')})`, ids)
      .map(r => r.kind);
    assert.deepStrictEqual(kinds.filter(k => k === 'heading' || k === 'invocation'), []);
    db.close();
  });

  test(`[${name}] the reference rahao line retrieves its near-identical twin`, { skip: !has || !HAS_DB }, () => {
    const db = core.openNodeAdapter(CORPUS);
    const q = db.all(`SELECT line_id FROM lines WHERE gurmukhi_uni LIKE 'ਕੋਇ ਨ ਜਾਣੈ ਤੇਰਾ ਕੇਤਾ%'`, [])[0];
    const hits = core.similarLines(art, q.line_id, 3);
    const top = db.all('SELECT gurmukhi_uni, ang FROM lines WHERE line_id=?', [hits[0].id])[0];
    // ang 349 carries the same verse with ਕੋਈ instead of ਕੋਇ. The English
    // translations of the two are identical, so the en index scores them ~0.93;
    // the Gurmukhi model sees the spelling difference and lands near 0.8.
    assert.strictEqual(top.ang, 349);
    const floor = name === 'en' ? 0.9 : 0.7;
    assert.ok(hits[0].score > floor, `expected a near-duplicate, got ${hits[0].score}`);
    db.close();
  });

  test(`[${name}] rahao search groups shabads by shared theme`, { skip: !has || !HAS_DB }, () => {
    const hits = core.similarByRahao(art, 41, 5);
    assert.ok(hits.length >= 4);
    // The top hit is the parallel shabad at ang 348 (same rahao with a one-letter
    // spelling difference); the rest are thematically related.
    const db = core.openNodeAdapter(CORPUS);
    const angs = hits.map(h => db.all('SELECT ang_start FROM shabads WHERE shabad_id=?', [h.id])[0].ang_start);
    assert.strictEqual(angs[0], 348);
    assert.ok(hits.every((h, i) => i === 0 || h.score <= hits[0].score), 'scores must be descending');
    db.close();
  });

  test(`[${name}] similarByRahao returns nothing for a shabad without a rahao line`, { skip: !has || !HAS_DB }, () => {
    const db = core.openNodeAdapter(CORPUS);
    const noRahao = db.all('SELECT shabad_id FROM shabads WHERE has_rahao=0 LIMIT 1', [])[0].shabad_id;
    assert.deepStrictEqual(core.similarByRahao(art, noRahao, 5), []);
    // ...but it still has a whole-shabad vector
    assert.ok(core.similarShabads(art, noRahao, 5).length > 0);
    db.close();
  });

  // reference_topk.json is a parity fixture the builder writes beside the index,
  // not a file the server reads, so a deployment that fetched its indexes will
  // not have it. Skip rather than fail: absent means "cannot check", not "wrong".
  const hasRef = has && fs.existsSync(path.join(dir, 'reference_topk.json'));
  test(`[${name}] JS int8 search matches the Python float32 reference`, { skip: !hasRef }, () => {
    const ref = JSON.parse(fs.readFileSync(path.join(dir, 'reference_topk.json'), 'utf8'));
    const checks = [];
    for (const [lineId, expected] of Object.entries(ref.lines)) {
      const got = core.similarLines(art, Number(lineId), 10);
      checks.push({ kind: 'line', id: lineId, got: got.map(h => h.id), want: expected.map(e => e.row) });
    }
    for (const [sid, expected] of Object.entries(ref.shabads)) {
      const got = core.similarShabads(art, Number(sid), 10);
      checks.push({ kind: 'shabad', id: sid, got: got.map(h => h.id), want: expected.map(e => e.id) });
    }
    for (const [sid, expected] of Object.entries(ref.rahao)) {
      const got = core.similarByRahao(art, Number(sid), 10);
      checks.push({ kind: 'rahao', id: sid, got: got.map(h => h.id), want: expected.map(e => e.id) });
    }
    // Quantization can transpose adjacent near-ties, so require the top-1 to be
    // exact and the top-10 sets to overlap heavily rather than demanding an
    // identical ordering the int8 index cannot promise.
    const top1Bad = checks.filter(c => c.got[0] !== c.want[0]);
    assert.deepStrictEqual(top1Bad.map(c => `${c.kind}:${c.id}`), [], 'top-1 must match exactly');
    for (const c of checks) {
      const overlap = c.got.filter(id => c.want.includes(id)).length;
      assert.ok(overlap >= 8, `${c.kind}:${c.id} only ${overlap}/10 overlap with the float reference`);
    }
    assert.ok(checks.length >= 15, 'reference file should cover a spread of queries');
  });

  test(`[${name}] results are identical across repeated calls and a cold reload`, { skip: !has }, async () => {
    const a = JSON.stringify(core.similarLines(art, 4000, 20));
    const b = JSON.stringify(core.similarLines(art, 4000, 20));
    assert.strictEqual(a, b);
    const fresh = await core.loadArtifacts(core.nodeReadFile(dir));
    assert.strictEqual(JSON.stringify(core.similarLines(fresh, 4000, 20)), a,
      'a cold reload must reproduce byte-identical ordering');
    assert.strictEqual(JSON.stringify(core.similarShabads(fresh, 41, 20)),
      JSON.stringify(core.similarShabads(art, 41, 20)));
  });
}

test('an English and a Gurmukhi index disagree on some neighbours -- they are different signals',
  { skip: !INDEXES.pa || !HAS_ART }, async () => {
    const en = await core.loadArtifacts(core.nodeReadFile(englishIndex[1]));
    const pa = await core.loadArtifacts(core.nodeReadFile(INDEXES.pa));
    let same = 0;
    for (const id of [1000, 4000, 9000, 20000, 33000, 45000]) {
      const a = core.similarLines(en, id, 10).map(h => h.id).join(',');
      const b = core.similarLines(pa, id, 10).map(h => h.id).join(',');
      if (a === b) same += 1;
    }
    assert.ok(same < 6, 'identical top-10 for every probe would mean the wrong index was copied');
  });

test('ISOLATION: lexical search works with the vector artifacts absent', { skip: !HAS_DB }, async () => {
  // The single most important structural guarantee: a user with no semantic
  // index (or a build where embedding failed) still gets a working app.
  // The root is no longer guaranteed to be an index, so any index will do --
  // and with none built at all, the lexical half below is still the point.
  if (englishIndex) {
    const bare = await core.loadArtifacts(core.nodeReadFile(englishIndex[1]), { semantic: false });
    assert.strictEqual(bare.lines, null);
  }
  const db = core.openNodeAdapter(CORPUS);
  const hits = core.firstLetterAnywhere(db, 'knjq', { limit: 10 });
  assert.ok(hits.length > 0, 'first-letter search must not depend on vectors');
  assert.strictEqual(core.firstLetterAnywhereCount(db, 'knjq'), 20);
  db.close();
});

test('ISOLATION: no vector file is opened during a lexical query', { skip: !HAS_DB }, () => {
  const db = core.openNodeAdapter(CORPUS);
  const realOpen = fs.readFileSync;
  const opened = [];
  fs.readFileSync = (p, ...rest) => { opened.push(String(p)); return realOpen(p, ...rest); };
  try {
    core.firstLetterAnywhere(db, 'hhg', { limit: 10 });
  } finally {
    fs.readFileSync = realOpen;
  }
  assert.deepStrictEqual(opened.filter(p => /\.i8$|\.f32$|\.u8$/.test(p)), []);
  db.close();
});

test('LATENCY: lexical p95 under 50ms, semantic p95 under 100ms', { skip: !HAS_ART || !HAS_DB }, async () => {
  const art = await core.loadArtifacts(core.nodeReadFile(englishIndex[1]));
  const db = core.openNodeAdapter(CORPUS);
  const queries = db.all(
    `SELECT first_letters_ascii FROM lines WHERE LENGTH(first_letters_ascii)>=5 LIMIT 200`, [])
    .map(r => r.first_letters_ascii.slice(0, 4));
  const p95 = times => times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)];

  const lex = queries.map(q => { const t = process.hrtime.bigint();
    core.firstLetterAnywhere(db, q, { limit: 25 });
    return Number(process.hrtime.bigint() - t) / 1e6; });

  const ids = db.all(`SELECT line_id FROM lines WHERE kind='line' LIMIT 60`, []).map(r => r.line_id);
  const sem = ids.map(id => { const t = process.hrtime.bigint();
    core.similarLines(art, id, 10);
    return Number(process.hrtime.bigint() - t) / 1e6; });

  console.log(`  lexical p95 ${p95(lex).toFixed(1)}ms | semantic p95 ${p95(sem).toFixed(1)}ms`);
  assert.ok(p95(lex) < 50, `lexical p95 ${p95(lex).toFixed(1)}ms`);
  assert.ok(p95(sem) < 100, `semantic p95 ${p95(sem).toFixed(1)}ms`);
  db.close();
});

test('SIZE: shipped artifacts stay within budget', { skip: !HAS_ART }, () => {
  const ship = ['lines.i8', 'lines.scale.f32', 'lines.mask.u8', 'pca.components.f32',
    'pca.mean.f32', 'shabads.i8', 'shabads.scale.f32', 'shabads.ids.i32',
    'rahao.i8', 'rahao.scale.f32', 'rahao.ids.i32'];
  const sum = dir => ship.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
  const sizeOf = p => (fs.existsSync(p) ? fs.statSync(p).size : 0);
  // Measure the SLIM database that actually ships, not the working corpus --
  // corpus.sqlite carries the English translations the app never displays.
  const shipDb = path.join(ARTIFACTS, 'gurbani.sqlite');
  assert.ok(fs.existsSync(shipDb), 'run pipeline/node/src/05-build-shipping-db.js first');
  const corpusBytes = fs.statSync(shipDb).size;
  if (HAS_DB) assert.ok(corpusBytes < fs.statSync(CORPUS).size, 'the shipping db must be smaller than the working corpus');
  // every shipping index, wherever it lives: the root stopped being one when
  // en-ss superseded `en`, so nothing here may assume it is still counted
  const enVec = sum(englishIndex[1]);
  const paVec = Object.entries(INDEXES).filter(([n]) => n !== englishIndex[0])
    .reduce((a, [, dir]) => a + sum(dir), 0);
  const MODELS_ROOT = process.env.MODELS_DIR || path.join(ROOT, 'vendor', 'models');
  const enModel = sizeOf(path.join(MODELS_ROOT, 'bge-small-en-v1.5', 'model_quantized.onnx'));
  // only the fine-tuned Gurmukhi model ships; pa serves neighbours without a model
  const paManifest = path.join(INDEXES['pa-ft'] || path.join(ARTIFACTS, 'pa-ft'), 'manifest.json');
  const paModelDir = fs.existsSync(paManifest) ? JSON.parse(fs.readFileSync(paManifest, 'utf8')).model_dir : 'multilingual-e5-small';
  const paModel = sizeOf(path.join(MODELS_ROOT, paModelDir, 'model_quantized.onnx'));
  const total = enVec + paVec + corpusBytes + enModel + paModel;
  console.log(`  en ${(enVec / 1e6).toFixed(1)}MB + pa ${(paVec / 1e6).toFixed(1)}MB + db ${(corpusBytes / 1e6).toFixed(1)}MB`
    + ` + models ${((enModel + paModel) / 1e6).toFixed(1)}MB = ${(total / 1e6).toFixed(1)}MB`);
  // Per index: vectors < 20MB. The fixed part -- database and the two query
  // models -- stays under 120MB; each index adds its vectors and nothing else,
  // since indexes built with one model share it. The budget was 200MB until
  // the Gurmukhi model's 250k-token embedding table was cut to the ~35k pieces
  // this corpus emits (pipeline/python/16_trim_vocab.py, 118MB -> 35MB). It is
  // tightened here so that win cannot be given back without someone deciding to.
  const nOther = Object.keys(INDEXES).length - 1;
  assert.ok(enVec < 20e6, `the English index grew past 20MB: ${(enVec / 1e6).toFixed(1)}MB`);
  assert.ok(paVec < 20e6 * Math.max(nOther, 1),
    `${nOther} other indexes came to ${(paVec / 1e6).toFixed(1)}MB, past 20MB each`);
  assert.ok(corpusBytes + enModel + paModel < 120e6,
    `database + models came to ${((corpusBytes + enModel + paModel) / 1e6).toFixed(1)}MB, past 120MB`);
  assert.ok(total < 120e6 + 20e6 * Object.keys(INDEXES).length, `total shipped size ${(total / 1e6).toFixed(1)}MB exceeds budget`);
});
