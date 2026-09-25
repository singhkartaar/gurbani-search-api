'use strict';
/**
 * Quantized vector index + exact brute-force nearest-neighbour search.
 *
 * Brute force is a deliberate choice, not a shortcut. At 60k x 256 int8 this is
 * ~15M multiply-adds -- tens of milliseconds in plain typed arrays. An ANN index
 * (HNSW/IVF) would buy nothing at this scale and would COST determinism, since
 * its graph construction and tie-breaking are order- and seed-dependent. An
 * exhaustive scan in fixed id order is both simpler and provably stable.
 */

/** Scores are rounded before comparison so float noise can never reorder ties. */
const SCORE_PRECISION = 1e6;
const roundScore = s => Math.round(s * SCORE_PRECISION) / SCORE_PRECISION;

class TopKHeap {
  constructor(k) {
    this.k = k;
    this.size = 0;
    this.rows = new Int32Array(k);
    this.scores = new Float64Array(k);
  }

  isWorse(s1, r1, s2, r2) {
    return (s1 < s2) || (s1 === s2 && r1 > r2);
  }

  isBetter(s1, r1, s2, r2) {
    return (s1 > s2) || (s1 === s2 && r1 < r2);
  }

  push(row, score) {
    if (this.size < this.k) {
      const idx = this.size;
      this.rows[idx] = row;
      this.scores[idx] = score;
      this.size += 1;
      this.siftUp(idx);
    } else if (this.isBetter(score, row, this.scores[0], this.rows[0])) {
      this.rows[0] = row;
      this.scores[0] = score;
      this.siftDown(0);
    }
  }

  siftUp(idx) {
    const { rows, scores } = this;
    const r = rows[idx];
    const s = scores[idx];
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.isWorse(s, r, scores[parent], rows[parent])) {
        rows[idx] = rows[parent];
        scores[idx] = scores[parent];
        idx = parent;
      } else {
        break;
      }
    }
    rows[idx] = r;
    scores[idx] = s;
  }

  siftDown(idx) {
    const { rows, scores, size } = this;
    const r = rows[idx];
    const s = scores[idx];
    const half = size >> 1;
    while (idx < half) {
      let left = (idx << 1) + 1;
      const right = left + 1;
      if (right < size && this.isWorse(scores[right], rows[right], scores[left], rows[left])) {
        left = right;
      }
      if (this.isWorse(scores[left], rows[left], s, r)) {
        rows[idx] = rows[left];
        scores[idx] = scores[left];
        idx = left;
      } else {
        break;
      }
    }
    rows[idx] = r;
    scores[idx] = s;
  }

  toSortedArray(idAt) {
    const res = new Array(this.size);
    for (let i = 0; i < this.size; i += 1) {
      res[i] = { id: idAt(this.rows[i]), row: this.rows[i], score: this.scores[i] };
    }
    res.sort((a, b) => (b.score - a.score) || (a.row - b.row));
    return res;
  }
}

class VectorIndex {
  /**
   * @param {Int8Array}    codes   n*dim row-major quantized vectors
   * @param {Float32Array} scales  per-vector dequantization scale
   * @param {number}       dim
   * @param {Int32Array}   [ids]   external id per row; defaults to row index
   * @param {Uint8Array}   [mask]  1 = row participates in search
   */
  constructor(codes, scales, dim, ids = null, mask = null) {
    this.codes = codes;
    this.scales = scales;
    this.dim = dim;
    this.n = scales.length;
    this.ids = ids;
    this.mask = mask;
    if (codes.length !== this.n * dim) {
      throw new Error(`codes length ${codes.length} != n*dim ${this.n * dim}`);
    }
  }

  idAt(row) { return this.ids ? this.ids[row] : row; }

  rowOf(id) {
    // without an ids table the id IS the row, so it has to be one: an id past
    // the end read zeros and scales of undefined, and came back as k confident
    // rows scored NaN
    if (!this.ids) return Number.isInteger(id) && id >= 0 && id < this.n ? id : -1;
    if (!this._rowOf) {
      this._rowOf = new Map();
      for (let i = 0; i < this.ids.length; i += 1) this._rowOf.set(this.ids[i], i);
    }
    const r = this._rowOf.get(id);
    return r === undefined ? -1 : r;
  }

  /** Dequantized float32 copy of one row. */
  vectorAt(row) {
    const { dim, codes, scales } = this;
    const out = new Float32Array(dim);
    const base = row * dim;
    const s = scales[row];
    for (let i = 0; i < dim; i += 1) out[i] = codes[base + i] * s;
    return out;
  }

  /**
   * Top-k rows by cosine against a float32 query.
   * The query stays float32 -- only the stored side is quantized -- so we lose
   * precision once rather than twice.
   */
  search(query, k = 10, opts = {}) {
    const { dim, codes, scales, n } = this;
    // k sizes a typed array: a fraction wrote past its end (a hit with no id),
    // and a huge one was an allocation error rather than "everything"
    k = Math.min(Math.floor(k), n);
    if (!(k >= 1)) return [];
    if (query.length !== dim) throw new Error(`query dim ${query.length} != ${dim}`);
    for (let i = 0; i < dim; i += 1) {
      if (!Number.isFinite(query[i])) throw new Error('query vector is not finite');
    }
    const excludeRow = opts.excludeRow ?? -1;
    const filter = opts.filter ?? null;

    /**
     * `opts.mask` — narrow the search with data instead of a predicate.
     *
     * It **replaces** this index's own mask rather than adding to it, so a
     * caller that has one must combine them itself. That is deliberate: the
     * callers who narrow (a corpus restricting to one book) do it the same way
     * on every search, and can build the combined mask once and keep it,
     * instead of this allocating and ANDing `n` bytes per query.
     *
     * Why not just use `filter`: a predicate is a JavaScript function, and a
     * kernel written in something other than JavaScript cannot call one 60,000
     * times without giving back everything it saved. A mask is bytes, and the
     * kernel already takes one. So a narrowing expressible as data stays fast
     * and a genuinely arbitrary one is honestly slow.
     */
    if (opts.mask && opts.mask.length !== n) {
      throw new Error(`mask length ${opts.mask.length} != ${n}`);
    }
    const mask = opts.mask || this.mask;

    /**
     * `opts.kernel` — someone else's scan, for a runtime where this loop is too
     * slow to be an interaction.
     *
     * It exists for one measured reason: Hermes has no JIT, and on a Pixel 7
     * Pro this loop takes **527ms** over the 60,403-row Gurmukhi index where V8
     * takes 14.6ms. That is not a wait, it is a frozen screen. Nothing on a
     * server ever passes this, and the default remains the loop below.
     *
     * The contract is the whole of it: given the same buffers it must return
     * the same rows with the same **rounded** scores, so that the ordering —
     * higher score first, lower row on a tie — is identical. Rounding happens
     * inside the kernel, on the raw dot product times the row's scale, exactly
     * as `roundScore` does here; a kernel that rounds later, or accumulates in
     * float32 rather than double, can reorder a tie. `apps/mobile/test/
     * kernel-seam.test.js` holds a reference kernel to that, and the app checks
     * its native one against this loop on the device itself.
     *
     * A `filter` keeps the scan here: it is a JavaScript predicate per row, and
     * calling back into JS 60,403 times would cost more than the scan it saved.
     */
    if (opts.kernel && !filter) {
      const hits = opts.kernel({ codes, scales, mask, dim, n, query, k, excludeRow });
      const res = hits.map(h => ({ id: this.idAt(h.row), row: h.row, score: h.score }));
      res.sort((a, b) => (b.score - a.score) || (a.row - b.row));
      return res;
    }

    const heap = new TopKHeap(k);
    for (let row = 0; row < n; row += 1) {
      if (row === excludeRow) continue;
      if (mask && mask[row] === 0) continue;
      if (filter && !filter(this.idAt(row))) continue;
      const base = row * dim;
      let acc = 0;
      for (let i = 0; i < dim; i += 1) acc += query[i] * codes[base + i];
      heap.push(row, roundScore(acc * scales[row]));
    }
    return heap.toSortedArray(r => this.idAt(r));
  }

  /** Nearest neighbours of an item already in the index. */
  similarTo(id, k = 10, opts = {}) {
    const row = this.rowOf(id);
    if (row < 0) return [];
    // A masked row is kept out of results; it must be kept out of the question
    // too. Lines with no text all embed to the same vector, so asked for their
    // neighbours they returned k confident, meaningless ones.
    if (this.mask && this.mask[row] === 0) return [];
    return this.search(this.vectorAt(row), k, { ...opts, excludeRow: row });
  }
}

/** Build from raw buffers as loaded from the shipped artifacts. */
function loadIndex({ codesBuf, scalesBuf, dim, idsBuf = null, maskBuf = null }) {
  return new VectorIndex(
    new Int8Array(codesBuf),
    new Float32Array(scalesBuf),
    dim,
    idsBuf ? new Int32Array(idsBuf) : null,
    maskBuf ? new Uint8Array(maskBuf) : null,
  );
}

module.exports = { VectorIndex, loadIndex, roundScore, SCORE_PRECISION };
