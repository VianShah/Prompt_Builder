const crypto = require('crypto');
const db = require('../db');
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const clone = o => JSON.parse(JSON.stringify(o));
function bump(v) { const [a, b] = String(v || '1.0').split('.'); return `${a}.${(Number(b) || 0) + 1}`; }
async function audit(user, action, detail) {
  await db.put('audit', { id: uid(), at: now(), actor: user ? user.email : 'system', action, detail });
}
// Wrap async route handlers so errors become JSON with a readable message.
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  const map = { no_llm: 503, kollect_off: 503, kollect_timeout: 504, kollect_network: 502, kollect_http: 502, invalid_json: 502, provider_error: 502, sarvam_off: 503, sarvam_no_token: 503, sarvam_token: 401, sarvam_http: 502, sarvam_timeout: 504, sarvam_shape: 502, sarvam_edit: 409, sarvam_base: 409, draft_dirty: 409, library: 502, stale_base: 409 };
  const status = e.status && e.status < 500 && !e.code?.startsWith('kollect') && !e.code?.startsWith('sarvam') ? e.status : (map[e.code] || 500);
  if (status >= 500) console.error('[api]', e.code || '', e.message);
  res.status(status).json({ error: e.publicMessage || e.message || 'Something went wrong.', code: e.code || 'error', ...(e.payload || {}) });
});
const fail = (status, msg, code) => Object.assign(new Error(msg), { status, publicMessage: msg, code: code || 'bad_request' });
module.exports = { uid, now, clone, bump, audit, h, fail };
