// auth.js — signed session tokens, PIN hashing, login rate limiting. No external deps.
const crypto = require('crypto');

const secret = () => process.env.SESSION_SECRET;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function signToken(payload, ttlSec) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!secret() || !token) return null;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Math.floor(Date.now() / 1000) ? p : null;
  } catch (_) { return null; }
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') };
}
function checkPin(pin, salt, hash) {
  const a = crypto.scryptSync(String(pin), salt, 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Failed logins are counted per IP *and* per sign-in area (admin, manager, kitchen),
// so mistyping at the kitchen can't lock anyone out of admin, and the reverse.
const fails = new Map();
const WINDOW = 10 * 60 * 1000, MAX_FAILS = 5;
const MAX_BY_SCOPE = { kds: 10 };          // kitchen staff share one network and mistype more often
const keyOf = (ip, scope) => `${scope}:${ip}`;
function isLimited(ip, scope = 'default') {
  const k = keyOf(ip, scope), now = Date.now();
  const list = (fails.get(k) || []).filter((t) => now - t < WINDOW);
  fails.set(k, list);
  return list.length >= (MAX_BY_SCOPE[scope] || MAX_FAILS);
}
const noteFail = (ip, scope = 'default') => { const k = keyOf(ip, scope); fails.set(k, [...(fails.get(k) || []), Date.now()]); };
const clearFails = (ip, scope = 'default') => fails.delete(keyOf(ip, scope));

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

module.exports = { signToken, verifyToken, hashPin, checkPin, isLimited, noteFail, clearFails, safeEqual, bearer };