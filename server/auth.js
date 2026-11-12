// Signed-cookie sessions for the users listed in BUILDER_USERS. No passwords are stored in the database.
const crypto = require('crypto');
const config = require('./config');

const COOKIE = 'pb_session';
const TTL_MS = 12 * 60 * 60 * 1000;
const sign = v => crypto.createHmac('sha256', config.sessionSecret).update(v).digest('base64url');
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

function readCookie(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [payload, sig] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split('.');
  if (!payload || !sig || !safeEq(sign(payload), sig)) return null;
  try { const d = JSON.parse(Buffer.from(payload, 'base64url').toString()); return d.exp > Date.now() ? d : null; } catch (_) { return null; }
}
function publicUser(u) { return { email: u.email, name: u.name, role: u.role }; }

function login(req, res) {
  const { email, password } = req.body || {};
  const u = config.users.find(x => x.email === String(email || '').toLowerCase());
  if (!u || !safeEq(u.password, password || '')) return res.status(401).json({ error: 'Email or password is wrong.' });
  const payload = Buffer.from(JSON.stringify({ email: u.email, exp: Date.now() + TTL_MS })).toString('base64url');
  const secure = (req.headers['x-forwarded-proto'] || req.protocol) === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(payload + '.' + sign(payload))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`);
  res.json({ user: publicUser(u), selfApprove: config.selfApprove });
}
function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}
function requireUser(req, res, next) {
  const s = readCookie(req);
  const u = s && config.users.find(x => x.email === s.email);
  if (!u) return res.status(401).json({ error: 'Sign in to continue.' });
  req.user = publicUser(u);
  next();
}
const can = (user, action) => ({
  edit: ['editor', 'approver', 'admin'],
  approve: ['approver', 'admin'],
  golive: ['approver', 'admin'],
  rollback: ['admin', 'approver'],
}[action] || []).includes(user.role);

module.exports = { login, logout, requireUser, can };
