'use strict';
/**
 * SentencePiece Unigram tokenizer, as used by XLM-R and multilingual-E5.
 *
 * Implemented from tokenizer.json rather than pulled in as a dependency for
 * the same reason as tokenizer.js (WordPiece): it has to run identically in
 * Node, the browser and React Native, and it has to be checkable token-for-
 * token against the Python `tokenizers` output. That parity is asserted in
 * test/encoder.pa.test.js over thousands of corpus lines.
 *
 * Pipeline, mirroring the HuggingFace config:
 *   normalizer     Precompiled (nmt_nfkc) -> NFKC + whitespace cleanup here
 *   pre_tokenizer  Metaspace: ' ' -> '▁', prefix '▁', split at each '▁'
 *   model          Unigram: Viterbi over log-probabilities per word
 *   post_processor <s> ... </s>
 */

const META = '▁';   // ▁
const UNK_PENALTY = 10.0;

class UnigramTokenizer {
  constructor(tokenizerJson) {
    const model = tokenizerJson.model;
    if (model.type !== 'Unigram') throw new Error(`expected a Unigram model, got ${model.type}`);
    this.pieces = new Map();       // piece -> id
    this.scores = new Float64Array(model.vocab.length);
    this.maxPieceLen = 1;
    let minScore = 0;
    model.vocab.forEach(([piece, score], id) => {
      this.pieces.set(piece, id);
      this.scores[id] = score;
      if (score < minScore) minScore = score;
      if (piece.length > this.maxPieceLen) this.maxPieceLen = piece.length;
    });
    this.unkId = model.unk_id;
    this.unkScore = minScore - UNK_PENALTY;
    const special = Object.fromEntries((tokenizerJson.added_tokens || []).map(t => [t.content, t.id]));
    this.bosId = special['<s>'];
    this.eosId = special['</s>'];
    this.padId = special['<pad>'];
    for (const [name, id] of [['<s>', this.bosId], ['</s>', this.eosId], ['<pad>', this.padId]]) {
      if (id === undefined) throw new Error(`tokenizer.json has no ${name} token`);
    }
  }

  /**
   * Best segmentation of one pre-tokenized word (already starting with ▁).
   * Standard Viterbi: best[i] = highest total log-prob of a segmentation of
   * chars[0..i). Unknown characters cost unkScore each and fuse into one <unk>.
   */
  segment(word) {
    const chars = Array.from(word);           // code points, not UTF-16 units
    const n = chars.length;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const backLen = new Int32Array(n + 1);
    const backId = new Int32Array(n + 1);
    best[0] = 0;
    for (let i = 0; i < n; i += 1) {
      if (best[i] === -Infinity) continue;
      let matched = false;
      for (let len = 1; len <= this.maxPieceLen && i + len <= n; len += 1) {
        const id = this.pieces.get(chars.slice(i, i + len).join(''));
        if (id === undefined) continue;
        matched = true;
        const s = best[i] + this.scores[id];
        if (s > best[i + len]) { best[i + len] = s; backLen[i + len] = len; backId[i + len] = id; }
      }
      if (!matched || best[i + 1] === -Infinity) {
        // no piece starts here: a single unknown character
        const s = best[i] + this.unkScore;
        if (s > best[i + 1]) { best[i + 1] = s; backLen[i + 1] = 1; backId[i + 1] = this.unkId; }
      }
    }
    const ids = [];
    for (let i = n; i > 0; i -= backLen[i]) ids.push(backId[i]);
    ids.reverse();
    // fuse runs of <unk>
    const out = [];
    for (const id of ids) if (!(id === this.unkId && out[out.length - 1] === this.unkId)) out.push(id);
    return out;
  }

  /** Token ids for a text, without special tokens. */
  tokenize(text) {
    const pre = preTokenize(normalize(text));
    const ids = [];
    for (const word of pre) for (const id of this.segment(word)) ids.push(id);
    return ids;
  }

  encode(text, maxLength = 512) {
    let ids = this.tokenize(text);
    if (ids.length > maxLength - 2) ids = ids.slice(0, maxLength - 2);
    ids = [this.bosId, ...ids, this.eosId];
    return { ids, attentionMask: ids.map(() => 1) };
  }

  /** Pad a batch to its longest member, as the Python side does. */
  encodeBatch(texts, maxLength = 512) {
    if (!texts || texts.length === 0) return [];
    const encoded = texts.map(t => this.encode(t, maxLength));
    const width = Math.max(...encoded.map(e => e.ids.length));
    return encoded.map(e => ({
      ids: [...e.ids, ...new Array(width - e.ids.length).fill(this.padId)],
      attentionMask: [...e.attentionMask, ...new Array(width - e.ids.length).fill(0)],
    }));
  }
}

/**
 * The Precompiled normalizer is SentencePiece's nmt_nfkc: NFKC plus removal of
 * control characters and normalization of odd whitespace to a plain space.
 * The character classes are built from code points so the source stays ASCII.
 */
const span = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const cls = codes => new RegExp('[' + codes.map(c => String.fromCharCode(c)).join('') + ']', 'g');
const CONTROL = cls([...span(0x00, 0x08), 0x0b, ...span(0x0e, 0x1f), ...span(0x7f, 0x9f)]);
// What the model's own normalizer turns into a plain space. The zero-width
// characters are in this list, NOT deleted: tokenizer.json maps ZWJ, ZWNJ,
// ZWSP, the BOM and the direction marks to a space, so a conjunct typed with a
// ZWJ is two words to the model that built the index, and must be two words
// here or the query lands somewhere the index never was. Checked against the
// Python `tokenizers` package over the cases in test/unigram.test.js.
const SPACES = cls([0x09, 0x0a, 0x0c, 0x0d, 0xa0, 0x1680, ...span(0x2000, 0x200f), 0x2028, 0x2029,
  0x202f, 0x205f, 0x3000, 0xfeff, 0xfffd, 0x2581]);

function normalize(text) {
  // runs of spaces collapse to one, as the normalizer's Replace(" {2,}") does
  return text.normalize('NFKC').replace(CONTROL, '').replace(SPACES, ' ').replace(/ {2,}/g, ' ');
}

/** Metaspace with add_prefix_space: one word per ▁-prefixed run, and no second ▁ on text that already leads with one. */
function preTokenize(text) {
  if (text.length === 0) return [];
  let s = text.replace(/ /g, META);
  if (!s.startsWith(META)) s = META + s;
  const words = [];
  let start = 0;
  for (let i = 1; i < s.length; i += 1) {
    if (s[i] === META) { words.push(s.slice(start, i)); start = i; }
  }
  words.push(s.slice(start));
  return words.filter(w => w.length > 0);
}

module.exports = { UnigramTokenizer, normalize, preTokenize, META };
