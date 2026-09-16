'use strict';
/**
 * Per-client request limits, off unless asked for.
 *
 *   RATE_LIMIT_PER_MINUTE           requests per client per minute, all routes
 *   RATE_LIMIT_TEXT_PER_MINUTE      a tighter ceiling for /api/text; defaults to
 *                                   the general one
 *   RATE_LIMIT_WRITINGS_PER_MINUTE  the same for /api/writings/search; defaults
 *                                   to the text ceiling, since it is the same
 *                                   kind of work (an ONNX forward pass)
 *   TRUST_PROXY                     how many reverse proxies sit in front (see below)
 *   CLIENT_IP_HEADER                a header the nearest proxy OVERWRITES with the
 *                                   client's address (Fly: fly-client-ip). When
 *                                   set, it is used and X-Forwarded-For ignored.
 *
 * Unset or 0 means no limiting at all, which is what a service behind someone
 * else's gateway wants.
 *
 * WHAT THIS IS FOR. Free-text search runs an ONNX forward pass, 25-70ms of CPU,
 * while a first-letter lookup is about 1ms; one careless loop can saturate a
 * shared vCPU. This keeps a single client from doing that. It is NOT a defence
 * against a determined attacker, who will simply use more addresses -- for that
 * you want a real WAF in front. Saying so plainly beats implying a protection
 * that is not there.
 *
 * A FIXED WINDOW, not a sliding log. The obvious implementation keeps a
 * timestamp per request, which at 120/minute across 10,000 clients is over a
 * million timestamps in a process sized at 149MB. This keeps one counter and one
 * window start per client instead. The cost is that a client can send up to 2x
 * the limit across a window boundary -- acceptable for "stop the box being
 * hammered", and worth knowing before you set a number.
 */

/** ::ffff:1.2.3.4 and 1.2.3.4 are the same client and must not be two keys. */
function normalizeIp(ip) {
  if (!ip) return 'unknown';
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

/**
 * Who to count this request against.
 *
 * X-Forwarded-For is a list a client can start and every proxy appends to, so
 * the LEFTMOST entry is whatever the client claimed and the RIGHTMOST is what
 * the nearest proxy actually saw. Taking the leftmost -- the common shortcut --
 * lets anyone forge a header and get a fresh budget per request, which makes the
 * limit decorative.
 *
 * With `trust` hops of proxy in front, the real client is `trust` entries from
 * the right. With trust = 0 the header is ignored entirely and the socket
 * address is used, which is correct when nothing is in front and safe when
 * something is (everyone behind that proxy shares a budget, which is
 * conservative rather than wrong).
 *
 * A proxy that OVERWRITES a header of its own (Fly's fly-client-ip) is simpler
 * and safer than counting hops, because there is nothing a client can prepend
 * to it. When `header` names one and the request carries it, that wins and
 * X-Forwarded-For is not consulted at all.
 */
function clientKey(req, trust = 0, header = '') {
  const headers = (req.headers) || {};
  if (header) {
    const v = String(headers[header] || '').split(',')[0].trim();
    if (v) return normalizeIp(v);
  }
  const socket = normalizeIp(req.socket && req.socket.remoteAddress);
  if (trust <= 0) return socket;
  const xff = String(headers['x-forwarded-for'] || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const i = xff.length - trust;
  return i >= 0 && xff[i] ? normalizeIp(xff[i]) : socket;
}

const WINDOW = 60_000;
/** Above this many tracked clients, sweep; if that does not help, drop the
 *  coldest. A bound is needed or the map itself becomes the denial of service. */
const MAX_CLIENTS = 50_000;

function createLimits(env = process.env, { now = () => Date.now(), setInterval: si = setInterval } = {}) {
  const perMinute = Math.max(0, Number(env.RATE_LIMIT_PER_MINUTE) || 0);
  const textPerMinute = Math.max(0, Number(env.RATE_LIMIT_TEXT_PER_MINUTE) || perMinute);
  const writingsPerMinute = Math.max(0, Number(env.RATE_LIMIT_WRITINGS_PER_MINUTE) || textPerMinute);
  const trust = Math.max(0, Number(env.TRUST_PROXY) || 0);
  const ipHeader = String(env.CLIENT_IP_HEADER || '').trim().toLowerCase();
  const enabled = perMinute > 0;

  // Routes that do model work get a tighter ceiling of their own. A route
  // absent here costs only the general budget.
  const ceilings = {
    '/api/text': { limit: textPerMinute, what: 'free-text search' },
    '/api/writings/search': { limit: writingsPerMinute, what: 'writings search' },
  };

  /** key -> { n, start } for the general budget and, separately, per tight route. */
  const buckets = new Map();

  const sweep = (t = now()) => {
    for (const [k, b] of buckets) if (t - b.start >= WINDOW) buckets.delete(k);
  };
  if (enabled) {
    const timer = si(() => sweep(), WINDOW);
    // must not hold the process open, and must not exist at all in a test that
    // injects its own clock
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /**
   * Would this key be allowed? Does not consume anything.
   *
   * Separate from spending because a request checked against two budgets must
   * not consume the first when the second refuses it -- otherwise hitting the
   * free-text ceiling would also eat the allowance for cheap lookups, which is
   * punitive and surprising.
   */
  const peek = (key, limit, t) => {
    const b = buckets.get(key);
    if (!b || t - b.start >= WINDOW) {
      return { ok: true, remaining: limit - 1, reset: Math.ceil(WINDOW / 1000) };
    }
    const reset = Math.ceil((WINDOW - (t - b.start)) / 1000);
    if (b.n >= limit) return { ok: false, retryAfter: reset, limit, reset };
    return { ok: true, remaining: limit - b.n - 1, reset };
  };

  /** Consume one, starting a window if there is none. */
  const spend = (key, t) => {
    const b = buckets.get(key);
    if (b && t - b.start < WINDOW) { b.n++; return; }
    if (buckets.size >= MAX_CLIENTS) {
      sweep(t);
      if (buckets.size >= MAX_CLIENTS) buckets.delete(buckets.keys().next().value);
    }
    buckets.set(key, { n: 1, start: t });
  };

  /**
   * Charge this request. Returns null to proceed, or a body to send back.
   *
   * /api/health is never counted: a host's health check would otherwise spend a
   * client's budget, and a limit that can take a deployment out of rotation is
   * worse than no limit.
   */
  const check = (pathname, req) => {
    if (!enabled || pathname === '/api/health') return null;
    const t = now();
    const key = clientKey(req, trust, ipHeader);

    const general = peek(key, perMinute, t);
    if (!general.ok) return refuse(general);
    // A model query costs both budgets, so a tighter ceiling is a ceiling
    // rather than a second, independent allowance. Both are checked before
    // either is spent.
    const tight = ceilings[pathname];
    const tightKey = key + '\0' + pathname;
    const alsoTight = Boolean(tight) && tight.limit < perMinute;
    if (alsoTight) {
      const r = peek(tightKey, tight.limit, t);
      if (!r.ok) return refuse(r, tight.what);
    }
    if (alsoTight) spend(tightKey, t);
    spend(key, t);
    return { ok: true, headers: rateHeaders(perMinute, general.remaining, general.reset) };
  };

  const refuse = (r, what = 'requests') => ({
    error: `too many ${what}; try again in ${r.retryAfter}s`,
    reason: 'rate_limited',
    retry_after: r.retryAfter,
    code: 429,
    headers: { 'retry-after': String(r.retryAfter), ...rateHeaders(r.limit, 0, r.reset) },
  });

  const rateHeaders = (limit, remaining, reset) => ({
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(Math.max(0, remaining)),
    'x-ratelimit-reset': String(reset),
  });

  return {
    enabled, perMinute, textPerMinute, writingsPerMinute, trustProxy: trust, clientIpHeader: ipHeader,
    check, clientKey: req => clientKey(req, trust, ipHeader),
    size: () => buckets.size,
    summary: () => (enabled
      ? { enabled: true, per_minute: perMinute, text_per_minute: textPerMinute,
          ...(writingsPerMinute !== textPerMinute ? { writings_per_minute: writingsPerMinute } : {}),
          trust_proxy: trust, ...(ipHeader ? { client_ip_header: ipHeader } : {}) }
      : { enabled: false }),
  };
}

module.exports = { createLimits, clientKey, normalizeIp };
