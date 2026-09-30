'use strict';
/**
 * Cross-origin access, off unless asked for.
 *
 * Search is read-only and every search route is a GET, so the risk CORS carries
 * here is not someone changing data -- it is someone READING data as you. That
 * only matters when APP_PASSWORD is set, and it is why credentials are never
 * granted to a wildcard.
 *
 * A preflight allows GET, HEAD and OPTIONS and never POST, on purpose. A build
 * that also answers questions takes them, and issues reader tokens, by POST --
 * and those are for this site's own page and its app only (the app is native,
 * and a native client sends no preflight). Allowed cross-origin, one wildcard
 * would let any page on the internet spend its visitors' daily questions and
 * the owner's budget from their browsers.
 *
 *   CORS_ORIGINS unset        no CORS headers at all, and OPTIONS stays a 405.
 *                             Byte-identical to having none of this code.
 *   CORS_ORIGINS=*            any origin may read. No credentials are allowed,
 *                             so a browser will not attach Basic auth, and a
 *                             password-protected deployment stays protected.
 *   CORS_ORIGINS=a,b          only these origins, and they MAY send credentials.
 *                             Match is exact, including scheme and port:
 *                             https://example.com and http://example.com are
 *                             different origins, as are :443 and :8443.
 *
 * `*` plus credentials is refused by every browser and by this module: the
 * combination would let any page on the internet read a private deployment.
 */

/** An origin is scheme://host[:port] and nothing else -- no path, no trailing slash. */
function normalize(o) {
  try {
    const u = new URL(o);
    return u.origin;
  } catch {
    return null;
  }
}

function createCors(env = process.env, log = console) {
  const raw = (env.CORS_ORIGINS || '').trim();
  const any = raw === '*';
  const list = any ? [] : raw.split(',').map(s => s.trim()).filter(Boolean);

  const allowed = new Set();
  for (const o of list) {
    const n = normalize(o);
    if (n) allowed.add(n);
    else log.warn(`CORS_ORIGINS: ignoring "${o}" -- an origin is scheme://host[:port], with no path`);
  }
  const enabled = any || allowed.size > 0;
  // Credentials are only meaningful against a named origin. With `*` the spec
  // forbids them, and granting them would defeat APP_PASSWORD entirely.
  const credentials = enabled && !any;

  if (any && env.APP_PASSWORD) {
    log.warn('CORS_ORIGINS=* with APP_PASSWORD set: browsers may read this API from any '
      + 'page, but without credentials, so the password still holds. Name the origins '
      + 'instead if a browser client needs to sign in.');
  }

  /** The origin to echo for this request, or null for "no CORS headers". */
  const originFor = req => {
    if (!enabled) return null;
    const origin = req.headers && req.headers.origin;
    if (!origin) return null;                 // not a cross-origin request
    if (any) return '*';
    const n = normalize(origin);
    return n && allowed.has(n) ? n : null;    // an origin we do not know gets nothing
  };

  /**
   * Headers to merge into every response.
   *
   * `Vary: Origin` is not optional when the answer depends on the request's
   * origin: without it a shared cache can hand one origin's allowance to
   * another, which is a real hole rather than a tidiness point. It is sent
   * whenever CORS is configured, including for origins that are refused,
   * because the refusal is itself origin-dependent.
   */
  const headers = req => {
    if (!enabled) return {};
    const origin = originFor(req);
    if (!origin) return { vary: 'Origin' };
    return {
      'access-control-allow-origin': origin,
      ...(credentials ? { 'access-control-allow-credentials': 'true' } : {}),
      // Without this a browser can see the 429 but not why or for how long.
      'access-control-expose-headers': 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
      vary: 'Origin',
    };
  };

  /**
   * Answer a preflight, if this is one. Returns true when it has replied.
   *
   * A preflight that names an origin we do not allow is answered 403 rather
   * than 204-without-headers: the browser blocks either way, but a developer
   * reading the network tab learns which of the two problems they have.
   */
  const preflight = (req, res, base = {}) => {
    if (!enabled || req.method !== 'OPTIONS') return false;
    if (!(req.headers && req.headers.origin)) return false;   // a bare OPTIONS is not a preflight
    const origin = originFor(req);
    if (!origin) {
      res.writeHead(403, { ...base, vary: 'Origin', 'content-type': 'text/plain; charset=utf-8' });
      res.end('origin not allowed');
      return true;
    }
    const asked = req.headers['access-control-request-headers'];
    res.writeHead(204, {
      ...base,
      ...headers(req),
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      // Echo what was asked for: the origin allowlist is what gates access, and
      // guessing a fixed list here only breaks clients that send a header we
      // did not think of.
      'access-control-allow-headers': asked || 'Authorization, Content-Type',
      'access-control-max-age': '86400',
      'content-length': '0',
    });
    res.end();
    return true;
  };

  return {
    enabled, credentials, headers, preflight,
    origins: any ? '*' : [...allowed],
    summary: () => (enabled
      ? { enabled: true, origins: any ? '*' : [...allowed], credentials }
      : { enabled: false }),
  };
}

module.exports = { createCors, normalize };
