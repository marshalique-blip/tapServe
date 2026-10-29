// Sends a correctly signed fake Fygaro webhook to your server (sandbox testing without a real card).
// Usage: node test-webhook.js <payment_ref> <amount> [currency] [baseUrl]
//   node test-webhook.js pay_abc123 25.00
//   node test-webhook.js pay_abc123 10.00     <- underpay: should be flagged payment_mismatch
try { require('dotenv').config(); } catch (_) {}
const crypto = require('crypto');

const [ref, amount, currency = process.env.PAYMENT_CURRENCY || 'USD', base = 'http://localhost:3000'] = process.argv.slice(2);
if (!ref || !amount) { console.error('Usage: node test-webhook.js <payment_ref> <amount> [currency] [baseUrl]'); process.exit(1); }

const keyId = process.env.FYGARO_API_KEY, secret = process.env.FYGARO_API_SECRET;
const body = JSON.stringify({
  transactionId: crypto.randomUUID(), reference: 'TEST-' + Date.now(), customReference: ref,
  authCode: 'A12345', currency, amount: Number(amount).toFixed(2), createdAt: new Date().toISOString(),
});
const t = Math.floor(Date.now() / 1000);
const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

fetch(`${base}/webhooks/fygaro`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Fygaro-Key-ID': keyId, 'Fygaro-Signature': `t=${t},v1=${sig}` },
  body,
}).then(async (r) => console.log(r.status, await r.text()));
