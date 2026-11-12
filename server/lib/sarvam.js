// Reads an agent's live instructions from Sarvam through Sarvam's Voice Agents MCP server.
//
// Why MCP: Sarvam's public REST API (X-API-Key) has no endpoint that returns an agent's prompt.
// /api/app-authoring/... answers 401 to the key, and analytics traces carry only the opening line,
// never the system prompt (both checked 2026-11-06). The MCP server at mcp.sarvam.ai/voice-agents
// can read (and write) agent config, and signs in with standard OAuth 2.1: dynamic client
// registration, PKCE, public client. So the builder signs in like any MCP client: an approver
// clicks "Connect Sarvam", approves on Sarvam's login page, and is sent back here. Sarvam says the
// token lasts 24 hours; when it lapses, click Connect again.
//
// Everything is kept in the settings collection; tokens are never sent to the browser.
const crypto = require('crypto');
const db = require('../db');

const MCP = 'https://mcp.sarvam.ai/voice-agents';
const AUTH_META = 'https://mcp.sarvam.ai/.well-known/oauth-authorization-server/voice-agents';
const TOKEN_ID = 'sarvam-token';
const CLIENT_ID = 'sarvam-oauth-client';
const PENDING_ID = 'sarvam-oauth-pending';

const err = (msg, code, status) => Object.assign(new Error(msg), { code, status, publicMessage: msg });
const b64url = buf => Buffer.from(buf).toString('base64url');

async function fetchJson(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await res.text();
    let body = {}; try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
    return { res, body, text };
  } catch (e) {
    if (e.name === 'AbortError') throw err('Sarvam did not answer in 20 seconds.', 'sarvam_timeout', 504);
    throw err(`Could not reach Sarvam: ${e.message}`, 'sarvam_http', 502);
  } finally { clearTimeout(timer); }
}

// ---------- OAuth ----------
let metaCache = null;
async function authMeta() {
  if (metaCache) return metaCache;
  const { res, body } = await fetchJson(AUTH_META);
  if (!res.ok || !body.authorization_endpoint) throw err('Could not read Sarvam\'s sign-in settings.', 'sarvam_http', 502);
  return (metaCache = body);
}

// One registered client per redirect URI (localhost and the Render URL each get their own).
async function clientFor(redirectUri) {
  const saved = await db.get('settings', CLIENT_ID);
  if (saved && saved.redirectUri === redirectUri && saved.clientId) return saved.clientId;
  const m = await authMeta();
  const { res, body } = await fetchJson(m.registration_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Kollect Prompt Builder', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  if (!res.ok || !body.client_id) throw err(`Sarvam refused to register the builder (HTTP ${res.status}).`, 'sarvam_http', 502);
  await db.put('settings', { id: CLIENT_ID, clientId: body.client_id, redirectUri });
  return body.client_id;
}

async function startAuth(redirectUri, user) {
  const m = await authMeta();
  const clientId = await clientFor(redirectUri);
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));
  await db.put('settings', { id: PENDING_ID, verifier, state, redirectUri, clientId, by: user.email, at: new Date().toISOString() });
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, resource: MCP,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  });
  return `${m.authorization_endpoint}?${q}`;
}

async function saveTokens(body, by) {
  const expiresAt = body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const prev = await db.get('settings', TOKEN_ID);
  return db.put('settings', { id: TOKEN_ID, token: body.access_token, refreshToken: body.refresh_token || (prev && prev.refreshToken) || null, expiresAt, setBy: by || (prev && prev.setBy), setAt: new Date().toISOString(), lastError: null, kind: 'mcp' });
}

async function finishAuth(code, state) {
  const p = await db.get('settings', PENDING_ID);
  if (!p || !state || p.state !== state) throw err('This Sarvam sign-in link is stale. Click Connect Sarvam again.', 'sarvam_token', 400);
  const m = await authMeta();
  const { res, body } = await fetchJson(m.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier, resource: MCP }),
  });
  await db.del('settings', PENDING_ID);
  if (!res.ok || !body.access_token) throw err(`Sarvam sign-in failed (HTTP ${res.status}${body.error ? `: ${body.error}` : ''}).`, 'sarvam_token', 401);
  sessionId = null; initialized = false;
  return saveTokens(body, p.by);
}

async function tryRefresh(t) {
  if (!t.refreshToken) return null;
  const c = await db.get('settings', CLIENT_ID);
  if (!c) return null;
  const m = await authMeta();
  const { res, body } = await fetchJson(m.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: c.clientId, resource: MCP }),
  });
  if (!res.ok || !body.access_token) return null;
  return saveTokens(body);
}

async function getToken() {
  const t = await db.get('settings', TOKEN_ID);
  if (!t || !t.token) return null;
  if (t.expiresAt && Date.parse(t.expiresAt) < Date.now() + 60000) return (await tryRefresh(t)) || { ...t, expired: true };
  return t;
}

async function status() {
  const t = await db.get('settings', TOKEN_ID);
  if (!t || !t.token) return { configured: true, hasToken: false };
  const expired = t.expiresAt ? Date.parse(t.expiresAt) < Date.now() : false;
  return { configured: true, hasToken: true, expiresAt: t.expiresAt, expired: expired && !t.refreshToken, setBy: t.setBy, setAt: t.setAt, lastError: t.lastError || null };
}

async function clearToken() { sessionId = null; initialized = false; await db.del('settings', TOKEN_ID); }

// ---------- MCP over streamable HTTP ----------
let sessionId = null;   // Sarvam's server is stateless today and sends none; kept in case it starts to
let initialized = false;
let rpcId = 0;

// A response is either plain JSON or an SSE stream whose data: lines carry JSON-RPC messages.
function parseRpc(text, id) {
  try { return JSON.parse(text); } catch (_) { /* SSE */ }
  const msgs = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5).trim()); } catch (_) { return null; } }).filter(Boolean);
  return msgs.find(m => m.id === id) || msgs[msgs.length - 1] || {};
}

// POST one JSON-RPC message. An SSE reply can stay open after the answer, so read it as it
// arrives and stop at the message carrying our id instead of waiting for the stream to close.
async function postMcp(headers, body, id) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const res = await fetch(MCP, { method: 'POST', headers, body, signal: ctl.signal });
    if (id === undefined) { if (res.body) res.body.cancel().catch(() => { }); return { res, text: '' }; } // notification: no reply to wait for
    const isSse = (res.headers.get('content-type') || '').includes('text/event-stream');
    if (!isSse || !res.body) return { res, text: await res.text() };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      const hit = text.split('\n').some(l => { if (!l.startsWith('data:')) return false; try { return JSON.parse(l.slice(5).trim()).id === id; } catch (_) { return false; } });
      if (hit) { reader.cancel().catch(() => { }); break; }
    }
    return { res, text };
  } catch (e) {
    if (e.name === 'AbortError') throw err('Sarvam\'s MCP server did not answer in 60 seconds.', 'sarvam_timeout', 504);
    throw err(`Could not reach Sarvam: ${e.message}`, 'sarvam_http', 502);
  } finally { clearTimeout(timer); }
}

async function rpc(method, params, { notify = false, retried = false } = {}) {
  const t = await getToken();
  if (!t) throw err('Sarvam isn\'t connected. Click Connect Sarvam on the Agents page.', 'sarvam_no_token', 503);
  if (t.expired) throw err('The Sarvam sign-in has expired. Click Connect Sarvam again.', 'sarvam_token', 401);
  if (!initialized && method !== 'initialize' && !method.startsWith('notifications/')) await initialize();
  const id = notify ? undefined : ++rpcId;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${t.token}`, 'MCP-Protocol-Version': '2025-06-18' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const { res, text } = await postMcp(headers, JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id }) }), id);
  if (res.status === 401 || res.status === 403) {
    await db.put('settings', { ...t, lastError: `Sarvam rejected the sign-in (HTTP ${res.status}) at ${new Date().toISOString()}` });
    throw err('Sarvam rejected the sign-in. It has probably expired: click Connect Sarvam again.', 'sarvam_token', 401);
  }
  if (res.status === 404 && sessionId && !retried) { sessionId = null; initialized = false; return rpc(method, params, { notify, retried: true }); } // session expired on Sarvam's side
  if (method === 'initialize') sessionId = res.headers.get('mcp-session-id') || sessionId;
  if (notify) return null;
  if (!res.ok) throw err(`Sarvam MCP returned HTTP ${res.status}.`, 'sarvam_http', 502);
  const msg = parseRpc(text, id);
  if (msg.error) throw err(`Sarvam MCP error: ${msg.error.message || JSON.stringify(msg.error)}`, 'sarvam_http', 502);
  return msg.result;
}

async function initialize() {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kollect-prompt-builder', version: '1.0' } });
  await rpc('notifications/initialized', {}, { notify: true });
  initialized = true;
}

// MCP resources: Sarvam's own playbooks and schemas (e.g. sarvam://playbooks/agents), used as
// best-practice guidance when building agents. Cached for an hour.
const resCache = new Map();
async function listResources() {
  const r = await rpc('resources/list', {});
  return (r && r.resources) || [];
}
async function readResource(uri) {
  const hit = resCache.get(uri);
  if (hit && hit.at > Date.now() - 3600e3) return hit.text;
  const r = await rpc('resources/read', { uri });
  const text = ((r && r.contents) || []).map(c => c.text || '').join('\n');
  resCache.set(uri, { at: Date.now(), text });
  return text;
}

let toolsCache = null;
async function listTools() {
  if (!toolsCache) toolsCache = (await rpc('tools/list', {})).tools || [];
  return toolsCache;
}

async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r && r.isError) {
    const raw = (r.content || []).map(c => c.text).join(' ');
    // Sarvam's refusals carry a JSON body with a readable "detail"; show that in full.
    const m = raw.match(/\{[\s\S]*\}/); let detail = null;
    try { const j = JSON.parse(m[0]); detail = j.error && (j.error.detail || j.error.message); } catch (_) { }
    throw err(detail ? `Sarvam refused it: ${String(detail).slice(0, 1500)}` : `Sarvam ${name} failed: ${raw.slice(0, 1000)}`, 'sarvam_http', 502);
  }
  if (r && r.structuredContent) return r.structuredContent;
  const text = (r && r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  try { return JSON.parse(text); } catch (_) { return { text }; }
}

// The `agents` tool takes { operation, id, params }; the read operation's exact name comes from
// the tool's own schema, so pick it from there instead of hard-coding a guess.
async function agentReadOp() {
  const tool = (await listTools()).find(t => t.name === 'agents');
  if (!tool) throw err('Sarvam\'s MCP server has no "agents" tool for this workspace.', 'sarvam_shape', 502);
  const ops = (((tool.inputSchema || {}).properties || {}).operation || {}).enum || [];
  return ops.find(o => /^(get|read)(_agent)?$/i.test(o)) || ops.find(o => /get|read|describe/i.test(o) && !/list|voice|version/i.test(o)) || 'get';
}

// ---------- Prompt extraction ----------
// The agent config's shape may vary, so collect every long text field whose key looks like
// instructions or a prompt. One field → that's the prompt. Several (e.g. per-state instructions)
// → join them under headings that name where each came from, so nothing is lost or reworded.
function extractInstructions(app) {
  const found = [];
  const walk = (v, path) => {
    if (typeof v === 'string') {
      const key = path[path.length - 1] || '';
      if (/instruction|prompt/i.test(key) && v.trim().length >= 80) found.push({ path: path.join('.'), text: v.trim() });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, String(i)]));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, [...path, k]));
  };
  walk(app, []);
  const seen = new Set();
  const uniq = found.filter(f => !seen.has(f.text) && seen.add(f.text)); // drafts often repeat the committed text
  if (!uniq.length) return null;
  const text = uniq.length === 1 ? uniq[0].text : uniq.map(f => `## ${f.path}\n\n${f.text}`).join('\n\n');
  return { text, fields: uniq.map(f => f.path), hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) };
}

const shape = app => (app && typeof app === 'object' ? Object.keys(app) : [typeof app]);

// The prompt Kollect actually calls: the version Kollect pinned, else the newest *committed*
// version. A bare agents.get reads the draft, which can hold uncommitted edits, so never use it.
// agents.get returns a summary by default; include=['prompt_text'] gives each state's full
// instructions (prompt_text.states.<state>.instructions) plus the shared global_prompt.
// The rest of what the agent says and uses, kept next to the prompt so the builder shows the agent
// as it is in Sarvam: the greeting (English plus Sarvam's per-language versions), the variables and
// the languages. Returned in a stable shape; `hash` changes when any of it changes.
function metaFrom(app) {
  const vars = (app.variables && (app.variables.agent_variables || app.variables)) || {};
  const tr = (((((app.config || {}).intro_message_config || {}).multilingual_audio || {}).language_text_mapping) || {});
  const meta = {
    greeting: (app.intro && app.intro.audio) || '',
    greetingByLanguage: tr,
    languages: app.languages ? { initial: app.languages.initial_language_name || '', supported: app.languages.supported_languages || [] } : null,
    variables: Object.values(vars).map(v => ({ name: v.name, type: v.type || 'string', description: String(v.description || '').trim(), example: v.value || '', afterCall: !!v.update_post_interaction })),
  };
  meta.hash = crypto.createHash('sha256').update(JSON.stringify(meta)).digest('hex').slice(0, 16);
  return meta;
}

const SNAPSHOT_PARTS = ['prompt_text', 'intro', 'variables', 'languages', 'config.intro_message_config.multilingual_audio.language_text_mapping'];

async function livePrompt(appId, pinnedVersion) {
  const op = await agentReadOp();
  let version = Number(pinnedVersion) || null;
  if (!version) {
    const v = await callTool('agents', { operation: op, id: appId, params: { include: ['versions'] } });
    const committed = (v.versions || []).filter(x => x.status === 'committed').map(x => Number(x.app_version)).filter(Boolean);
    if (!committed.length) throw err(`Only an uncommitted draft exists in Sarvam for this agent. Commit it in Sarvam, then pull again.`, 'sarvam_shape', 502);
    version = Math.max(...committed);
  }
  const app = await callTool('agents', { operation: op, id: appId, params: { app_version: version, include: SNAPSHOT_PARTS } });
  if (app && app.ok === false) throw err(`Sarvam refused to read ${appId} v${version}: ${(app.error && app.error.detail) || 'unknown error'}`, 'sarvam_http', 502);
  const ex = extractInstructions(app.prompt_text || app);
  if (!ex) throw err(`Sarvam answered for ${appId} v${version}, but no instructions field was found (top-level keys: ${shape(app).join(', ')}).`, 'sarvam_shape', 502);
  // The draft is what Sarvam's editor shows; note when it holds edits that aren't committed.
  let draftAhead = null;
  try {
    const d = await promptText(appId, null);
    if (d.hash !== ex.hash) draftAhead = { chars: d.text.length - ex.text.length };
  } catch (_) { /* informational only */ }
  return { ...ex, version, meta: metaFrom(app), draftAhead };
}

// Every agent in the Sarvam workspace (paged). Returned in a stable shape; fields Sarvam may or may
// not send are left empty rather than guessed.
async function listAgents() {
  const out = [], seen = new Set();
  for (let offset = 0, i = 0; i < 20; i++) {
    const r = await callTool('agents', { operation: 'list', params: { offset, limit: 100 } });
    const page = r.items || r.agents || r.apps || (Array.isArray(r) ? r : []);
    for (const a of page) {
      const id = a.app_id || a.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: a.name || a.app_name || a.display_name || id, status: a.status || '', latestVersion: Number(a.latest_version || a.latest_committed_version || a.app_version || 0) || null,
        updatedAt: a.updated_at || a.modified_at || a.created_at || null, channel: a.channel_type || '', raw: a });
    }
    const p = r.pagination;
    if (!page.length || (p ? !p.more : page.length < 100)) break;
    offset = p && p.next_offset != null ? p.next_offset : offset + page.length;
  }
  return out;
}

// ---------- Writing (used by the approved-version push) ----------
async function committedVersions(appId) {
  const v = await callTool('agents', { operation: 'get', id: appId, params: { include: ['versions'] } });
  return (v.versions || []).filter(x => x.status === 'committed').map(x => Number(x.app_version)).filter(Boolean).sort((a, b) => a - b);
}

// The prompt text of one committed version, or of the draft when version is null.
async function promptText(appId, version) {
  const params = { include: ['prompt_text'] };
  if (version) params.app_version = Number(version);
  const app = await callTool('agents', { operation: 'get', id: appId, params });
  if (app && app.ok === false) throw err(`Sarvam refused to read ${appId}${version ? ' v' + version : ' draft'}: ${(app.error && app.error.detail) || 'unknown error'}`, 'sarvam_http', 502);
  const ex = extractInstructions(app.prompt_text || app);
  if (!ex) throw err(`No prompt text found for ${appId}${version ? ' v' + version : ' draft'}.`, 'sarvam_shape', 502);
  return ex;
}

// configure_agent with prompt_edits writes the draft only. dry_run runs every check and writes nothing.
// extra: { config } (e.g. the greeting) and/or { prompt_append } for an empty prompt.
async function editDraft(appId, edits, dryRun, extra = {}) {
  const args = { agent_id: appId, dry_run: !!dryRun };
  if (edits && edits.length) args.prompt_edits = edits;
  if (extra.prompt_append) args.prompt_append = extra.prompt_append;
  if (extra.config) args.config = extra.config;
  const r = await callTool('configure_agent', args);
  if (r && r.ok === false) throw err(`Sarvam refused the edit: ${(r.error && (r.error.detail || r.error.message)) || JSON.stringify(r.error).slice(0, 300)}`, 'sarvam_edit', 409);
  if (r && Array.isArray(r.not_applied) && r.not_applied.length) throw err(`Sarvam did not apply part of the edit: ${JSON.stringify(r.not_applied).slice(0, 300)}`, 'sarvam_edit', 409);
  return r;
}

// Freeze the draft as a new immutable version; returns the new version number.
async function commit(appId, description) {
  const before = await committedVersions(appId);
  const r = await callTool('agents', { operation: 'commit', id: appId, params: { app_version_description: String(description).slice(0, 480) } });
  if (r && r.ok === false) throw err(`Sarvam refused the commit: ${(r.error && (r.error.detail || r.error.message)) || 'unknown error'}`, 'sarvam_edit', 409);
  const fromReply = Number(r && (r.app_version || (r.version && r.version.app_version) || (r.committed && r.committed.app_version)));
  const after = await committedVersions(appId);
  const v = fromReply && after.includes(fromReply) ? fromReply : after[after.length - 1];
  if (!v || before.includes(v)) throw err('Sarvam did not report a new committed version.', 'sarvam_edit', 502);
  return v;
}

module.exports = { listResources, readResource, listAgents, callTool, status, clearToken, startAuth, finishAuth, listTools, livePrompt, extractInstructions, committedVersions, promptText, editDraft, commit };
