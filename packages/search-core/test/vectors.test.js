'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { VectorIndex, loadIndex, roundScore } = require('../src/vectors.js');

/** Quantize float32 rows the same way the Python pipeline does. */
function makeIndex(rows, ids = null, mask = null) {
  const dim = rows[0].length;
  const n = rows.length;
  const codes = new Int8Array(n * dim);
  const scales = new Float32Array(n);
  rows.forEach((v, r) => {
    const peak = Math.max(1e-12, ...v.map(Math.abs));
    const scale = peak / 127;
    scales[r] = scale;
    for (let i = 0; i < dim; i += 1) {
      codes[r * dim + i] = Math.max(-127, Math.min(127, Math.round(v[i] / scale)));
    }
  });
  return new VectorIndex(codes, scales, dim,
    ids ? new Int32Array(ids) : null, mask ? new Uint8Array(mask) : null);
}

const unit = v => { const n = Math.hypot(...v); return v.map(x => x / n); };

test('rejects a codes buffer that does not match n*dim', () => {
  assert.throws(() => new VectorIndex(new Int8Array(5), new Float32Array(2), 4), /codes length/);
});

test('rejects a query of the wrong dimension', () => {
  const idx = makeIndex([[1, 0, 0, 0], [0, 1, 0, 0]]);
  assert.throws(() => idx.search(new Float32Array(3)), /query dim/);
});

test('finds the nearest vector', () => {
  const idx = makeIndex([unit([1, 0, 0, 0]), unit([0, 1, 0, 0]), unit([0.9, 0.1, 0, 0])]);
  const hits = idx.search(new Float32Array(unit([1, 0, 0, 0])), 2);
  assert.strictEqual(hits[0].id, 0);
  assert.strictEqual(hits[1].id, 2, 'the near-parallel vector ranks above the orthogonal one');
});

test('similarTo excludes the query item itself', () => {
  const idx = makeIndex([unit([1, 0, 0, 0]), unit([0.99, 0.14, 0, 0]), unit([0, 0, 1, 0])]);
  const hits = idx.similarTo(0, 3);
  assert.ok(hits.every(h => h.id !== 0), 'self must never be returned');
  assert.strictEqual(hits[0].id, 1);
});

test('ties break on ascending row index, deterministically', () => {
  // Three identical vectors -> identical scores -> order must be 0,1,2 always.
  const v = unit([1, 1, 0, 0]);
  const idx = makeIndex([v, v, v, unit([0, 0, 1, 0])]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const hits = idx.search(new Float32Array(v), 3);
    assert.deepStrictEqual(hits.map(h => h.id), [0, 1, 2]);
  }
});

test('repeated searches are byte-identical', () => {
  const rows = Array.from({ length: 50 }, (_, i) =>
    unit(Array.from({ length: 16 }, (_, j) => Math.sin(i * 7 + j * 3))));
  const idx = makeIndex(rows);
  const q = new Float32Array(rows[7]);
  const a = JSON.stringify(idx.search(q, 10));
  for (let i = 0; i < 3; i += 1) assert.strictEqual(JSON.stringify(idx.search(q, 10)), a);
});

test('external ids are returned instead of row indices', () => {
  const idx = makeIndex([unit([1, 0]), unit([0, 1])], [500, 900]);
  assert.strictEqual(idx.search(new Float32Array(unit([1, 0])), 1)[0].id, 500);
  assert.strictEqual(idx.rowOf(900), 1);
  assert.strictEqual(idx.rowOf(12345), -1, 'unknown id resolves to -1');
  assert.deepStrictEqual(idx.similarTo(12345, 5), [], 'unknown id yields no results');
});

test('masked-out rows never appear in results', () => {
  const idx = makeIndex([unit([1, 0]), unit([0.99, 0.14]), unit([0, 1])], null, [1, 0, 1]);
  const hits = idx.search(new Float32Array(unit([1, 0])), 5);
  assert.deepStrictEqual(hits.map(h => h.id), [0, 2], 'row 1 is masked out');
});

test('a masked row is not a question either', () => {
  const idx = makeIndex([unit([1, 0]), unit([0.9, 0.1]), unit([0, 1])], null, [1, 0, 1]);
  assert.deepStrictEqual(idx.similarTo(1, 2), []);
  assert.strictEqual(idx.similarTo(0, 2).length, 1);   // row 2 only: row 1 is masked, row 0 is itself
});

test('an id that is not a row finds nothing, rather than k rows scored NaN', () => {
  const idx = makeIndex([unit([1, 0]), unit([0, 1])]);
  for (const id of [99, -1, 1.5, NaN, undefined]) assert.deepStrictEqual(idx.similarTo(id, 2), []);
});

test('k is an integer no larger than the index, whatever was asked for', () => {
  const idx = makeIndex([unit([1, 0]), unit([0.9, 0.1]), unit([0, 1])]);
  const q = new Float32Array(unit([1, 0]));
  assert.strictEqual(idx.search(q, 2.5).length, 2);
  assert.ok(idx.search(q, 2.5).every(h => Number.isInteger(h.id)));
  assert.strictEqual(idx.search(q, 1e10).length, 3);
  assert.strictEqual(idx.search(q, Infinity).length, 3);
  assert.deepStrictEqual(idx.search(q, 0.5), []);
  assert.deepStrictEqual(idx.search(q, NaN), []);
});

test('a query that is not finite is refused, not scored', () => {
  const idx = makeIndex([unit([1, 0]), unit([0, 1])]);
  assert.throws(() => idx.search(new Float32Array([NaN, 0]), 2), /not finite/);
});

test('filter predicate restricts candidates by id', () => {
  const idx = makeIndex([unit([1, 0]), unit([0.99, 0.14]), unit([0.98, 0.2])]);
  const hits = idx.search(new Float32Array(unit([1, 0])), 5, { filter: id => id !== 0 });
  assert.ok(hits.every(h => h.id !== 0));
});

test('quantization keeps cosine within tolerance of the float original', () => {
  const dim = 64;
  const rows = Array.from({ length: 20 }, (_, i) =>
    unit(Array.from({ length: dim }, (_, j) => Math.cos(i * 1.7 + j * 0.31))));
  const idx = makeIndex(rows);
  for (let r = 0; r < rows.length; r += 1) {
    const exact = rows[r].reduce((a, x) => a + x * x, 0);       // = 1
    const got = idx.search(new Float32Array(rows[r]), 1)[0].score;
    assert.ok(Math.abs(got - exact) < 0.01, `row ${r}: ${got} vs ${exact}`);
  }
});

test('loadIndex builds an equivalent index from raw buffers', () => {
  const src = makeIndex([unit([1, 0, 0, 0]), unit([0, 1, 0, 0])]);
  const loaded = loadIndex({
    codesBuf: src.codes.buffer, scalesBuf: src.scales.buffer, dim: 4,
  });
  assert.strictEqual(loaded.n, 2);
  assert.deepStrictEqual(
    loaded.search(new Float32Array([1, 0, 0, 0]), 2).map(h => h.id),
    src.search(new Float32Array([1, 0, 0, 0]), 2).map(h => h.id));
});

test('roundScore collapses float noise below the precision floor', () => {
  assert.strictEqual(roundScore(0.1 + 0.2), roundScore(0.3));
});

test('opts.mask narrows a search with data, and replaces the index own mask', () => {
  const codes = new Int8Array(5 * 2);
  const scales = new Float32Array(5).fill(1 / 127);
  for (let r = 0; r < 5; r += 1) { codes[r * 2] = 127 - r; codes[r * 2 + 1] = 1; }
  const idx = new VectorIndex(codes, scales, 2, null, new Uint8Array([1, 1, 1, 1, 0]));
  const q = new Float32Array([1, 0]);

  // its own mask: row 4 is not in the index at all
  assert.deepEqual(idx.search(q, 5).map(h => h.row), [0, 1, 2, 3]);

  // opts.mask REPLACES it -- which is why a caller with a mask of its own has
  // to combine them, and why maskForWork in corpus.js does exactly that
  assert.deepEqual(idx.search(q, 5, { mask: new Uint8Array([0, 0, 1, 1, 1]) }).map(h => h.row),
    [2, 3, 4], 'row 4 comes back, because the index mask was replaced and not added to');

  assert.throws(() => idx.search(q, 5, { mask: new Uint8Array(3) }), /mask length 3 != 5/);
});

test('a kernel sees the same mask the loop does', () => {
  const codes = new Int8Array(6 * 2);
  const scales = new Float32Array(6).fill(1 / 127);
  for (let r = 0; r < 6; r += 1) { codes[r * 2] = 120 - r * 7; codes[r * 2 + 1] = r; }
  const idx = new VectorIndex(codes, scales, 2, null, new Uint8Array(6).fill(1));
  const q = new Float32Array([1, 0.25]);
  const narrow = new Uint8Array([0, 1, 1, 0, 1, 0]);

  let sawMask = null;
  const spy = (args) => {
    sawMask = args.mask;
    const out = [];
    for (let row = 0; row < args.n; row += 1) {
      if (row === args.excludeRow || (args.mask && args.mask[row] === 0)) continue;
      let acc = 0;
      for (let i = 0; i < args.dim; i += 1) acc += args.query[i] * args.codes[row * args.dim + i];
      out.push({ row, score: roundScore(acc * args.scales[row]) });
    }
    out.sort((a, b) => (b.score - a.score) || (a.row - b.row));
    return out.slice(0, args.k);
  };

  assert.deepEqual(idx.search(q, 3, { kernel: spy, mask: narrow }), idx.search(q, 3, { mask: narrow }));
  assert.equal(sawMask, narrow, 'the kernel is handed the narrowing, not left to guess it');
});
