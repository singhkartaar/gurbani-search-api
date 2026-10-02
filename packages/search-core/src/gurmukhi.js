'use strict';
/**
 * Gurmukhi encoding + first-letter search primitives.
 *
 * Ported verbatim from BaniDB (KhalisFoundation/banidb-api @ dev):
 *   - api/lib/searchOperators.js  (constantsObj, bindiCharacters, firstLetter*ToQuery)
 *   - api/controllers/shabads.js  (charCodeQuery construction, lines 76-99)
 *
 * We reimplement rather than call their API so search runs fully offline and
 * deterministically. Parity against the live API is asserted in test/parity.test.js.
 */
const anvaad = require('anvaad-js');

// searchOperators.js:5-10 -- verbatim
const ASTERISK_ASCII_VALUE = 42;
const ASTERISK_MARIADB_TRANSLATION = '%';
const SEARCH_OPERATORS = ['+', '-', '*', '"', "'"];
const DEC_SEARCH_OPERATORS = [43, 45, 42, 34, 39];

/**
 * searchOperators.js:12-18 -- verbatim key/value pairs.
 *
 * NOTE: upstream's inline comments mislabel which letter is which (e.g. '106' is
 * commented as "ਖ" but 106 is ASCII 'j' = ਜ in the AnmolLipi/GurbaniAkhar keymap).
 * The *pairs* are correct; only the comments are wrong. Verified empirically in
 * test/gurmukhi.test.js by round-tripping each code through anvaad.
 *
 * Maps plain consonant char code -> its bindi (nukta) variant char code.
 */
const BINDI_CHARACTERS = {
  103: '090', // 'g' ਗ -> 'Z' ਗ਼
  106: '122', // 'j' ਜ -> 'z' ਜ਼
  115: '083', // 's' ਸ -> 'S' ਸ਼
  '075': '094', // 'K' ਖ -> '^' ਖ਼
  '080': '038', // 'P' ਫ -> '&' ਫ਼
};

/**
 * What a reader typed, as text. Nothing is the empty string -- not the word
 * "null" or "undefined", which String() would make of it and buildQuery would
 * then search for, letter by letter -- and anything else is its string form,
 * so every function here returns a string whatever it was handed.
 */
const text = v => (v === null || v === undefined ? '' : String(v));

/** Unicode Gurmukhi -> ASCII Gurbani keymap (AnmolLipi). shabads.js:82 */
const toAscii = unicodeStr => anvaad.unicode(text(unicodeStr), true);

/** ASCII Gurbani keymap -> Unicode Gurmukhi. */
const toUnicode = asciiStr => anvaad.unicode(text(asciiStr));

/** First letter of each word, as an ASCII Gurbani string. */
const firstLettersAscii = asciiStr => anvaad.firstLetters(text(asciiStr));

/** Vowel-stripped consonant skeleton. */
const mainLetters = asciiStr => anvaad.mainLetters(text(asciiStr));

/**
 * Encode an ASCII Gurbani string to BaniDB's comma-delimited char-code form.
 * Ported verbatim from shabads.js:84-97.
 *
 * Codes are zero-padded to 3 digits so that string ordering matches code
 * ordering -- this is what makes the BETWEEN range scan correct.
 *
 *   'knjq' -> ',107,110,106,113'
 */
function encodeCharCodes(asciiStr) {
  let out = '';
  for (let x = 0, len = asciiStr.length; x < len; x += 1) {
    let charCode = asciiStr.charCodeAt(x);
    if (DEC_SEARCH_OPERATORS.includes(charCode)) {
      // operators are appended raw so they stay parseable
      out += asciiStr.charAt(x);
    } else {
      if (charCode < 100) {
        charCode = `0${charCode}`;
      }
      out += `,${charCode}`;
    }
  }
  return out;
}

/** shabads.js:98 -- trailing wildcard. 'z' (122) sorts after every digit. */
const wildcard = charCodeQuery => `${charCodeQuery},z`;

/**
 * Nukta (bindi) letters -- ਸ਼ ਖ਼ ਗ਼ ਜ਼ ਫ਼ ਲ਼ -- exist both precomposed (U+0A36) and
 * decomposed (ਸ U+0A38 + ਼ U+0A3C). anvaad renders the decomposed form as two
 * ASCII chars ("sæ"), which encodes to TWO char codes and would never match
 * an index built from single-code letters.
 *
 * SGGS as published by BaniDB contains no nukta characters at all, so folding a
 * typed nukta down to its base letter is exactly right: tapping ਸ਼ finds ਸ lines.
 * The reverse direction (typing ਸ and reaching a ਸ਼ line) is handled separately
 * by bindiVariant(), which matters once the corpus grows beyond SGGS.
 */
const NUKTA_BASE = {
  'ਸ਼': 'ਸ', // ਸ਼ -> ਸ
  'ਖ਼': 'ਖ', // ਖ਼ -> ਖ
  'ਗ਼': 'ਗ', // ਗ਼ -> ਗ
  'ਜ਼': 'ਜ', // ਜ਼ -> ਜ
  'ਫ਼': 'ਫ', // ਫ਼ -> ਫ
  'ਲ਼': 'ਲ', // ਲ਼ -> ਲ
};

/** Fold precomposed and combining nuktas to their base consonant. */
function stripNukta(input) {
  return text(input)
    .normalize('NFC')
    .replace(/[ਸ਼ਖ਼ਗ਼ਜ਼ਫ਼ਲ਼]/g, ch => NUKTA_BASE[ch])
    .replace(/਼/g, '');
}

/**
 * Build the full query string for a user's first-letter input.
 * Mirrors shabads.js:77-98: strip whitespace, unicode->ascii, encode.
 * Accepts either Unicode Gurmukhi or ASCII keymap input.
 */
function buildQuery(rawInput) {
  const stripped = stripNukta(text(rawInput).replace(/\s+/g, ''));
  // anvaad.unicode(_, true) is a no-op on text that is already ASCII keymap
  const ascii = toAscii(stripped);
  return encodeCharCodes(ascii);
}

/**
 * searchOperators.js:83-105 -- substitute plain consonants for their bindi
 * variants, so a query typed without nuktas still matches lines that have them.
 * Returns null when the query contains no substitutable characters.
 */
function bindiVariant(charCodeQuery) {
  let changed = false;
  const codes = charCodeQuery.split(',');
  const mapped = codes.map(code => {
    const variant = BINDI_CHARACTERS[code];
    if (variant) {
      changed = true;
      return variant;
    }
    return code;
  });
  return changed ? mapped.join(',') : null;
}

/**
 * Every comma-delimited suffix of an encoded char-code string. These are the
 * rows of BaniDB's `tokenized_firstletters`; storing them lets
 * "first letter anywhere" become an indexed prefix range scan instead of a
 * full-table LIKE '%...%'.
 *
 *   ',107,110,106' -> [',107,110,106', ',110,106', ',106']
 */
function suffixTokens(charCodeStr) {
  if (!charCodeStr) return [];
  const codes = charCodeStr.split(',').filter(Boolean);
  const tokens = [];
  for (let i = 0; i < codes.length; i += 1) {
    tokens.push(`,${codes.slice(i).join(',')}`);
  }
  return tokens;
}

const containsOperator = q => SEARCH_OPERATORS.some(op => q.includes(op));

module.exports = {
  ASTERISK_ASCII_VALUE,
  ASTERISK_MARIADB_TRANSLATION,
  SEARCH_OPERATORS,
  DEC_SEARCH_OPERATORS,
  BINDI_CHARACTERS,
  toAscii,
  toUnicode,
  firstLettersAscii,
  mainLetters,
  encodeCharCodes,
  wildcard,
  buildQuery,
  stripNukta,
  NUKTA_BASE,
  bindiVariant,
  suffixTokens,
  containsOperator,
};
