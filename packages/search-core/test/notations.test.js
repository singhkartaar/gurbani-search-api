'use strict';
/**
 * The notations store over a database built here from the pinned columns:
 * no artifacts, no pipeline. The gurbani side is a second tiny database with
 * the three `lines` columns the store reads.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NotationsStore, NOTATION_COLUMNS } = require('../src/notations.js');
const { openNodeAdapter } = require('../src/adapter-node.js');

const ROOT = path.join(__dirname, '..', '..', '..');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notations-'));
}

const { buildNotations, buildGurbani } = require('./helpers/notations-fixture.js');

function open(opts = {}) {
  const d = tmpDir();
  const nf = path.join(d, 'notations.sqlite');
  const gf = path.join(d, 'gurbani.sqlite');
  buildNotations(nf, opts);
  buildGurbani(gf);
  const db = openNodeAdapter(nf);
  const gurbani = openNodeAdapter(gf);
  return { store: new NotationsStore({ db, gurbani }), db, gurbani, dir: d };
}

test('the store refuses a database whose columns are not the pinned ones', () => {
  assert.throws(() => open({ dropColumn: ['notations', 'sargam_en'] }), /notations.sqlite: table notations/);
});

test('the pinned columns match the pipeline file when both are in the tree', () => {
  const py = path.join(ROOT, 'pipeline', 'python', 'lib', 'notation_columns.json');
  if (!fs.existsSync(py)) return;
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(py, 'utf8')).tables, NOTATION_COLUMNS);
});

test('summary, counts and the roster', () => {
  const { store } = open();
  const s = store.summary();
  assert.deepStrictEqual([s.enabled, s.books, s.notations, s.shabads, s.images, s.images_published, s.verified], [true, 2, 4, 2, 5, 1, 1]);
  assert.strictEqual(store.countFor(913), 2);
  assert.strictEqual(store.countFor(999), 0);
  const rows = store.attachCounts([{ shabad_id: 913, x: 1 }, { shabad_id: 5 }, { line_id: 1 }]);
  assert.strictEqual(rows[0].notations, 2);
  assert.strictEqual(rows[1].notations, undefined);
  const r = store.roster();
  // GGS raags first in Granth order, then the rest by name; the counts split used from prescribed
  assert.deepStrictEqual(r.raags.map(x => x.key), ['gauri', 'gauri_purbi', 'sarang', 'bhairavi']);
  const bhairavi = r.raags.find(x => x.key === 'bhairavi');
  assert.deepStrictEqual([bhairavi.used, bhairavi.prescribed], [3, 0]);
  const gauri = r.raags.find(x => x.key === 'gauri');
  assert.deepStrictEqual([gauri.used, gauri.prescribed], [0, 2]);
  assert.deepStrictEqual(r.taals.map(t => [t.key, t.n]), [['dadra', 3], ['teentaal', 1]]);
  assert.deepStrictEqual(r.authors.map(a => [a.author_key, a.n]), [['prin-dyal-singh', 3], ['prof-tara-singh', 1]]);
  assert.strictEqual(r.books.length, 2);
  assert.ok(store.known('raag', 'gauri') && !store.known('raag', 'nope') && store.known('book', 'rr') && !store.known('taal', 'x'));
});

test('list filters by raag (a parent covers its forms), shabad raag, author, book, taal, shabad and verified', () => {
  const { store } = open();
  const ids = f => store.list(f).results.map(c => c.notation_id);
  assert.deepStrictEqual(ids({}), ['gss-1:0168:1', 'rr:0500:1', 'gss-1:0171:1', 'gss-1:0174:1']);   // by ang, the unresolved last
  assert.deepStrictEqual(ids({ raag: 'gauri' }), ['rr:0500:1']);                 // gauri_purbi is a gauri
  assert.deepStrictEqual(ids({ raag: 'bhairavi' }).length, 3);
  assert.deepStrictEqual(ids({ shabadRaag: 'gauri' }), ['gss-1:0168:1', 'rr:0500:1']);
  assert.deepStrictEqual(ids({ author: 'prof-tara-singh' }), ['rr:0500:1']);
  assert.deepStrictEqual(ids({ book: 'gss-1', taal: 'teentaal' }), ['gss-1:0171:1']);
  assert.deepStrictEqual(ids({ shabad: 913 }), ['gss-1:0168:1', 'rr:0500:1']);
  assert.deepStrictEqual(ids({ verified: true }), ['gss-1:0168:1']);
  const page = store.list({ k: 2, page: 2 });
  assert.deepStrictEqual([page.total, page.page, page.pages, page.k, page.results.length], [4, 2, 2, 2, 2]);
  assert.strictEqual(store.list({ k: 2, page: 9 }).page, 2);   // clamped, not empty
});

test('a first-line query matches Gurmukhi, Roman and first letters', () => {
  const { store } = open();
  const ids = q => store.list({ q }).results.map(c => c.notation_id);
  assert.deepStrictEqual(ids('ਸਾਕਤ'), ['gss-1:0168:1', 'rr:0500:1']);
  assert.deepStrictEqual(ids('lubhaaeeai'), ['gss-1:0171:1']);
  assert.deepStrictEqual(ids('bsk'), ['gss-1:0168:1', 'rr:0500:1']);
  assert.deepStrictEqual(store.list({ q: 'zzzz' }), { total: 0, page: 1, k: 20, results: [] });
});

test('any line of the shabad finds its notations, and the card names the line that matched', () => {
  const { store } = open();
  const ids = q => store.list({ q }).results.map(c => c.notation_id);
  // the shabad's second line, in Gurmukhi, Roman, first letters typed in Gurmukhi and in the corpus's ASCII
  for (const q of ['ਹੋਵਤ ਸੂਚਾ', 'hovat soochaa', 'ਸਬਕ', 'sbkh']) assert.deepStrictEqual(ids(q), ['gss-1:0168:1', 'rr:0500:1'], q);
  // first letters from the middle of a line, as the main letter search reads them
  assert.deepStrictEqual(ids('ਕਹਸ'), ['gss-1:0168:1', 'rr:0500:1']);
  // a vowel typed whole is its carrier: ਆਰਜਾ's first letter is ਅ
  assert.deepStrictEqual(ids('ਸਕਆ'), ['gss-1:0168:1', 'rr:0500:1']);
  const card = store.list({ q: 'ਹੋਵਤ ਸੂਚਾ' }).results[0];
  assert.strictEqual(card.first_line, 'ਬਿਰਥੀ ਸਾਕਤ ਕੀ ਆਰਜਾ ॥');
  assert.strictEqual(card.matched_line, 'ਸਾਚ ਬਿਨਾ ਕਹ ਹੋਵਤ ਸੂਚਾ ॥');
  // found by its first line: nothing more to say
  assert.strictEqual(store.list({ q: 'ਸਾਕਤ' }).results[0].matched_line, undefined);
  // a line of a shabad with no notation finds nothing
  assert.strictEqual(store.list({ q: 'ਕੋਈ ਹੋਰ' }).total, 0);
});

test('a card says what the reader needs and get() adds the grid, the images and the shabad header', () => {
  const { store } = open();
  const card = store.list({ shabad: 4284 }).results[0];
  assert.strictEqual(card.first_line, 'ਮਨ ਕਹਾ ਲੁਭਾਈਐ ਆਨ ਕਉ ॥');
  assert.strictEqual(card.translit_roman, 'man kahaa lubhaaeeai aan kau ||');
  assert.deepStrictEqual([card.author, card.book_title_en, card.raag_used_en, card.taal_en, card.raag_differs, card.has_grid, card.verified],
                         ['Prin. Dyal Singh', 'Gurmat Sangeet Sagar', 'Bhairavi', 'Teentaal', true, true, false]);
  // no thumbnail: the card shows the first crop instead (thumbnails need not be published)
  assert.deepStrictEqual(card.thumb, { path: 'gss-1/images/gss-1-0171-1-1.png', url: null });
  const got = store.get('gss-1:0168:1');
  assert.strictEqual(got.notation.grid[0].kind, 'sthai');
  assert.strictEqual(got.notation.images.length, 3);
  assert.strictEqual(got.notation.images[0].url, 'https://github.com/o/r/releases/download/notations-gss-1-v1/a.png');
  assert.strictEqual(got.notation.others, 1);
  assert.strictEqual(got.notation.taal_info.matras, 6);
  assert.deepStrictEqual(got.shabad, { shabad_id: 913, notations: 2, first_line: 'ਬਿਰਥੀ ਸਾਕਤ ਕੀ ਆਰਜਾ ॥',
                                       translit_roman: 'birathee saakat kee aarajaa ||', writer: 'Guru Arjan Dev Ji', raag: 'Raag Gauri', ang: 269 });
  assert.strictEqual(store.get('nope:0001:1'), null);
  const partial = store.get('gss-1:0174:1');
  assert.strictEqual(partial.notation.grid, null);
  assert.strictEqual(partial.shabad, null);
  const withThumb = store.list({ shabad: 913, book: 'gss-1' }).results[0];
  // a thumbnail not published beside a published first crop: the published crop, as one image (its url and its path)
  assert.deepStrictEqual(withThumb.thumb, { url: 'https://github.com/o/r/releases/download/notations-gss-1-v1/a.png', path: 'gss-1/images/gss-1-0168-1-1.png' });
});

test('image URLs: the release, a mirror of it, or the server itself', () => {
  const rel = { url: 'https://github.com/o/r/releases/download/x/a.png', path: 'b/images/a.png' };
  const local = { url: null, path: 'b/images/a.png' };
  assert.strictEqual(NotationsStore.imageUrl(rel), rel.url);
  assert.strictEqual(NotationsStore.imageUrl(rel, { urlBase: 'https://cdn.example/n/', releaseBase: 'https://github.com/o/r/releases/download/' }),
                     'https://cdn.example/n/x/a.png');
  assert.strictEqual(NotationsStore.imageUrl(local, { localBase: '/notation-images' }), '/notation-images/b/images/a.png');
  assert.strictEqual(NotationsStore.imageUrl(local), null);
});

test('without the corpus, cards carry the stored first line and a Gurmukhi query still works', () => {
  const d = tmpDir();
  const nf = path.join(d, 'notations.sqlite');
  buildNotations(nf);
  const store = new NotationsStore({ db: openNodeAdapter(nf) });
  const card = store.list({ shabad: 913 }).results[0];
  assert.strictEqual(card.first_line, 'ਬਿਰਥੀ ਸਾਕਤ ਕੀ ਆਰਜਾ ॥');
  assert.strictEqual(card.translit_roman, null);
  assert.strictEqual(store.list({ q: 'ਸਾਕਤ' }).total, 2);
  assert.strictEqual(store.list({ q: 'saakat' }).total, 0);
});
