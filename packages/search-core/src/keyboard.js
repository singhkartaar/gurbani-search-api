'use strict';
/**
 * Gurmukhi on-screen keyboard layout for first-letter search.
 *
 * The keyboard emits Gurmukhi letters; buildQuery() converts them to the ASCII
 * keymap char codes the index is built from. Users think in ਪੈਂਤੀ (the 35
 * akhar), so that is the layout -- not a QWERTY transliteration.
 */
const g = require('./gurmukhi.js');

/** ਪੈਂਤੀ ਅੱਖਰ -- the 35 letters, in traditional row order. */
const PAINTI = [
  ['ੳ', 'ਅ', 'ੲ', 'ਸ', 'ਹ'],
  ['ਕ', 'ਖ', 'ਗ', 'ਘ', 'ਙ'],
  ['ਚ', 'ਛ', 'ਜ', 'ਝ', 'ਞ'],
  ['ਟ', 'ਠ', 'ਡ', 'ਢ', 'ਣ'],
  ['ਤ', 'ਥ', 'ਦ', 'ਧ', 'ਨ'],
  ['ਪ', 'ਫ', 'ਬ', 'ਭ', 'ਮ'],
  ['ਯ', 'ਰ', 'ਲ', 'ਵ', 'ੜ'],
];

/**
 * Nukta letters. Present for familiarity -- SGGS itself contains none, and
 * stripNukta() folds each to its base letter, so tapping ਸ਼ searches ਸ.
 */
const NUKTA_ROW = ['ਸ਼', 'ਖ਼', 'ਗ਼', 'ਜ਼', 'ਫ਼', 'ਲ਼'];

/**
 * Vowel signs and nasal/gemination marks, for typing whole words on the
 * Punjabi free-text screen. Not part of first-letter search, where a query is
 * consonants only.
 */
const MATRA_ROW = ['ਾ', 'ਿ', 'ੀ', 'ੁ', 'ੂ', 'ੇ', 'ੈ', 'ੋ', 'ੌ', 'ੰ', 'ੱ', 'ਂ', '਼'];

const ALL_KEYS = [...PAINTI.flat(), ...NUKTA_ROW];

/**
 * Roman sound of each key, for the reader who knows the language but not the
 * script. The keyboard can wear these labels instead of the letters; what is
 * searched is unchanged -- a key still emits its Gurmukhi letter.
 *
 * Retroflex consonants are capitalised (T D N R), the convention Punjabi
 * writers already use when typing Roman, and aspirates carry the h.
 */
const ROMAN = {
  'ੳ': 'u', 'ਅ': 'a', 'ੲ': 'i', 'ਸ': 's', 'ਹ': 'h',
  'ਕ': 'k', 'ਖ': 'kh', 'ਗ': 'g', 'ਘ': 'gh', 'ਙ': 'ng',
  'ਚ': 'ch', 'ਛ': 'chh', 'ਜ': 'j', 'ਝ': 'jh', 'ਞ': 'ny',
  'ਟ': 'T', 'ਠ': 'Th', 'ਡ': 'D', 'ਢ': 'Dh', 'ਣ': 'N',
  'ਤ': 't', 'ਥ': 'th', 'ਦ': 'd', 'ਧ': 'dh', 'ਨ': 'n',
  'ਪ': 'p', 'ਫ': 'ph', 'ਬ': 'b', 'ਭ': 'bh', 'ਮ': 'm',
  'ਯ': 'y', 'ਰ': 'r', 'ਲ': 'l', 'ਵ': 'v', 'ੜ': 'R',
  'ਸ਼': 'sh', 'ਖ਼': 'khh', 'ਗ਼': 'ghh', 'ਜ਼': 'z', 'ਫ਼': 'f', 'ਲ਼': 'L',
};

/**
 * Physical key -> letter when the keyboard is in Roman mode: what the letter
 * sounds like, not where AnmolLipi puts it.
 *
 * Only sounds a SINGLE key can name are here. A two-letter sound cannot be:
 * `kh` would have to swallow the h, and ਹ opens more words in Gurbani than any
 * other letter (ਹਰਿ alone opens thousands), so `ਕਰਿ ਹਰਿ` would silently become
 * ਖ. Those letters are one tap away on the on-screen keyboard, which is always
 * complete; typing here stays unambiguous.
 */
const ROMAN_KEYMAP = {
  // e is i's sound as often as its own (ਇਹ is typed `eh` as readily as `ih`),
  // and both open on ੲ. o is ਓ, which the corpus keeps as a first letter of
  // its own -- not on the ਪੈਂਤੀ keyboard, but typed as a reader says it.
  u: 'ੳ', a: 'ਅ', i: 'ੲ', e: 'ੲ', o: 'ਓ', s: 'ਸ', h: 'ਹ',
  k: 'ਕ', K: 'ਖ', g: 'ਗ', G: 'ਘ',
  c: 'ਚ', C: 'ਛ', j: 'ਜ', J: 'ਝ',
  T: 'ਟ', D: 'ਡ', N: 'ਣ', R: 'ੜ',
  t: 'ਤ', d: 'ਦ', n: 'ਨ',
  p: 'ਪ', P: 'ਫ', b: 'ਬ', B: 'ਭ', m: 'ਮ',
  y: 'ਯ', r: 'ਰ', l: 'ਲ', v: 'ਵ', w: 'ਵ',
  f: 'ਫ਼', z: 'ਜ਼', S: 'ਸ਼',
};

/** Letter -> the ASCII keymap character the index uses. */
function keyToAscii(letter) {
  return g.toAscii(g.stripNukta(letter));
}

/**
 * Physical keyboard map: AnmolLipi ASCII key -> Gurmukhi letter, for typing a
 * first-letter query on a real keyboard. Base letters are assigned first so a
 * nukta letter (which folds to its base) never shadows one.
 */
function physicalKeymap() {
  const map = {};
  for (const letter of ALL_KEYS) {
    const key = keyToAscii(letter);
    if (key.length === 1 && !(key in map)) map[key] = letter;
  }
  return map;
}

const ASCII_BINDI_MAP = { g: 'Z', j: 'z', s: 'S', K: '^', P: '&' };
const ASCII_BINDI_REV = { Z: 'g', z: 'j', S: 's', '^': 'K', '&': 'P' };

/**
 * Highlight support: which words of a line the query matched.
 * Returns {start, length} in WORD offsets, or null when there is no match.
 * Without this the user cannot tell why a line came back.
 */
function matchSpan(firstLettersAscii, input) {
  const q = g.toAscii(g.stripNukta(String(input).replace(/\s+/g, '')));
  if (!q || !firstLettersAscii) return null;
  const idx = firstLettersAscii.indexOf(q);
  if (idx !== -1) return { start: idx, length: q.length };

  // Fallback: match taking bindi variants into account (e.g. typed 's' matching 'S')
  const qLen = q.length;
  for (let i = 0; i <= firstLettersAscii.length - qLen; i += 1) {
    let match = true;
    for (let j = 0; j < qLen; j += 1) {
      const qc = q[j];
      const fc = firstLettersAscii[i + j];
      if (qc !== fc && ASCII_BINDI_MAP[qc] !== fc && ASCII_BINDI_REV[qc] !== fc) {
        match = false;
        break;
      }
    }
    if (match) return { start: i, length: qLen };
  }
  return null;
}

/**
 * Map each first-letter position back to the word it came from.
 *
 * This cannot be derived by "take each word's first character": the ASCII
 * Gurbani encoding writes the sihari vowel BEFORE its consonant, so `inrBau`
 * is ਨਿਰਭਉ whose first letter is `n`, not `i`. Rather than reimplement that
 * rule (and every other exception), ask anvaad per word -- exact by construction.
 *
 * @param {string} asciiLine  the line in ASCII keymap form
 * @returns {{words: string[], wordOf: number[]}} wordOf[i] = word index that
 *   produced first-letter i
 */
function firstLetterWordMap(asciiLine) {
  const words = String(asciiLine).split(/\s+/).filter(w => w.length > 0);
  const wordOf = [];
  words.forEach((w, wi) => {
    const letters = g.firstLettersAscii(w);
    for (let i = 0; i < letters.length; i += 1) wordOf.push(wi);
  });
  return { words, wordOf };
}

/**
 * Word range to highlight in a result line, given the query that matched it.
 * Returns {firstWord, lastWord} inclusive, or null.
 */
function highlightWords(asciiLine, firstLettersAscii, input) {
  const span = matchSpan(firstLettersAscii, input);
  if (!span) return null;
  const { wordOf } = firstLetterWordMap(asciiLine);
  const first = wordOf[span.start];
  const last = wordOf[span.start + span.length - 1];
  if (first === undefined || last === undefined) return null;
  return { firstWord: first, lastWord: last };
}

module.exports = { PAINTI, NUKTA_ROW, MATRA_ROW, ALL_KEYS, ROMAN, ROMAN_KEYMAP, keyToAscii, physicalKeymap, matchSpan, firstLetterWordMap, highlightWords };
