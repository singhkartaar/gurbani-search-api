'use strict';
/**
 * The notation routes against a real server process, with a notations
 * database and a directory of images built here (no artifacts, no
 * pipeline): health, the roster, the list and its 400s, one notation, the
 * count on a shabad, the local image route and its traversal guard, and the
 * renderer bundle the page loads.
 *
 * The server needs gurbani.sqlite to boot, so this runs only where the
 * artifacts are (the store itself is covered without them in
 * packages/search-core/test/notations.test.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACTS = process.env.ARTIFACTS_DIR || path.join(ROOT, 'artifacts');
const HAS_DB = fs.existsSync(path.join(ARTIFACTS, 'gurbani.sqlite'));
const PORT = 5206;
const BASE = `http://127.0.0.1:${PORT}`;
const { buildNotations } = require('../../../packages/search-core/test/helpers/notations-fixture.js');

let child = null;
let tmp = null;

const call = async (p) => {
  const res = await fetch(BASE + p);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};

test.before(async () => {
  if (!HAS_DB) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notations-api-'));
  const dbPath = path.join(tmp, 'notations.sqlite');
  buildNotations(dbPath);
  const images = path.join(tmp, 'images');
  fs.mkdirSync(path.join(images, 'gss-1', 'images'), { recursive: true });
  // a 1x1 PNG, enough for a content type and a byte count
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(images, 'gss-1', 'images', 'gss-1-0168-1-1.thumb.png'), png);
  fs.writeFileSync(path.join(images, 'gss-1', 'images', 'gss-1-0171-1-1.png'), png);
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'not an image');
  child = spawn(process.execPath, [path.join(ROOT, 'apps', 'web', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ARTIFACTS_DIR: ARTIFACTS, NOTATIONS_PATH: dbPath, NOTATION_IMAGES_DIR: images,
           APP_PASSWORD: '', RATE_LIMIT_PER_MINUTE: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    if (child.exitCode !== null) throw new Error('server exited: ' + log);
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start: ' + log);
});

test.after(async () => {
  // the server holds notations.sqlite open, and Windows will not delete an open file: wait for it to go
  if (child && child.exitCode === null) {
    const gone = new Promise(r => child.once('exit', r));
    child.kill();
    await gone;
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('health reports the notations and the roster lists the facets', { skip: !HAS_DB }, async () => {
  const h = await call('/api/health');
  assert.strictEqual(h.body.notations.enabled, true);
  assert.strictEqual(h.body.notations.notations, 4);
  const r = await call('/api/notations');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=3600');
  assert.deepStrictEqual(r.body.raags.map(x => x.key), ['gauri', 'gauri_purbi', 'sarang', 'bhairavi']);
  assert.strictEqual(r.body.books.length, 2);
  assert.strictEqual(r.body.authors.length, 2);
});

test('the list filters, pages, answers a query and refuses what it does not know', { skip: !HAS_DB }, async () => {
  const all = await call('/api/notations/list');
  assert.strictEqual(all.body.total, 4);
  assert.strictEqual(all.body.results[0].notation_id, 'gss-1:0168:1');
  // the card's picture: a published crop before a thumbnail only this machine has
  assert.strictEqual(all.body.results[0].thumb, 'https://github.com/o/r/releases/download/notations-gss-1-v1/a.png');
  // nothing published: the local crop, served by this server because NOTATION_IMAGES_DIR is set
  assert.strictEqual(all.body.results.find(c => c.notation_id === 'gss-1:0171:1').thumb,
                     '/notation-images/gss-1/images/gss-1-0171-1-1.png');
  const gauri = await call('/api/notations/list?raag=gauri');
  assert.deepStrictEqual(gauri.body.results.map(c => c.notation_id), ['rr:0500:1']);
  // the first line comes from the real corpus, so the query is a word of whatever it says
  const one = await call('/api/notation?id=gss-1:0171:1');
  const word = one.body.shabad.first_line.split(/\s+/).find(w => w.length > 2 && !/[॥।]/.test(w));
  const q = await call('/api/notations/list?q=' + encodeURIComponent(word));
  assert.ok(q.body.results.some(c => c.notation_id === 'gss-1:0171:1'), word);
  const letters = await call('/api/notations/list?q=' + encodeURIComponent(one.body.shabad.first_letters || 'zzzz'));
  assert.ok(Array.isArray(letters.body.results));
  const paged = await call('/api/notations/list?k=1&page=2');
  assert.deepStrictEqual([paged.body.page, paged.body.pages, paged.body.results.length], [2, 4, 1]);
  for (const bad of ['raag=nope', 'taal=nope', 'author=nope', 'book=nope', 'shabad=abc', 'q=' + 'x'.repeat(300)]) {
    const r = await call('/api/notations/list?' + bad);
    assert.strictEqual(r.status, 400, bad);
  }
});

test('one notation, whole; a bad id is 400 and an unknown one 404', { skip: !HAS_DB }, async () => {
  const one = await call('/api/notation?id=gss-1:0168:1');
  assert.strictEqual(one.status, 200);
  const n = one.body.notation;
  assert.strictEqual(n.grid[0].kind, 'sthai');
  assert.strictEqual(n.images.length, 3);
  // the release URL is kept; a crop without one comes from this server; the local path is never exposed
  assert.strictEqual(n.images[0].url, 'https://github.com/o/r/releases/download/notations-gss-1-v1/a.png');
  assert.strictEqual(n.images[1].url, '/notation-images/gss-1/images/gss-1-0168-1-1.thumb.png');
  assert.strictEqual(n.images[0].path, undefined);
  assert.strictEqual(one.body.shabad.shabad_id, 913);
  assert.ok(Array.isArray(one.body.shabad.lines));
  assert.strictEqual((await call('/api/notation?id=nonsense')).status, 400);
  assert.strictEqual((await call('/api/notation?id=zz:0001:1')).status, 404);
});

test('the shabad and the search rows carry the count', { skip: !HAS_DB }, async () => {
  const s = await call('/api/shabad?id=913');
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.body.shabad.notations, 2);
  const none = await call('/api/shabad?id=1');
  assert.strictEqual(none.body.shabad.notations, undefined);
});

test('local images are served with a content type, and nothing outside the directory is', { skip: !HAS_DB }, async () => {
  const img = await fetch(BASE + '/notation-images/gss-1/images/gss-1-0171-1-1.png');
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.headers.get('content-type'), 'image/png');
  assert.strictEqual((await fetch(BASE + '/notation-images/gss-1/images/missing.png')).status, 404);
  // two spellings of the same escape: refused either way, and never the file
  for (const p of ['/notation-images/..%2Fsecret.txt', '/notation-images/../secret.txt']) {
    const r = await fetch(BASE + p);
    assert.ok([403, 404].includes(r.status), p + ' -> ' + r.status);
    assert.notStrictEqual(await r.text(), 'not an image');
  }
  // the URL parser may fold the dots before the server sees them; either way nothing is served
  const dots = await fetch(BASE + '/notation-images/%2e%2e/%2e%2e/etc/passwd.png');
  assert.ok([403, 404].includes(dots.status), String(dots.status));
});

test('the page gets the renderer and its stylesheet', { skip: !HAS_DB }, async () => {
  const js = await fetch(BASE + '/notation-render.js');
  assert.strictEqual(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const text = await js.text();
  assert.match(text, /window\.NotationRender = req\('notation-render\.js'\)/);
  const css = await fetch(BASE + '/notation.css');
  assert.strictEqual(css.status, 200);
  assert.match(await css.text(), /\.ntn/);
  const csp = (await fetch(BASE + '/api/health')).headers.get('content-security-policy');
  assert.match(csp, /img-src 'self' data: https:\/\/github\.com https:\/\/objects\.githubusercontent\.com https:\/\/release-assets\.githubusercontent\.com/);
});
