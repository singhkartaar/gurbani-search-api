'use strict';
/**
 * Finding the meaning indexes on disk.
 *
 * What a manifest MEANS moved to packages/search-core/src/registry.js, which is
 * pure and therefore runs on a phone too. What stays here is the half that
 * cannot: reading a directory. A device never discovers anything -- the bundle
 * manifest carries the index manifests inlined -- so keeping node:fs out of the
 * shared half is what lets both sides apply exactly the same defaults instead of
 * two implementations that drift.
 *
 * The pure functions are re-exported so every existing caller is unchanged.
 */
const fs = require('node:fs');
const path = require('node:path');
const pure = require('../../packages/search-core/src/registry.js');
const { normalizeManifest } = pure;
/**
 * Every index directory: the root manifest first, then each subdirectory that
 * has one, keyed by the manifest's own `index` name. A directory whose name
 * disagrees with its manifest is reported; the first claim on a name wins.
 * @returns {Array<{name: string, dir: string, manifest: object, warning?: string}>}
 */
function discoverIndexDirs(artifactsDir) {
  const out = [];
  const seen = new Set();
  const consider = (dir, fallbackName) => {
    const mp = path.join(dir, 'manifest.json');
    if (!fs.existsSync(mp)) return;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch (err) {
      out.push({ name: fallbackName, dir, manifest: null, warning: `unreadable manifest: ${err.message}` });
      return;
    }
    // A documents index (kind: "documents") addresses passages of prose, not
    // lines of the Granth: loaded as a Gurbani index its row numbers would
    // render the wrong verse rather than fail. Those belong under
    // artifacts/corpora/, which is too deep to be found here -- but depth is a
    // convention and the manifest is a fact, so the manifest is what is checked.
    if (manifest.kind === 'documents') return;
    const name = manifest.index || fallbackName;
    const entry = { name, dir, manifest };
    if (fallbackName !== name && dir !== artifactsDir) entry.warning = `directory ${path.basename(dir)} carries index "${name}"`;
    if (seen.has(name)) { entry.warning = `duplicate index "${name}", ignored`; entry.manifest = null; }
    seen.add(name);
    out.push(entry);
  };
  consider(artifactsDir, 'en');
  if (fs.existsSync(artifactsDir)) {
    for (const e of fs.readdirSync(artifactsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) consider(path.join(artifactsDir, e.name), e.name);
    }
  }
  return out;
}

module.exports = { ...pure, discoverIndexDirs };
