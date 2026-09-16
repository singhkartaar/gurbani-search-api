'use strict';
/**
 * The OpenAPI document has to describe the server that exists, not the one it
 * described when it was written. A spec that has quietly drifted is worse than
 * no spec: it generates clients that compile and then 404.
 *
 * No YAML parser here on purpose -- this repository has two runtime
 * dependencies and neither is for tests. The document is read structurally
 * enough to answer the two questions that matter: are all the routes there, and
 * are there any that are not.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SPEC = fs.readFileSync(path.join(ROOT, 'openapi.yaml'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'apps', 'web', 'server.js'), 'utf8');

/** Route keys from the `routes` table: lines of the form `  '/api/x': ...`. */
const serverRoutes = [...SERVER.matchAll(/^ {2}'(\/api\/[^']*)':/gm)].map(m => m[1]).sort();
/** Path keys from the document: `  /api/x:` at two spaces of indent. */
const specPaths = [...SPEC.matchAll(/^ {2}(\/api\/[^:\s]*):$/gm)].map(m => m[1]).sort();

test('the server has routes and the spec has paths', () => {
  assert.ok(serverRoutes.length >= 8, `found ${serverRoutes.length} routes: ${serverRoutes}`);
  assert.ok(specPaths.length >= 8, `found ${specPaths.length} paths: ${specPaths}`);
});

test('every route the server serves is in the spec', () => {
  const missing = serverRoutes.filter(r => !specPaths.includes(r));
  assert.deepStrictEqual(missing, [],
    `openapi.yaml does not describe: ${missing.join(', ')}`);
});

test('every path the spec describes is a route the server serves', () => {
  const extra = specPaths.filter(p => !serverRoutes.includes(p));
  assert.deepStrictEqual(extra, [],
    `openapi.yaml describes routes that do not exist: ${extra.join(', ')}`);
});

test('the spec version matches the package version the server reports', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'web', 'package.json'), 'utf8'));
  const m = /^info:\n(?:.*\n)*?  version: (\S+)$/m.exec(SPEC);
  assert.ok(m, 'openapi.yaml has no info.version');
  assert.strictEqual(m[1], pkg.version,
    'the spec version and apps/web/package.json must agree; the server reports the latter');
});

test('the spec does not promise features this build does not have', () => {
  // These were deliberately left out of the public API. A spec mentioning them
  // would send someone looking for an endpoint that is not there.
  for (const gone of ['/api/ask', '/api/me', '/api/token', '/bundles/']) {
    assert.ok(!SPEC.includes(gone), `openapi.yaml mentions ${gone}`);
  }
});

test('the licensing position is stated in the document itself', () => {
  // Someone may read the spec and never open the repository.
  assert.match(SPEC, /NOTICE\.md/, 'the spec must point at the data licensing');
  assert.match(SPEC, /MIT/);
});
