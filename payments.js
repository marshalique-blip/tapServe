// payments.js — Fygaro webhook (full / partial / over payment), status endpoint, expiry job, post-payment actions.

const express = require('express');
const { verifyWebhook, buildPaymentLink, CURRENCY } = require('./fygaro');
const { getSettings } = require('./settings');
const { audit } = require('./audit');
const crypto = require('crypto');

// Never shown on the KDS, order lists, revenue stats, and can't be moved forward by a status change.
const UNPAID_STATUSES = ['pending_payment', 'expired', 'payment_mismatch', 'payment_partial', 'payment_hold', 'cancelled'];
// States an order can still be confirmed from
const OPEN_STATUSES = ['pending_payment', 'expired', 'payment_partial', 'payment_hold'];

const cents = (v) => Math.round(Number(v || 0) * 100);
const money = (c) => `$${(c / 100).toFixed(2)}`;
const newPaymentRef = () => `pay_${crypto.randomBytes(12).toString('hex')}`;
const whatsappEnabled = () => !!(process.env.META_PHONE_ID && process.env.META_ACCESS_TOKEN);

async function notify({ sendWhatsAppMessage }, phone, text) {
  if (!whatsappEnabled() || !phone) return;
  try { await sendWhatsAppMessage(phone, text); } catch (err) { console.error('❌ WhatsApp notify failed:', err.message); }
}
const alertStaff = (io, type, order, message) =>
  io.emit('payment-alert', { type, orderNumber: order.order_number, message });

/**
 * KDS ticket + WhatsApp confirmation for a confirmed order.
 * Each step is flagged in the DB so a repeat call only retries what failed.
 */
async function runSideEffects(deps, order) {
  const { supabase, io, sendWhatsAppMessage } = deps;

  if (!order.kds_sent) {
    try {
      io.emit('new-kds-order', {
        ...(order.kds_payload || { id: order.id, orderNumber: order.order_number }),
        status: 'new',
        timestamp: new Date().toISOString(),
      });
      await supabase.from('orders').update({ kds_sent: true }).eq('id', order.id);
      console.log(`📡 KDS broadcast sent for ${order.order_number}`);
    } catch (err) { console.error('❌ KDS emit failed:', err.message); }
  }

  if (!order.whatsapp_sent && order.confirmation_message && whatsappEnabled()) {
    const cfg = await getSettings(supabase);
    if (cfg.whatsapp_confirmations) {
      const extra = cents(order.refund_amount);
      const text = extra > 0 && order.refund_status === 'pending'
        ? `${order.confirmation_message}\n\nWe received ${money(extra)} more than your total. The extra will be refunded to you, our team will be in touch.`
        : order.confirmation_message;
      try {
        const result = await sendWhatsAppMessage(order.phone_number, text);
        if (result && result.success) await supabase.from('orders').update({ whatsapp_sent: true }).eq('id', order.id);
        else console.error('❌ WhatsApp confirmation not sent for', order.order_number);
      } catch (err) { console.error('❌ WhatsApp confirmation failed:', err.message); }
    }
  }
}

/** POST /webhooks/fygaro — mount BEFORE express.json(): signature checking needs the raw body. */
function webhookRouter(deps) {
  const { supabase, io } = deps;
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
    if (!p.transactionId) return res.status(400).json({ error: 'missing transactionId' });

    const logEvent = (outcome, ref) =>
      supabase.from('payment_events').insert({
        transaction_id: p.transactionId, payment_ref: ref || null, amount: p.amount, currency: p.currency,
        outcome, raw: { ...p, jwt: undefined, card: undefined, billing: undefined },
      }).then(() => {}, () => {});

    try {
      // JWT mode returns customReference; plain mode may return it as client_reference (confirm in sandbox).
      const candidates = [p.customReference, p.client_reference, p.clientReference, p.reference]
        .filter((v) => typeof v === 'string' && v.startsWith('pay_'));
      const { data: order } = candidates.length
        ? await supabase.from('orders').select('*').in('payment_ref', candidates).maybeSingle()
        : { data: null };
      if (!order) { await logEvent('unmatched'); return res.status(200).json({ ok: true, matched: false }); }

      const currencyOk = String(p.currency || '').toUpperCase() === CURRENCY.toUpperCase();

      // Record this payment. transaction_id is unique, so a re-delivered webhook is caught here.
      const ins = await supabase.from('order_payments').insert({
        order_id: order.id, transaction_id: p.transactionId, amount: p.amount, currency: p.currency, counted: currencyOk,
      });
      if (ins.error) {
        if (ins.error.code === '23505') {
          if (order.paid_at) await runSideEffects(deps, order);      // retry anything that failed earlier
          await logEvent('duplicate', order.payment_ref);
          return res.status(200).json({ ok: true, duplicate: true });
        }
        throw ins.error;
      }

      // Total received so far (same-currency payments only)
      const { data: pays } = await supabase.from('order_payments').select('amount').eq('order_id', order.id).eq('counted', true);
      const paidC = (pays || []).reduce((s, r) => s + cents(r.amount), 0);
      const totalC = cents(order.total_amount);
      const now = new Date().toISOString();

      // Order was cancelled: whatever arrives is refunded
      if (order.status === 'cancelled') {
        await supabase.from('orders').update({ amount_paid: paidC / 100, refund_amount: paidC / 100, refund_status: 'pending', updated_at: now }).eq('id', order.id);
        await audit(supabase, { action: 'payment_on_cancelled_order', order, amount: cents(p.amount) / 100, details: { transactionId: p.transactionId } });
        alertStaff(io, 'refund_due', order, `Payment of ${money(cents(p.amount))} arrived on cancelled order ${order.order_number}. Refund needed.`);
        await logEvent('cancelled_order_payment', order.payment_ref);
        return res.status(200).json({ ok: true });
      }

      // Already confirmed: anything beyond the total is an overpayment to refund
      if (order.paid_at) {
        const excess = Math.max(0, paidC - totalC);
        if (excess > 0) {
          await supabase.from('orders').update({ amount_paid: paidC / 100, refund_amount: excess / 100, refund_status: 'pending', updated_at: now }).eq('id', order.id);
          alertStaff(io, 'refund_due', order, `Extra payment on ${order.order_number}: refund ${money(excess)}.`);
        }
        await logEvent('extra_payment', order.payment_ref);
        return res.status(200).json({ ok: true });
      }

      // Wrong currency: hold for a manager, tell the customer
      if (!currencyOk) {
        const { data: held } = await supabase.from('orders').update({
          status: 'payment_hold', amount_paid: paidC / 100, updated_at: now,
          payment_flag: `Paid in ${p.currency || '?'} (expected ${CURRENCY}): ${p.amount}`,
        }).eq('id', order.id).in('status', OPEN_STATUSES).select().maybeSingle();
        if (held) {
          await notify(deps, order.phone_number, `We received your payment for order #${order.order_number}, but it needs a quick check by our team before we can confirm it. We'll message you shortly.`);
          alertStaff(io, 'payment_hold', order, `Order ${order.order_number}: payment in wrong currency (${p.currency}). Manager review needed.`);
        }
        await logEvent('currency_hold', order.payment_ref);
        return res.status(200).json({ ok: true });
      }

      // Paid in full (or more): confirm, send to kitchen
      if (paidC >= totalC) {
        const excess = paidC - totalC;
        const { data: claimed } = await supabase.from('orders').update({
          status: 'new', amount_paid: paidC / 100, paid_at: now, fygaro_transaction_id: p.transactionId, updated_at: now,
          refund_amount: excess > 0 ? excess / 100 : null, refund_status: excess > 0 ? 'pending' : null, payment_flag: null,
        }).eq('id', order.id).in('status', OPEN_STATUSES).select().maybeSingle();
        if (claimed) {
          console.log(`💳 Payment confirmed: ${claimed.order_number}${excess > 0 ? ` (overpaid ${money(excess)})` : ''}`);
          await runSideEffects(deps, claimed);
          if (excess > 0) alertStaff(io, 'refund_due', claimed, `Order ${claimed.order_number} overpaid by ${money(excess)}. Refund needed.`);
          await logEvent(excess > 0 ? 'paid_overpaid' : 'paid', order.payment_ref);
        }
        return res.status(200).json({ ok: true });
      }

      // Underpaid: hold the order and give the customer a one-tap link for the difference
      const remainingC = totalC - paidC;
      const { data: partial } = await supabase.from('orders').update({
        status: 'payment_partial', amount_paid: paidC / 100, updated_at: now,
        payment_flag: `Received ${money(paidC)} of ${money(totalC)}`,
      }).eq('id', order.id).in('status', OPEN_STATUSES).select().maybeSingle();
      if (partial) {
        let link = '';
        try { link = buildPaymentLink({ paymentRef: order.payment_ref, total: remainingC / 100 }); } catch (_) {}
        await notify(deps, order.phone_number,
          `Hi ${order.customer_name}, we received ${money(paidC)} of ${money(totalC)} for order #${order.order_number}.\n\n` +
          `To confirm it, please pay the remaining *${money(remainingC)}*${link ? `:\n${link}` : '.'}\n\n` +
          `Your order goes to the kitchen as soon as the balance is paid.`);
        alertStaff(io, 'payment_partial', order, `Order ${order.order_number}: ${money(paidC)} of ${money(totalC)} received. Waiting for the customer to top up.`);
        await logEvent('partial', order.payment_ref);
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
    const { data } = await supabase.from('orders').select('order_number, status, paid_at, total_amount, amount_paid').eq('payment_ref', ref).maybeSingle();
    if (!data) return res.status(404).json({ error: 'not found' });
    const status = data.paid_at ? 'paid'
      : ['payment_partial', 'payment_hold', 'expired', 'cancelled'].includes(data.status) ? data.status
      : data.status === 'payment_mismatch' ? 'payment_hold' : 'pending_payment';
    const remaining = Math.max(0, cents(data.total_amount) - cents(data.amount_paid)) / 100;
        let pay_url;
    if (status === 'payment_partial' && remaining > 0) {
      try { pay_url = buildPaymentLink({ paymentRef: ref, total: remaining }); } catch (_) {}
    }
    res.set('Cache-Control', 'no-store').json({ status, order_number: data.order_number, remaining, pay_url });
  });
  return router;
}

/** Marks unpaid orders as expired so they never linger. Timeout comes from the admin panel. */
function startPaymentExpiryJob(supabase) {
  setInterval(async () => {
    try {
      const cfg = await getSettings(supabase);
      const cutoff = new Date(Date.now() - cfg.payment_timeout_min * 60000).toISOString();
      const { error } = await supabase.from('orders').update({ status: 'expired' })
        .eq('status', 'pending_payment').lt('created_at', cutoff);
      if (error) console.error('❌ Payment expiry job error:', error.message);
    } catch (err) { console.error('❌ Payment expiry job error:', err.message); }
  }, 5 * 60000);
}

module.exports = { webhookRouter, statusRouter, startPaymentExpiryJob, newPaymentRef, runSideEffects, UNPAID_STATUSES, OPEN_STATUSES };
