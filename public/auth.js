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

// 5 failed logins per IP per 10 minutes
const fails = new Map();
const WINDOW = 10 * 60 * 1000, MAX_FAILS = 5;
function isLimited(ip) {
  const now = Date.now();
  const list = (fails.get(ip) || []).filter((t) => now - t < WINDOW);
  fails.set(ip, list);
  return list.length >= MAX_FAILS;
}
const noteFail = (ip) => fails.set(ip, [...(fails.get(ip) || []), Date.now()]);
const clearFails = (ip) => fails.delete(ip);

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

module.exports = { signToken, verifyToken, hashPin, checkPin, isLimited, noteFail, clearFails, safeEqual, bearer };
