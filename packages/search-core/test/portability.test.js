'use strict';
/**
 * The library has to bundle for a phone.
 *
 * search-core and query-encoder are written to run anywhere: the SQLite handle,
 * the file reader and the ONNX session are all injected. That is easy to state
 * and easy to lose, because losing it takes one `require('node:fs')` added in
 * good faith to a file that only ever runs on a server today.
 *
 * It is worth a test rather than a comment because the failure is invisible
 * here and total there. Metro's dependency collector is STATIC and walks
 * function bodies, so even a require that never executes -- inside a factory
 * nobody calls on a device -- goes into the graph, fails to resolve, and breaks
 * the whole bundle. Nothing in Node would ever notice.
 *
 * So: a small allowlist of files that may be node-only, and everything else in
 * both packages must be clean.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// The only files allowed to need Node. Each has a portable counterpart that the
// device uses instead, and none of them is reachable from a portable entry point.
const NODE_ONLY = new Set([
  'packages/search-core/src/adapter-node.js',    // node:sqlite -- RN uses an op-sqlite adapter of the same shape
  'packages/search-core/src/io-node.js',         // node:fs     -- RN reads bundled/downloaded assets
  'packages/search-core/src/index-node.js',      // the barrel that adds both
  'packages/search-core/src/notation-node.js',   // node:crypto -- the notation content hash; the phone never hashes
  'packages/query-encoder/src/factory-node.js',  // onnxruntime-node -- RN uses onnxruntime-react-native
]);

const BANNED = /require\(\s*['"](node:[a-z/]+|fs|path|os|crypto|child_process|onnxruntime-node)['"]\s*\)/;

function sourceFiles() {
  const out = [];
  for (const pkg of ['packages/search-core/src', 'packages/query-encoder/src']) {
    const dir = path.join(ROOT, pkg);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js')) out.push(`${pkg}/${f}`);
    }
  }
  return out.sort();
}

test('no portable module reaches for Node', () => {
  const offenders = [];
  for (const rel of sourceFiles()) {
    if (NODE_ONLY.has(rel)) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const line = src.split('\n').findIndex(l => BANNED.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    if (line !== -1) offenders.push(`${rel}:${line + 1}`);
  }
  assert.deepStrictEqual(offenders, [],
    'these must move into a *-node.js file, or React Native cannot bundle the package');
});

test('the node-only files really are node-only, and really are needed', () => {
  // If one of them stops needing Node, it should move back rather than sit in
  // an allowlist that no longer means anything.
  for (const rel of NODE_ONLY) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const needsNode = BANNED.test(src) || /require\('\.\/(adapter|io)-node\.js'\)/.test(src);
    assert.ok(needsNode, `${rel} no longer needs Node; move it back into the portable half`);
  }
});

test('the portable entry point exports the whole library except the Node parts', () => {
  const portable = require('../src/index.js');
  const withNode = require('../src/index-node.js');
  for (const fn of ['loadArtifacts', 'projectQuery', 'loadIndex', 'firstLetterStart',
                    'firstLetterAnywhere', 'similarLines', 'similarShabads', 'similarByRahao',
                    'fuseSimilar', 'retrieveShabads', 'rahaoStanzaFlags',
                    'canRead', 'normalizeManifest', 'orderIndexes', 'summarize']) {
    assert.strictEqual(typeof portable[fn], 'function', `${fn} must be portable`);
  }
  assert.strictEqual(typeof portable.keyboard, 'object');
  assert.strictEqual(typeof portable.gurmukhi, 'object');
  // and the two that are not
  assert.strictEqual(portable.openNodeAdapter, undefined);
  assert.strictEqual(portable.nodeReadFile, undefined);
  assert.strictEqual(typeof withNode.openNodeAdapter, 'function');
  assert.strictEqual(typeof withNode.nodeReadFile, 'function');
});

test('the registry split leaves one implementation of the defaults, not two', () => {
  // apps/web/registry.js re-exports the shared half rather than copying it, so
  // a device and the server can never disagree about what a manifest means.
  const shared = require('../src/registry.js');
  const web = require(path.join(ROOT, 'apps', 'web', 'registry.js'));
  for (const fn of ['normalizeManifest', 'canRead', 'orderIndexes', 'summarize']) {
    assert.strictEqual(web[fn], shared[fn], `${fn} is a second copy, not the shared one`);
  }
  assert.strictEqual(typeof web.discoverIndexDirs, 'function', 'discovery stays on the server side');
  assert.strictEqual(shared.discoverIndexDirs, undefined, 'discovery reads a directory and cannot be portable');
});

test('an index loads from buffers alone, with no reader and no filesystem', () => {
  // This is the property the phone depends on: vectors.js is handed raw
  // ArrayBuffers by whatever read them, and does not care what that was.
  // React Native's File.bytes() returns a Uint8Array owning its whole buffer,
  // which artifacts.js now adopts without the 15MB copy it used to make.
  const { loadIndex } = require('../src/vectors.js');
  const dim = 2;
  const codes = new Int8Array([10, 0, 0, 10, 7, 7, -10, 0]);
  const scales = new Float32Array([1, 1, 1, 1]);
  const idx = loadIndex({ codesBuf: codes.buffer, scalesBuf: scales.buffer, dim });
  assert.strictEqual(idx.n, 4);
  assert.strictEqual(idx.dim, dim);

  const hits = idx.search(new Float32Array([1, 0]), 2);
  assert.strictEqual(hits[0].row, 0, 'the vector aligned with the query should win');
  assert.ok(hits[0].score > hits[1].score);
});
