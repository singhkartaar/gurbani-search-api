'use strict';
/**
 * The keertan notations: a store over artifacts/notations.sqlite.
 *
 * 32_build_notations_db.py writes the database; this reads it for the web
 * app and the public API. It knows nothing about Node beyond the adapter it
 * is given (`all(sql, params)`), so a phone can carry it later. The columns
 * are pinned in notation-columns.json (a mirror of the pipeline's
 * lib/notation_columns.json); a database whose columns differ is refused at
 * open, because the alternative is a page that renders the wrong field.
 *
 * What it answers:
 *   summary()      what /api/health reports
 *   roster()       the facets a reader browses by: raags (used and prescribed),
 *                  authors, books, taals, each with counts
 *   countFor(id)   how many notations a shabad has (O(1), a Map)
 *   attachCounts() adds `notations: n` to search rows that have a shabad_id
 *   list(filter)   cards, paged, filtered by raag/author/book/taal/shabad and
 *                  a query that finds any line of the shabad: Gurmukhi, Roman
 *                  or first letters
 *   get(id)        one notation: the card, the heading, the parsed grid, its
 *                  images (release URL or local path), and the shabad's header
 *
 * The scan is the authority. `grid` is what the machine read from it, with
 * its confidence; the app shows the crop first and the grid as the English
 * alternate view, badged as machine-read unless `verified`.
 */
const COLUMNS = require('./notation-columns.json').tables;
const g = require('./gurmukhi.js');

// how a writer is named on the page, by author_key, over the name the books' manifests gave
// the database ("Prin Dyal Singh"); a published database is never edited, so the name is set here
const AUTHOR_NAMES = {
  'prin-dyal-singh': 'Principal (Gyani) Dyal Singh Ji',
  'prof-tara-singh': 'Professor Tara Singh Ji',
};

// and each book's title and part as the page names them: the manifests gave some a file
// name ("gurmat sangeet sagar part 3") and only part 1 its number
const BOOKS = {
  'gurmat-sangeet-sagar-1': { title: 'Gurmat Sangeet Sagar', part: 1 },
  'gurmat-sangeet-sagar-part-2': { title: 'Gurmat Sangeet Sagar', part: 2 },
  'gurmat-sangeet-sagar-part-3': { title: 'Gurmat Sangeet Sagar', part: 3 },
  'gurmat-sangeet-sagar-part-4': { title: 'Gurmat Sangeet Sagar', part: 4 },
  'guru-ram-das-rag-ratnavali': { title: 'Guru Raam Daas Raag Ratnaavli' },
  'guru-arjun-dev-rag-ratnavali': { title: 'Guru Arjun Dev Raag Ratnaavli' },
  'guru-amardass-raag-ratnakar-punjabi-by-prof-tara-singh': { title: 'Guru Amardaas Raag Ratnakar' },
  'guru-tegh-bahadur-rag-ratnavali': { title: 'Guru Tegh Bahadur Raag Ratnaavli' },
  'bhagat-raag-ratnavali': { title: 'Bhagat Raag Ratnaavli' },
};

const PAGE_MAX = 100;
const Q_MAX = 120;
const CHUNK = 500;

function rowsOf(db, sql, params = []) {
  return db.all(sql, params);
}

function parseJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** Gurmukhi folded for matching: NFC, no nukta, no addak, one space. */
function foldGurmukhi(s) {
  return String(s || '').normalize('NFC').replace(/[਼ੱ]/g, '').replace(/\s+/g, ' ').trim();
}

function foldRoman(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

class NotationsStore {
  /**
   * @param db       adapter over notations.sqlite
   * @param gurbani  adapter over gurbani.sqlite, or null: then cards carry
   *                 the first line the pipeline stored and no transliteration
   */
  constructor({ db, gurbani = null }) {
    this.db = db;
    this.gurbani = gurbani;
    this.checkColumns();
    this.meta = Object.fromEntries(rowsOf(db, 'SELECT key, value FROM meta').map(r => [r.key, r.value]));
    this.raags = new Map(rowsOf(db, 'SELECT * FROM raags').map(r => [r.key, { ...r, aliases: parseJson(r.aliases, { pa: [], en: [] }) }]));
    this.taals = new Map(rowsOf(db, 'SELECT * FROM taals').map(r => [r.key, { ...r, vibhag: parseJson(r.vibhag, []), tali: parseJson(r.tali, []), khali: parseJson(r.khali, []) }]));
    this.authors = new Map(rowsOf(db, 'SELECT * FROM authors')
      .map(r => [r.author_key, { ...r, name: AUTHOR_NAMES[r.author_key] || r.name }]));
    this.books = new Map(rowsOf(db, 'SELECT * FROM books')
      .map(r => ({ ...r, ...BOOKS[r.book_key], style: parseJson(r.style, {}) }))
      .sort((a, b) => a.author_key.localeCompare(b.author_key) || (a.part ?? 0) - (b.part ?? 0)
                      || String(a.title).localeCompare(String(b.title)))
      .map(r => [r.book_key, r]));
    this.counts = new Map(rowsOf(db, 'SELECT shabad_id, n FROM shabad_counts').map(r => [r.shabad_id, r.n]));
    this.shabadLines = new Map();
    this.firstLines = this.loadFirstLines();
  }

  checkColumns() {
    for (const [table, want] of Object.entries(COLUMNS)) {
      const have = rowsOf(this.db, `PRAGMA table_info(${table})`).map(r => r.name);
      if (have.join(',') !== want.join(',')) {
        throw new Error(`notations.sqlite: table ${table} has columns [${have.join(', ')}], the app expects [${want.join(', ')}]; rebuild the database with 32_build_notations_db.py`);
      }
    }
  }

  /**
   * The first line of every shabad that has a notation, from the corpus when
   * it is there; every line of it goes to `shabadLines`, for the query.
   */
  loadFirstLines() {
    const out = new Map();
    const ids = [...this.counts.keys()];
    if (!this.gurbani || !ids.length) return out;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const rows = rowsOf(this.gurbani,
        `SELECT shabad_id, gurmukhi_uni, translit_roman, first_letters_ascii, writer, raag, ang
           FROM lines WHERE shabad_id IN (${chunk.map(() => '?').join(',')}) AND kind IN ('line','rahao')
          ORDER BY shabad_id, position_in_shabad`, chunk);
      for (const r of rows) {
        if (!this.shabadLines.has(r.shabad_id)) this.shabadLines.set(r.shabad_id, []);
        this.shabadLines.get(r.shabad_id).push({
          gurmukhi_uni: r.gurmukhi_uni, folded: foldGurmukhi(r.gurmukhi_uni), roman: foldRoman(r.translit_roman),
          letters: String(r.first_letters_ascii || ''), codes: r.first_letters_ascii ? g.encodeCharCodes(r.first_letters_ascii) : '',
        });
        if (!out.has(r.shabad_id)) {
          out.set(r.shabad_id, {
            gurmukhi_uni: r.gurmukhi_uni, translit_roman: r.translit_roman, first_letters_ascii: r.first_letters_ascii,
            writer: r.writer, raag: r.raag, ang: r.ang,
            folded: foldGurmukhi(r.gurmukhi_uni), roman: foldRoman(r.translit_roman),
          });
        }
      }
    }
    return out;
  }

  summary() {
    const m = this.meta;
    return {
      enabled: true,
      books: Number(m.books || 0), notations: Number(m.notations || 0), shabads: Number(m.shabads || 0),
      images: Number(m.images || 0), images_published: Number(m.images_published || 0),
      verified: [...this.books.values()].reduce((n, b) => n + (b.verified || 0), 0),
      parser_version: m.parser_version || null, vocab_version: m.vocab_version || null, built: m.built || null,
    };
  }

  countFor(shabadId) {
    return this.counts.get(Number(shabadId)) || 0;
  }

  /** Search rows (lines or shabads) with `notations: n` where n > 0. Additive; O(1) a row. */
  attachCounts(rows) {
    for (const r of rows || []) {
      if (r && r.shabad_id !== undefined && r.shabad_id !== null) {
        const n = this.counts.get(Number(r.shabad_id));
        if (n) r.notations = n;
      }
    }
    return rows;
  }

  known(kind, key) {
    if (kind === 'raag') return this.raags.has(key);
    if (kind === 'taal') return this.taals.has(key);
    if (kind === 'author') return this.authors.has(key);
    if (kind === 'book') return this.books.has(key);
    return false;
  }

  /** A raag's place in the Granth: its own, or its parent's for a form such as Gauri Purbi. */
  granthOrder(r) {
    if (r.ggs_order) return r.ggs_order;
    const parent = r.parent_key ? this.raags.get(r.parent_key) : null;
    return (parent && parent.ggs_order) || 99;
  }

  roster() {
    const used = new Map(rowsOf(this.db, 'SELECT raag_used_key k, COUNT(*) n FROM notations WHERE raag_used_key IS NOT NULL GROUP BY raag_used_key').map(r => [r.k, r.n]));
    const prescribed = new Map(rowsOf(this.db, 'SELECT raag_shabad_key k, COUNT(*) n FROM notations WHERE raag_shabad_key IS NOT NULL GROUP BY raag_shabad_key').map(r => [r.k, r.n]));
    const byTaal = new Map(rowsOf(this.db, 'SELECT taal_key k, COUNT(*) n FROM notations WHERE taal_key IS NOT NULL GROUP BY taal_key').map(r => [r.k, r.n]));
    const byAuthor = new Map(rowsOf(this.db, 'SELECT author_key k, COUNT(*) n FROM notations GROUP BY author_key').map(r => [r.k, r.n]));
    const notes = new Map(rowsOf(this.db, 'SELECT raag_key k, COUNT(*) n FROM raag_notes WHERE raag_key IS NOT NULL GROUP BY raag_key').map(r => [r.k, r.n]));
    const raags = [...this.raags.values()]
      .filter(r => used.has(r.key) || prescribed.has(r.key) || notes.has(r.key))
      .map(r => ({ key: r.key, english: r.english, gurmukhi: r.gurmukhi, in_ggs: Boolean(r.in_ggs), parent_key: r.parent_key,
                   ggs_order: r.ggs_order, used: used.get(r.key) || 0, prescribed: prescribed.get(r.key) || 0, notes: notes.get(r.key) || 0 }))
      .sort((a, b) => (b.in_ggs - a.in_ggs) || (this.granthOrder(a) - this.granthOrder(b))
                      || ((a.parent_key ? 1 : 0) - (b.parent_key ? 1 : 0)) || a.english.localeCompare(b.english));
    const taals = [...this.taals.values()].filter(t => byTaal.has(t.key))
      .map(t => ({ key: t.key, english: t.english, gurmukhi: t.gurmukhi, matras: t.matras, n: byTaal.get(t.key) }))
      .sort((a, b) => b.n - a.n);
    const authors = [...this.authors.values()].map(a => ({ author_key: a.author_key, name: a.name, name_gurmukhi: a.name_gurmukhi, n: byAuthor.get(a.author_key) || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const books = [...this.books.values()].map(b => ({
      book_key: b.book_key, title: b.title, title_en: b.title_en, author_key: b.author_key, part: b.part,
      publisher: b.publisher, year: b.year, source_url: b.source_url, pages: b.pages,
      notations: b.notations, resolved: b.resolved, verified: b.verified, passed_bar: Boolean(b.passed_bar),
    }));
    return { ...this.summary(), raags, taals, authors, books };
  }

  /**
   * Cards, filtered and paged. Unknown keys are the caller's 400: check with
   * known() first. `q` finds a shabad by any of its lines: a Gurmukhi or
   * Roman substring, or first letters from any word on (Gurmukhi or the
   * corpus's ASCII), as the main letter search reads them. A card found by a
   * line other than its first carries that line as `matched_line`.
   */
  list({ raag = null, shabadRaag = null, author = null, book = null, taal = null, shabad = null, q = '',
         verified = false, k = 20, page = 1 } = {}) {
    const where = [];
    const params = [];
    if (raag) { where.push('(n.raag_used_key = ? OR n.raag_used_parent_key = ?)'); params.push(raag, raag); }
    if (shabadRaag) { where.push('n.raag_shabad_key = ?'); params.push(shabadRaag); }
    if (author) { where.push('n.author_key = ?'); params.push(author); }
    if (book) { where.push('n.book_key = ?'); params.push(book); }
    if (taal) { where.push('n.taal_key = ?'); params.push(taal); }
    if (shabad !== null && shabad !== undefined) { where.push('n.shabad_id = ?'); params.push(Number(shabad)); }
    if (verified) where.push('n.verified = 1');
    const query = String(q || '').trim().slice(0, Q_MAX);
    let matched = null;
    if (query) {
      matched = this.matchLines(query);
      if (!matched.size) return { total: 0, page: 1, k, results: [] };
      const ids = [...matched.keys()];
      where.push(`n.shabad_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = rowsOf(this.db, `SELECT COUNT(*) c FROM notations n ${w}`, params)[0].c;
    const size = Math.max(1, Math.min(PAGE_MAX, Number(k) || 20));
    const pages = Math.max(1, Math.ceil(total / size));
    const p = Math.max(1, Math.min(pages, Number(page) || 1));
    const rows = rowsOf(this.db,
      // the card's picture: a published thumbnail, else the first crop itself (the crops are small 1-bit PNGs, so
      // thumbnails need not be published at all), else whatever local file a self-hoster serves
      `SELECT n.*, COALESCE(i.url, f.url) thumb_url,
              CASE WHEN i.url IS NOT NULL THEN i.path WHEN f.url IS NOT NULL THEN f.path ELSE COALESCE(i.path, f.path) END thumb_path
         FROM notations n
         LEFT JOIN images i ON i.notation_id = n.notation_id AND i.kind = 'thumb' AND i.n = 1
         LEFT JOIN images f ON f.notation_id = n.notation_id AND f.kind = 'full' AND f.n = 1
         ${w}
         ORDER BY n.shabad_id IS NULL, n.ang IS NULL, n.ang, n.book_key, n.ordinal
         LIMIT ? OFFSET ?`, [...params, size, (p - 1) * size]);
    const results = rows.map(r => {
      const c = this.card(r);
      const line = matched && matched.get(r.shabad_id);
      if (line && line !== c.first_line) c.matched_line = line;
      return c;
    });
    return { total, page: p, pages, k: size, results };
  }

  /**
   * The shabads a query finds, each with the first of its lines that matched.
   * Words match as typed (a substring of a line); a query without spaces may
   * also be first letters, from any word of a line on, nuktas optional.
   */
  matchLines(query) {
    const out = new Map();
    const isGurmukhi = /[਀-੿]/.test(query);
    const words = isGurmukhi ? foldGurmukhi(query) : foldRoman(query);
    const bare = !/\s/.test(query.trim());
    // a vowel typed whole (ਊ) is its carrier (ੳ) among first letters, as the corpus stores them
    const codes = bare ? g.buildQuery(query.replace(/[ਆਐਔ]/g, 'ਅ').replace(/[ਇਈਏ]/g, 'ੲ').replace(/[ਉਊਓ]/g, 'ੳ')) : '';
    const codeQs = codes && codes.split(',').length > 2 ? [codes, g.bindiVariant(codes)].filter(Boolean) : [];
    // the corpus's first letters are ASCII with case (a is ੳ, A is ਅ); a Latin query is also tried without it
    const lower = !isGurmukhi && bare && query.length >= 2 ? query.toLowerCase() : '';
    const hit = l => (isGurmukhi ? l.folded.includes(words) : (words && l.roman.includes(words)))
      || codeQs.some(c => l.codes.includes(c))
      || (lower && l.letters.toLowerCase().includes(lower));
    for (const [id, lines] of this.shabadLines) {
      const l = lines.find(hit);
      if (l) out.set(id, l.gurmukhi_uni);
    }
    // no corpus at hand: the stored first lines still answer a Gurmukhi query
    if (!this.shabadLines.size && isGurmukhi) {
      for (const r of rowsOf(this.db, 'SELECT DISTINCT shabad_id, first_line FROM notations WHERE shabad_id IS NOT NULL')) {
        if (foldGurmukhi(r.first_line).includes(words)) out.set(r.shabad_id, r.first_line);
      }
    }
    return out;
  }

  card(r) {
    const fl = r.shabad_id !== null ? this.firstLines.get(r.shabad_id) : null;
    const book = this.books.get(r.book_key) || {};
    const author = this.authors.get(r.author_key) || {};
    return {
      notation_id: r.notation_id, book_key: r.book_key, book_title: book.title || r.book_key, book_title_en: book.title_en || null,
      part: book.part ?? null, author_key: r.author_key, author: author.name || r.author_key,
      page_start: r.page_start, page_end: r.page_end, kind: r.kind,
      shabad_id: r.shabad_id, shabad_source: r.shabad_source, ang: r.ang,
      first_line: (fl && fl.gurmukhi_uni) || r.first_line || null,
      translit_roman: fl ? fl.translit_roman : null,
      writer: r.writer || (fl && fl.writer) || null,
      raag_shabad: r.raag_shabad, raag_shabad_key: r.raag_shabad_key,
      raag_used: r.raag_used, raag_used_key: r.raag_used_key, raag_used_parent_key: r.raag_used_parent_key,
      raag_used_en: r.raag_used_key && this.raags.has(r.raag_used_key) ? this.raags.get(r.raag_used_key).english : null,
      raag_differs: Boolean(r.raag_differs),
      taal: r.taal, taal_key: r.taal_key, taal_en: r.taal_key && this.taals.has(r.taal_key) ? this.taals.get(r.taal_key).english : null,
      matras: r.matras, laya: r.laya, partaal: Boolean(r.partaal),
      sections: r.sections, beats: r.beats, has_grid: r.grid !== null && r.grid !== undefined,
      confidence: r.confidence, verified: Boolean(r.verified), flags: parseJson(r.flags, []),
      // the review ledger's verdict when the database was built: 'accepted', 'backlog', or null (not looked at yet)
      review_status: r.review_status || null, review_comment: r.review_comment || null,
      image_count: r.image_count,
      thumb: r.thumb_url || r.thumb_path ? { url: r.thumb_url || null, path: r.thumb_path || null } : null,
    };
  }

  /** One notation whole, or null. */
  get(notationId) {
    const r = rowsOf(this.db, 'SELECT * FROM notations WHERE notation_id = ?', [String(notationId)])[0];
    if (!r) return null;
    const images = rowsOf(this.db, 'SELECT n, kind, role, page, path, url, bbox, w, h, bytes, sha256 FROM images WHERE notation_id = ? ORDER BY n, kind', [r.notation_id])
      .map(i => ({ ...i, bbox: parseJson(i.bbox, null) }));
    const card = this.card(r);
    const grid = parseJson(r.grid, null);
    const notation = {
      ...card,
      heading: r.heading,
      resolve_method: r.resolve_method, resolve_score: r.resolve_score, confidences: parseJson(r.confidences, {}),
      line_ids: parseJson(r.line_ids, []),
      sargam_en: r.sargam_en,
      grid,
      taal_info: r.taal_key && this.taals.has(r.taal_key) ? this.taals.get(r.taal_key) : null,
      images,
      others: r.shabad_id !== null ? Math.max(0, this.countFor(r.shabad_id) - 1) : 0,
    };
    return { notation, shabad: r.shabad_id !== null ? this.shabadHeader(r.shabad_id) : null };
  }

  /** What the books say about a raag: the descriptions, with their crops. */
  raagNotes(raagKey) {
    return rowsOf(this.db, 'SELECT * FROM raag_notes WHERE raag_key = ? ORDER BY book_key, n', [String(raagKey)])
      .map(r => ({ ...r, pages: parseJson(r.pages, []), book_title: (this.books.get(r.book_key) || {}).title || r.book_key,
                   author: (this.authors.get((this.books.get(r.book_key) || {}).author_key) || {}).name || null }));
  }

  shabadHeader(shabadId) {
    const fl = this.firstLines.get(Number(shabadId)) || null;
    return {
      shabad_id: Number(shabadId), notations: this.countFor(shabadId),
      first_line: fl ? fl.gurmukhi_uni : null, translit_roman: fl ? fl.translit_roman : null,
      writer: fl ? fl.writer : null, raag: fl ? fl.raag : null, ang: fl ? fl.ang : null,
    };
  }

  /**
   * Where an image can be fetched from: its release URL (prefix rewritten to
   * `urlBase` when a mirror is configured), else `localBase` + path when the
   * server serves the crops itself, else null.
   */
  static imageUrl(image, { localBase = null, urlBase = null, releaseBase = null } = {}) {
    if (!image) return null;
    if (image.url) {
      if (urlBase && releaseBase && image.url.startsWith(releaseBase)) return urlBase.replace(/\/+$/, '') + '/' + image.url.slice(releaseBase.length).replace(/^\/+/, '');
      return image.url;
    }
    if (localBase && image.path) return localBase.replace(/\/+$/, '') + '/' + String(image.path).replace(/^\/+/, '');
    return null;
  }
}

module.exports = { NotationsStore, NOTATION_COLUMNS: COLUMNS, foldGurmukhi, foldRoman };
