// fygaro.js — payment link building + webhook signature verification (no external deps)
const crypto = require('crypto');

const MODE = (process.env.FYGARO_LINK_MODE || 'plain').toLowerCase();
const BUTTON_URL = process.env.FYGARO_BUTTON_URL;
const CURRENCY = process.env.PAYMENT_CURRENCY || 'USD';
const LINK_TTL_MIN = Number(process.env.PAYMENT_LINK_TTL_MIN || 15);

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * Build the URL the customer is sent to for payment.
 * plain: ?amount=&client_reference=   (customer can edit amount — server check on webhook is the safeguard)
 * jwt:   ?jwt=<signed>                (amount locked; Fygaro Pro plan or above)
 */
function buildPaymentLink({ paymentRef, total }) {
  if (!BUTTON_URL) throw new Error('FYGARO_BUTTON_URL is not set');
  const amount = Number(total).toFixed(2);
  const url = new URL(BUTTON_URL);

  if (MODE === 'jwt') {
    const key = process.env.FYGARO_API_KEY;
    const secret = process.env.FYGARO_API_SECRET;
    if (!key || !secret) throw new Error('FYGARO_API_KEY / FYGARO_API_SECRET required for jwt mode');
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'HS256', typ: 'JWT', kid: key };
    const payload = {
      amount,
      currency: CURRENCY,
      custom_reference: paymentRef,
      nbf: now - 5,
      exp: now + LINK_TTL_MIN * 60,
    };
    const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = crypto.createHmac('sha256', secret).update(unsigned).digest();
    url.searchParams.set('jwt', `${unsigned}.${b64url(sig)}`);
  } else {
    url.searchParams.set('amount', amount);
    url.searchParams.set('client_reference', paymentRef);
  }
  return url.toString();
}

function getSecrets() {
  if (process.env.FYGARO_WEBHOOK_SECRETS) {
    try { return JSON.parse(process.env.FYGARO_WEBHOOK_SECRETS); } catch (_) { /* fall through */ }
  }
  if (process.env.FYGARO_API_KEY && process.env.FYGARO_API_SECRET) {
    return { [process.env.FYGARO_API_KEY]: process.env.FYGARO_API_SECRET };
  }
  return {};
}

/**
 * Verify a Fygaro webhook per their documented algorithm.
 * @param {Buffer} rawBody  exact bytes received
 * @param {object} headers  lower-cased request headers
 * @returns {{ok:boolean, reason?:string}}
 */
function verifyWebhook(rawBody, headers) {
  const sigHeader = headers['fygaro-signature'];
  const keyId = headers['fygaro-key-id'];
  if (!sigHeader || !keyId) return { ok: false, reason: 'missing headers' };

  const secret = getSecrets()[keyId];
  if (!secret) return { ok: false, reason: 'unknown key id' };

  let t = null;
  const hashes = [];
  for (const part of String(sigHeader).split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s.trim());
    if (k === 't') t = v;
    if (k === 'v1' && v) hashes.push(v);
  }
  if (!t || !hashes.length) return { ok: false, reason: 'malformed signature' };

  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > 300) {
    return { ok: false, reason: 'stale timestamp' };
  }

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  const expBuf = Buffer.from(expected, 'hex');
  const match = hashes.some((h) => {
    const hb = Buffer.from(h, 'hex');
    return hb.length === expBuf.length && crypto.timingSafeEqual(hb, expBuf);
  });
  return match ? { ok: true } : { ok: false, reason: 'invalid signature' };
}

module.exports = { buildPaymentLink, verifyWebhook, CURRENCY, MODE };
