'use strict';
/**
 * The notation contract, checked against the same fixtures the Python side
 * uses: the vocabulary vectors, the valid records, the invalid variants with
 * the error each names, and the content hash. The fixtures live in the
 * pipeline (pipeline/python/fixtures/notations); where this package is
 * checked out alone (the public API repo) they are absent and these tests
 * skip, since the contract is then pinned on the other side.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const vocab = require('../src/notation-vocab.js');
const { validate, fillDefaults, stripDefaults, makeId, parseId, imageName, canonicalJson } = require('../src/notation.js');
const { contentHash } = require('../src/notation-node.js');

const FIXTURES = path.join(__dirname, '..', '..', '..', 'pipeline', 'python', 'fixtures', 'notations');
const HAVE = fs.existsSync(path.join(FIXTURES, 'teentaal-sthai.json'));
const load = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

test('the vocabulary mirror is byte-identical to the pipeline\'s', { skip: !HAVE }, () => {
  const mine = fs.readFileSync(path.join(__dirname, '..', 'src', 'notation-vocab.json'));
  const theirs = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'pipeline', 'python', 'lib', 'notation_vocab.json'));
  assert.ok(mine.equals(theirs), 'run node tools/sync-notation-vocab.mjs --write');
});

test('every vocabulary vector resolves to its key', { skip: !HAVE }, () => {
  const vec = load('vocab-vectors.json');
  for (const [text, key] of vec.raag_pa) assert.strictEqual(vocab.normaliseRaag(text).key, key, text);
  for (const [text, key] of vec.raag_en) assert.strictEqual(vocab.normaliseRaag(text, 'en').key, key, text);
  for (const [text, key, laya] of vec.taal) {
    const got = vocab.normaliseTaal(text);
    assert.deepStrictEqual([got.key, got.laya], [key, laya], text);
  }
});

test('the bracketed variant is the raag and the bare name its parent', () => {
  const got = vocab.normaliseRaag('ਰਾਗ ਸਾਰੰਗ (ਬਿੰਦ੍ਰਾਬਨੀ ਸਾਰੰਗ)');
  assert.deepStrictEqual([got.key, got.parent, got.method], ['brindavani_sarang', 'sarang', 'alias']);
  assert.strictEqual(vocab.raagKeyFromCorpus('Raag Sorath'), 'sorath');
  assert.strictEqual(vocab.raagKeyFromCorpus('Salok Kabeer Jee'), 'salok_kabir');
  assert.strictEqual(vocab.raagKeyFromCorpus('Guru Arjan Dev Ji'), null);
});

test('markers, taal detection and section labels', () => {
  assert.deepStrictEqual(vocab.taalMarkers('teentaal').slice(0, 5), ['×', null, null, null, '2']);
  assert.deepStrictEqual(vocab.taalMarkers('teentaal', 9, 8), ['0', null, null, null, '3', null, null, null]);
  assert.strictEqual(vocab.taalFromMarkers(10, { 1: '×', 6: '0' }), 'jhaptaal');
  assert.strictEqual(vocab.taalFromMarkers(7, { 1: '0' }), 'rupak');
  assert.strictEqual(vocab.taalFromMarkers(16, { 1: '×', 9: '0' }), null);
  assert.deepStrictEqual(vocab.sectionLabel('ਅੰਤਰਾ ੨'), ['antara', 2]);
  assert.deepStrictEqual(vocab.sectionLabel('ਸਥਾਈ'), ['sthai', null]);
  assert.strictEqual(vocab.sectionLabel('ਹਰਿ ਹਰਿ ਨਾਮੁ'), null);
  assert.strictEqual(vocab.indelRatio('kitten', 'sitting'), 1 - 5 / 13);
});

test('the fixtures are valid and every invalid variant names its error', { skip: !HAVE }, () => {
  for (const name of ['teentaal-sthai.json', 'slok-free.json']) assert.deepStrictEqual(validate(load(name)), [], name);
  const folder = path.join(FIXTURES, 'invalid');
  const files = fs.readdirSync(folder).sort();
  assert.ok(files.length >= 10);
  for (const fn of files) {
    const c = JSON.parse(fs.readFileSync(path.join(folder, fn), 'utf8'));
    const codes = validate(c.notation).map(e => e.code);
    assert.ok(codes.includes(c.error), `${fn}: ${codes.join(',')}`);
  }
});

test('defaults round-trip and the hash agrees with Python', { skip: !HAVE }, () => {
  const rec = load('teentaal-sthai.json');
  const full = fillDefaults(rec);
  assert.deepStrictEqual(full.sections[0].lines[0].beats[0].notes[0], { s: 'S', o: 0, k: false, t: false, len: 1, kh: false });
  assert.deepStrictEqual(stripDefaults(full), stripDefaults(rec));
  assert.strictEqual(contentHash(rec), contentHash(full));
  const pinned = path.join(FIXTURES, 'teentaal-sthai.expected.hash.txt');
  if (fs.existsSync(pinned)) assert.strictEqual(contentHash(rec), fs.readFileSync(pinned, 'utf8').trim());
  assert.strictEqual(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

test('ids', () => {
  assert.strictEqual(makeId('gurmat-sangeet-sagar-1', 42, 3), 'gurmat-sangeet-sagar-1:0042:3');
  assert.deepStrictEqual(parseId('gurmat-sangeet-sagar-1:0042:3'), ['gurmat-sangeet-sagar-1', 42, 3]);
  assert.strictEqual(parseId('Bad Key:42:3'), null);
  assert.strictEqual(imageName('a-b:0042:3', 2), 'a-b-0042-3-2.png');
  assert.strictEqual(imageName('a-b:0042:3', 2, true), 'a-b-0042-3-2.thumb.png');
  assert.throws(() => makeId('Not A Slug', 1, 1));
});
