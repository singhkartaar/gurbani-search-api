'use strict';
/**
 * Tokenizer and encoder tests.
 *
 * The load-bearing claims here are cross-runtime: JS tokenization must match
 * Python token-for-token, and JS embeddings must match Python's closely enough
 * that a query embedded on a phone retrieves the same documents as one embedded
 * on the build machine. Everything else in the semantic pipeline is downstream
 * of those two facts.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { WordPieceTokenizer, normalize, preTokenize } = require('../src/tokenizer.js');

const ROOT = process.env.ROOT_DIR || path.resolve(__dirname, '..', '..', '..');
const MODEL_DIR = process.env.MODEL_DIR
  || path.join(process.env.MODELS_DIR || path.join(ROOT, 'vendor', 'models'), 'bge-small-en-v1.5');
const ARTIFACTS = process.env.ARTIFACTS_DIR || path.join(ROOT, 'artifacts');
const TOKENIZER_JSON = path.join(MODEL_DIR, 'tokenizer.json');
const REF_TOKENS = path.join(ARTIFACTS, 'reference_tokens.json');
const REF_EMB = path.join(ARTIFACTS, 'reference_embeddings.json');

const HAS_MODEL = fs.existsSync(TOKENIZER_JSON);
const tok = HAS_MODEL
  ? new WordPieceTokenizer(JSON.parse(fs.readFileSync(TOKENIZER_JSON, 'utf8')))
  : null;

test('special token ids match the vocabulary', { skip: !HAS_MODEL }, () => {
  assert.strictEqual(tok.padId, 0);
  assert.strictEqual(tok.unkId, 100);
  assert.strictEqual(tok.clsId, 101);
  assert.strictEqual(tok.sepId, 102);
});

test('normalization lowercases and strips accents by default', () => {
  assert.strictEqual(normalize('Café NAÏVE'), 'cafe naive');
  assert.strictEqual(normalize('Ĥéllo'), 'hello');
});

test('an Indic model turns both off, because a matra is a combining mark', () => {
  const off = { lowercase: false, stripAccents: false };
  // what BERT's defaults would do to Gurmukhi: aunkar, dulainkar and the
  // halant are all Mn, so stripping accents eats them and leaves a word that
  // is not the word (ਸਤਿਗੁਰੁ -> ਸਤਿਗਰ, ਪ੍ਰਸਾਦਿ -> ਪਰਸਾਦਿ)
  assert.strictEqual(normalize('ਸਤਿਗੁਰੁ ਪ੍ਰਸਾਦਿ'), 'ਸਤਿਗਰ ਪਰਸਾਦਿ');
  assert.strictEqual(normalize('ਸਤਿਗੁਰੁ ਪ੍ਰਸਾਦਿ', off), 'ਸਤਿਗੁਰੁ ਪ੍ਰਸਾਦਿ');
  // and the case switch is independent of the accent one
  assert.strictEqual(normalize('Café', { lowercase: false }), 'Cafe');
  assert.strictEqual(normalize('Café', { stripAccents: false }), 'café'.normalize('NFC'));
});

test('a word that names something on Object.prototype is a word, not a function', () => {
  // needs no model: "constructor", "toString" and the rest must be looked up in
  // the vocabulary and nowhere else. They used to come back as Object's own
  // members, and the first English query to say "constructor" threw.
  const tiny = new WordPieceTokenizer({
    normalizer: { lowercase: true, strip_accents: true },
    model: { unk_token: '[UNK]', continuing_subword_prefix: '##',
      vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, construct: 4, '##or': 5, the: 6 } },
  });
  const ids = tiny.encode('the constructor', 16).ids.map(Number);
  assert.deepStrictEqual(ids, [2, 6, 4, 5, 3]);
  for (const w of ['valueof', 'hasownproperty', 'isprototypeof', 'tostring']) {
    const out = tiny.encode(w, 16).ids.map(Number);
    assert.deepStrictEqual(out, [2, 1, 3], `${w} must be [UNK], got ${out}`);
  }
});

test('pre-tokenization splits punctuation into standalone tokens', { skip: !HAS_MODEL }, () => {
  assert.deepStrictEqual(preTokenize("the lord's name!"), ['the', 'lord', "'", 's', 'name', '!']);
  assert.deepStrictEqual(preTokenize('a  b\tc'), ['a', 'b', 'c']);
});

test('encode wraps in [CLS] ... [SEP]', { skip: !HAS_MODEL }, () => {
  const { ids, attentionMask } = tok.encode('peace');
  assert.strictEqual(ids[0], tok.clsId);
  assert.strictEqual(ids[ids.length - 1], tok.sepId);
  assert.strictEqual(attentionMask.length, ids.length);
  assert.ok(attentionMask.every(m => m === 1));
});

test('encode respects maxLength including the [SEP]', { skip: !HAS_MODEL }, () => {
  const long = 'word '.repeat(500);
  const { ids } = tok.encode(long, 32);
  assert.ok(ids.length <= 32, `got ${ids.length}`);
  assert.strictEqual(ids[ids.length - 1], tok.sepId, 'must still be terminated');
});

test('an unknown word falls back to [UNK] rather than throwing', { skip: !HAS_MODEL }, () => {
  const { ids } = tok.encode('\u0a38\u0a24\u0a3f');   // Gurmukhi, not in an English vocab
  assert.ok(ids.length >= 2);
  assert.strictEqual(ids[0], tok.clsId);
});

test('a word longer than 100 chars becomes a single [UNK]', { skip: !HAS_MODEL }, () => {
  assert.deepStrictEqual(tok.wordPiece('a'.repeat(101)), [tok.unkId]);
});

test('encodeBatch pads to the longest member and masks the padding', { skip: !HAS_MODEL }, () => {
  const batch = tok.encodeBatch(['hi', 'a much longer sentence about the divine name']);
  assert.strictEqual(batch[0].ids.length, batch[1].ids.length);
  const padCount = batch[0].ids.filter(i => i === tok.padId).length;
  assert.ok(padCount > 0);
  assert.strictEqual(batch[0].attentionMask.filter(m => m === 0).length, padCount,
    'every pad position must be masked out');
});

test('JS tokenization matches Python token-for-token over the corpus',
  { skip: !HAS_MODEL || !fs.existsSync(REF_TOKENS) }, () => {
    const ref = JSON.parse(fs.readFileSync(REF_TOKENS, 'utf8'));
    const bad = [];
    for (const r of ref) {
      const got = tok.encode(r.text, 160).ids;
      if (got.length !== r.ids.length || got.some((v, i) => v !== r.ids[i])) {
        if (bad.length < 5) bad.push({ text: r.text.slice(0, 60), want: r.ids, got });
      }
    }
    assert.deepStrictEqual(bad, [], `${bad.length} of ${ref.length} tokenizations diverged`);
    assert.ok(ref.length > 10000, 'reference should cover the corpus, not a handful of strings');
  });

test('JS embeddings match the Python reference closely enough to retrieve the same documents',
  { skip: !HAS_MODEL || !fs.existsSync(REF_EMB) }, async () => {
    const { createNodeEncoder } = require('../src/factory-node.js');
    const ref = JSON.parse(fs.readFileSync(REF_EMB, 'utf8'));
    assert.strictEqual(ref.batch_size, 1,
      'reference must be encoded singly, matching how queries are encoded at runtime');
    const enc = await createNodeEncoder(MODEL_DIR);
    const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 1) d += a[i] * b[i]; return d; };

    // onnxruntime-node and onnxruntime-python produce slightly different results
    // for the same quantized graph -- different runtime versions optimize the
    // int8 kernels differently. Measured worst case is ~0.9971, so 0.99 is the
    // honest bound. What actually matters is asserted in the next test.
    let worst = 1;
    for (const q of ref.queries) {
      worst = Math.min(worst, cos(await enc.encodeQuery(q.text), Float32Array.from(q.vec)));
    }
    for (const d of ref.docs) {
      worst = Math.min(worst, cos((await enc.encode([d.text]))[0], Float32Array.from(d.vec)));
    }
    console.log(`  worst JS-vs-Python cosine: ${worst.toFixed(6)}`);
    assert.ok(worst > 0.99, `cross-runtime cosine dropped to ${worst.toFixed(6)}`);
  });

/**
 * What cross-runtime drift (~0.3% of a unit vector) does and does not change.
 * A cosine shifts by at most a few thousandths, so: the top-10 SET can differ
 * only at its boundary (8+ of 10 shared), and the top-1 can differ only when
 * the best two scores are within 0.01 of each other -- in which case the other
 * runtime's winner must still be one of this runtime's top three.
 */
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

test('cross-runtime drift never changes WHICH documents are retrieved',
  { skip: !HAS_MODEL || !fs.existsSync(REF_EMB) }, async () => {
    // This is the guarantee that actually matters for the app: a query embedded
    // on a phone must find the same lines as one embedded on the build machine.
    // Ordering within the result set is NOT guaranteed across runtimes -- near
    // ties can transpose -- but membership is.
    const { createNodeEncoder } = require('../src/factory-node.js');
    const core = require('../../search-core/src/index-node.js');
    const ARTS = ARTIFACTS;
    if (!fs.existsSync(path.join(ARTS, 'manifest.json'))) return;
    const ref = JSON.parse(fs.readFileSync(REF_EMB, 'utf8'));
    const enc = await createNodeEncoder(MODEL_DIR);
    const art = await core.loadArtifacts(core.nodeReadFile(ARTS));

    for (const q of ref.queries) {
      const js = core.searchText(art, core.projectQuery(art.pca, await enc.encodeQuery(q.text)), 'lines', 10);
      const py = core.searchText(art, core.projectQuery(art.pca, Float32Array.from(q.vec)), 'lines', 10);
      assertSameRetrieval(q.text, js, py);
    }
  });

test('the query prefix is applied to queries and never to documents',
  { skip: !HAS_MODEL || !fs.existsSync(REF_EMB) }, async () => {
    const { createNodeEncoder } = require('../src/factory-node.js');
    const { QUERY_PREFIX } = require('../src/index.js');
    const ref = JSON.parse(fs.readFileSync(REF_EMB, 'utf8'));
    assert.strictEqual(QUERY_PREFIX, ref.query_prefix, 'prefix must match the indexing run');
    const enc = await createNodeEncoder(MODEL_DIR);
    const withPrefix = await enc.encodeQuery('peace of mind');
    const asDoc = (await enc.encode(['peace of mind']))[0];
    let d = 0;
    for (let i = 0; i < withPrefix.length; i += 1) d += withPrefix[i] * asDoc[i];
    assert.ok(d < 0.999, 'prefixed query and bare document must not be identical vectors');
  });

test('embedding is deterministic across repeated calls', { skip: !HAS_MODEL }, async () => {
  const { createNodeEncoder } = require('../src/factory-node.js');
  const enc = await createNodeEncoder(MODEL_DIR);
  const a = await enc.encodeQuery('the fear of death');
  const b = await enc.encodeQuery('the fear of death');
  assert.deepStrictEqual(Array.from(a), Array.from(b));
});

test('batching shifts vectors slightly -- dynamic int8 quantization, not a mask bug',
  { skip: !HAS_MODEL }, async () => {
    // The quantized model derives activation scales from the tensor it is given,
    // so batch composition perturbs the result by ~0.3%. Verified that this is
    // NOT a padding/attention-mask fault: a same-width batch (no extra padding)
    // shifts the vector just as much as a padded one. The corpus was embedded in
    // batches of 64 and queries are embedded alone, so a small systematic offset
    // exists by construction -- far below the margin separating relevant from
    // irrelevant results.
    const { createNodeEncoder } = require('../src/factory-node.js');
    const enc = await createNodeEncoder(MODEL_DIR);
    const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 1) d += a[i] * b[i]; return d; };
    const alone = (await enc.encode(['peace']))[0];
    const sameWidth = (await enc.encode(['peace', 'truth']))[0];
    const padded = (await enc.encode(['peace',
      'a considerably longer sentence that will force the batch width much wider']))[0];

    assert.ok(cos(alone, sameWidth) < 0.99999,
      'same-width batching should also perturb -- if not, this note is stale');
    assert.ok(cos(alone, sameWidth) > 0.99, 'perturbation must stay small');
    assert.ok(cos(alone, padded) > 0.99, 'padding must not compound the perturbation');
  });

test('an identical batch always reproduces an identical vector', { skip: !HAS_MODEL }, async () => {
  // Determinism is guaranteed for a fixed batch composition, which is what the
  // runtime always has: queries are embedded one at a time.
  const { createNodeEncoder } = require('../src/factory-node.js');
  const enc = await createNodeEncoder(MODEL_DIR);
  const a = (await enc.encode(['peace', 'truth']))[0];
  const b = (await enc.encode(['peace', 'truth']))[0];
  assert.deepStrictEqual(Array.from(a), Array.from(b));
});

test('onnxruntime telemetry is disabled before the runtime loads', { skip: !HAS_MODEL }, async () => {
  // onnxruntime-node bundles a telemetry uploader. The app promises no outside
  // calls, so createNodeEncoder must set ORT_DISABLE_TELEMETRY before requiring
  // the native module -- unless the operator already chose a value.
  const { createNodeEncoder } = require('../src/factory-node.js');
  const before = process.env.ORT_DISABLE_TELEMETRY;
  await createNodeEncoder(MODEL_DIR);
  assert.strictEqual(process.env.ORT_DISABLE_TELEMETRY, before === undefined ? '1' : before);
});
