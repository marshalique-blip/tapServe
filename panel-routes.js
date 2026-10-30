// panel-routes.js — admin panel (feature switches, managers) and manager tools (waivers, refunds, log).
//   Admin  = owner, signs in with ADMIN_PASSWORD. Can change settings and manage managers. CANNOT waive payments.
//   Manager = signs in with their own PIN. Can approve waivers / queue refunds. Every action is logged with their name.

const express = require('express');
const auth = require('./auth');
const { getSettings, updateSettings } = require('./settings');
const { audit } = require('./audit');
const { runSideEffects } = require('./payments');
const { forgetPin } = require('./kds-auth');

const cents = (v) => Math.round(Number(v || 0) * 100);
const money = (c) => `$${(c / 100).toFixed(2)}`;
const HELD = ['payment_partial', 'payment_hold'];

function panelRouter(deps) {
  const { supabase } = deps;
  const r = express.Router();
  const json = express.json({ limit: '50kb' });
  const ready = (req, res, next) =>
    process.env.SESSION_SECRET ? next() : res.status(503).json({ error: 'SESSION_SECRET is not set on the server' });

  const adminOnly = (req, res, next) => {
    const t = auth.verifyToken(auth.bearer(req));
    if (!t || t.role !== 'admin') return res.status(401).json({ error: 'Please sign in again' });
    req.actor = t; next();
  };
  const managerOnly = async (req, res, next) => {
    const t = auth.verifyToken(auth.bearer(req));
    if (!t || t.role !== 'manager') return res.status(401).json({ error: 'Please sign in again' });
    const { data: m } = await supabase.from('managers').select('id, name, active').eq('id', t.id).maybeSingle();
    if (!m || !m.active) return res.status(401).json({ error: 'Manager access removed' });
    req.actor = { id: m.id, name: m.name }; next();
  };

  // ---------------------------------------------------------------- Public: what the order page needs
  r.get('/api/public-config', async (req, res) => {
    const c = await getSettings(supabase);
    res.set('Cache-Control', 'no-store').json({
      accepting_orders: c.accepting_orders, delivery_enabled: c.delivery_enabled,
      takeout_enabled: c.takeout_enabled, closed_message: c.closed_message,
    });
  });

  // ---------------------------------------------------------------- Admin
  r.post('/api/admin/login', ready, json, (req, res) => {
    const ip = req.ip;
    if (auth.isLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected || !auth.safeEqual(req.body?.password || '', expected)) {
      auth.noteFail(ip); return res.status(401).json({ error: 'Wrong password' });
    }
    auth.clearFails(ip);
    res.json({ token: auth.signToken({ role: 'admin' }, 8 * 3600) });
  });

  r.get('/api/admin/settings', ready, adminOnly, async (req, res) => {
    const f = require('./fygaro');
    res.set('Cache-Control', 'no-store').json({
      settings: await getSettings(supabase),
      fygaro_configured: !!(process.env.FYGARO_BUTTON_URL && process.env.FYGARO_API_KEY && process.env.FYGARO_API_SECRET),
      link_mode: f.MODE,
    });
  });

  r.put('/api/admin/settings', ready, adminOnly, json, async (req, res) => {
    try {
      const changed = await updateSettings(supabase, req.body);
      for (const c of changed) await audit(supabase, { action: 'setting_changed', role: 'admin', name: 'admin', details: c });
      res.json({ ok: true, settings: await getSettings(supabase) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  r.get('/api/admin/managers', ready, adminOnly, async (req, res) => {
    const { data } = await supabase.from('managers').select('id, name, active, created_at').order('created_at', { ascending: true });
    res.json({ managers: data || [] });
  });

  r.post('/api/admin/managers', ready, adminOnly, json, async (req, res) => {
    const name = String(req.body?.name || '').trim(), pin = String(req.body?.pin || '');
    if (!name || name.length > 60) return res.status(400).json({ error: 'Name is required (max 60 characters)' });
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 to 8 digits' });
    const { data: existing } = await supabase.from('managers').select('pin_salt, pin_hash').eq('active', true);
    if ((existing || []).some((m) => auth.checkPin(pin, m.pin_salt, m.pin_hash))) {
      return res.status(400).json({ error: 'That PIN is already in use. Choose a different one.' });
    }
    const { salt, hash } = auth.hashPin(pin);
    const { data, error } = await supabase.from('managers').insert({ name, pin_salt: salt, pin_hash: hash }).select('id, name, active').single();
    if (error) return res.status(500).json({ error: 'Could not add manager' });
    await audit(supabase, { action: 'manager_added', role: 'admin', name: 'admin', details: { manager: name, id: data.id } });
    res.json({ ok: true, manager: data });
  });

  r.post('/api/admin/managers/:id/deactivate', ready, adminOnly, async (req, res) => {
    const { data } = await supabase.from('managers').update({ active: false }).eq('id', req.params.id).select('id, name').maybeSingle();
    if (!data) return res.status(404).json({ error: 'Manager not found' });
    await audit(supabase, { action: 'manager_deactivated', role: 'admin', name: 'admin', details: { manager: data.name, id: data.id } });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- Manager
  r.post('/api/manager/login', ready, json, async (req, res) => {
    const ip = req.ip, pin = String(req.body?.pin || '');
    if (auth.isLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
    const { data: managers } = await supabase.from('managers').select('id, name, pin_salt, pin_hash').eq('active', true);
    const m = /^\d{4,8}$/.test(pin) ? (managers || []).find((x) => auth.checkPin(pin, x.pin_salt, x.pin_hash)) : null;
    if (!m) { auth.noteFail(ip); return res.status(401).json({ error: 'Wrong PIN' }); }
    auth.clearFails(ip);
    res.json({ token: auth.signToken({ role: 'manager', id: m.id }, 2 * 3600), name: m.name });
  });

  r.get('/api/manager/queue', ready, managerOnly, async (req, res) => {
    const cols = 'id, order_number, customer_name, phone_number, status, total_amount, amount_paid, refund_amount, payment_flag, created_at, kds_payload';
    const [held, refunds, log] = await Promise.all([
      supabase.from('orders').select(cols).in('status', HELD).order('created_at', { ascending: true }),
      supabase.from('orders').select(cols).eq('refund_status', 'pending').order('created_at', { ascending: true }),
      supabase.from('payment_audit').select('at, action, actor_role, actor_name, order_number, amount, reason').order('at', { ascending: false }).limit(40),
    ]);
    const slim = (o) => ({ ...o, items: (o.kds_payload?.items || []).map((i) => `${i.quantity}× ${i.name}`), kds_payload: undefined });
    res.set('Cache-Control', 'no-store').json({
      manager: req.actor.name, held: (held.data || []).map(slim), refunds: (refunds.data || []).map(slim), log: log.data || [],
    });
  });

  // Approve a short order. Requires a manager and a reason; logged permanently.
  r.post('/api/manager/waive', ready, managerOnly, json, async (req, res) => {
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 5 || reason.length > 300) return res.status(400).json({ error: 'A reason is required (5–300 characters)' });
    const { data: order } = await supabase.from('orders').select('*').eq('id', String(req.body?.order_id || '')).maybeSingle();
    if (!order || !HELD.includes(order.status)) return res.status(409).json({ error: 'This order is not waiting for approval' });

    const waivedC = Math.max(0, cents(order.total_amount) - cents(order.amount_paid));
    const now = new Date().toISOString();
    const { data: claimed } = await supabase.from('orders').update({
      status: 'new', paid_at: now, waived_amount: waivedC / 100, waived_by: req.actor.name, payment_flag: null, updated_at: now,
    }).eq('id', order.id).in('status', HELD).select().maybeSingle();
    if (!claimed) return res.status(409).json({ error: 'Someone else already handled this order' });

    const logged = await audit(supabase, {
      action: 'waiver_approved', role: 'manager', name: req.actor.name, order, amount: waivedC / 100, reason,
      details: { total: order.total_amount, paid: order.amount_paid },
    });
    // Waived orders get the plain confirmation text (no "payment received" wording)
    const text = (claimed.confirmation_message || '')
      .replace('Payment received – Order Confirmed!', 'Order Confirmed!').replace('Total paid:', 'Total:');
    await runSideEffects(deps, { ...claimed, confirmation_message: text, refund_amount: null });
    res.json({ ok: true, logged: logged.ok });
  });

  // Cancel a held order and queue whatever was received for refund
  r.post('/api/manager/cancel-refund', ready, managerOnly, json, async (req, res) => {
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 5 || reason.length > 300) return res.status(400).json({ error: 'A reason is required (5–300 characters)' });
    const { data: order } = await supabase.from('orders').select('*').eq('id', String(req.body?.order_id || '')).maybeSingle();
    if (!order || !HELD.includes(order.status)) return res.status(409).json({ error: 'This order is not waiting for approval' });
    const paid = cents(order.amount_paid) / 100;
    const { data: claimed } = await supabase.from('orders').update({
      status: 'cancelled', refund_amount: paid, refund_status: paid > 0 ? 'pending' : null, updated_at: new Date().toISOString(),
    }).eq('id', order.id).in('status', HELD).select().maybeSingle();
    if (!claimed) return res.status(409).json({ error: 'Someone else already handled this order' });
    await audit(supabase, { action: 'order_cancelled_refund_queued', role: 'manager', name: req.actor.name, order, amount: paid, reason });
    if (deps.sendWhatsAppMessage && process.env.META_PHONE_ID) {
      deps.sendWhatsAppMessage(order.phone_number, `Order #${order.order_number} could not be completed and has been cancelled.${paid > 0 ? ` Your payment of ${money(cents(paid))} will be refunded.` : ''} Sorry about that.`);
    }
    res.json({ ok: true });
  });

  r.post('/api/manager/refund-done', ready, managerOnly, json, async (req, res) => {
    const note = String(req.body?.note || '').trim().slice(0, 300);
    const { data: order } = await supabase.from('orders').select('*').eq('id', String(req.body?.order_id || '')).maybeSingle();
    if (!order || order.refund_status !== 'pending') return res.status(409).json({ error: 'No pending refund on this order' });
    const { data: claimed } = await supabase.from('orders').update({ refund_status: 'done', updated_at: new Date().toISOString() })
      .eq('id', order.id).eq('refund_status', 'pending').select().maybeSingle();
    if (!claimed) return res.status(409).json({ error: 'Someone else already handled this refund' });
    await audit(supabase, { action: 'refund_marked_done', role: 'manager', name: req.actor.name, order, amount: order.refund_amount, reason: note || null });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- Kitchen display (KDS) PINs
  // Each PIN is 4 digits, has a label (e.g. "Front line", "Closing shift"), and can be removed at any time.
  const KDS_PIN = /^\d{4}$/;

  r.post('/api/kds/login', ready, json, async (req, res) => {
    const ip = req.ip, pin = String(req.body?.pin || '');
    if (auth.isLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
    const { data: pins, error } = await supabase.from('kds_pins').select('id, label, pin_salt, pin_hash').eq('active', true);
    if (error) return res.status(500).json({ error: 'Sign-in is unavailable right now' });
    const p = KDS_PIN.test(pin) ? (pins || []).find((x) => auth.checkPin(pin, x.pin_salt, x.pin_hash)) : null;
    if (!p) { auth.noteFail(ip); return res.status(401).json({ error: 'Wrong PIN' }); }
    auth.clearFails(ip);
    res.json({ token: auth.signToken({ role: 'kds', id: p.id }, 8 * 3600), label: p.label });
  });

  // The KDS page calls this on load so a removed PIN stops working without waiting for the 8 hours to run out
  r.get('/api/kds/verify', ready, async (req, res) => {
    const t = auth.verifyToken(auth.bearer(req));
    if (!t || t.role !== 'kds') return res.status(401).json({ error: 'Please sign in again' });
    const { data: p } = await supabase.from('kds_pins').select('id, label, active').eq('id', t.id).maybeSingle();
    if (!p || !p.active) return res.status(401).json({ error: 'This PIN was removed' });
    res.set('Cache-Control', 'no-store').json({ ok: true, label: p.label });
  });

  r.get('/api/admin/kds-pins', ready, adminOnly, async (req, res) => {
    const { data } = await supabase.from('kds_pins').select('id, label, active, created_at').eq('active', true).order('created_at', { ascending: true });
    res.set('Cache-Control', 'no-store').json({ pins: data || [] });
  });

  r.post('/api/admin/kds-pins', ready, adminOnly, json, async (req, res) => {
    const label = String(req.body?.label || '').trim(), pin = String(req.body?.pin || '');
    if (!label || label.length > 60) return res.status(400).json({ error: 'Label is required (max 60 characters)' });
    if (!KDS_PIN.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    const { data: existing } = await supabase.from('kds_pins').select('pin_salt, pin_hash').eq('active', true);
    if ((existing || []).some((m) => auth.checkPin(pin, m.pin_salt, m.pin_hash))) {
      return res.status(400).json({ error: 'That PIN is already in use. Choose a different one.' });
    }
    const { salt, hash } = auth.hashPin(pin);
    const { data, error } = await supabase.from('kds_pins').insert({ label, pin_salt: salt, pin_hash: hash }).select('id, label').single();
    if (error) return res.status(500).json({ error: 'Could not add PIN' });
    await audit(supabase, { action: 'kds_pin_added', role: 'admin', name: 'admin', details: { label, id: data.id } });
    res.json({ ok: true, pin: data });
  });

  r.post('/api/admin/kds-pins/:id/deactivate', ready, adminOnly, async (req, res) => {
    const { data } = await supabase.from('kds_pins').update({ active: false }).eq('id', req.params.id).select('id, label').maybeSingle();
    if (!data) return res.status(404).json({ error: 'PIN not found' });
    forgetPin(data.id);
    // Disconnect any kitchen screen signed in with this PIN, right now
    if (deps.io) deps.io.sockets.sockets.forEach((sk) => { if (sk.data && sk.data.kdsPin === data.id) sk.disconnect(true); });
    await audit(supabase, { action: 'kds_pin_removed', role: 'admin', name: 'admin', details: { label: data.label, id: data.id } });
    res.json({ ok: true });
  });

  return r;
}

module.exports = { panelRouter };