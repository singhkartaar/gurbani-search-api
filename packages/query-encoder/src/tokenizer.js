'use strict';
/**
 * BERT WordPiece tokenizer, implemented directly from tokenizer.json.
 *
 * Why not pull in a tokenizer library: the whole system's guarantee is that a
 * query embedded on-device lands in the same vector space as the corpus
 * embedded at build time. Tokenization is the first place that can silently
 * diverge, and a library's version bump could change it under us. Implementing
 * it here means we can assert JS output == Python output token-for-token over
 * the entire corpus (see test/tokenizer.test.js), which is a far stronger
 * guarantee than trusting a dependency.
 *
 * Config this mirrors (bge-small-en-v1.5):
 *   normalizer     BertNormalizer  clean_text, handle_chinese_chars,
 *                                  lowercase=true, strip_accents=null(->true)
 *   pre_tokenizer  BertPreTokenizer
 *   model          WordPiece  unk=[UNK]  prefix=##  max_input_chars_per_word=100
 *   post_processor [CLS] A [SEP]
 */

const CONTINUING_PREFIX = '##';
const MAX_CHARS_PER_WORD = 100;

/** Control chars are removed; whitespace-ish chars become a plain space. */
function cleanText(text) {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0 || cp === 0xfffd) continue;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) { out += ' '; continue; }
    if (isControl(ch)) continue;
    out += ch;
  }
  return out;
}

function isControl(ch) {
  const cp = ch.codePointAt(0);
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  return /\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}/u.test(ch);
}

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || /\p{Zs}/u.test(ch);
}

/** BERT's punctuation rule: the ASCII punct blocks plus any Unicode P* category. */
function isPunctuation(ch) {
  const cp = ch.codePointAt(0);
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) ||
      (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  // Unicode category P only -- HF's _is_punctuation does not split on symbols
  // (currency, math), and the Python reference tokens were produced that way.
  return /\p{P}/u.test(ch);
}

function isChineseChar(cp) {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
         (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0x2a700 && cp <= 0x2b73f) ||
         (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf) ||
         (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
}

/** CJK ideographs are padded with spaces so each becomes its own token. */
function padChineseChars(text) {
  let out = '';
  for (const ch of text) {
    if (isChineseChar(ch.codePointAt(0))) out += ` ${ch} `;
    else out += ch;
  }
  return out;
}

/** NFD then drop combining marks -- BERT's strip_accents. */
function stripAccents(text) {
  return text.normalize('NFD').replace(/\p{Mn}/gu, '');
}

/**
 * BERT's normaliser, with the two switches its config actually carries.
 *
 * Both default to true, which is right for bge-small-en and every other
 * English WordPiece model. They must both be FALSE for an Indic model such as
 * MuRIL: Gurmukhi matras are combining marks, so strip_accents would turn
 * ਸਤਿਗੁਰੁ into ਸਤਗਰ -- a different word, or no word at all. The manifest says
 * which, so the JS encoder and the Python embedder cannot drift apart.
 */
function normalize(text, { lowercase = true, stripAccents: strip = true } = {}) {
  const cleaned = padChineseChars(cleanText(text));
  const cased = lowercase ? cleaned.toLowerCase() : cleaned;
  return strip ? stripAccents(cased) : cased.normalize('NFC');
}

/** Whitespace split, then split punctuation into standalone tokens. */
function preTokenize(text) {
  const words = [];
  for (const chunk of text.split(/\s+/)) {
    if (!chunk) continue;
    let current = '';
    for (const ch of chunk) {
      if (isWhitespace(ch)) continue;
      if (isPunctuation(ch)) {
        if (current) { words.push(current); current = ''; }
        words.push(ch);
      } else {
        current += ch;
      }
    }
    if (current) words.push(current);
  }
  return words;
}

class WordPieceTokenizer {
  /**
   * @param {object} tokenizerJson parsed tokenizer.json
   * @param {object} [norm]  {lowercase, stripAccents} from the manifest; the
   *                         defaults are BERT's, which suit every English model
   */
  constructor(tokenizerJson, norm = undefined) {
    this.norm = norm;
    // A null-prototype copy, never the parsed object itself: on a plain object
    // `vocab['constructor']` is Object's own constructor, not undefined, so the
    // word "constructor" came back as a function where an id belonged and the
    // BigInt tensor refused it -- one ordinary English word, and the query threw.
    this.vocab = Object.assign(Object.create(null), tokenizerJson.model.vocab);
    this.unkToken = tokenizerJson.model.unk_token || '[UNK]';
    this.unkId = this.vocab[this.unkToken];
    this.clsId = this.vocab['[CLS]'];
    this.sepId = this.vocab['[SEP]'];
    this.padId = this.vocab['[PAD]'];
    if (this.unkId === undefined || this.clsId === undefined || this.sepId === undefined) {
      throw new Error('tokenizer.json is missing [UNK]/[CLS]/[SEP]');
    }
  }

  /** Greedy longest-match-first over a single word. */
  wordPiece(word) {
    if (word.length > MAX_CHARS_PER_WORD) return [this.unkId];
    const pieces = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let found = null;
      while (start < end) {
        const sub = (start === 0 ? '' : CONTINUING_PREFIX) + word.slice(start, end);
        if (this.vocab[sub] !== undefined) { found = this.vocab[sub]; break; }
        end -= 1;
      }
      if (found === null) return [this.unkId];   // whole word is unknown
      pieces.push(found);
      start = end;
    }
    return pieces;
  }

  /** @returns {{ids:number[], attentionMask:number[]}} with [CLS]/[SEP] added. */
  encode(text, maxLength = 160) {
    const ids = [this.clsId];
    for (const word of preTokenize(normalize(text, this.norm))) {
      for (const id of this.wordPiece(word)) {
        if (ids.length >= maxLength - 1) break;
        ids.push(id);
      }
      if (ids.length >= maxLength - 1) break;
    }
    ids.push(this.sepId);
    return { ids, attentionMask: new Array(ids.length).fill(1) };
  }

  /** Pad a batch to its longest member, as the Python side does. */
  encodeBatch(texts, maxLength = 160) {
    if (!texts || texts.length === 0) return [];
    const encoded = texts.map(t => this.encode(t, maxLength));
    const width = Math.max(...encoded.map(e => e.ids.length));
    return encoded.map(e => ({
      ids: [...e.ids, ...new Array(width - e.ids.length).fill(this.padId)],
      attentionMask: [...e.attentionMask, ...new Array(width - e.ids.length).fill(0)],
    }));
  }
}

module.exports = { WordPieceTokenizer, normalize, preTokenize, isPunctuation };
