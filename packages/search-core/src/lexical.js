'use strict';
/**
 * First-letter search over the offline index.
 *
 * Portable by construction: the only thing injected is a `db` with
 *   all(sql, params) -> rows
 * so the same code runs on node:sqlite today and on a React Native SQLite
 * driver later. No DOM, no Node built-ins, no vector index required -- lexical
 * search must keep working with the semantic artifacts entirely absent.
 */
const g = require('./gurmukhi.js');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 1000;

/**
 * A page size SQLite will take. The server clamps its own `limit`, but the
 * phone calls these directly: NaN, Infinity or 2.5 reached `LIMIT ?` as a
 * "datatype mismatch" throw, and -1 or 1e9 meant every matching line -- all
 * 25,817 of them for one letter. Whole numbers 0..1000; anything else is the
 * default.
 */
function limitOf(v) {
  if (v === undefined || v === null) return DEFAULT_LIMIT;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_LIMIT, Math.floor(n))) : DEFAULT_LIMIT;
}

/**
 * Range predicate equivalent to BaniDB's `t.token BETWEEN ? AND ?`.
 * Because codes are zero-padded to 3 digits and 'z' sorts above every digit,
 * [q, q||',z'] is exactly the set of tokens having q as a prefix.
 */
function rangeClause(alias) {
  return `${alias}.token BETWEEN ? AND ?`;
}

/**
 * First letter ANYWHERE in the line.
 * @param {{all:(sql:string,params:any[])=>any[]}} db
 * @param {string} input  Gurmukhi (Unicode or ASCII keymap) letters
 */
function firstLetterAnywhere(db, input, opts = {}) {
  const limit = limitOf(opts.limit);
  const query = g.buildQuery(input);
  if (!query) return [];

  const ranges = [[query, g.wildcard(query)]];
  // A query typed without nuktas should still match lines that carry them.
  const variant = g.bindiVariant(query);
  if (variant) ranges.push([variant, g.wildcard(variant)]);

  const where = ranges.map(() => rangeClause('t')).join(' OR ');
  const params = ranges.flat();

  // MIN(t.pos) keeps the earliest match position for highlighting.
  const sql = `
    SELECT l.line_id, l.verse_id, l.shabad_id, l.ang, l.gurmukhi_uni,
           l.first_letters_ascii, l.kind, MIN(t.pos) AS match_pos
    FROM firstletter_tokens t
    JOIN lines l ON l.line_id = t.line_id
    WHERE ${where}
    GROUP BY l.line_id
    ORDER BY LENGTH(l.first_letters_ascii) ASC, l.line_id ASC
    LIMIT ?`;
  return db.all(sql, [...params, limit]);
}

/** First letter at the START of the line. */
function firstLetterStart(db, input, opts = {}) {
  const limit = limitOf(opts.limit);
  const query = g.buildQuery(input);
  if (!query) return [];

  const ranges = [[query, g.wildcard(query)]];
  const variant = g.bindiVariant(query);
  if (variant) ranges.push([variant, g.wildcard(variant)]);

  const where = ranges.map(() => 'l.first_letters_codes BETWEEN ? AND ?').join(' OR ');
  const sql = `
    SELECT l.line_id, l.verse_id, l.shabad_id, l.ang, l.gurmukhi_uni,
           l.first_letters_ascii, l.kind, 0 AS match_pos
    FROM lines l
    WHERE ${where}
    ORDER BY LENGTH(l.first_letters_ascii) ASC, l.line_id ASC
    LIMIT ?`;
  return db.all(sql, [...ranges.flat(), limit]);
}

/** Count of matches without paging, for result-count UI. */
function firstLetterAnywhereCount(db, input) {
  const query = g.buildQuery(input);
  if (!query) return 0;
  const ranges = [[query, g.wildcard(query)]];
  const variant = g.bindiVariant(query);
  if (variant) ranges.push([variant, g.wildcard(variant)]);
  const where = ranges.map(() => rangeClause('t')).join(' OR ');
  const row = db.all(
    `SELECT COUNT(DISTINCT t.line_id) AS c FROM firstletter_tokens t WHERE ${where}`,
    ranges.flat())[0];
  return row ? row.c : 0;
}

module.exports = { firstLetterAnywhere, firstLetterStart, firstLetterAnywhereCount, DEFAULT_LIMIT, MAX_LIMIT };
