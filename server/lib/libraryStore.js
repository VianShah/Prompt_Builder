// The module library, kept as JSON files in the git repo (until it moves to a database):
//   library/modules/<MODULE-ID>/<version>.json      one file per module version
//
// With GITHUB_TOKEN and GITHUB_REPO set (the deployed builder), the files live on a branch of the
// GitHub repo (GITHUB_LIBRARY_BRANCH, default "module-library"): they are read from it at start, and
// every save or delete is a commit there. A separate branch, so a module save never redeploys the
// service (Render deploys main). Merge it into main whenever you want the library in main.
// Without a token (your own computer), the files are read from and written to this folder; commit
// them like any other change.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DIR = 'library/modules';
const ROOT = path.join(__dirname, '..', '..');
const gh = () => !!(config.github.token && config.github.repo);
let docs = new Map();        // id -> module doc
let shas = new Map();        // repo path -> blob sha (GitHub mode)
let queue = Promise.resolve();
let lastError = null;
let loadFailed = false;  // GitHub couldn't be read at start: saving is refused, so nothing there is overwritten blind

const fileOf = d => `${DIR}/${safe(d.moduleId)}/${safe(d.v)}.json`;
const safe = s => String(s || 'x').replace(/[^A-Za-z0-9._-]/g, '-');
const clone = o => JSON.parse(JSON.stringify(o));
const err = (msg, status) => Object.assign(new Error(msg), { code: 'library', status: 502, publicMessage: msg, ghStatus: status });

async function api(method, url, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(`https://api.github.com/repos/${config.github.repo}${url}`, {
      method, signal: ctl.signal,
      headers: { Authorization: `Bearer ${config.github.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'prompt-builder', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw err(`GitHub ${method} ${url.split('?')[0]} answered ${res.status}: ${data.message || 'error'}`, res.status);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw err('GitHub did not answer in 20 seconds.');
    throw e.code === 'library' ? e : err(`Could not reach GitHub: ${e.message}`);
  } finally { clearTimeout(timer); }
}

// The library branch, created from the default branch the first time.
async function ensureBranch() {
  const b = config.github.branch;
  try { await api('GET', `/git/ref/heads/${encodeURIComponent(b)}`); return; } catch (e) { if (e.ghStatus !== 404) throw e; }
  const repo = await api('GET', '');
  const base = await api('GET', `/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
  await api('POST', '/git/refs', { ref: `refs/heads/${b}`, sha: base.object.sha });
  console.log(`[library] created branch ${b} from ${repo.default_branch}`);
}

async function loadGitHub() {
  await ensureBranch();
  const tree = await api('GET', `/git/trees/${encodeURIComponent(config.github.branch)}?recursive=1`);
  const files = (tree.tree || []).filter(t => t.type === 'blob' && t.path.startsWith(DIR + '/') && t.path.endsWith('.json'));
  const out = new Map();
  for (const f of files) {
    const blob = await api('GET', `/git/blobs/${f.sha}`);
    try { const d = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8')); if (d && d.id) out.set(d.id, d); shas.set(f.path, f.sha); }
    catch (_) { console.warn('[library] skipped unreadable', f.path); }
  }
  return out;
}

function loadLocal() {
  const out = new Map(), base = path.join(ROOT, DIR);
  if (!fs.existsSync(base)) return out;
  for (const m of fs.readdirSync(base)) {
    const dir = path.join(base, m);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      try { const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (d && d.id) out.set(d.id, d); } catch (_) { console.warn('[library] skipped unreadable', path.join(m, f)); }
    }
  }
  return out;
}

// seed: modules found in the old database store, copied in once when the library is empty.
async function init(seed) {
  try { docs = gh() ? await loadGitHub() : loadLocal(); loadFailed = false; }
  catch (e) {
    // Start anyway (agents and prompts still work); the library shows the error and refuses saves.
    docs = new Map(); loadFailed = true; lastError = `Module library not loaded: ${e.publicMessage || e.message}`;
    console.error('[library]', lastError);
    return;
  }
  console.log(`[library] ${docs.size} module version(s) from ${gh() ? `GitHub ${config.github.repo}@${config.github.branch}` : DIR + ' (local files)'}`);
  if (!docs.size && seed && seed.length) {
    for (const d of seed) await put(d);
    console.log(`[library] copied ${seed.length} module version(s) from the database into the library`);
  }
}

const who = d => { const h = (d.history || [])[(d.history || []).length - 1]; return h ? `${h.action || 'saved'} by ${h.by}` : 'saved'; };

async function writeGitHub(file, d) {
  const body = { message: `Module ${d.moduleId} v${d.v}: ${who(d)}`, content: Buffer.from(JSON.stringify(d, null, 2) + '\n').toString('base64'), branch: config.github.branch };
  const send = () => api('PUT', `/contents/${file}`, { ...body, ...(shas.get(file) ? { sha: shas.get(file) } : {}) });
  let r;
  try { r = await send(); }
  catch (e) {
    if (![409, 422].includes(e.ghStatus)) throw e;
    // Our sha is out of date (the file changed on GitHub): take the current one and write again.
    const cur = await api('GET', `/contents/${file}?ref=${encodeURIComponent(config.github.branch)}`).catch(() => null);
    if (cur && cur.sha) shas.set(file, cur.sha); else shas.delete(file);
    r = await send();
  }
  shas.set(file, r.content.sha);
}

function writeLocal(file, d) {
  const p = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
}

// Writes go one at a time, so two saves never race on the same file's sha.
const serial = fn => { const run = queue.then(fn, fn); queue = run.catch(() => { }); return run; };

async function get(id) { const d = docs.get(id); return d ? clone(d) : null; }
async function list() { return [...docs.values()].map(clone).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); }
async function put(doc) {
  if (!doc.id) throw new Error('doc.id required');
  if (loadFailed) throw err(`${lastError}. Restart the service once GitHub is reachable.`);
  doc.updatedAt = new Date().toISOString();
  doc.createdAt = doc.createdAt || doc.updatedAt;
  const d = clone(doc), file = fileOf(d);
  await serial(async () => {
    try { if (gh()) await writeGitHub(file, d); else writeLocal(file, d); lastError = null; }
    catch (e) { lastError = e.publicMessage || e.message; throw e; }
  });
  docs.set(d.id, d);
  return doc;
}
async function del(id) {
  const d = docs.get(id); if (!d) return;
  if (loadFailed) throw err(`${lastError}. Restart the service once GitHub is reachable.`);
  const file = fileOf(d);
  await serial(async () => {
    if (gh()) {
      if (!shas.get(file)) { const cur = await api('GET', `/contents/${file}?ref=${encodeURIComponent(config.github.branch)}`).catch(() => null); if (cur) shas.set(file, cur.sha); }
      if (shas.get(file)) await api('DELETE', `/contents/${file}`, { message: `Module ${d.moduleId} v${d.v}: deleted`, sha: shas.get(file), branch: config.github.branch });
      shas.delete(file);
    } else { try { fs.unlinkSync(path.join(ROOT, file)); } catch (_) { /* already gone */ } }
  });
  docs.delete(id);
}
const status = () => ({ kind: gh() ? 'github' : 'local-files', repo: gh() ? config.github.repo : null, branch: gh() ? config.github.branch : null, path: DIR, modules: docs.size, loaded: !loadFailed, lastError });

module.exports = { init, get, list, put, del, status };
