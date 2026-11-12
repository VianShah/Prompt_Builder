const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const llm = require('./lib/llm');
const kollect = require('./lib/kollect');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));

// Render health check: no auth, no secrets.
app.get('/healthz', async (req, res) => { const d = await db.ping(); res.status(d.ok ? 200 : 503).json({ ok: d.ok }); });

app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.use('/api', auth.requireUser);
app.get('/api/me', (req, res) => res.json({ user: req.user, selfApprove: config.selfApprove }));
app.get('/api/health', async (req, res) => res.json({
  db: await db.ping(), llm: llm.labels(), kollect: { enabled: kollect.enabled(), baseUrl: config.kollect.baseUrl || null }, sarvamPush: config.sarvamPush, library: require('./lib/libraryStore').status(),
}));
app.use('/api', require('./routes/agents'));
app.use('/api', require('./routes/prompts'));
app.use('/api', require('./routes/feedback'));
app.use('/api', require('./routes/ai'));
app.use('/api', require('./routes/modules'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// no-cache: browsers re-check the scripts on every load, so an update shows up without a hard refresh.
const fresh = { setHeaders: res => res.set('Cache-Control', 'no-cache') };
app.use('/shared', express.static(path.join(__dirname, '..', 'shared'), fresh));
app.use(express.static(path.join(__dirname, '..', 'public'), fresh));

db.init().then(() => {
  if (!config.users.length) console.warn('[auth] BUILDER_USERS is empty: nobody can sign in. See .env.example.');
  if (config.sessionSecret === 'dev-only-secret-change-me') console.warn('[auth] SESSION_SECRET is not set.');
  console.log(`[llm] providers: ${llm.labels().join(' → ') || 'none (rule-based fallback only)'}`);
  console.log(`[kollect] ${kollect.enabled() ? config.kollect.baseUrl : 'not configured'}`);
  app.listen(config.port, () => console.log(`Prompt Builder on http://localhost:${config.port}`));
}).catch(e => { console.error('[db] failed to start:', e); process.exit(1); });
