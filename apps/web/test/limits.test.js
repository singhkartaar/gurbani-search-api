'use strict';
/**
 * Per-client request limits. The clock is injected, so window behaviour is
 * asserted rather than slept through.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createLimits, clientKey, normalizeIp } = require('../limits.js');

/** A limiter with a clock we drive and no background timer. */
const make = (env, clock = { t: 1_000_000 }) => ({
  limits: createLimits(env, { now: () => clock.t, setInterval: () => null }),
  clock,
});

const from = (ip, xff) => ({
  socket: { remoteAddress: ip },
  headers: xff ? { 'x-forwarded-for': xff } : {},
});

test('unset means no limiting, and check() returns null', () => {
  const { limits } = make({});
  assert.strictEqual(limits.enabled, false);
  for (let i = 0; i < 1000; i++) assert.strictEqual(limits.check('/api/fl', from('1.1.1.1')), null);
  assert.deepStrictEqual(limits.summary(), { enabled: false });
});

test('a client is refused once it passes the limit, with a Retry-After', () => {
  const { limits } = make({ RATE_LIMIT_PER_MINUTE: '3' });
  const req = from('1.1.1.1');
  for (let i = 0; i < 3; i++) {
    const r = limits.check('/api/fl', req);
    assert.ok(r.ok, `request ${i + 1} should pass`);
    assert.strictEqual(r.headers['x-ratelimit-remaining'], String(2 - i));
  }
  const r = limits.check('/api/fl', req);
  assert.strictEqual(r.code, 429);
  assert.strictEqual(r.reason, 'rate_limited');
  assert.ok(r.retry_after > 0 && r.retry_after <= 60, `retry_after ${r.retry_after}`);
  assert.strictEqual(r.headers['retry-after'], String(r.retry_after));
  assert.strictEqual(r.headers['x-ratelimit-remaining'], '0');
  assert.match(r.error, /too many requests/);
});

test('clients are counted separately', () => {
  const { limits } = make({ RATE_LIMIT_PER_MINUTE: '1' });
  assert.ok(limits.check('/api/fl', from('1.1.1.1')).ok);
  assert.ok(limits.check('/api/fl', from('2.2.2.2')).ok, 'a different address has its own budget');
  assert.strictEqual(limits.check('/api/fl', from('1.1.1.1')).code, 429);
});

test('the window resets', () => {
  const clock = { t: 0 };
  const { limits } = make({ RATE_LIMIT_PER_MINUTE: '2' }, clock);
  const req = from('1.1.1.1');
  assert.ok(limits.check('/api/fl', req).ok);
  assert.ok(limits.check('/api/fl', req).ok);
  assert.strictEqual(limits.check('/api/fl', req).code, 429);
  clock.t += 59_999;
  assert.strictEqual(limits.check('/api/fl', req).code, 429, 'still inside the window');
  clock.t += 2;
  assert.ok(limits.check('/api/fl', req).ok, 'a new window starts');
});

test('/api/health is never counted', () => {
  const { limits } = make({ RATE_LIMIT_PER_MINUTE: '1' });
  const req = from('1.1.1.1');
  // A host health check that spends a budget could take the deployment out of
  // rotation, which is worse than not limiting it.
  for (let i = 0; i < 50; i++) assert.strictEqual(limits.check('/api/health', req), null);
  assert.ok(limits.check('/api/fl', req).ok, 'and the real budget is untouched');
});

test('the text ceiling is a sub-limit, not a second allowance', () => {
  const { limits } = make({ RATE_LIMIT_PER_MINUTE: '10', RATE_LIMIT_TEXT_PER_MINUTE: '2' });
  const req = from('1.1.1.1');
  assert.ok(limits.check('/api/text', req).ok);
  assert.ok(limits.check('/api/text', req).ok);
  const r = limits.check('/api/text', req);
  assert.strictEqual(r.code, 429);
  assert.match(r.error, /free-text search/);
  // the two text calls also spent general budget, so 8 remain there
  for (let i = 0; i < 8; i++) assert.ok(limits.check('/api/fl', req).ok, `general ${i}`);
  assert.strictEqual(limits.check('/api/fl', req).code, 429);
});

test('a text limit above the general one is simply the general one', () => {
  const { limits } = make({ RATE_LIMIT_PER_MINUTE: '2', RATE_LIMIT_TEXT_PER_MINUTE: '99' });
  const req = from('1.1.1.1');
  assert.ok(limits.check('/api/text', req).ok);
  assert.ok(limits.check('/api/text', req).ok);
  assert.strictEqual(limits.check('/api/text', req).code, 429);
});

// --- who gets counted --------------------------------------------------------

test('TRUST_PROXY=0 ignores X-Forwarded-For entirely', () => {
  // otherwise anyone can mint a fresh budget per request by varying a header
  assert.strictEqual(clientKey(from('9.9.9.9', '1.1.1.1'), 0), '9.9.9.9');
  const { limits } = make({ RATE_LIMIT_PER_MINUTE: '1' });
  assert.ok(limits.check('/api/fl', from('9.9.9.9', 'a')).ok);
  assert.strictEqual(limits.check('/api/fl', from('9.9.9.9', 'b')).code, 429,
    'a forged header must not buy another request');
});

test('with one trusted proxy the rightmost entry wins, so a forged prefix is ignored', () => {
  // the client claimed "1.2.3.4"; our proxy appended what it actually saw
  assert.strictEqual(clientKey(from('10.0.0.1', '1.2.3.4, 203.0.113.7'), 1), '203.0.113.7');
  assert.strictEqual(clientKey(from('10.0.0.1', '203.0.113.7'), 1), '203.0.113.7');
});

test('with two trusted proxies the count comes from the right', () => {
  assert.strictEqual(clientKey(from('10.0.0.1', 'evil, 203.0.113.7, 10.0.0.9'), 2), '203.0.113.7');
});

test('a missing or short X-Forwarded-For falls back to the socket', () => {
  assert.strictEqual(clientKey(from('10.0.0.1'), 1), '10.0.0.1');
  assert.strictEqual(clientKey(from('10.0.0.1', ''), 1), '10.0.0.1');
  assert.strictEqual(clientKey(from('10.0.0.1', 'a'), 3), '10.0.0.1');
});

test('an IPv4-mapped IPv6 address is the same client as its IPv4 form', () => {
  assert.strictEqual(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.strictEqual(normalizeIp('2001:db8::1'), '2001:db8::1');
  assert.strictEqual(normalizeIp(undefined), 'unknown');
  const { limits } = make({ RATE_LIMIT_PER_MINUTE: '1' });
  assert.ok(limits.check('/api/fl', from('::ffff:5.5.5.5')).ok);
  assert.strictEqual(limits.check('/api/fl', from('5.5.5.5')).code, 429, 'one client, one budget');
});

test('the client table stays bounded under a flood of addresses', () => {
  const { limits } = make({ RATE_LIMIT_PER_MINUTE: '5' });
  for (let i = 0; i < 60_000; i++) limits.check('/api/fl', from(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`));
  assert.ok(limits.size() <= 50_000, `tracked ${limits.size()} clients`);
});

test('health reports the configuration', () => {
  const { limits } = make({ RATE_LIMIT_PER_MINUTE: '60', RATE_LIMIT_TEXT_PER_MINUTE: '10', TRUST_PROXY: '1' });
  assert.deepStrictEqual(limits.summary(),
    { enabled: true, per_minute: 60, text_per_minute: 10, trust_proxy: 1 });
});

// --- over HTTP ---------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACTS = process.env.ARTIFACTS_DIR || path.join(ROOT, 'artifacts');
const HAS_DB = fs.existsSync(path.join(ARTIFACTS, 'gurbani.sqlite'));
const PORT = 5204;
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;

test.before(async () => {
  if (!HAS_DB) return;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), APP_PASSWORD: '', RATE_LIMIT_PER_MINUTE: '4' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 120000);
    child.stdout.on('data', d => { if (String(d).includes('http://localhost')) { clearTimeout(timer); resolve(); } });
    child.on('exit', c => reject(new Error(`server exited with ${c}`)));
  });
});
test.after(async () => {
  if (!child) return;
  const done = new Promise(r => child.on('exit', r));
  child.kill();
  await done;
});

test('the fifth request in a minute is a 429 with Retry-After', { skip: !HAS_DB }, async () => {
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${BASE}/api/fl?q=gnm&limit=1`);
    seen.push(res.status);
    if (res.status === 429) {
      assert.ok(Number(res.headers.get('retry-after')) > 0, 'Retry-After is set');
      assert.strictEqual(res.headers.get('x-ratelimit-limit'), '4');
      assert.strictEqual(res.headers.get('x-ratelimit-remaining'), '0');
      const body = await res.json();
      assert.strictEqual(body.code, 429);
      assert.strictEqual(body.reason, 'rate_limited');
    }
  }
  assert.deepStrictEqual(seen, [200, 200, 200, 200, 429], seen.join(','));
});

test('health keeps answering after the budget is gone', { skip: !HAS_DB }, async () => {
  // the previous test exhausted this address; a host health check must not be
  // collateral damage
  const res = await fetch(`${BASE}/api/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  // the numbers are reported; which header names the client is not, because
  // that is the one detail that would help someone route around them
  assert.deepStrictEqual(body.rate_limit, { enabled: true, per_minute: 4, text_per_minute: 4 });
  assert.ok(!('trust_proxy' in body.rate_limit) && !('client_ip_header' in body.rate_limit));
});
