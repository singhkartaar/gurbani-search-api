'use strict';
/**
 * A notations.sqlite and a matching slice of gurbani.sqlite, built from the
 * pinned columns: what the store test and the web API test run against, so
 * neither needs the pipeline or the artifacts. Two books, four notations,
 * five images, two shabads.
 */
const { DatabaseSync } = require('node:sqlite');
const { NOTATION_COLUMNS } = require('../../src/notations.js');

/** notations.sqlite with the pinned columns and a handful of rows. */
function buildNotations(file, { dropColumn = null } = {}) {
  const db = new DatabaseSync(file);
  for (const [table, cols] of Object.entries(NOTATION_COLUMNS)) {
    const keep = cols.filter(c => !(dropColumn && dropColumn[0] === table && dropColumn[1] === c));
    db.exec(`CREATE TABLE ${table} (${keep.join(', ')})`);
  }
  const ins = (table, row) => {
    const cols = Object.keys(row).filter(c => !(dropColumn && dropColumn[0] === table && dropColumn[1] === c));
    db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c]));
  };
  for (const [k, v] of Object.entries({ schema: '1', parser_version: '0.1.0', vocab_version: '2026.09.1', built: '2026-09-30T00:00:00Z',
                                         books: '2', notations: '4', shabads: '2', images: '5', images_published: '1' })) ins('meta', { key: k, value: v });
  ins('raags', { key: 'bhairavi', gurmukhi: 'ਭੈਰਵੀ', english: 'Bhairavi', in_ggs: 0, parent_key: null, ggs_order: null, aliases: '{}' });
  ins('raags', { key: 'gauri', gurmukhi: 'ਗਉੜੀ', english: 'Gauri', in_ggs: 1, parent_key: null, ggs_order: 3, aliases: '{}' });
  ins('raags', { key: 'gauri_purbi', gurmukhi: 'ਗਉੜੀ ਪੂਰਬੀ', english: 'Gauri Purbi', in_ggs: 1, parent_key: 'gauri', ggs_order: null, aliases: '{}' });
  ins('raags', { key: 'sarang', gurmukhi: 'ਸਾਰੰਗ', english: 'Sarang', in_ggs: 1, parent_key: null, ggs_order: 27, aliases: '{}' });
  ins('taals', { key: 'dadra', gurmukhi: 'ਦਾਦਰਾ', english: 'Dadra', matras: 6, vibhag: '[3,3]', sam: 1, tali: '[1]', khali: '[4]' });
  ins('taals', { key: 'teentaal', gurmukhi: 'ਤੀਨਤਾਲ', english: 'Teentaal', matras: 16, vibhag: '[4,4,4,4]', sam: 1, tali: '[1,5,13]', khali: '[9]' });
  ins('authors', { author_key: 'prin-dyal-singh', name: 'Prin. Dyal Singh', name_gurmukhi: null });
  ins('authors', { author_key: 'prof-tara-singh', name: 'Prof. Tara Singh', name_gurmukhi: null });
  ins('books', { book_key: 'gss-1', title: 'ਗੁਰਮਤਿ ਸੰਗੀਤ ਸਾਗਰ', title_en: 'Gurmat Sangeet Sagar', author_key: 'prin-dyal-singh', part: 1, publisher: null, year: null,
                 source_url: null, style: '{}', pages: 373, notations: 3, resolved: 2, verified: 1, images_bytes: 1000, passed_bar: 0, built: 'x' });
  ins('books', { book_key: 'rr', title: 'ਰਾਗ ਰਤਨਾਵਲੀ', title_en: null, author_key: 'prof-tara-singh', part: null, publisher: null, year: null,
                 source_url: null, style: '{}', pages: 957, notations: 1, resolved: 1, verified: 0, images_bytes: 1000, passed_bar: 0, built: 'x' });
  const grid = JSON.stringify([{ kind: 'sthai', n: 1, lines: [{ kind: 'avartan', beats: [{ m: 1, notes: [{ s: 'S' }] }] }] }]);
  const base = { author_key: 'prin-dyal-singh', book_key: 'gss-1', kind: 'notation', shabad_source: 'G', line_ids: '[]', raag_shabad: 'Raag Gauri',
                 raag_shabad_key: 'gauri', raag_used: 'ਰਾਗ ਭੈਰਵੀ', raag_used_key: 'bhairavi', raag_used_parent_key: null, raag_differs: 1,
                 taal: 'ਦਾਦਰਾ', taal_key: 'dadra', matras: 6, laya: 'madh', partaal: 0, heading: 'h', sections: 1, beats: 6,
                 resolve_method: 'stream+ref', resolve_score: 0.9, confidence: 0.9, confidences: '{}', verified: 0, flags: '["raag-differs"]',
                 sargam_en: 'S R G', image_count: 1, grid };
  ins('notations', { ...base, notation_id: 'gss-1:0168:1', ordinal: 1, page_start: 167, page_end: 168, pages: '[167,168]', shabad_id: 913, ang: 269,
                     first_line: 'ਬਿਰਥੀ ਸਾਕਤ ਕੀ ਆਰਜਾ ॥', writer: 'Guru Arjan Dev Ji', verified: 1 });
  ins('notations', { ...base, notation_id: 'gss-1:0171:1', ordinal: 2, page_start: 170, page_end: 171, pages: '[170,171]', shabad_id: 4284, ang: 1208,
                     first_line: 'ਮਨ ਕਹਾ ਲੁਭਾਈਐ ਆਨ ਕਉ ॥', writer: 'Guru Arjan Dev Ji', raag_shabad: 'Raag Sarang', raag_shabad_key: 'sarang',
                     taal: 'ਤੀਨਤਾਲ', taal_key: 'teentaal', matras: 16 });
  ins('notations', { ...base, notation_id: 'gss-1:0174:1', ordinal: 3, page_start: 174, page_end: 174, pages: '[174]', shabad_id: null, ang: null,
                     first_line: null, writer: null, raag_shabad: null, raag_shabad_key: null, raag_differs: 0, kind: 'partial', grid: null,
                     sargam_en: null, resolve_method: 'none', resolve_score: null, confidence: 0, flags: '["unresolved-shabad","partial-grid"]' });
  ins('notations', { ...base, notation_id: 'rr:0500:1', author_key: 'prof-tara-singh', book_key: 'rr', ordinal: 1, page_start: 500, page_end: 500, pages: '[500]',
                     shabad_id: 913, ang: 269, first_line: 'ਬਿਰਥੀ ਸਾਕਤ ਕੀ ਆਰਜਾ ॥', writer: 'Guru Arjan Dev Ji',
                     raag_used: 'ਗਉੜੀ ਪੂਰਬੀ', raag_used_key: 'gauri_purbi', raag_used_parent_key: 'gauri', raag_differs: 0 });
  ins('images', { notation_id: 'gss-1:0168:1', n: 1, kind: 'full', role: 'grid', page: 168, path: 'gss-1/images/gss-1-0168-1-1.png',
                  url: 'https://github.com/o/r/releases/download/notations-gss-1-v1/a.png', bbox: '[1,2,3,4]', w: 100, h: 50, bytes: 10, sha256: 'a' });
  ins('images', { notation_id: 'gss-1:0168:1', n: 1, kind: 'thumb', role: 'grid', page: 168, path: 'gss-1/images/gss-1-0168-1-1.thumb.png',
                  url: null, bbox: '[1,2,3,4]', w: 320, h: 160, bytes: 5, sha256: 'b' });
  ins('images', { notation_id: 'gss-1:0168:1', n: 2, kind: 'full', role: 'shabad', page: 167, path: 'gss-1/images/gss-1-0168-1-2.png',
                  url: null, bbox: null, w: 100, h: 50, bytes: 10, sha256: 'c' });
  ins('images', { notation_id: 'gss-1:0171:1', n: 1, kind: 'full', role: 'grid', page: 171, path: 'gss-1/images/gss-1-0171-1-1.png',
                  url: null, bbox: null, w: 100, h: 50, bytes: 10, sha256: 'd' });
  ins('images', { notation_id: 'rr:0500:1', n: 1, kind: 'full', role: 'grid', page: 500, path: 'rr/images/rr-0500-1-1.png',
                  url: null, bbox: null, w: 100, h: 50, bytes: 10, sha256: 'e' });
  ins('shabad_counts', { shabad_id: 913, n: 2 });
  ins('shabad_counts', { shabad_id: 4284, n: 1 });
  db.close();
}

function buildGurbani(file) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE lines (line_id INTEGER PRIMARY KEY, shabad_id INTEGER, gurmukhi_uni TEXT, translit_roman TEXT, first_letters_ascii TEXT, writer TEXT, raag TEXT, ang INTEGER, kind TEXT, position_in_shabad INTEGER)');
  const ins = db.prepare('INSERT INTO lines VALUES (?,?,?,?,?,?,?,?,?,?)');
  ins.run(1000, 913, 'ਬਿਰਥੀ ਸਾਕਤ ਕੀ ਆਰਜਾ ॥', 'birathee saakat kee aarajaa ||', 'bskA', 'Guru Arjan Dev Ji', 'Raag Gauri', 269, 'line', 1);
  ins.run(1001, 913, 'ਸਾਚ ਬਿਨਾ ਕਹ ਹੋਵਤ ਸੂਚਾ ॥', 'saach binaa kah hovat soochaa ||', 'sbkhs', 'Guru Arjan Dev Ji', 'Raag Gauri', 269, 'line', 2);
  ins.run(2000, 4284, 'ਮਨ ਕਹਾ ਲੁਭਾਈਐ ਆਨ ਕਉ ॥', 'man kahaa lubhaaeeai aan kau ||', 'mklAk', 'Guru Arjan Dev Ji', 'Raag Sarang', 1208, 'rahao', 1);
  ins.run(3000, 5, 'ਕੋਈ ਹੋਰ ॥', 'koee hor ||', 'kh', 'x', 'Raag Asa', 400, 'line', 1);
  db.close();
}


module.exports = { buildNotations, buildGurbani };
