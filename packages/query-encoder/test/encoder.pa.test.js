'use strict';
/**
 * The Gurmukhi query encoders: multilingual-e5-small (index "pa") and its
 * Gurbani fine-tune (index "pa-ft"), both with a SentencePiece Unigram
 * tokenizer. Same load-bearing claims as encoder.test.js for the English
 * model -- JS tokenization must match Python token-for-token, and JS
 * embeddings must retrieve the same documents as the Python build -- checked
 * for every Gurmukhi index present, against the model its manifest names.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { UnigramTokenizer, normalize, preTokenize } = require('../src/unigram.js');

const ROOT = process.env.ROOT_DIR || path.resolve(__dirname, '..', '..', '..');
const ARTIFACTS_ROOT = process.env.ARTIFACTS_DIR || path.join(ROOT, 'artifacts');
const CORPUS = process.env.CORPUS_DB || path.join(ROOT, 'data', 'corpus.sqlite');

test('normalization is NFKC with whitespace folded', () => {
  assert.strictEqual(normalize('a b\tc'), 'a b c');
  assert.strictEqual(normalize('ﬁ'), 'fi');
});

test('Metaspace pre-tokenization prefixes and splits on the meta symbol', () => {
  assert.deepStrictEqual(preTokenize('ਮਨ ਦੀ ਸ਼ਾਂਤੀ'), ['▁ਮਨ', '▁ਦੀ', '▁ਸ਼ਾਂਤੀ']);
  assert.deepStrictEqual(preTokenize('query: peace'), ['▁query:', '▁peace']);
});

test('odd whitespace is what the model\'s own normalizer makes of it', () => {
  // Each of these was checked against the Python `tokenizers` package with
  // multilingual-e5-small's tokenizer.json (2026-09-18). The corpus holds none
  // of them, so the token-for-token parity test below never sees them; a reader
  // typing with a ZWJ, or pasting two spaces, does.
  assert.strictEqual(normalize('hello  world'), 'hello world');
  assert.strictEqual(normalize('a\t\tb'), 'a b');
  assert.strictEqual(normalize('a\x0cb'), 'a b');                  // form feed is a space, not a control
  assert.strictEqual(normalize('ਸ੍‍ਰੀ'), 'ਸ੍ ਰੀ');              // ZWJ
  assert.strictEqual(normalize('ਸ‌ਤਿ'), 'ਸ ਤਿ');               // ZWNJ
  assert.strictEqual(normalize('a​b'), 'a b');                // ZWSP
  assert.strictEqual(normalize('x﻿y'), 'x y');                // BOM
  assert.strictEqual(normalize('a‎b'), 'a b');                // LRM
  assert.strictEqual(normalize('a�b'), 'a b');                // replacement character
  assert.strictEqual(normalize('a\x01b'), 'ab');                   // a real control is removed
  // and Metaspace does not double a leading meta symbol, or invent one for nothing
  assert.deepStrictEqual(preTokenize(''), []);
  assert.deepStrictEqual(preTokenize(normalize(' hello')), ['▁hello']);
  assert.deepStrictEqual(preTokenize(normalize('   ')), ['▁']);
  assert.deepStrictEqual(preTokenize(normalize('▁already')), ['▁already']);
  assert.deepStrictEqual(preTokenize(normalize('query:  ਮੌਤ')), ['▁query:', '▁ਮੌਤ']);
});

/** See encoder.test.js: what ~0.3% cross-runtime drift can and cannot change. */
function assertSameRetrieval(label, js, py) {
  const a = js.map(h => h.id), b = py.map(h => h.id);
  const overlap = a.filter(id => b.includes(id)).length;
  assert.ok(overlap >= 8, `query "${label}": only ${overlap}/10 lines shared across runtimes`);
  if (a[0] !== b[0]) {
    const gap = py[0].score - py[1].score;
    assert.ok(gap < 0.01, `query "${label}": top-1 differs with a clear margin (${gap.toFixed(4)})`);
    assert.ok(b.slice(0, 3).includes(a[0]), `query "${label}": JS top-1 not among the Python top three`);
  }
}

// every index built with a SentencePiece model that carries parity references
const UNIGRAM_INDEXES = fs.existsSync(ARTIFACTS_ROOT)
  ? fs.readdirSync(ARTIFACTS_ROOT).filter(d => {
      const mp = path.join(ARTIFACTS_ROOT, d, 'manifest.json');
      if (!fs.existsSync(mp)) return false;
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      return m.tokenizer === 'unigram' && Array.isArray(m.roles) && m.roles.length > 0
        && fs.existsSync(path.join(ARTIFACTS_ROOT, d, 'reference_tokens.json'));
    }).sort()
  : [];
for (const INDEX of UNIGRAM_INDEXES.length ? UNIGRAM_INDEXES : ['pa', 'pa-ft']) {
  const ARTIFACTS = path.join(ARTIFACTS_ROOT, INDEX);
  const MANIFEST_PATH = path.join(ARTIFACTS, 'manifest.json');
  const HAS_INDEX = fs.existsSync(MANIFEST_PATH);
  const manifest = HAS_INDEX ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) : null;
  // MODELS_DIR, like ARTIFACTS_DIR above: a deployment that downloaded its
  // models rather than building them keeps them somewhere else entirely, and the
  // parity tests are exactly the ones such a deployment wants to run.
  const MODELS_ROOT = process.env.MODELS_DIR || path.join(ROOT, 'vendor', 'models');
  const MODEL_DIR = path.join(MODELS_ROOT, manifest ? manifest.model_dir : 'multilingual-e5-small');
  const TOKENIZER_JSON = path.join(MODEL_DIR, 'tokenizer.json');
  const HAS_MODEL = fs.existsSync(TOKENIZER_JSON);
  const REF_TOKENS = path.join(ARTIFACTS, 'reference_tokens.json');
  const REF_EMB = path.join(ARTIFACTS, 'reference_embeddings.json');
  const tok = HAS_MODEL ? new UnigramTokenizer(JSON.parse(fs.readFileSync(TOKENIZER_JSON, 'utf8'))) : null;
  const opts = () => require('../src/index.js').encoderOptions(manifest);
  const skip = !HAS_MODEL || !HAS_INDEX;
  const T = name => `[${INDEX}] ${name}`;

  test(T('special token ids match XLM-R'), { skip: !HAS_MODEL }, () => {
    assert.strictEqual(tok.bosId, 0);
    assert.strictEqual(tok.padId, 1);
    assert.strictEqual(tok.eosId, 2);
    assert.strictEqual(tok.unkId, 3);
  });

  test(T('the vocabulary and the unk score it implies are consistent'), { skip: !HAS_MODEL }, () => {
    // unkScore = minScore - 10 is computed over whatever vocabulary is
    // present, so a trimmed model that dropped the lowest-scored pieces would
    // silently re-segment every out-of-vocabulary word. Pin the relationship
    // here, in the runtime that has it.
    const raw = JSON.parse(fs.readFileSync(TOKENIZER_JSON, 'utf8'));
    assert.strictEqual(tok.pieces.size, raw.model.vocab.length, 'every piece is reachable by its id');
    let min = Infinity;
    for (const [, score] of raw.model.vocab) if (score < min) min = score;
    assert.strictEqual(tok.unkScore, min - 10.0);

    const reportPath = path.join(MODEL_DIR, 'trim_report.json');
    if (fs.existsSync(reportPath)) {
      // A trimmed model (pipeline/python/16_trim_vocab.py). The table is sliced
      // to these rows, so a tokenizer that disagrees emits ids past the end of
      // the embedding matrix and ORT throws on the first query.
      const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      assert.strictEqual(raw.model.vocab.length, r.kept, 'tokenizer.json is not the one the trim wrote');
      assert.strictEqual(min, r.min_score, 'the trim moved the minimum score');
      assert.strictEqual(r.verified.divergences, 0, 'the trim changed how indexed text tokenizes');
    }
  });

  test(T('encode wraps in <s> ... </s> and pads with <pad>'), { skip: !HAS_MODEL }, () => {
    const [a, b] = tok.encodeBatch(['ਮਨ', 'ਮਨ ਦੀ ਸ਼ਾਂਤੀ ਕਿਵੇਂ ਮਿਲੇ']);
    assert.strictEqual(a.ids[0], 0);
    assert.strictEqual(a.ids[a.attentionMask.lastIndexOf(1)], 2);
    assert.ok(a.ids.length === b.ids.length, 'padded to the same width');
    assert.ok(a.ids.slice(a.attentionMask.lastIndexOf(1) + 1).every(id => id === 1), 'padding is <pad>');
    assert.ok(a.attentionMask.slice(a.attentionMask.lastIndexOf(1) + 1).every(m => m === 0));
  });

  test(T('characters outside the vocabulary become a single fused <unk>'), { skip: !HAS_MODEL }, () => {
    // XLM-R's 250k vocabulary covers emoji and even private-use characters, so
    // find two characters it really does not have rather than guessing.
    const unknown = [];
    for (let cp = 0x10000; cp < 0x10400 && unknown.length < 2; cp += 1) {
      const ch = String.fromCodePoint(cp);
      if (!tok.pieces.has(ch) && !tok.pieces.has('▁' + ch)) unknown.push(ch);
    }
    assert.strictEqual(unknown.length, 2, 'expected to find characters outside the vocabulary');
    const ids = tok.tokenize(unknown.join(''));
    assert.deepStrictEqual(ids.filter(id => id === tok.unkId), [tok.unkId], 'a run of unknowns fuses into one <unk>');
  });

  test(T('JS Unigram tokenization matches Python token-for-token over the corpus'),
    { skip: skip || !fs.existsSync(REF_TOKENS) }, () => {
      const ref = JSON.parse(fs.readFileSync(REF_TOKENS, 'utf8'));
      assert.ok(ref.length >= 1000, 'reference should cover thousands of lines');
      const bad = [];
      for (const r of ref) {
        const got = tok.encode(r.text, manifest.max_len).ids;
        if (JSON.stringify(got) !== JSON.stringify(r.ids)) bad.push(r.text);
      }
      assert.deepStrictEqual(bad.slice(0, 5), [], `${bad.length}/${ref.length} texts tokenize differently`);
    });

  test(T('JS e5 embeddings match the Python reference closely enough to retrieve the same documents'),
    { skip: skip || !fs.existsSync(REF_EMB) }, async () => {
      const { createNodeEncoder } = require('../src/factory-node.js');
      const ref = JSON.parse(fs.readFileSync(REF_EMB, 'utf8'));
      assert.strictEqual(ref.batch_size, 1);
      assert.strictEqual(ref.pooling, 'mean');
      const enc = await createNodeEncoder(MODEL_DIR, opts());
      const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 1) d += a[i] * b[i]; return d; };
      let worst = 1;
      for (const q of ref.queries) worst = Math.min(worst, cos(await enc.encodeQuery(q.text), Float32Array.from(q.vec)));
      for (const d of ref.docs) worst = Math.min(worst, cos((await enc.encode([d.text]))[0], Float32Array.from(d.vec)));
      console.log(`  [${INDEX}] worst JS-vs-Python cosine: ${worst.toFixed(6)}`);
      // int8 activation drift between runtimes grows with the text: a Gurbani
      // line stays above 0.99, a 256-token Darpan paragraph lands ~0.985. What
      // matters -- that the drift never changes WHICH lines are retrieved -- is
      // the next test, and it holds for every index.
      const floor = (manifest.max_len || 160) > 160 ? 0.98 : 0.99;
      assert.ok(worst > floor, `cross-runtime cosine dropped to ${worst.toFixed(6)} (floor ${floor})`);
    });

  test(T('cross-runtime drift never changes WHICH lines a Gurmukhi query retrieves'),
    { skip: skip || !fs.existsSync(REF_EMB) }, async () => {
      const { createNodeEncoder } = require('../src/factory-node.js');
      const core = require('../../search-core/src/index-node.js');
      const ref = JSON.parse(fs.readFileSync(REF_EMB, 'utf8'));
      const enc = await createNodeEncoder(MODEL_DIR, opts());
      const art = await core.loadArtifacts(core.nodeReadFile(ARTIFACTS));
      for (const q of ref.queries) {
        const js = core.searchText(art, core.projectQuery(art.pca, await enc.encodeQuery(q.text)), 'lines', 10);
        const py = core.searchText(art, core.projectQuery(art.pca, Float32Array.from(q.vec)), 'lines', 10);
        assertSameRetrieval(q.text, js, py);
      }
    });

  test(T('the e5 prefixes are applied: "query: " on queries, "passage: " on documents'), { skip }, async () => {
    const { createNodeEncoder } = require('../src/factory-node.js');
    const enc = await createNodeEncoder(MODEL_DIR, opts());
    assert.strictEqual(enc.queryPrefix, 'query: ');
    assert.strictEqual(enc.docPrefix, 'passage: ');
    const q = await enc.encodeQuery('ਮੌਤ ਦਾ ਡਰ');
    const d = (await enc.encode(['ਮੌਤ ਦਾ ਡਰ']))[0];
    let dot = 0;
    for (let i = 0; i < q.length; i += 1) dot += q[i] * d[i];
    assert.ok(dot < 0.999, 'query and passage encodings of the same text must differ');
  });

  test(T('Gurmukhi embedding is deterministic across repeated calls'), { skip }, async () => {
    const { createNodeEncoder } = require('../src/factory-node.js');
    const enc = await createNodeEncoder(MODEL_DIR, opts());
    const a = await enc.encodeQuery('ਮਨ ਦੀ ਸ਼ਾਂਤੀ');
    const b = await enc.encodeQuery('ਮਨ ਦੀ ਸ਼ਾਂਤੀ');
    assert.deepStrictEqual(Array.from(a), Array.from(b));
  });

  // Sanity, not a gate: the query ਕੋਈ ਨ ਜਾਣੈ ਤੇਰਾ ਕੇਤਾ ਕੇਵਡੁ ਚੀਰਾ should retrieve
  // that verse (angs 9 and 348) at the top -- in an index over the scripture's
  // own text. An index over a commentary holds the verse's ARTH, a paraphrase,
  // and is not expected to put the verbatim verse first.
  const scripture = manifest && (manifest.text_source === 'gurmukhi_uni');
  test(T('a Gurmukhi query finds lines about the same thing'), { skip: skip || !scripture }, async () => {
    const { createNodeEncoder } = require('../src/factory-node.js');
    const core = require('../../search-core/src/index-node.js');
    if (!fs.existsSync(CORPUS)) return;
    const enc = await createNodeEncoder(MODEL_DIR, opts());
    const art = await core.loadArtifacts(core.nodeReadFile(ARTIFACTS));
    const hits = core.searchText(art, core.projectQuery(art.pca, await enc.encodeQuery('ਕੋਈ ਨ ਜਾਣੈ ਤੇਰਾ ਕੇਤਾ ਕੇਵਡੁ ਚੀਰਾ')), 'lines', 3);
    const db = core.openNodeAdapter(CORPUS);
    const top = db.all('SELECT gurmukhi_uni FROM lines WHERE line_id=?', [hits[0].id])[0].gurmukhi_uni;
    db.close();
    assert.match(top, /ਜਾਣੈ ਤੇਰਾ ਕੇਤਾ ਕੇਵਡੁ ਚੀਰਾ/);
  });
}
