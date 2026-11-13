// Small document store. Render Postgres when DATABASE_URL is set, a JSON file otherwise (local dev only:
// Render's disk is wiped on every deploy, so production must use Postgres).
const fs = require('fs');
const path = require('path');
const config = require('./config');
// Modules are kept in the git repo (lib/libraryStore.js), not in this store.
const library = require('./lib/libraryStore');
const LIB = 'modules';
// collection -> kind of file in the git library
const LIBK = { modules: 'module', skeletons: 'skeleton' };

const COLLECTIONS = ['callReviews', 'skeletons', 'agents', 'prompts', 'versions', 'feedback', 'coreChanges', 'audit', 'settings', 'tests', 'factory', 'modules'];
let pool = null;
const FILE = path.join(__dirname, '..', 'data', 'store.json');
let mem = null;

async function init() {
  if (config.databaseUrl) {
    const { Pool } = require('pg');
    const local = /localhost|127\.0\.0\.1/.test(config.databaseUrl);
    pool = new Pool({ connectionString: config.databaseUrl, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
    await pool.query(`CREATE TABLE IF NOT EXISTS docs (
      col text NOT NULL, id text NOT NULL, data jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (col, id))`);
    await pool.query('CREATE INDEX IF NOT EXISTS docs_col_updated ON docs (col, updated_at)');
    console.log('[db] Postgres ready');
  } else {
    try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { mem = {}; }
    COLLECTIONS.forEach(c => { mem[c] = mem[c] || {}; });
    console.warn('[db] DATABASE_URL not set: using data/store.json. Fine locally; data will be lost on Render redeploys.');
  }
  // Modules saved in the database before the library moved to git are copied over once.
  let seed = [];
  if (pool) seed = (await pool.query('SELECT data FROM docs WHERE col=$1 ORDER BY created_at', [LIB])).rows.map(r => r.data);
  else seed = Object.values(mem[LIB] || {});
  await library.init(seed);
}
function persistFile() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(mem, null, 1));
}
const check = col => { if (!COLLECTIONS.includes(col)) throw new Error('unknown collection ' + col); };

async function get(col, id) {
  check(col);
  if (LIBK[col]) { const d = await library.get(id); return d && (d._kind || 'module') === LIBK[col] ? d : null; }
  if (pool) { const r = await pool.query('SELECT data FROM docs WHERE col=$1 AND id=$2', [col, id]); return r.rows[0] ? r.rows[0].data : null; }
  return mem[col][id] ? JSON.parse(JSON.stringify(mem[col][id])) : null;
}
async function list(col, filter) {
  check(col);
  let rows;
  if (LIBK[col]) { rows = await library.list(LIBK[col]); return filter ? rows.filter(filter) : rows; }
  if (pool) rows = (await pool.query('SELECT data FROM docs WHERE col=$1 ORDER BY created_at', [col])).rows.map(r => r.data);
  else rows = Object.values(mem[col]).map(d => JSON.parse(JSON.stringify(d))).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return filter ? rows.filter(filter) : rows;
}
async function put(col, doc) {
  check(col);
  if (LIBK[col]) return library.put(col === 'skeletons' ? { ...doc, _kind: 'skeleton' } : doc);
  if (!doc.id) throw new Error('doc.id required');
  doc.updatedAt = new Date().toISOString();
  doc.createdAt = doc.createdAt || doc.updatedAt;
  if (pool) {
    await pool.query(`INSERT INTO docs (col,id,data) VALUES ($1,$2,$3)
      ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [col, doc.id, doc]);
  } else { mem[col][doc.id] = JSON.parse(JSON.stringify(doc)); persistFile(); }
  return doc;
}
async function del(col, id) {
  check(col);
  if (LIBK[col]) return library.del(id);
  if (pool) await pool.query('DELETE FROM docs WHERE col=$1 AND id=$2', [col, id]);
  else { delete mem[col][id]; persistFile(); }
}
async function ping() {
  if (!pool) return { kind: 'file', ok: true };
  try { await pool.query('SELECT 1'); return { kind: 'postgres', ok: true }; } catch (e) { return { kind: 'postgres', ok: false, error: e.message }; }
}
module.exports = { init, get, list, put, del, ping };
