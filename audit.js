// audit.js — append-only record of anything money- or control-related. Never throws; returns {ok}.
async function audit(supabase, { action, role = 'system', name = null, order = null, amount = null, reason = null, details = null }) {
  const row = {
    action, actor_role: role, actor_name: name,
    order_id: order?.id || null, order_number: order?.order_number || null,
    amount, reason, details,
  };
  const { error } = await supabase.from('payment_audit').insert(row);
  if (error) { console.error('🚨 AUDIT WRITE FAILED — record this manually:', JSON.stringify(row), error.message); return { ok: false }; }
  return { ok: true };
}
module.exports = { audit };
