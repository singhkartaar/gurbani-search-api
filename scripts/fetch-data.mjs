#!/usr/bin/env node
'use strict';
/**
 * Download the data packs this API serves.
 *
 *   node scripts/fetch-data.mjs                  # the default packs (~125MB)
 *   node scripts/fetch-data.mjs --core-only      # the smallest useful set (~46MB)
 *   node scripts/fetch-data.mjs --all            # every index, and every writings corpus
 *   node scripts/fetch-data.mjs --packs writings-puran   # one author's writings (brings `english`)
 *   node scripts/fetch-data.mjs --verify         # re-hash what is on disk
 *
 * Node built-ins only -- no tar, no shell-out, no dependencies -- so Windows,
 * macOS and Linux take exactly the same code path.
 *
 * WHAT IS TRUSTED. data/manifest.json is committed to this repository: its
 * hashes were reviewed in a pull request and are pinned to the code that expects
 * them. The manifest is NOT fetched from the network, so a replaced or tampered
 * release asset fails against a digest an attacker cannot change. Verified bytes
 * are the only bytes that reach a final path.
 *
 * LICENSING. The code in this repository is MIT. The data is not: see NOTICE.md.
 * This script writes LICENSE-DATA.txt beside the files so the terms travel with
 * the bytes when the directory is copied to a server.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXIT = { OK: 0, IO: 1, HASH: 2, USAGE: 3 };

function parseArgs(argv) {
  const o = { packs: null, dest: path.join(ROOT, 'data'), manifest: null, baseUrl: null,
              concurrency: 3, verify: false, dryRun: false, force: false, quiet: false,
              keepArchives: false, noModel: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--core-only') o.packs = ['core'];
    else if (a === '--all') o.packs = 'all';
    else if (a === '--packs') o.packs = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--dest') o.dest = path.resolve(next());
    else if (a === '--manifest') o.manifest = path.resolve(next());
    else if (a === '--base-url') o.baseUrl = next();
    else if (a === '--concurrency') o.concurrency = Math.max(1, Number(next()) || 3);
    else if (a === '--verify') o.verify = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--force') o.force = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--keep-archives') o.keepArchives = true;
    else if (a === '--no-model') o.noModel = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else { console.error(`unknown argument: ${a}`); process.exit(EXIT.USAGE); }
  }
  o.manifest ??= path.join(ROOT, 'data', 'manifest.json');
  o.baseUrl ??= process.env.GURBANI_DATA_BASE_URL || null;
  return o;
}

const mb = n => (n / 1048576).toFixed(1) + 'MB';

async function sha256File(file, transform = null) {
  const h = crypto.createHash('sha256');
  const stages = [fs.createReadStream(file)];
  if (transform) stages.push(transform);
  stages.push(async function* (src) { for await (const c of src) h.update(c); });
  await pipeline(...stages);
  return h.digest('hex');
}

/** Rename over a possibly-existing destination. Windows throws EPERM/EEXIST
 *  where POSIX replaces silently, so unlink first and retry once. */
async function renameOver(from, to) {
  try { await fsp.rename(from, to); return; } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EEXIST' && err.code !== 'ENOTEMPTY') throw err;
  }
  await fsp.rm(to, { force: true });
  await fsp.rename(from, to);
}

/**
 * Download `url` into `part`, resuming if a partial is already there.
 *
 * A gzipped asset is fetched WHOLE and decompressed afterwards, never
 * decompressed during the stream: a partially decompressed output has no
 * defined resume offset, so streaming through gunzip would make resume
 * impossible. That is the one non-obvious decision in this file.
 */
async function download(url, part, expectBytes, onProgress) {
  let have = 0;
  try { have = (await fsp.stat(part)).size; } catch { /* no partial */ }
  if (have >= expectBytes) have = 0;              // stale or complete; start over

  const headers = {};
  if (have > 0) headers.Range = `bytes=${have}-`;
  const res = await fetch(url, { headers });
  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  // A mirror that ignores Range answers 200 with the whole file. Appending then
  // would corrupt it, so start clean instead.
  let append = have > 0 && res.status === 206;
  if (have > 0 && res.status === 200) { await fsp.rm(part, { force: true }); have = 0; append = false; }

  await fsp.mkdir(path.dirname(part), { recursive: true });
  let done = have;
  const counter = async function* (src) {
    for await (const c of src) { done += c.length; onProgress?.(done); yield c; }
  };
  await pipeline(Readable.fromWeb(res.body), counter,
                 fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
  return done;
}

/** Fetch, verify and install one manifest entry. Returns 'ok' | 'skip' | 'fail'. */
async function fetchOne(entry, o, report) {
  const dest = path.join(o.dest, entry.path);
  const finalSha = entry.sha256_plain ?? entry.sha256;

  if (!o.force) {
    try {
      const st = await fsp.stat(dest);
      const expect = entry.bytes_plain ?? entry.bytes;
      if (st.size === expect && (!o.verify || await sha256File(dest) === finalSha)) {
        if (!o.verify) return 'skip';
        report(`  ok       ${entry.path}`);
        return 'skip';
      }
      if (o.verify) { report(`  CORRUPT  ${entry.path}`); return 'fail'; }
    } catch { /* not there yet */ }
  }
  if (o.verify) { report(`  MISSING  ${entry.path}`); return 'fail'; }

  const url = `${o.baseUrl}/${entry.asset}`;
  const part = dest + '.part';

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) await fsp.rm(part, { force: true });   // retry from byte 0
    try {
      await download(url, part, entry.bytes);
    } catch (err) {
      if (attempt === 2) { report(`  FAILED   ${entry.path}: ${err.message}`); return 'fail'; }
      continue;
    }
    const got = await sha256File(part);
    if (got !== entry.sha256) {
      if (attempt === 1) continue;    // usually a stale .part or a caching proxy
      await fsp.rm(part, { force: true });
      report(`  MISMATCH ${entry.path}\n`
        + `           expected ${entry.sha256}\n`
        + `           received ${got}\n`
        + `           from ${url}`);
      return 'fail';
    }
    if (entry.encoding === 'gzip') {
      const plainPart = dest + '.plain.part';
      await pipeline(fs.createReadStream(part), zlib.createGunzip(), fs.createWriteStream(plainPart));
      const plainGot = await sha256File(plainPart);
      if (plainGot !== entry.sha256_plain) {
        await fsp.rm(plainPart, { force: true });
        if (attempt === 1) continue;
        report(`  MISMATCH ${entry.path} after decompressing`);
        return 'fail';
      }
      await renameOver(plainPart, dest);
      if (o.keepArchives) await renameOver(part, dest + '.gz');
      else await fsp.rm(part, { force: true });
    } else {
      await renameOver(part, dest);
    }
    return 'ok';
  }
  return 'fail';
}

const LICENCE_NOTE = `These data files are NOT covered by this project's MIT licence.

The Gurmukhi text, the translations, the Punjabi teekas and every vector index
derived from them come from BaniDB (Khalis Foundation) under NPOSL-3.0 -- the
NON-PROFIT Open Software License. The underlying source documents are Dr Kulbir
Thind's corrected editions, and the English traces to Sant Singh Khalsa, MD;
their notice requires written approval from both for commercial use or for
internet projects. The models are MIT (BAAI, intfloat; ONNX exports by Xenova).

Permission for the publication these files came from was obtained by that
project's owner. IT DOES NOT TRANSFER. If you intend to redistribute these
files, mirror them, or run a commercial deployment on top of them, you need your
own written permission from the rights holders.

Machine-translated text in translations.sqlite is marked machine = 1 in the
translators table and must never be presented as a human translation.

See NOTICE.md in the repository for the full statement.
`;

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n').slice(2, 22).map(l => l.replace(/^ \* ?/, '')).join('\n'));
    return EXIT.OK;
  }

  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(o.manifest, 'utf8'));
  } catch (err) {
    console.error(`cannot read ${o.manifest}: ${err.message}`);
    console.error('This file is committed to the repository; a clean checkout has it.');
    return EXIT.USAGE;
  }
  if (manifest.schema !== 1) {
    console.error(`manifest schema ${manifest.schema} is newer than this script understands; update the repo.`);
    return EXIT.USAGE;
  }
  o.baseUrl ??= manifest.base_url;

  const names = o.packs === 'all' ? Object.keys(manifest.packs)
    : (o.packs ?? Object.entries(manifest.packs).filter(([, p]) => p.default).map(([n]) => n));
  for (const n of names) {
    if (!manifest.packs[n]) {
      console.error(`no such pack: ${n}. Available: ${Object.keys(manifest.packs).join(', ')}`);
      return EXIT.USAGE;
    }
  }
  if (!names.includes('core')) names.unshift('core');     // required
  // A pack that needs another -- a writings corpus needs the model the english
  // pack carries -- brings it along, so `--packs writings-puran` alone works.
  for (let i = 0; i < names.length; i++) {
    for (const dep of manifest.packs[names[i]].requires || []) {
      if (!names.includes(dep)) { names.push(dep); console.log(`${names[i]} requires ${dep}: added`); }
    }
  }

  let entries = names.flatMap(n => manifest.packs[n].files);
  if (o.noModel) entries = entries.filter(e => !e.path.startsWith('models/'));

  const total = entries.reduce((a, e) => a + e.bytes, 0);
  const onDisk = entries.reduce((a, e) => a + (e.bytes_plain ?? e.bytes), 0);

  console.log(`${manifest.release}  (version ${manifest.version})`);
  console.log(`packs: ${names.join(', ')}`);
  console.log(`${entries.length} files, ${mb(total)} to download, ${mb(onDisk)} on disk`);
  console.log(`into ${o.dest}`);
  if (o.noModel) console.log('without the query model: /api/text will return 503, everything else works');
  console.log(`\nThe code here is MIT. These files are not -- BaniDB is NPOSL-3.0 (non-profit),`);
  console.log(`and the translations carry their translators' terms. The permission does not`);
  console.log(`transfer to you. See NOTICE.md.\n`);

  if (o.dryRun) {
    for (const e of entries) console.log(`  ${mb(e.bytes).padStart(9)}  ${e.path}`);
    return EXIT.OK;
  }

  const report = m => console.log(m);
  const results = { ok: 0, skip: 0, fail: 0 };
  const failures = [];
  let i = 0;
  const worker = async () => {
    while (i < entries.length) {
      const e = entries[i++];
      const n = i;
      const r = await fetchOne(e, o, report).catch(err => {
        report(`  ERROR    ${e.path}: ${err.message}`); return 'fail';
      });
      results[r]++;
      if (r === 'fail') failures.push(e.path);
      else if (!o.quiet && r === 'ok') console.log(`  [${String(n).padStart(3)}/${entries.length}] ${e.path}`);
    }
  };
  await Promise.all(Array.from({ length: o.concurrency }, worker));

  if (!o.verify) await fsp.writeFile(path.join(o.dest, 'LICENSE-DATA.txt'), LICENCE_NOTE);

  console.log(`\n${results.ok} fetched, ${results.skip} already present, ${results.fail} failed`);
  if (failures.length) {
    console.error(`\nfailed: ${failures.join(', ')}`);
    console.error('\nIf you are pointing at a mirror with GURBANI_DATA_BASE_URL, it is serving');
    console.error('different bytes than this repository expects. If not, please open an issue');
    console.error('with the output above -- a published asset should never change.');
    return EXIT.HASH;
  }
  if (o.verify) { console.log('everything on disk matches the manifest.'); return EXIT.OK; }

  const indexes = [...new Set(entries.filter(e => e.path.startsWith('artifacts/') && e.path.includes('/'))
    .map(e => e.path.split('/')[1]).filter(n => n && !n.endsWith('.sqlite')))];
  console.log(`\nReady. Start the server with:\n`);
  console.log(`  ARTIFACTS_DIR=${path.join(o.dest, 'artifacts')} \\`);
  console.log(`  MODELS_DIR=${path.join(o.dest, 'models')} \\`);
  if (indexes.length) console.log(`  INDEXES=${indexes.join(',')} \\`);
  console.log(`  npm start\n`);
  return EXIT.OK;
}

main(process.argv.slice(2)).then(c => process.exit(c))
  .catch(err => { console.error(err); process.exit(EXIT.IO); });
