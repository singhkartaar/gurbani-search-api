#!/usr/bin/env node
'use strict';
/**
 * Ask a running server one of everything and print what came back.
 *
 *   npm start                    # in one terminal
 *   npm run smoke                # in another
 *   npm run smoke -- --base https://your-deployment --password hunter2
 *
 * Deliberately not a test: it hits a real deployment, prints a table a human
 * can read, and exits non-zero if anything is not 200. Use it after deploying,
 * when the question is "is this thing actually serving?".
 */
import process from 'node:process';

const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const BASE = (arg('--base') || process.env.GURBANI_API || 'http://localhost:5173').replace(/\/$/, '');
const PASSWORD = arg('--password') || process.env.APP_PASSWORD || '';
const headers = PASSWORD ? { authorization: 'Basic ' + Buffer.from(`api:${PASSWORD}`).toString('base64') } : {};

/** A shabad id and a line id are only valid if the deployment has them, so the
 *  ids used below are discovered from the deployment rather than hardcoded. */
async function get(p) {
  const t = Date.now();
  const res = await fetch(BASE + p, { headers });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, ms: Date.now() - t, body };
}

const rows = [];
const check = (name, r, describe) => {
  rows.push({ name, status: r.status, ms: r.ms, note: r.status === 200 ? describe(r.body) : (r.body?.error ?? '') });
  return r;
};

const health = await get('/api/health');
if (health.status === 401) {
  console.error(`401 from ${BASE}/api/health -- that route should never need credentials.`);
  process.exit(1);
}
if (health.status !== 200) {
  console.error(`${BASE} is not answering (${health.status}). Is the server running?`);
  process.exit(1);
}
check('/api/health', health, b =>
  `${b.lines} lines, indexes: ${(b.sources || []).join(',') || 'none'}, default ${b.default_index}`);

const freeText = Object.values(health.body.indexes || {}).some(i => i.freeText);
const langs = Object.entries(health.body.translations || {}).filter(([, v]) => v).map(([k]) => k);
const tr = langs.length ? '&tr=' + langs.join(',') : '';

// the writings are optional packs; probe the first one this deployment can search
const corpora = (health.body.corpora || []).filter(c => c.enabled && c.search);
if (corpora.length) {
  check('/api/writings/search', await get(`/api/writings/search?q=fear+of+death&corpus=${corpora[0].key}&k=3`), b =>
    `${b.results.length} passages from ${corpora[0].key} (${b.score_kind})`);
}

const fl = check('/api/fl', await get('/api/fl?q=gnm&limit=3' + tr), b =>
  `${b.total} matches, first at ang ${b.results?.[0]?.ang}`);

const shabadId = fl.body?.results?.[0]?.shabad_id;
const lineId = fl.body?.results?.[0]?.line_id;

if (shabadId !== undefined) {
  check('/api/shabad', await get(`/api/shabad?id=${shabadId}${tr}`), b =>
    `${b.lines?.length} lines, ${b.shabad?.writer || '?'}, ang ${b.shabad?.ang_start}`
    + (b.darpan ? ', with darpan' : ''));
  check('/api/similar/shabad', await get(`/api/similar/shabad?id=${shabadId}&k=3`), b =>
    `${b.results?.length ?? 0} neighbours`);
  check('/api/similar/rahao', await get(`/api/similar/rahao?id=${shabadId}&k=3`), b =>
    `${b.results?.length ?? 0} on the same theme`);
}
if (lineId !== undefined) {
  check('/api/similar/line', await get(`/api/similar/line?id=${lineId}&k=3`), b =>
    `${b.results?.length ?? 0} neighbours` + (b.note ? ` (${b.note})` : ''));
}
check('/api/keyboard', await get('/api/keyboard'), b =>
  `${b.rows?.flat?.().length ?? b.letters?.length ?? '?'} keys`);

const text = await get('/api/text?q=' + encodeURIComponent('how do I overcome the fear of death') + '&k=3&index=all' + tr);
rows.push({
  name: '/api/text', status: text.status, ms: text.ms,
  note: text.status === 200
    ? `${text.body.results?.length} results, ${text.body.score_kind}`
      + (text.body.results?.[0]?.votes !== undefined ? `, top has ${text.body.results[0].votes} vote(s)` : '')
    : (freeText ? (text.body?.error ?? '') : 'no query model installed -- expected'),
});

const w = Math.max(...rows.map(r => r.name.length));
console.log(`\n${BASE}\n`);
for (const r of rows) {
  const ok = r.status === 200 || (r.name === '/api/text' && r.status === 503 && !freeText);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(w)}  ${String(r.status)}  ${String(r.ms).padStart(5)}ms  ${r.note}`);
}

const bad = rows.filter(r => r.status !== 200 && !(r.name === '/api/text' && r.status === 503 && !freeText));
if (bad.length) { console.error(`\n${bad.length} endpoint(s) did not answer.`); process.exit(1); }
console.log(`\nall ${rows.length} endpoints answered.\n`);
