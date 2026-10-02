'use strict';
const test = require('node:test');
const assert = require('node:assert');
const kb = require('../src/keyboard.js');
const g = require('../src/gurmukhi.js');

test('the layout is the 35 akhar plus 6 nukta letters', () => {
  assert.strictEqual(kb.PAINTI.length, 7);
  assert.ok(kb.PAINTI.every(r => r.length === 5));
  assert.strictEqual(kb.PAINTI.flat().length, 35);
  assert.strictEqual(kb.NUKTA_ROW.length, 6);
  assert.strictEqual(new Set(kb.ALL_KEYS).size, 41, 'no duplicate keys');
});

test('every one of the 35 akhar maps to a distinct single ASCII char', () => {
  const seen = new Map();
  for (const letter of kb.PAINTI.flat()) {
    const a = kb.keyToAscii(letter);
    assert.strictEqual(a.length, 1, `${letter} produced ${JSON.stringify(a)}, expected one char`);
    assert.ok(!seen.has(a), `${letter} collides with ${seen.get(a)} on ${JSON.stringify(a)}`);
    seen.set(a, letter);
  }
  assert.strictEqual(seen.size, 35);
});

test('every key has a Roman name, and no two share one', () => {
  for (const letter of kb.ALL_KEYS) {
    assert.ok(kb.ROMAN[letter], `${letter} has no Roman name`);
    assert.match(kb.ROMAN[letter], /^[a-zA-Z]{1,3}$/, `${letter} -> ${kb.ROMAN[letter]}`);
  }
  assert.strictEqual(new Set(Object.values(kb.ROMAN)).size, kb.ALL_KEYS.length,
    'two keys would read the same in Roman');
});

test('the Roman keymap types by sound, and only where one key can say it', () => {
  const byLetter = Object.entries(kb.ROMAN_KEYMAP);
  for (const [key, letter] of byLetter) {
    assert.strictEqual(key.length, 1, `${key} is not a single key`);
    // ਓ alone is off the keyboard: the corpus keeps it as a first letter of its own
    assert.ok(kb.ALL_KEYS.includes(letter) || letter === 'ਓ', `${key} produces ${letter}, which is not on the keyboard`);
  }
  assert.strictEqual(kb.ROMAN_KEYMAP.e, kb.ROMAN_KEYMAP.i, 'e and i both open on ੲ');
  assert.strictEqual(g.buildQuery(kb.ROMAN_KEYMAP.o), g.buildQuery('ਓ'), 'o searches ਓ, as typed in Gurmukhi');
  // by sound, not by AnmolLipi position: the same physical key means different
  // letters in the two modes, which is the whole point of the switch
  assert.strictEqual(kb.ROMAN_KEYMAP.t, '\u0a24');
  assert.strictEqual(kb.physicalKeymap().t, '\u0a1f');
  assert.strictEqual(kb.ROMAN_KEYMAP.k, '\u0a15');
  assert.strictEqual(kb.ROMAN_KEYMAP.T, '\u0a1f', 'retroflex is the capital');
  // an aspirate cannot be typed, because `h` must stay \u0a39: \u0a15\u0a30\u0a3f \u0a39\u0a30\u0a3f would become \u0a16\u0a30\u0a3f
  assert.strictEqual(kb.ROMAN_KEYMAP.h, '\u0a39');
  assert.ok(!Object.values(kb.ROMAN_KEYMAP).includes('\u0a25'), '\u0a25 is on-screen only');
});

test('every key produces exactly one 3-digit char code', () => {
  for (const letter of kb.ALL_KEYS) {
    const q = g.buildQuery(letter);
    assert.match(q, /^,\d{3}$/, `${letter} -> ${q}`);
  }
});

test('nukta keys fold to their base letter', () => {
  const pairs = [['ਸ਼', 'ਸ'], ['ਖ਼', 'ਖ'], ['ਗ਼', 'ਗ'], ['ਜ਼', 'ਜ'], ['ਫ਼', 'ਫ'], ['ਲ਼', 'ਲ']];
  for (const [nukta, base] of pairs) {
    assert.strictEqual(g.buildQuery(nukta), g.buildQuery(base), `${nukta} should search as ${base}`);
  }
});

test('decomposed and precomposed nukta input agree', () => {
  assert.strictEqual(g.buildQuery('ਸ਼'.normalize('NFD')), g.buildQuery('ਸ'));
  assert.strictEqual(g.buildQuery('ਸ਼'.normalize('NFC')), g.buildQuery('ਸ'));
});

test('tapping several keys builds a multi-letter query', () => {
  assert.strictEqual(g.buildQuery(['ਕ', 'ਨ', 'ਜ', 'ਤ'].join('')), ',107,110,106,113');
});

test('matchSpan locates the query within a line for highlighting', () => {
  assert.deepStrictEqual(kb.matchSpan('knjqkkc', 'ਕਨਜ'), { start: 0, length: 3 });
  assert.deepStrictEqual(kb.matchSpan('knjqkkc', 'njq'), { start: 1, length: 3 });
  assert.strictEqual(kb.matchSpan('knjqkkc', 'ਮਮਮ'), null);
  assert.strictEqual(kb.matchSpan('knjqkkc', ''), null);
});

test('firstLetterWordMap maps every first letter back to its source word', () => {
  // `inrBau` is ਨਿਰਭਉ: the sihari vowel is written BEFORE its consonant, so the
  // first letter is `n`, not `i`. Asking anvaad per word sidesteps that entirely.
  const line = '<> siq nwmu krqw purKu inrBau inrvYru Akwl mUriq AjUnI sYBM gur pRswid ]';
  const { words, wordOf } = kb.firstLetterWordMap(line);
  assert.strictEqual(wordOf.length, g.firstLettersAscii(line).length);
  assert.ok(wordOf.every((w, i) => w >= 0 && w < words.length && (i === 0 || w >= wordOf[i - 1])),
    'word indices must be in range and non-decreasing');
});

test('highlightWords resolves the matched run to a word range', () => {
  const line = 'koie n jwxY qyrw kyqw kyvfu cIrw ]1] rhwau ]';
  const fl = g.firstLettersAscii(line);            // knjqkkc
  assert.deepStrictEqual(kb.highlightWords(line, fl, 'ਕਨਜ'), { firstWord: 0, lastWord: 2 });
  assert.deepStrictEqual(kb.highlightWords(line, fl, 'ਜਤਕ'), { firstWord: 2, lastWord: 4 });
  assert.strictEqual(kb.highlightWords(line, fl, 'ਮਮਮ'), null);
});

test('the only per-word/whole-line disagreements are the 25 rahao dooja lines', () => {
  // Whole-line firstLetters drops one letter on `rhwau dUjw` lines. It affects
  // highlight placement on 0.04% of lines and nothing else -- but if this set
  // ever grows, the mapping has drifted and we want to know.
  const fs = require('node:fs');
  const path = require('node:path');
  const CORPUS = process.env.CORPUS_DB || path.resolve(__dirname, '..', '..', '..', 'data', 'corpus.sqlite');
  if (!fs.existsSync(CORPUS)) return;
  const { openNodeAdapter } = require('../src/index-node.js');
  const db = openNodeAdapter(CORPUS);
  const rows = db.all('SELECT gurmukhi_ascii, first_letters_ascii, rahao_kind FROM lines', []);
  const bad = rows.filter(r =>
    kb.firstLetterWordMap(r.gurmukhi_ascii).wordOf.length !== r.first_letters_ascii.length);
  assert.strictEqual(bad.length, 25);
  assert.ok(bad.every(r => r.rahao_kind === 'rahao-dooja'),
    'disagreements must be confined to rahao-dooja lines');
  db.close();
});
