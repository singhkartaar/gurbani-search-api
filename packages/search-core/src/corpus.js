'use strict';
/**
 * A prose corpus: a body of writing ABOUT Gurbani, searchable by meaning.
 *
 * There is one store per corpus -- Bau Ji's English essays, Prof. Puran
 * Singh's books -- each with its own directory of vectors, its own database
 * and its own encoder, and nothing in this file names any of them.
 *
 * It is deliberately NOT another index in the Gurbani sense. Those address the
 * Granth -- their ids are line and shabad ids, and every route resolves them
 * against gurbani.sqlite. A corpus unit_row of 4,112 fused into that space
 * would render Gurbani line 4,112: not an error, a wrong verse shown as if it
 * were right. So a corpus keeps its own id space, its own store and its own
 * retrieval, and the two meet only where a passage names a shabad.
 *
 * What it does reuse is everything that does not care what an id means:
 * vectors.js (int8 codes with a per-vector scale), projectQuery (the saved
 * PCA) and the query encoder its manifest asks for. Like artifacts.js, the
 * only I/O is an injected reader, so the same store loads on a server from
 * the filesystem and on a phone from a downloaded tier.
 *
 * `unit_row` is both the vector row and the primary key in the database, so a
 * search result indexes straight into the text with nothing in between.
 */
const { loadIndex } = require('./vectors.js');
const { projectQuery } = require('./artifacts.js');
const { normalizeManifest, canRead } = require('./registry.js');

const FILES = ['units.i8', 'units.scale.f32', 'units.mask.u8', 'pca.components.f32', 'pca.mean.f32'];

const toArrayBuffer = b => {
  if (b instanceof ArrayBuffer) return b;
  if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength) return b.buffer;
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

/** A corpus manifest read the way an index manifest is, so canRead and friends apply. */
function corpusMeta(manifest) {
  return normalizeManifest({ ...manifest, index: manifest.corpus || manifest.index || 'corpus' });
}

/**
 * Build the in-memory half of a corpus from bytes already read: the manifest
 * (parsed) and the five vector files. Synchronous, so a caller with the bytes
 * in hand -- a server reading its own disk -- need not go through a promise.
 *
 * @param {object} manifest
 * @param {Record<string, ArrayBuffer|Uint8Array>} bytes  keyed by file name
 */
function corpusFromBytes(manifest, bytes) {
  for (const f of FILES) if (!bytes[f]) throw new Error(`corpus: ${f} missing`);
  const dim = manifest.index_dim;
  const units = loadIndex({
    codesBuf: toArrayBuffer(bytes['units.i8']),
    scalesBuf: toArrayBuffer(bytes['units.scale.f32']),
    maskBuf: toArrayBuffer(bytes['units.mask.u8']),
    dim,
  });
  const pca = {
    components: new Float32Array(toArrayBuffer(bytes['pca.components.f32'])),
    mean: new Float32Array(toArrayBuffer(bytes['pca.mean.f32'])),
    inDim: manifest.embed_dim,
    outDim: dim,
  };
  return { manifest, meta: corpusMeta(manifest), units, pca };
}

/**
 * Load a corpus's vectors through an injected reader, exactly as
 * loadArtifacts does for an index.
 *
 * @param {(name:string)=>Promise<ArrayBuffer|Uint8Array>} readFile
 */
async function loadCorpus(readFile) {
  const manifest = JSON.parse(new TextDecoder().decode(
    new Uint8Array(toArrayBuffer(await readFile('manifest.json')))));
  const bytes = {};
  for (const f of FILES) bytes[f] = await readFile(f);
  return corpusFromBytes(manifest, bytes);
}

class CorpusStore {
  /**
   * @param {object} o
   * @param {object} o.art      what loadCorpus / corpusFromBytes returned
   * @param {object} o.db       an adapter over this corpus's sqlite: { all(sql, params) }
   * @param {object} [o.encoder] a query encoder built from this manifest; null
   *   means the store can be read and browsed but not searched by text
   * @param {Function} [o.kernel] a scan for `VectorIndex.search`'s `opts.kernel`.
   *   Null on a server, where the JavaScript loop is fast enough; the phone
   *   passes its native one, because Hermes is not. See vectors.js.
   */
  constructor({ art, db, encoder = null, kernel = null }) {
    this.manifest = art.manifest;
    this.meta = art.meta;
    this.units = art.units;
    this.pca = art.pca;
    this.db = db;
    this.encoder = encoder;
    this.kernel = kernel;
    this.workMasks = new Map();     // work_id -> Uint8Array, built once; see maskForWork
    this.works = db.all('SELECT * FROM works ORDER BY title', []);
    // which work each row belongs to, so a reader can search inside one book.
    // A few thousand short strings; the alternative is a query per search.
    this.workOf = [];
    for (const r of db.all('SELECT unit_row, work_id FROM units ORDER BY unit_row', [])) {
      this.workOf[r.unit_row] = r.work_id;
    }
  }

  /** Can this corpus's model embed this text? Gurmukhi needs a model that reads it. */
  canRead(text) { return canRead(this.meta, text); }

  hasWork(workId) { return this.works.some(w => w.work_id === workId); }

  /**
   * The passages nearest ONE query vector, by cosine, best first.
   *
   * This is what a search shows a reader: a real score per passage, and none
   * below `minScore` -- a question with two relevant passages returns two,
   * not ten with eight strangers padding the list. The Ask pipeline uses
   * search() below instead, because it has several query forms to fuse.
   *
   * @returns {Array<{unit_row: number, score: number}>}
   */
  nearest(vec, k = 10, { work = null, minScore = -Infinity } = {}) {
    return this.units.search(vec, k, this.scanOpts(work))
      .map(h => ({ unit_row: h.id, score: h.score }))
      .filter(h => h.score >= minScore);
  }

  /**
   * The rows belonging to one work, as a mask the scan can use directly.
   *
   * Narrowing to a book used to be a `filter` predicate, which is correct and
   * shuts a native kernel out — `VectorIndex.search` will not hand a scan it
   * cannot call back into a JavaScript function. As a mask it is just bytes,
   * and the kernel takes one, so searching inside a book is as fast as
   * searching all of them. On the phone that is the difference between about
   * 100ms and about 6ms.
   *
   * The index's own mask is folded in here, because `opts.mask` replaces
   * rather than adds. Built once per work and kept: a corpus has at most a few
   * dozen works and its longest is 11,119 rows, so the whole cache is a few
   * hundred kilobytes even if a reader visits every book.
   */
  maskForWork(work) {
    let m = this.workMasks.get(work);
    if (m) return m;
    const own = this.units.mask;
    m = new Uint8Array(this.units.n);
    for (let row = 0; row < m.length; row += 1) {
      m[row] = (this.workOf[row] === work && (!own || own[row] === 1)) ? 1 : 0;
    }
    this.workMasks.set(work, m);
    return m;
  }

  /** What to hand the scan: the kernel when there is one, the work's mask when narrowed. */
  scanOpts(work) {
    const opts = {};
    if (this.kernel) opts.kernel = this.kernel;
    if (work) opts.mask = this.maskForWork(work);
    return opts;
  }

  /**
   * The passages closest to each of several query vectors, fused by rank.
   *
   * fuseBy is not used here because there is one list per query form over one
   * id space; a plain reciprocal-rank sum over the forms is the whole of it.
   *
   * `work` narrows the search to one book. The narrowing happens inside the
   * scan rather than over its results, so asking within a short work still
   * returns a full set of candidates instead of whatever survived a global
   * top-40. See maskForWork for why it is a mask and not a predicate.
   */
  search(queryVecs, k = 20, depth = 40, work = null) {
    const scores = new Map();
    const opts = this.scanOpts(work);
    for (const vec of queryVecs) {
      const hits = this.units.search(vec, depth, opts);
      hits.forEach((hit, rank) => {
        const row = hit.id ?? hit.row;
        scores.set(row, (scores.get(row) || 0) + 1 / (60 + rank + 1));
      });
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, k)
      .map(([unit_row, score]) => ({ unit_row, score }));
  }

  /** Rows of this corpus for the given unit_rows, in that order, with the verses they cite. */
  load(rows) {
    if (!rows.length) return [];
    const marks = rows.map(() => '?').join(',');
    const units = this.db.all(
      `SELECT u.unit_row, u.unit_id, u.work_id, u.part, u.page, u.para_no, u.marker, u.text,
              w.title, w.title_en, w.author, w.quote_policy, w.original
         FROM units u JOIN works w ON w.work_id = u.work_id
        WHERE u.unit_row IN (${marks})`, rows);
    const cites = this.db.all(
      `SELECT unit_row, shabad_id, line_id, ang, score, method, span
         FROM citations WHERE unit_row IN (${marks})`, rows);
    const byUnit = new Map();
    for (const c of cites) {
      if (!byUnit.has(c.unit_row)) byUnit.set(c.unit_row, []);
      byUnit.get(c.unit_row).push(c);
    }
    const order = new Map(rows.map((r, i) => [r, i]));
    return units
      .map(u => ({ ...u, original: Boolean(u.original), cites: byUnit.get(u.unit_row) || [] }))
      .sort((a, b) => order.get(a.unit_row) - order.get(b.unit_row));
  }

  /** Embed a question or phrase and project it into the corpus's own space. */
  async encode(text) {
    if (!this.encoder) throw new Error('corpus: no query encoder');
    return projectQuery(this.pca, await this.encoder.encodeQuery(text));
  }

  summary() {
    const meta = Object.fromEntries(this.db.all('SELECT key, value FROM meta', []).map(r => [r.key, r.value]));
    return {
      enabled: true,
      author: meta.author || null,
      corpus: this.manifest.corpus,
      work_count: this.works.length,
      units: Number(meta.units || 0),
      citations: Number(meta.citations || 0),
      model: this.manifest.model,
      query_scripts: this.meta.query_scripts,
      search: Boolean(this.encoder),
    };
  }
}

module.exports = { CorpusStore, loadCorpus, corpusFromBytes, corpusMeta, CORPUS_FILES: FILES };
