// Small security helpers built on Node's crypto module (no extra dependencies).
const crypto = require('crypto');

// ---------- Signed session tokens (HMAC-SHA256) ----------
// Format: base64url(JSON payload) + "." + base64url(signature)
function signToken(payload, secret, ttlSeconds) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token, secret) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

// ---------- Cookies ----------
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    try { out[key] = decodeURIComponent(val); } catch (_) { out[key] = val; }
  });
  return out;
}

// ---------- In-memory rate limiter (per IP) ----------
function rateLimit({ windowMs, limit, message, skipSuccessfulRequests = false }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    if (entry.count >= limit) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json(message);
    }
    entry.count++;
    if (skipSuccessfulRequests) {
      res.on('finish', () => { if (res.statusCode < 400) entry.count = Math.max(0, entry.count - 1); });
    }
    next();
  };
}

module.exports = { signToken, verifyToken, parseCookies, rateLimit };
