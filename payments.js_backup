// payments.js — Fygaro webhook, payment-status endpoint, expiry job. Built around your existing server.js:
// same `new-kds-order` event, same WhatsApp sender, same orders table. See server-changes.md for the edits.

const express = require('express');
const crypto = require('crypto');
const { verifyWebhook, CURRENCY } = require('./fygaro');

// Statuses that mean "not paid" — kept off the KDS, the order lists, revenue stats and status changes.
const UNPAID_STATUSES = ['pending_payment', 'expired', 'payment_mismatch'];

const cents = (v) => Math.round(Number(v) * 100);
const newPaymentRef = () => `pay_${crypto.randomBytes(12).toString('hex')}`;
const whatsappEnabled = () => !!(process.env.META_PHONE_ID && process.env.META_ACCESS_TOKEN);

/** KDS ticket + WhatsApp confirmation. Each step is flagged in the DB so a repeat webhook only retries what failed. */
async function runSideEffects({ supabase, io, sendWhatsAppMessage }, order) {
  if (!order.kds_sent) {
    try {
      io.emit('new-kds-order', {
        ...(order.kds_payload || { id: order.id, orderNumber: order.order_number }),
        status: 'new',
        timestamp: new Date().toISOString(),
      });
      await supabase.from('orders').update({ kds_sent: true }).eq('id', order.id);
      console.log(`📡 KDS broadcast sent for paid order ${order.order_number}`);
    } catch (err) { console.error('❌ KDS emit failed:', err.message); }
  }

  if (!order.whatsapp_sent && order.confirmation_message && whatsappEnabled()) {
    try {
      const result = await sendWhatsAppMessage(order.phone_number, order.confirmation_message);
      if (result && result.success) {
        await supabase.from('orders').update({ whatsapp_sent: true }).eq('id', order.id);
      } else {
        console.error('❌ WhatsApp confirmation not sent for', order.order_number);
      }
    } catch (err) { console.error('❌ WhatsApp confirmation failed:', err.message); }
  }
}

/** POST /webhooks/fygaro — mount BEFORE express.json(): signature checking needs the raw body. */
function webhookRouter(deps) {
  const { supabase } = deps;
  const router = express.Router();

  router.post('/webhooks/fygaro', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const check = verifyWebhook(rawBody, req.headers);
    if (!check.ok) {
      console.warn('⚠️ Fygaro webhook rejected:', check.reason);
      return res.status(400).json({ error: check.reason });
    }

    let p;
    try { p = JSON.parse(rawBody.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'bad json' }); }

    const audit = (outcome, paymentRef) =>
      supabase.from('payment_events').insert({
        transaction_id: p.transactionId, payment_ref: paymentRef || null, amount: p.amount, currency: p.currency,
        outcome, raw: { ...p, jwt: undefined, card: undefined, billing: undefined },
      }).then(() => {}, () => {});

    try {
      // JWT mode returns customReference; plain mode may return it as client_reference (confirm in sandbox).
      const candidates = [p.customReference, p.client_reference, p.clientReference, p.reference]
        .filter((v) => typeof v === 'string' && v.startsWith('pay_'));
      if (!candidates.length) { await audit('unmatched'); return res.status(200).json({ ok: true, matched: false }); }

      const { data: order } = await supabase.from('orders').select('*').in('payment_ref', candidates).maybeSingle();
      if (!order) { await audit('unmatched'); return res.status(200).json({ ok: true, matched: false }); }

      // Duplicate delivery of an already-confirmed payment: only retry side effects that failed before.
      if (order.paid_at) {
        await runSideEffects(deps, order);
        await audit('duplicate', order.payment_ref);
        return res.status(200).json({ ok: true, duplicate: true });
      }
      if (order.status === 'payment_mismatch') {          // second payment on a flagged order: leave for manual review
        await audit('mismatch_repeat', order.payment_ref);
        return res.status(200).json({ ok: true, flagged: true });
      }

      // Full-amount check: amount AND currency must equal what the server stored.
      const amountOk = cents(p.amount) === cents(order.total_amount);
      const currencyOk = String(p.currency || '').toUpperCase() === CURRENCY.toUpperCase();
      if (!amountOk || !currencyOk) {
        await supabase.from('orders').update({
          status: 'payment_mismatch',
          fygaro_transaction_id: p.transactionId || null,
          payment_flag: `Expected ${order.total_amount} ${CURRENCY}, received ${p.amount} ${p.currency}`,
          updated_at: new Date().toISOString(),
        }).eq('id', order.id).in('status', ['pending_payment', 'expired']);
        console.warn(`⚠️ PAYMENT MISMATCH on ${order.order_number}: expected ${order.total_amount}, got ${p.amount} ${p.currency}`);
        await audit('mismatch', order.payment_ref);
        return res.status(200).json({ ok: true, flagged: true });   // 200 stops Fygaro retries; review manually
      }

      // Atomic claim: only one delivery can move the order to 'new'. A late payment on an expired order still counts.
      const { data: claimed } = await supabase.from('orders').update({
        status: 'new', fygaro_transaction_id: p.transactionId, paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', order.id).in('status', ['pending_payment', 'expired']).select().maybeSingle();

      if (claimed) {
        console.log(`💳 Payment confirmed: ${claimed.order_number}`);
        await runSideEffects(deps, claimed);
        await audit('paid', order.payment_ref);
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('❌ Fygaro webhook error:', err);
      return res.status(500).json({ error: 'processing error' });   // non-200 => Fygaro retries
    }
  });

  return router;
}

/** GET /api/payments/status/:paymentRef — polled by payment-complete.html. Returns minimal info only. */
function statusRouter({ supabase }) {
  const router = express.Router();
  router.get('/api/payments/status/:paymentRef', async (req, res) => {
    const ref = String(req.params.paymentRef || '');
    if (!ref.startsWith('pay_')) return res.status(400).json({ error: 'bad reference' });
    const { data } = await supabase.from('orders').select('order_number, status, paid_at').eq('payment_ref', ref).maybeSingle();
    if (!data) return res.status(404).json({ error: 'not found' });
    const status = data.paid_at ? 'paid'
      : data.status === 'payment_mismatch' ? 'payment_mismatch'
      : data.status === 'expired' ? 'expired' : 'pending_payment';
    res.set('Cache-Control', 'no-store').json({ status, order_number: data.order_number });
  });
  return router;
}

/** Marks unpaid orders as expired so they never linger. */
function startPaymentExpiryJob(supabase) {
  const timeoutMin = Number(process.env.PAYMENT_TIMEOUT_MIN || 30);
  setInterval(async () => {
    const cutoff = new Date(Date.now() - timeoutMin * 60000).toISOString();
    const { error } = await supabase.from('orders').update({ status: 'expired' })
      .eq('status', 'pending_payment').lt('created_at', cutoff);
    if (error) console.error('❌ Payment expiry job error:', error.message);
  }, 5 * 60000);
}

module.exports = { webhookRouter, statusRouter, startPaymentExpiryJob, newPaymentRef, UNPAID_STATUSES };
