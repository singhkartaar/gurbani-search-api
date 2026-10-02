'use strict';
/**
 * Garbage into the library, with no server in front of it.
 *
 * The web server checks every parameter before calling in here, but the phone
 * does not have one: what a reader types, and whatever page size a screen
 * computes, reaches these functions as it is. So each one is held to the
 * contract the screens rely on -- any input gives back an ordinary answer of
 * the right shape, or nothing; it does not throw, and it does not hand back
 * the whole corpus because a number was odd.
 *
 * Found by this file: a `limit` of NaN, Infinity or 2.5 threw a SQLite
 * "datatype mismatch" from both first-letter searches, and -1 or 1e9 returned
 * every matching line (25,817 for one letter); NotationsStore threw on a page
 * size of 2.5 and reported a page of 2.5 back.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/index-node.js');
const { buildNotations, buildGurbani } = require('./helpers/notations-fixture.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACTS = process.env.ARTIFACTS_DIR || path.join(ROOT, 'artifacts');
const DB = path.join(ARTIFACTS, 'gurbani.sqlite');
const HAS_DB = fs.existsSync(DB);

const TEXT = [null, undefined, '', ' ', 42, 0, -1, NaN, {}, [], ['k'], true, '😀', '\u0000', '‍', '%', '_', '*', "'", '"',
              '\\', '<script>', 'ਾਿੀ', '॥', 'ੴ', 'k'.repeat(5000), 'ਕ'.repeat(5000), 'a b c', '\n\t', '١٢٣', 'Ω', '__proto__'];
const NUMBERS = [undefined, null, 0, -1, -0, 1, 2.5, NaN, Infinity, -Infinity, 1e9, '5', '', 'x', {}, [], true];

test('the first-letter searches answer anything with an array of at most the page size, and never throw', { skip: !HAS_DB }, () => {
  const db = core.openNodeAdapter(DB);
  for (const q of TEXT) {
    for (const fn of [core.firstLetterAnywhere, core.firstLetterStart]) {
      const rows = fn(db, q, { limit: 10 });
      assert.ok(Array.isArray(rows) && rows.length <= 10, `${fn.name}(${JSON.stringify(q)?.slice(0, 20)})`);
    }
    assert.ok(Number.isInteger(core.firstLetterAnywhereCount(db, q)));
  }
});

test('a page size that is not a sensible number is clamped or defaulted, never "everything" and never a throw', { skip: !HAS_DB }, () => {
  const db = core.openNodeAdapter(DB);
  for (const limit of NUMBERS) {
    for (const fn of [core.firstLetterAnywhere, core.firstLetterStart]) {
      let rows;
      assert.doesNotThrow(() => { rows = fn(db, 'k', { limit }); }, `${fn.name} limit=${String(limit)}`);
      assert.ok(rows.length <= core.MAX_LIMIT, `${fn.name} limit=${String(limit)}: ${rows.length} rows`);
    }
  }
  assert.strictEqual(core.firstLetterAnywhere(db, 'k', { limit: 2.5 }).length, 2, 'a fraction is floored');
  assert.strictEqual(core.firstLetterAnywhere(db, 'k', { limit: -1 }).length, 0, 'a negative is nothing, not everything');
  assert.strictEqual(core.firstLetterAnywhere(db, 'k', { limit: 1e9 }).length, core.MAX_LIMIT);
  assert.strictEqual(core.firstLetterAnywhere(db, 'k', { limit: NaN }).length, core.DEFAULT_LIMIT);
  assert.strictEqual(core.firstLetterAnywhere(db, 'k').length, core.DEFAULT_LIMIT);
});

test('the script helpers take anything and give back a string', () => {
  const g = core.gurmukhi;
  for (const s of TEXT) {
    for (const fn of ['toAscii', 'toUnicode', 'stripNukta', 'buildQuery', 'firstLettersAscii']) {
      let out;
      assert.doesNotThrow(() => { out = g[fn](s); }, `${fn}(${JSON.stringify(s)?.slice(0, 20)})`);
      assert.strictEqual(typeof out, 'string', `${fn}(${JSON.stringify(s)?.slice(0, 20)}) -> ${typeof out}`);
    }
  }
});

test('highlighting a line by a query never throws, and a span it gives is inside the line', () => {
  const kb = core.keyboard;
  for (const letters of ['', 'mrenkhm', 'k', null]) {
    for (const q of TEXT) {
      let span;
      assert.doesNotThrow(() => { span = kb.matchSpan(letters, q); });
      if (span) assert.ok(span.start >= 0 && span.start + span.length <= String(letters).length);
      assert.doesNotThrow(() => kb.highlightWords('myry rwm ieh nIc krm hir myry', letters || '', q));
    }
  }
});

test('the Roman folds take anything and give back a string, and fold a spelling and its variant alike', () => {
  for (const s of TEXT) {
    for (const fn of [core.foldRoman, core.foldGurmukhi, core.looseRoman]) {
      let out;
      assert.doesNotThrow(() => { out = fn(s); }, `${fn.name}(${JSON.stringify(s)?.slice(0, 20)})`);
      assert.strictEqual(typeof out, 'string');
    }
  }
  assert.strictEqual(core.looseRoman('IEH Neech'), core.looseRoman('eh nich'), 'case is not spelling');
  assert.strictEqual(core.looseRoman('  mere   raam  '), core.looseRoman('mere raam'), 'nor is spacing');
  assert.strictEqual(core.looseRoman('ਮੇਰੇ'), '', 'Gurmukhi is not Roman: it folds to nothing rather than to noise');
});

test('the notations store pages anything into a whole page number and size', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garbage-notations-'));
  buildNotations(path.join(dir, 'n.sqlite'));
  buildGurbani(path.join(dir, 'g.sqlite'));
  const n = core.openNodeAdapter(path.join(dir, 'n.sqlite'));
  const g = core.openNodeAdapter(path.join(dir, 'g.sqlite'));
  try {
    const store = new core.NotationsStore({ db: n, gurbani: g });
    for (const k of NUMBERS) {
      for (const page of NUMBERS) {
        let out;
        assert.doesNotThrow(() => { out = store.list({ k, page }); }, `k=${String(k)} page=${String(page)}`);
        assert.ok(Number.isInteger(out.k) && out.k >= 1 && out.k <= 100, `k=${String(k)} -> ${out.k}`);
        assert.ok(Number.isInteger(out.page) && out.page >= 1 && out.page <= out.pages, `page=${String(page)} -> ${out.page}`);
        assert.ok(out.results.length <= out.k);
      }
    }
    for (const q of TEXT) {
      let out;
      assert.doesNotThrow(() => { out = store.list({ q }); }, JSON.stringify(q)?.slice(0, 20));
      assert.ok(Array.isArray(out.results) && Number.isInteger(out.total));
    }
    for (const shabad of [NaN, 'abc', -1, 1e9, {}]) assert.strictEqual(store.list({ shabad }).total, 0, String(shabad));
    for (const id of [null, undefined, '', 'junk', 42, {}, '::', 'gss-1:x:1']) assert.strictEqual(store.get(id), null, String(id));
  } finally {
    n.close?.(); g.close?.();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
