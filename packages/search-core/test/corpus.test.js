'use strict';
/**
 * A prose corpus, loaded through an injected reader and searched by cosine.
 *
 * Nothing here touches the disk: a three-passage corpus is built in memory,
 * with a stub adapter for the database, so the shape of the contract is what
 * is asserted -- which is what a phone will depend on.
 */
const test = require('node:test');
const assert = require('node:assert');

const { loadCorpus, corpusFromBytes, CorpusStore, corpusMeta } = require('../src/corpus.js');

const DIM = 4, EMBED = 6, N = 3;

/** Three unit vectors along the first three axes, quantized the way the pipeline does. */
function fakeCorpus() {
  const codes = new Int8Array(N * DIM);
  const scales = new Float32Array(N);
  for (let r = 0; r < N; r += 1) { codes[r * DIM + r] = 127; scales[r] = 1 / 127; }
  const mask = new Uint8Array(N).fill(1);
  // an identity-ish projection: the first DIM embedding dims pass through
  const comp = new Float32Array(DIM * EMBED);
  for (let i = 0; i < DIM; i += 1) comp[i * EMBED + i] = 1;
  const mean = new Float32Array(EMBED);
  const manifest = { corpus: 'fake-en', index_dim: DIM, embed_dim: EMBED, model: 'fake', text_lang: 'en', query_scripts: ['latin'] };
  return {
    manifest,
    files: {
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
      'units.i8': codes, 'units.scale.f32': scales, 'units.mask.u8': mask,
      'pca.components.f32': comp, 'pca.mean.f32': mean,
    },
  };
}

const ROWS = [
  { unit_row: 0, unit_id: 'a', work_id: 'w1', part: null, page: 3, para_no: 1, marker: null, text: 'first', title: 'Book One', title_en: null, author: 'A', quote_policy: 'verbatim', original: 1 },
  { unit_row: 1, unit_id: 'b', work_id: 'w1', part: null, page: 4, para_no: 1, marker: null, text: 'second', title: 'Book One', title_en: null, author: 'A', quote_policy: 'verbatim', original: 1 },
  { unit_row: 2, unit_id: 'c', work_id: 'w2', part: null, page: 9, para_no: 1, marker: null, text: 'third', title: 'Book Two', title_en: null, author: 'A', quote_policy: 'summarise', original: 0 },
];

/** Just enough of an adapter for the store's four queries. */
const stubDb = {
  all(sql, params) {
    if (sql.startsWith('SELECT * FROM works')) return [{ work_id: 'w1', title: 'Book One' }, { work_id: 'w2', title: 'Book Two' }];
    if (sql.startsWith('SELECT unit_row, work_id')) return ROWS.map(r => ({ unit_row: r.unit_row, work_id: r.work_id }));
    if (sql.startsWith('SELECT key, value FROM meta')) return [{ key: 'author', value: 'A' }, { key: 'units', value: '3' }, { key: 'citations', value: '1' }];
    if (sql.includes('FROM units u JOIN works')) return ROWS.filter(r => params.includes(r.unit_row));
    if (sql.includes('FROM citations')) return params.includes(2) ? [{ unit_row: 2, shabad_id: 77, line_id: 900, ang: 12, score: 1, method: 'letters', span: 'x' }] : [];
    throw new Error('unexpected sql: ' + sql);
  },
};

test('a corpus loads through an injected reader, sync or async, and reads its manifest like an index', async () => {
  const { manifest, files } = fakeCorpus();
  const art = await loadCorpus(async name => files[name]);
  assert.strictEqual(art.units.n, 3);
  assert.strictEqual(art.pca.inDim, EMBED);
  assert.strictEqual(art.meta.name, 'fake-en');
  assert.deepStrictEqual(art.meta.query_scripts, ['latin']);
  const sync = corpusFromBytes(manifest, files);
  assert.strictEqual(sync.units.n, 3);
  assert.throws(() => corpusFromBytes(manifest, { ...files, 'units.i8': undefined }), /units\.i8 missing/);
  // an older manifest without query_scripts still reads its own language
  assert.deepStrictEqual(corpusMeta({ corpus: 'x', text_lang: 'pa' }).query_scripts, ['gurmukhi', 'latin']);
});

test('nearest orders by cosine, honours a work, and drops rows under the floor', async () => {
  const { files } = fakeCorpus();
  const store = new CorpusStore({ art: await loadCorpus(async n => files[n]), db: stubDb });
  assert.ok(store.canRead('what is seva') && !store.canRead('ਸੇਵਾ'));
  assert.ok(store.hasWork('w2') && !store.hasWork('w9'));

  // a query pointing mostly at row 1, a little at row 2, not at all at row 0
  const q = new Float32Array([0, 0.9, 0.3, 0]);
  const hits = store.nearest(q, 10);
  assert.deepStrictEqual(hits.map(h => h.unit_row), [1, 2, 0]);
  assert.ok(hits[0].score > hits[1].score && hits[1].score > hits[2].score);
  assert.strictEqual(hits[2].score, 0);

  assert.deepStrictEqual(store.nearest(q, 10, { minScore: 0.5 }).map(h => h.unit_row), [1], 'the floor is a floor');
  assert.deepStrictEqual(store.nearest(q, 10, { work: 'w2' }).map(h => h.unit_row), [2], 'inside one book');
  assert.deepStrictEqual(store.nearest(q, 1).map(h => h.unit_row), [1]);

  // the Ask path fuses several forms by rank and is unchanged
  const fused = store.search([q, new Float32Array([1, 0, 0, 0])], 3, 3);
  assert.strictEqual(fused.length, 3);
  assert.ok(fused.every(f => f.score > 0 && f.score < 1));
});

test('load returns rows in the order asked, with their citations attached', async () => {
  const { files } = fakeCorpus();
  const store = new CorpusStore({ art: await loadCorpus(async n => files[n]), db: stubDb });
  const rows = store.load([2, 0]);
  assert.deepStrictEqual(rows.map(r => r.unit_row), [2, 0]);
  assert.strictEqual(rows[0].cites.length, 1);
  assert.strictEqual(rows[0].cites[0].shabad_id, 77);
  assert.strictEqual(rows[0].original, false);
  assert.strictEqual(rows[1].original, true);
  assert.deepStrictEqual(store.load([]), []);
  const s = store.summary();
  assert.strictEqual(s.units, 3);
  assert.strictEqual(s.search, false, 'no encoder, no text search');
  await assert.rejects(() => store.encode('x'), /no query encoder/);
});
