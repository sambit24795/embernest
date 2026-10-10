/**
 * auth.js — Host check, token/cookie auth, pairing and rate limiting.
 * Non-loopback requests always need the token; loopback is the user's own computer.
 */
'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const { getLanIps, isLoopback } = require('../core/net');

const COOKIE = 'pk_auth';
const MAX_FAILS = 10;
const WINDOW_MS = 60 * 1000;
const BLOCK_MS = 5 * 60 * 1000;
const YEAR_S = 31536000;

/** Constant-time comparison that tolerates different lengths. */
function tokenEquals(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Lowercased hostname of a Host header value: port removed, IPv6 keeps its brackets.
 * @param {unknown} host e.g. "Pc.local:3000" or "[::1]:3000"
 * @returns {string} '' when missing
 */
function hostnameOf(host) {
  const h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const i = h.lastIndexOf(':');
  return i !== -1 && h.indexOf(':') === i ? h.slice(0, i) : h;
}

/** Value of one cookie from a Cookie header, or ''. */
function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/**
 * @param {object} o
 * @param {() => object} o.getConfig current config; called per request
 * @param {boolean} [o.trustLoopback] false only in tests, to act like a phone from 127.0.0.1
 */
function createAuth({ getConfig, trustLoopback = true }) {
  const fails = new Map(); // ip -> { times: number[], blockedUntil: number }

  const ipOf = (req) => req.socket.remoteAddress || 'unknown';
  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  const FORWARD_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip',
    'tailscale-user-login', 'tailscale-user-name'];
  /**
   * The user's own computer: a loopback socket, a loopback Host, and no proxy
   * headers. Reverse proxies (`tailscale serve`/Funnel, nginx, …) connect from
   * 127.0.0.1 too, so their requests must still present the token.
   */
  const isLocal = (req) => trustLoopback
    && isLoopback(req.socket.remoteAddress)
    && LOOPBACK_HOSTS.has(hostnameOf(req.headers.host))
    && !FORWARD_HEADERS.some((h) => req.headers[h] !== undefined);

  function allowedHostnames() {
    const host = os.hostname().toLowerCase();
    const set = new Set(['localhost', '127.0.0.1', '[::1]', host, `${host}.local`]);
    for (const { address } of getLanIps()) set.add(address);
    for (const h of getConfig().allowedHosts || []) set.add(hostnameOf(h));
    return set;
  }

  function hostAllowed(hostname) {
    return Boolean(hostname) && (hostname.endsWith('.ts.net') || allowedHostnames().has(hostname));
  }

  /** Record a failed attempt. @returns {boolean} true when the IP is now blocked */
  function recordFailure(ip) {
    const now = Date.now();
    const rec = fails.get(ip) || { times: [], blockedUntil: 0 };
    rec.times = rec.times.filter((t) => now - t < WINDOW_MS);
    rec.times.push(now);
    if (rec.times.length > MAX_FAILS) rec.blockedUntil = now + BLOCK_MS;
    fails.set(ip, rec);
    return rec.blockedUntil > now;
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of fails) {
      if (rec.blockedUntil <= now && rec.times.every((t) => now - t >= WINDOW_MS)) fails.delete(ip);
    }
  }, WINDOW_MS);
  sweep.unref();

  /** 421 for any Host header we do not know (blocks DNS rebinding). */
  function hostCheck(req, res, next) {
    if (hostAllowed(hostnameOf(req.headers.host))) return next();
    return res.status(421).type('text/plain')
      .send('Unknown host. Add it with: embernest config set allowedHosts …');
  }

  function rateLimiter(req, res, next) {
    const rec = fails.get(ipOf(req));
    if (rec && rec.blockedUntil > Date.now()) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }
    return next();
  }

  function tokenFrom(req) {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    return readCookie(req.headers.cookie, COOKIE)
      || req.get('x-embernest-token')
      || req.get('x-pixelkiln-token') // pre-rename header, kept so paired setups keep working
      || (bearer && bearer[1])
      || req.get('x-ember-token') // legacy header, kept until v0.3
      || '';
  }

  function validToken(provided) {
    const configured = String(getConfig().authToken || '');
    return Boolean(configured) && Boolean(provided) && tokenEquals(provided, configured);
  }

  function originAllowed(req) {
    const origin = req.get('origin');
    if (!origin) return true;
    try { return hostAllowed(hostnameOf(new URL(origin).host)); } catch (_) { return false; }
  }

  const crossSite = (req) => !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !originAllowed(req);

  function requireAuth(req, res, next) {
    if (isLocal(req)) {
      // Loopback skips the token, not the Origin check: a web page open in the
      // user's own browser can still send "simple" form POSTs to 127.0.0.1.
      if (crossSite(req)) return res.status(403).json({ error: 'Cross-site request refused' });
      return next();
    }
    if (!validToken(tokenFrom(req))) {
      if (recordFailure(ipOf(req))) {
        return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
      }
      return res.status(401).json({ error: 'Unauthorized', pair: true });
    }
    if (crossSite(req)) return res.status(403).json({ error: 'Cross-site request refused' });
    return next();
  }

  function secure(req) {
    return Boolean(req.secure) || String(req.get('x-forwarded-proto') || '').toLowerCase() === 'https';
  }

  function pairRoute(req, res) {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!validToken(token)) {
      if (recordFailure(ipOf(req))) return res.status(429).type('text/plain').send('Too many failed attempts. Try again in a few minutes.');
      return res.status(401).type('html').send(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
        + '<title>Pairing</title><p>That pairing link is old. Run <code>embernest pair</code> on your computer and scan again.</p>');
    }
    const flags = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${YEAR_S}${secure(req) ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${flags}`);
    return res.redirect(302, '/');
  }

  function logoutRoute(req, res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure(req) ? '; Secure' : ''}`);
    res.json({ ok: true });
  }

  return { hostCheck, requireAuth, pairRoute, logoutRoute, rateLimiter };
}

module.exports = { createAuth, hostnameOf, tokenEquals };
