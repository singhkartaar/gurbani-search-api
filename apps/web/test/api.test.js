'use strict';
/**
 * End-to-end API tests against a real server process: both semantic indexes,
 * the per-request index switch, and free text in English and Gurmukhi.
 * Skips whatever the local build does not have (no artifacts, no model).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACTS = process.env.ARTIFACTS_DIR || path.join(ROOT, 'artifacts');
const HAS_DB = fs.existsSync(path.join(ARTIFACTS, 'gurbani.sqlite'));
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;
let health = null;

const get = async p => {
  const res = await fetch(BASE + p);
  return { status: res.status, body: await res.json() };
};

test.before(async () => {
  if (!HAS_DB) return;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), APP_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 120000);
    child.stdout.on('data', d => { if (String(d).includes('http://localhost')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('exit', code => reject(new Error(`server exited with ${code}`)));
  });
  health = (await get('/api/health')).body;
});

test.after(() => { if (child) child.kill(); });

const EN = () => (health && health.default_index) || 'en';
// the Gurmukhi index this build offers, whichever it is called
const PA = () => (health && (health.sources || []).find(n => health.indexes[n].text_lang === 'pa')) || 'pa-ft';
const en = () => health && health.indexes[EN()] && health.indexes[EN()].loaded;
const pa = () => health && health.indexes[PA()] && health.indexes[PA()].loaded;

test('health reports the translations this build can show', { skip: !HAS_DB }, () => {
  assert.strictEqual(typeof health.translations, 'object');
  for (const [lang, on] of Object.entries(health.translations)) {
    assert.ok(['en', 'pa', 'pad', 'fk'].includes(lang));
    assert.strictEqual(typeof on, 'boolean');
  }
});

test('health reports every index and whether it has free text', { skip: !HAS_DB }, () => {
  assert.strictEqual(health.ok, true);
  assert.ok(health.lines > 60000);
  // A deployment may load any subset of the indexes it has -- one index is a
  // supported configuration, not a broken one -- so what is asserted is that
  // whatever IS offered is described honestly, not that any particular index is
  // present. The languages are checked only once both are actually loaded.
  const langs = new Set(Object.values(health.indexes).filter(i => i.loaded).map(i => i.text_lang));
  if (langs.size > 1) {
    for (const lang of ['en', 'pa']) {
      assert.ok(Object.values(health.indexes).some(i => i.text_lang === lang), `a ${lang} index is offered`);
    }
  }
  assert.ok(!('pa-plain' in health.indexes) && !('en-doc' in health.indexes), 'lab indexes are not offered');
  assert.ok(!('pa-pss' in health.indexes), 'a demoted index stops being offered');
  for (const [name, i] of Object.entries(health.indexes)) {
    assert.strictEqual(typeof i.loaded, 'boolean', name);
    if (!i.loaded) continue;
    assert.strictEqual(typeof i.freeText, 'boolean');
    // the presentation the client builds its switches from
    assert.ok(typeof i.label === 'string' && i.label.length, `${name} has a label`);
    assert.ok(['en', 'pa'].includes(i.text_lang), `${name} names the language it embedded`);
    assert.ok(Array.isArray(i.query_scripts) && i.query_scripts.length, `${name} says what it can read`);
    assert.ok(Array.isArray(i.roles) && i.roles.length, `${name} has a role`);
    assert.strictEqual(typeof i.ask_weight, 'number');
    assert.strictEqual(typeof i.order, 'number');
  }
  // the reader's switch: loaded indexes in display order, default first among equals
  assert.ok(Array.isArray(health.sources) && health.sources.length >= 1);
  assert.ok(health.sources.every(n => health.indexes[n].loaded));
  const orders = health.sources.map(n => health.indexes[n].order);
  assert.deepStrictEqual(orders, [...orders].sort((a, b) => a - b), 'sources are in display order');
  assert.ok(health.default_index in health.indexes, 'the default index is one of the offered ones');
  // It reads English when an English index is loaded. When none is -- a
  // deployment that ships only the Gurmukhi index -- the default falls back to
  // what did load, and that fallback is the behaviour worth asserting.
  const english = health.sources.filter(n => health.indexes[n].text_lang === 'en');
  assert.strictEqual(health.indexes[health.default_index].text_lang,
    english.length ? 'en' : health.indexes[health.sources[0]].text_lang,
    english.length ? 'the default reads English' : 'the default fell back to the first loaded index');
  // legacy fields still describe the default index
  assert.strictEqual(health.semantic, health.indexes[health.default_index].loaded);
});

test('the keyboard carries the physical keymap and the matra row', { skip: !HAS_DB }, async () => {
  const { body } = await get('/api/keyboard');
  assert.strictEqual(body.keymap.q, 'ਤ', 'AnmolLipi: q is ਤ');
  assert.strictEqual(body.keymap.t, 'ਟ');
  assert.ok(body.matras.includes('ਾ') && body.matras.includes('ੰ'));
  assert.strictEqual(body.rows.length, 7);
});

test('the keyboard also carries the Roman names and the by-sound keymap', { skip: !HAS_DB }, async () => {
  const { body } = await get('/api/keyboard');
  const keys = [...body.rows.flat(), ...body.nukta];
  assert.ok(keys.every(k => body.roman[k]), 'every key on the keyboard has a Roman name');
  assert.strictEqual(body.roman['ਕ'], 'k');
  // the two modes disagree on purpose: AnmolLipi puts ਟ on t, the sounds put ਤ there
  assert.strictEqual(body.romanKeymap.t, 'ਤ');
  assert.strictEqual(body.keymap.t, 'ਟ');
});

test('a shabad marks its whole rahao stanza, not only the marked line', { skip: !HAS_DB }, async () => {
  // ang 10, Gujri M5: `ਮੇਰੇ ਮਾਧਉ ਜੀ ...` and the line under it are one refrain
  const fl = (await get('/api/fl?q=' + encodeURIComponent('ਕਰਮਜ') + '&limit=1')).body;
  const { body } = await get('/api/shabad?id=' + fl.results[0].shabad_id);
  const flagged = body.lines.filter(l => l.rahao_stanza);
  const marked = body.lines.filter(l => l.kind === 'rahao');
  if (!marked.length) return;                      // that shabad has no refrain
  assert.ok(flagged.length > marked.length, 'the stanza is more than its last line');
  assert.ok(marked.every(l => l.rahao_stanza), 'the marked line is inside its own stanza');
  assert.ok(body.lines.every(l => typeof l.rahao_stanza === 'boolean'), 'every line is flagged either way');
  // the refrain ends on its marked line and reaches back no further than the
  // stanza counter above it
  const idx = body.lines.findIndex(l => l.kind === 'rahao');
  assert.ok(!(body.lines[idx + 1] || {}).rahao_stanza, 'the refrain ends at the marker');
  const above = body.lines[idx - 1];
  assert.ok(above.rahao_stanza, 'the line above the marker belongs to the refrain');
  assert.ok(!/॥\s*[੦-੯]+\s*॥\s*$/.test(above.gurmukhi_uni), 'and it is not itself a stanza end');
  const twoUp = body.lines[idx - 2];
  if (twoUp && /॥\s*[੦-੯]+\s*॥\s*$/.test(twoUp.gurmukhi_uni)) {
    assert.strictEqual(twoUp.rahao_stanza, false, 'the stanza above stays out of it');
  }
});

test('translations come back only when asked for, in the language asked for', { skip: !HAS_DB }, async () => {
  const health = (await get('/api/health')).body;
  const langs = health.translations || {};
  const plain = (await get('/api/fl?q=' + encodeURIComponent('ਕਨਜ') + '&limit=3')).body;
  assert.ok(plain.results.length);
  for (const r of plain.results) {
    assert.ok(!('tr_en' in r) && !('tr_pa' in r), 'a request that did not ask gets no translation');
    assert.ok(typeof r.translit_roman === 'string', 'transliteration ships with the line itself');
  }
  if (!langs.en && !langs.pa) return;              // build without translations.sqlite
  const asked = (await get('/api/fl?q=' + encodeURIComponent('ਕਨਜ') + '&limit=3&tr=en,pa')).body;
  const first = asked.results[0];
  if (langs.en) assert.ok(first.tr_en && /[a-zA-Z]/.test(first.tr_en), 'English translation');
  if (langs.pa) assert.ok(first.tr_pa && /[਀-੿]/.test(first.tr_pa), 'Punjabi translation in Gurmukhi');
  // one language at a time
  const onlyPa = (await get('/api/fl?q=' + encodeURIComponent('ਕਨਜ') + '&limit=1&tr=pa')).body;
  assert.ok(!('tr_en' in onlyPa.results[0]));
  // the pad-arth and the Faridkot teeka are views of their own
  if (langs.pad) {
    const pad = (await get('/api/fl?q=' + encodeURIComponent('ਕਨਜ') + '&limit=5&tr=pad')).body;
    const withPad = pad.results.filter(r => r.tr_pad);
    assert.ok(withPad.length, 'some line carries its pad-arth');
    assert.ok(withPad.every(r => r.tr_pad.includes('=') && /[਀-੿]/.test(r.tr_pad)), 'pad-arth is `word = gloss` in Gurmukhi');
  }
  if (langs.fk) {
    const fk = (await get('/api/fl?q=' + encodeURIComponent('ਕਨਜ') + '&limit=5&tr=fk')).body;
    assert.ok(fk.results.some(r => r.tr_fk && /[਀-੿]/.test(r.tr_fk)), 'Faridkot text is Gurmukhi');
  }
  // an unknown language is ignored rather than an error
  const junk = await get('/api/fl?q=' + encodeURIComponent('ਕਨਜ') + '&limit=1&tr=xx');
  assert.strictEqual(junk.status, 200);
  assert.ok(!('tr_xx' in junk.body.results[0]));
});

test('a shabad and similar lines carry translations too', { skip: !HAS_DB }, async () => {
  const health = (await get('/api/health')).body;
  if (!(health.translations || {}).en) return;
  const fl = (await get('/api/fl?q=' + encodeURIComponent('ਕਨਜ') + '&limit=1')).body;
  const line = fl.results[0];
  const shabad = (await get('/api/shabad?id=' + line.shabad_id + '&tr=en')).body;
  assert.ok(shabad.lines.some(l => l.tr_en), 'the shabad view can show meaning');
  if (!en()) return;
  const sim = (await get('/api/similar/line?id=' + line.line_id + '&k=3&tr=en')).body;
  assert.ok((sim.results || []).some(l => l.tr_en), 'so can a list of similar lines');
});

test('index=all fuses every source that serves the role and says how many agreed', { skip: !HAS_DB }, async () => {
  const line = await get('/api/similar/line?id=4000&index=all&k=5');
  assert.strictEqual(line.status, 200);
  assert.strictEqual(line.body.score_kind, 'rrf');
  assert.ok(line.body.indexes.length >= 1 && line.body.indexes.every(n => health.indexes[n].roles.includes('neighbours')));
  assert.ok(line.body.results.every(r => Number.isInteger(r.votes) && r.votes >= 1 && r.votes <= line.body.indexes.length));
  const shabad = await get('/api/similar/shabad?id=289&index=all&k=5');
  assert.strictEqual(shabad.body.score_kind, 'rrf');
  const text = await get('/api/text?q=' + encodeURIComponent('the fear of death') + '&index=all&k=5');
  assert.strictEqual(text.status, 200);
  assert.ok(text.body.indexes.every(n => health.indexes[n].query_scripts.includes('latin')), 'only sources that read Latin script vote');
  assert.ok(text.body.results.length > 0 && text.body.results.every(r => /[਀-੿]/.test(r.gurmukhi_uni)));
});

test('an unknown index is a 400, an unbuilt one a 503', { skip: !HAS_DB }, async () => {
  assert.strictEqual((await get('/api/similar/line?id=4000&index=xx')).status, 400);
  assert.strictEqual((await get('/api/similar/line?id=4000&index=pa-plain')).status, 400, 'a lab index is not a name');
  for (const name of [EN(), PA()]) {
    if (!health.indexes[name].loaded) {
      assert.strictEqual((await get(`/api/similar/line?id=4000&index=${name}`)).status, 503);
    }
  }
});

test('similar lines default to the English index and switch with ?index=', { skip: !HAS_DB }, async () => {
  if (!en()) return;
  const dflt = (await get('/api/similar/line?id=4000&k=10')).body;
  assert.strictEqual(dflt.index, EN());
  assert.strictEqual(dflt.results.length, 10);
  assert.ok(dflt.results.every(r => typeof r.gurmukhi_uni === 'string' && typeof r.score === 'number'));
  // a one-index deployment has nothing to switch to, and EN() and PA() would
  // both resolve to it -- comparing an index against itself proves nothing
  if (!pa() || PA() === EN()) return;
  const alt = (await get('/api/similar/line?id=4000&k=10&index=' + PA())).body;
  assert.strictEqual(alt.index, PA());
  assert.strictEqual(alt.results.length, 10);
  const a = dflt.results.map(r => r.line_id).join(','), b = alt.results.map(r => r.line_id).join(',');
  assert.notStrictEqual(a, b, 'the two indexes should not agree on every neighbour');
});

test('similar shabads and rahao honour the index switch', { skip: !HAS_DB }, async () => {
  for (const name of [EN(), PA()]) {
    if (!health.indexes[name].loaded) continue;
    const s = (await get(`/api/similar/shabad?id=41&index=${name}`)).body;
    assert.strictEqual(s.index, name);
    assert.ok(s.results.length > 0);
    const r = (await get(`/api/similar/rahao?id=41&index=${name}`)).body;
    assert.strictEqual(r.index, name);
    assert.ok(r.results.length > 0);
    assert.ok(r.results.every(x => x.rahao_line), 'rahao results carry the rahao line');
  }
});

test('English free text runs against the English index', { skip: !HAS_DB }, async () => {
  if (!(en() && health.indexes[EN()].freeText)) return;
  const { body } = await get('/api/text?q=' + encodeURIComponent('the fear of death') + '&k=5');
  assert.strictEqual(body.index, EN());
  assert.strictEqual(body.results.length, 5);
  assert.ok(body.results.every(r => /[਀-੿]/.test(r.gurmukhi_uni)), 'results are Gurmukhi lines');
});

test('Gurmukhi free text runs against a Gurmukhi index', { skip: !HAS_DB }, async () => {
  const name = ['pa-ft', PA()].find(n => health.indexes[n] && health.indexes[n].loaded && health.indexes[n].freeText);
  if (!name) return;
  const q = 'ਕੋਈ ਨ ਜਾਣੈ ਤੇਰਾ ਕੇਤਾ ਕੇਵਡੁ ਚੀਰਾ';
  const { body } = await get('/api/text?q=' + encodeURIComponent(q) + '&k=5&index=' + name);
  assert.strictEqual(body.index, name);
  assert.strictEqual(body.results.length, 5);
  assert.match(body.results[0].gurmukhi_uni, /ਜਾਣੈ ਤੇਰਾ ਕੇਤਾ ਕੇਵਡੁ ਚੀਰਾ/, 'the verse itself comes first');
  // and a plain-Punjabi paraphrase still lands on the theme
  const para = (await get('/api/text?q=' + encodeURIComponent('ਮੌਤ ਦਾ ਡਰ') + '&k=10&index=' + name)).body;
  assert.strictEqual(para.results.length, 10);
});

test('free text on an index without an encoder is a 503, not a crash', { skip: !HAS_DB }, async () => {
  for (const name of new Set([EN(), PA(), 'pa-ft'])) {
    const i = health.indexes[name];
    if (i && i.loaded && !i.freeText) {
      assert.strictEqual((await get(`/api/text?q=x&index=${name}`)).status, 503);
    }
  }
});

// Every route is GET; nothing here accepts a body. Asserted on its own rather
// than inside the ask test below, because a build without ask still has a
// method gate worth checking.
test('POST is refused with 405', { skip: !HAS_DB }, async () => {
  assert.strictEqual((await fetch(BASE + '/api/text', { method: 'POST' })).status, 405);
});

// The writings: a search returns whole passages, a bounded number of them,
// each with the shabads it cites. Skips where this build carries no corpus.
test('writings search: bounded, floored, scored, and the id spaces never cross', { skip: !HAS_DB }, async () => {
  const carried = (health.corpora || []).filter(c => c.enabled && c.search);
  if (!carried.length) return;
  const key = carried[0].key;
  const r = (await get('/api/writings/search?q=' + encodeURIComponent('how to overcome fear') + '&corpus=' + key + '&k=5&cites=1'));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const d = r.body;
  assert.strictEqual(d.corpus, key);
  assert.strictEqual(d.score_kind, 'cosine');
  assert.ok(d.results.length >= 1 && d.results.length <= 5, `got ${d.results.length}`);
  for (const p of d.results) {
    assert.ok(p.text && p.title && p.author && p.work, 'a whole passage, placed');
    assert.ok(typeof p.score === 'number');
    assert.ok(Array.isArray(p.cites));
  }
  // best first, and no filtering by default: both floors are off, because
  // none of the three measured could tell relevant from irrelevant (see the
  // route's comment). The invariant is still asserted so that a deployment
  // which does set a floor is checked against it rather than trusted.
  const scores = d.results.map(p => p.score);
  assert.deepStrictEqual(scores, [...scores].sort((a, b) => b - a));
  assert.strictEqual(d.min_ratio, 0, 'the relative floor ships off');
  assert.strictEqual(d.min_score, 0, 'the absolute floor ships off');
  assert.ok(scores.every(s => s >= scores[0] * d.min_ratio && s >= d.min_score));
  // cited shabads come back as shabads, resolved against the Granth, not as passage rows
  for (const s of d.sources || []) assert.ok(s.shabad_id >= 0 && s.ang_start >= 1 && s.first_line !== undefined);

  // the cap: k is clamped to the server's maximum, never above it
  const many = (await get('/api/writings/search?q=fear&corpus=' + key + '&k=99')).body;
  assert.ok(many.results.length <= 50);
  // AND THE FLOOR: leaving k out means the default, not one. `Number(null)` is
  // 0 and Number.isInteger accepts it, so an absent bound used to clamp to the
  // minimum and every optional-k route answered with a single result to any
  // caller that did not name one. The browser always names one; the API did not.
  const bare = (await get('/api/writings/search?q=fear&corpus=' + key)).body;
  assert.ok(bare.results.length > 1, `no k means the default, got ${bare.results.length}`);
  const blank = (await get('/api/writings/search?q=fear&corpus=' + key + '&k=')).body;
  assert.strictEqual(blank.results.length, bare.results.length, 'an empty k is an absent k');
  // across every corpus, fused by rank
  const all = (await get('/api/writings/search?q=' + encodeURIComponent('the fear of death') + '&corpus=all&k=6')).body;
  assert.strictEqual(all.score_kind, carried.length > 1 ? 'rrf' : 'cosine');
  assert.ok(all.results.length <= 6);
  if (carried.length > 1) assert.ok(all.results.every(p => typeof p.score === 'number' && p.corpus && !('votes' in p)));
  // the mistakes a caller can make
  assert.strictEqual((await get('/api/writings/search?q=x&corpus=nope')).status, 400);
  assert.strictEqual((await get('/api/writings/search?q=x&corpus=' + key + '&work=nope')).status, 400);
  assert.strictEqual((await get('/api/writings/search?q=x&corpus=all&work=' + key)).status, 400);
  assert.strictEqual((await get('/api/writings/search?q=' + encodeURIComponent('ਮੌਤ ਦਾ ਡਰ') + '&corpus=' + key)).status,
    carried[0].query_scripts.includes('gurmukhi') ? 200 : 400, 'a script the model cannot read is refused, not [UNK]-ranked');
  assert.deepStrictEqual((await get('/api/writings/search?corpus=' + key)).body.results, []);
  // and the roster route still describes the works
  const w = (await get('/api/writings?corpus=' + key)).body;
  assert.ok(w.works.length >= 1 && w.units > 0);
});


test('a shabad carries what the Darpan says about it as a whole', { skip: !HAS_DB }, async () => {
  // ang 23, Siri Raag M1 -- the anthology's very first reference, filed under ਪਰਮਾਤਮਾ
  const fl = (await get('/api/fl?q=' + encodeURIComponent('ਰਰਮਸਰਰ') + '&limit=1')).body;
  const { body } = await get('/api/shabad?id=' + fl.results[0].shabad_id);
  if (!body.darpan) return;                        // translations.sqlite predates the ingest
  assert.ok(Array.isArray(body.darpan.stanzas));
  assert.ok(Array.isArray(body.darpan.topics));
  for (const t of body.darpan.topics) {
    assert.strictEqual(typeof t.topic, 'string');
    assert.ok('pa' in t && 'en' in t);
  }
  for (const st of body.darpan.stanzas) {
    assert.ok(typeof st.pa === 'string' && st.pa.length);
    assert.ok(Number.isInteger(st.covers) && st.covers >= 1);
  }
});

test('the Darpan\'s machine English is never served as a reading view', { skip: !HAS_DB }, async () => {
  // it drives the English meaning indexes; it is not offered as Sahib Singh's
  // words, so neither the view list nor ?tr= will produce it
  if (!Object.values(health.translations).some(Boolean)) return;   // no translations installed
  assert.ok(!('mt' in health.translations) && !('pad_en' in health.translations),
    Object.keys(health.translations).join(','));
  const fl = (await get('/api/fl?q=' + encodeURIComponent('ਕਰਮਜ') + '&limit=1')).body;
  const { body } = await get('/api/shabad?id=' + fl.results[0].shabad_id + '&tr=pa,pad,mt,pad_en');
  assert.ok(body.lines.some(l => l.tr_pa || l.tr_pad), 'the Punjabi Darpan still comes back');
  assert.ok(body.lines.every(l => !('tr_mt' in l) && !('tr_pad_en' in l)), 'the English does not');
});
