// kds-auth.js — gate for the kitchen display: HTTP routes and the Socket.IO connection.
// A request is allowed only with a valid kitchen token whose PIN is still active.
const auth = require('./auth');

const cache = new Map();            // pin id -> { ok, at }   (short cache so busy screens don't hit the DB every call)
const TTL = 15000;

async function pinActive(supabase, id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.ok;
  const { data, error } = await supabase.from('kds_pins').select('active').eq('id', id).maybeSingle();
  if (error) return hit ? hit.ok : false;      // DB hiccup: keep the last known answer, otherwise deny
  const ok = !!(data && data.active);
  cache.set(id, { ok, at: Date.now() });
  return ok;
}
const forgetPin = (id) => cache.delete(id);

const kdsOnly = (supabase) => async (req, res, next) => {
  const t = auth.verifyToken(auth.bearer(req));
  if (!t || t.role !== 'kds' || !(await pinActive(supabase, t.id))) {
    return res.status(401).json({ success: false, error: 'Please sign in again' });
  }
  next();
};

const socketAuth = (supabase) => async (socket, next) => {
  const t = auth.verifyToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!t || t.role !== 'kds' || !(await pinActive(supabase, t.id))) return next(new Error('unauthorized'));
  socket.data.kdsPin = t.id;
  next();
};

module.exports = { kdsOnly, socketAuth, forgetPin };