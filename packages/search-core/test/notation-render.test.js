'use strict';
/**
 * The renderer agrees with its Python twin to the byte: every expected file
 * under pipeline/python/fixtures/notations was written by Python, and this
 * side must produce the same text, the same HTML and the same cells. The
 * fixtures are absent in the public API checkout; then the tests skip.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../src/notation-render.js');

const FIXTURES = path.join(__dirname, '..', '..', '..', 'pipeline', 'python', 'fixtures', 'notations');
const HAVE = fs.existsSync(path.join(FIXTURES, 'teentaal-sthai.expected.english.txt'));
const read = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const load = name => JSON.parse(read(name));
const corpus = () => (HAVE ? load('corpus-lines.json') : {});

for (const name of ['teentaal-sthai', 'slok-free']) {
  test(`${name}: the renderings match the pinned expectations`, { skip: !HAVE }, () => {
    const rec = load(`${name}.json`);
    const c = corpus();
    assert.strictEqual(R.textEnglish(rec, c).trimEnd(), read(`${name}.expected.english.txt`).trimEnd());
    assert.strictEqual(R.textGurmukhi(rec, c).trimEnd(), read(`${name}.expected.gurmukhi.txt`).trimEnd());
    assert.strictEqual(R.html(rec, 'english', c), read(`${name}.expected.english.html`).trimEnd());
    assert.strictEqual(R.html(rec, 'gurmukhi', c), read(`${name}.expected.gurmukhi.html`).trimEnd());
    assert.deepStrictEqual(JSON.parse(JSON.stringify(R.cells(rec, c))), load(`${name}.expected.cells.json`));
  });
}

test('the CSS is the pipeline\'s', { skip: !HAVE }, () => {
  assert.strictEqual(R.NOTATION_CSS, read('notation.css'));
});

test('the english row says what the notes say', { skip: !HAVE }, () => {
  const rows = R.cells(load('teentaal-sthai.json'), corpus());
  const sthai = rows[0];
  assert.deepStrictEqual(sthai.swar_en.slice(0, 9), ['S', 'r', 'G', 'm', 'P', '-', 'DN', "S'", '*']);
  assert.strictEqual(sthai.swar_en[12], '{P}M');
  assert.strictEqual(sthai.swar_en[14], 'R-S');
  assert.strictEqual(sthai.bol_en[15], 'tariaa');
  assert.strictEqual(sthai.bol_en[5], '-');
  assert.deepStrictEqual(sthai.marks.slice(0, 5), ['×', null, null, null, '2']);
  const antara = rows[1];
  assert.strictEqual(antara.matra_from, 9);
  assert.strictEqual(antara.swar_en[4], '?');
  assert.strictEqual(antara.swar_en[5], 'nDPM');
  assert.strictEqual(antara.swar_en[3], 'S,');
  assert.strictEqual(antara.swar_pa[3], 'ਸ̣');
});

test('format and parse a line round-trip', { skip: !HAVE }, () => {
  const rec = load('teentaal-sthai.json');
  for (const row of R.cells(rec)) {
    const back = R.parseLine(R.formatLine(row));
    assert.strictEqual(back.kind, row.kind);
    assert.strictEqual(back.matra_from, row.matra_from);
    assert.strictEqual(back.beats.length, row.beats.length);
  }
  assert.deepStrictEqual(R.parseCell("{P'}m~-"), { notes: [{ s: 'M', t: true, kan: { s: 'P', o: 1 }, kh: true, len: 2 }], div: 2 });
  assert.throws(() => R.parseCell('Q'));
});

test('the roman table and word spans', () => {
  assert.deepStrictEqual(['ਸਤਿ', 'ਨਾਮੁ', 'ਸੰਗਤਿ', 'ਪ੍ਰਭ', 'ਸੱਚ', 'ਵਾਹਿਗੁਰੂ', ''].map(R.romanOf),
    ['sat', 'naam', 'sangat', 'prabh', 'sacch', 'vaahiguroo', '']);
  const text = 'ਮੇਰੇ ਮਾਧਉ ਜੀ ਸਤਸੰਗਤਿ ਮਿਲੇ ਸੁ ਤਰਿਆ ॥੧॥ ਰਹਾਉ ॥';
  assert.deepStrictEqual(R.wordSpans(text).map(([a, b]) => text.slice(a, b)),
    ['ਮੇਰੇ', 'ਮਾਧਉ', 'ਜੀ', 'ਸਤਸੰਗਤਿ', 'ਮਿਲੇ', 'ਸੁ', 'ਤਰਿਆ']);
});

test('html escapes and marks up', { skip: !HAVE }, () => {
  const rec = load('teentaal-sthai.json');
  rec.sections[0].lines[0].beats[0].bol.g = '<b>&';
  const out = R.html(rec, 'gurmukhi');
  assert.ok(out.includes('&lt;b&gt;&amp;'));
  assert.ok(!out.includes('<b>&'));
  for (const needle of ['class="n n-komal"', 'class="n n-tivra"', 'class="n n-taar"', '<sup class="n-kan">', 'class="n-grp n-grp-2"', 'class="ntn-cell ntn-vb ntn-sam"', 'ntn-unknown']) {
    assert.ok(out.includes(needle), needle);
  }
  const en = R.html(rec, 'english');
  assert.strictEqual((out.match(/<td/g) || []).length, (en.match(/<td/g) || []).length);
});
