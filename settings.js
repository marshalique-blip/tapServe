// settings.js — admin-controlled feature switches, stored in Supabase (app_settings), cached for 5 seconds.

const DEFAULTS = {
  card_processing: true,        // ON = customers pay via Fygaro; OFF = demo mode (orders go straight to the kitchen)
  accepting_orders: true,
  delivery_enabled: true,
  takeout_enabled: true,
  whatsapp_confirmations: true, // order confirmation + status-update WhatsApp messages
  payment_timeout_min: 30,
  closed_message: "We're not taking orders right now. Please check back soon.",
};

const RULES = {
  card_processing: { type: 'bool' },
  accepting_orders: { type: 'bool' },
  delivery_enabled: { type: 'bool' },
  takeout_enabled: { type: 'bool' },
  whatsapp_confirmations: { type: 'bool' },
  payment_timeout_min: { type: 'int', min: 5, max: 240 },
  closed_message: { type: 'text', max: 200 },
};

let cache = null, cacheAt = 0, warned = false;

async function getSettings(supabase) {
  if (cache && Date.now() - cacheAt < 5000) return cache;
  const s = { ...DEFAULTS };
  const { data, error } = await supabase.from('app_settings').select('key, value');
  if (error) {
    if (!warned) { console.warn('⚠️ app_settings not readable, using defaults:', error.message); warned = true; }
  } else {
    for (const row of data || []) if (row.key in DEFAULTS) s[row.key] = row.value;
  }
  cache = s; cacheAt = Date.now();
  return s;
}

function validate(key, value) {
  const r = RULES[key];
  if (!r) throw new Error(`Unknown setting: ${key}`);
  if (r.type === 'bool') { if (typeof value !== 'boolean') throw new Error(`${key} must be true or false`); return value; }
  if (r.type === 'int') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < r.min || n > r.max) throw new Error(`${key} must be a whole number from ${r.min} to ${r.max}`);
    return n;
  }
  const t = String(value ?? '').trim();
  if (!t || t.length > r.max) throw new Error(`${key} must be 1–${r.max} characters`);
  return t;
}

/** @returns {Promise<Array<{key,from,to}>>} the settings that actually changed */
async function updateSettings(supabase, changes) {
  const current = await getSettings(supabase);
  const rows = [], changed = [];
  for (const [key, raw] of Object.entries(changes || {})) {
    const value = validate(key, raw);
    if (current[key] !== value) { changed.push({ key, from: current[key], to: value }); rows.push({ key, value, updated_at: new Date().toISOString() }); }
  }
  if (rows.length) {
    const { error } = await supabase.from('app_settings').upsert(rows);
    if (error) throw error;
    cache = null;
  }
  return changed;
}

module.exports = { getSettings, updateSettings, DEFAULTS };
