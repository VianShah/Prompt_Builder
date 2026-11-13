const express = require('express');
const db = require('../db');
const ai = require('../lib/aiTasks');
const sarvam = require('../lib/sarvam');
const sarvamRest = require('../lib/sarvamRest');
const pushLib = require('../lib/sarvamPush');
const PB = require('../../shared/blocks');
const { uid, now, h, fail, audit, can } = { ...require('../lib/util'), can: require('../auth').can };

const r = express.Router();

const VAR_ALIAS = { overdue_amount: 'total_overdue', attempt_no_month: 'attempt_count', attempt_number: 'attempt_count', true_dpd: 'dpd', user_name: 'customer_name' };
const PRODUCT = p => ({ 'personal loan': 'Personal loan', bnpl: 'BNPL', 'credit card': 'Credit card', 'two-wheeler loan': 'Two-wheeler loan', 'gold loan': 'Gold loan' })[String(p).toLowerCase()] || 'Personal loan';

function cfgFromAgent(a) {
  const c = PB.baseCfg();
  c.preset = 'imported';
  Object.assign(c.client, { name: a.client || a.name, legal: a.client || '', product: PRODUCT(a.product), productDesc: a.description || '', agentName: a.name });
  const langs = (a.languages || []).filter(l => PB.LANGS.includes(l));
  if (langs.length) c.client.languages = langs;
  c.bucket = a.bucket || 'b1';
  c.persona = a.persona || 'compliant';
  (a.variables || []).forEach(v => {
    const k = PB.SCHEMA.some(s => s.k === v) ? v : VAR_ALIAS[v];
    if (k && !c.mapping[k]) c.mapping[k] = v;
  });
  return c;
}

r.get('/agents', h(async (req, res) => {
  const agents = await db.list('agents');
  const prompts = await db.list('prompts');
  res.json({ agents: agents.map(a => ({ ...a, promptId: (prompts.find(p => p.agentId === a.id) || {}).id || null })) });
}));

// Refresh the agent list: every agent in the Sarvam workspace is listed, then each prompt is re-read from Sarvam.
const friendly = e => e && (e.publicMessage || e.message) || 'unknown error';
r.post('/agents/sync', h(async (req, res) => {
  const existing = await db.list('agents');
  const st = await sarvam.status();
  const sarvamOk = !!(st.hasToken && st.configured && !st.expired);
  const out = { synced: 0, added: 0, sarvam: { ok: false, error: null, count: 0 } };
  let sList = [];
  if (!sarvamOk) out.sarvam.error = !st.configured ? 'SARVAM_ORG_ID / SARVAM_WORKSPACE_ID not set' : !st.hasToken ? 'Sarvam is not connected. Click Connect Sarvam.' : 'The Sarvam sign-in expired. Click Reconnect.';
  else { try { sList = await sarvam.listAgents(); out.sarvam = { ok: true, error: null, count: sList.length }; } catch (e) { out.sarvam.error = friendly(e); } }
  if (!out.sarvam.ok) throw fail(502, `Couldn't refresh the agent list. ${out.sarvam.error}`);

  for (const sv of sList) {
    const old = existing.find(x => x.id === sv.id);
    if (!old) out.added++;
    let newestV = old ? old.sarvamNewest : undefined; // newest committed version, so the list can show it before the prompt is loaded
    try { const c = await sarvam.committedVersions(sv.id); newestV = c[c.length - 1] || null; } catch (_) { /* keep what we had */ }
    await db.put('agents', { bucket: 'b1', persona: 'compliant', languages: [], variables: [], product: '', stage: '', ...(old || {}),
      id: sv.id, sarvamAppId: sv.id, name: (old && old.name) || sv.name, sarvamName: sv.name, client: (old && old.client) || '', source: 'sarvam',
      ...(newestV === undefined ? {} : { sarvamNewest: newestV }), syncedAt: now() });
  }
  out.synced = (await db.list('agents')).length;
  await audit(req.user, 'agents.sync', { sarvam: out.sarvam.count, added: out.added });
  // Then bring in each agent's live prompt from Sarvam.
  out.prompts = can(req.user, 'edit') ? await pullAll(req.user) : { skipped: true, reason: 'your role cannot import prompts' };
  res.json(out);
}));

// Store a Sarvam prompt as this agent's live version. Text is regrouped into sections, never reworded.
async function importText(a, text, sarvamVersion, user, src, extra = {}) {
  const label = `Imported from Sarvam v${sarvamVersion || '?'}`;
  const imp = await ai.importPrompt(text, label);
  const prompts = await db.list('prompts');
  let prompt = prompts.find(p => p.agentId === a.id);
  const versions = prompt ? await db.list('versions', v => v.promptId === prompt.id) : [];
  if (!prompt) prompt = await db.put('prompts', { id: uid(), name: `${a.client || a.name} · ${a.name}`, agentId: a.id, cfg: cfgFromAgent(a), createdBy: user.email });
  const last = [...versions].sort((x, y) => x.createdAt.localeCompare(y.createdAt)).pop(); // copy: pop() must not drop it from `versions`
  const v = last ? `${Number(String(last.v).split('.')[0]) + 1}.0` : '1.0';
  for (const old of versions.filter(x => x.status === 'live')) await db.put('versions', { ...old, status: 'superseded' });
  const ver = await db.put('versions', { id: uid(), promptId: prompt.id, v, sections: imp.sections, order: imp.order, note: label, src, by: user.email,
    status: 'live', sarvamVersion, liveAt: now(), liveBy: user.email, importStats: { chunks: imp.chunks, via: imp.via, provider: imp.provider, counts: imp.counts }, history: [{ at: now(), by: user.email, action: 'imported' }], ...extra });
  await db.put('prompts', { ...prompt, latestVersionId: ver.id, liveVersionId: ver.id });
  await audit(user, 'prompt.import', { agent: a.id, prompt: prompt.id, version: v, sarvamVersion, src });
  return { promptId: prompt.id, versionId: ver.id, v, import: ver.importStats };
}

// Pull the agent's instructions from Sarvam. Imports a new live version only when the text changed,
// so repeated syncs don't pile up identical versions.
async function pullFromSarvam(a, user) {
  // Sarvam is the source of truth: the prompt read is the newest committed version.
  const committed = await sarvam.committedVersions(a.sarvamAppId);
  const newest = committed[committed.length - 1] || null;
  await db.put('agents', { ...(await db.get('agents', a.id)), sarvamNewest: newest, sarvamCheckedAt: now() });
  const prompt0 = (await db.list('prompts')).find(p => p.agentId === a.id);
  const live0 = prompt0 && (await db.list('versions', v => v.promptId === prompt0.id && v.status === 'live'))[0];
  const lp = await sarvam.livePrompt(a.sarvamAppId);
  const fresh = await db.get('agents', a.id);
  const agentInfo = { sarvamPulledAt: now(), sarvamPullError: null, sarvamDraftAhead: lp.draftAhead || null };
  // Sections that no longer line up with the text (e.g. from an older import) are rebuilt by re-importing.
  // A fresh import of this exact text counts as in sync even if its sections can't be mapped back
  // (e.g. the text has <!-- --> lines, which the builder hides), so a sync never re-imports it twice.
  // The live version already holds exactly this text (an import, or a version the builder just pushed):
  // nothing to import.
  const sameText = live0 && live0.sarvamText === lp.text && (!live0.sarvamVersion || Number(live0.sarvamVersion) === Number(lp.version));
  const freshImport = live0 && live0.src === 'Sarvam auto-import' && live0.sarvamText === lp.text;
  const inSync = live0 && (sameText || freshImport || live0.sourceChunks || pushLib.chunkMap(live0.sections, live0.order, lp.text));
  if ((fresh.sarvamPromptHash === lp.hash || sameText) && inSync) {
    // Same prompt text: keep the live version's exact Sarvam text, greeting and variables current.
    const prompt = prompt0, live = live0;
    if (live && (!live.sarvamText || !live.sarvamMeta || live.sarvamMeta.hash !== lp.meta.hash)) await db.put('versions', { ...live, sarvamText: live.sarvamText || lp.text, sarvamMeta: lp.meta });
    await db.put('agents', { ...fresh, ...agentInfo, sarvamPromptHash: lp.hash });
    return { changed: false };
  }
  const sv = Number(lp.version) || a.catalogVersion || null;
  const r = await importText(a, lp.text, sv, user, 'Sarvam auto-import', { sarvamFields: lp.fields, sarvamText: lp.text, sarvamMeta: lp.meta });
  await db.put('agents', { ...(await db.get('agents', a.id)), sarvamPromptHash: lp.hash, ...agentInfo });
  return { changed: true, ...r };
}

r.get('/sarvam/status', h(async (req, res) => res.json(await sarvam.status())));

// Sign in to Sarvam's MCP server (OAuth). The browser is sent to Sarvam and comes back to /callback.
const callbackUrl = req => `${req.protocol}://${req.get('host')}/api/sarvam/callback`;

r.get('/sarvam/connect', h(async (req, res) => {
  if (!can(req.user, 'approve')) throw fail(403, 'Only approvers and admins can connect Sarvam.');
  // A failure here is a page the user lands on, so show it on the Agents page instead of as raw JSON.
  // ?manual=1: for a site Sarvam hasn't allow-listed. The callback is a localhost address the person
  // copies back into the site (see POST /sarvam/finish-manual).
  try { res.redirect(req.query.manual ? await sarvam.startAuthManual(req.user) : await sarvam.startAuth(callbackUrl(req), req.user)); }
  catch (e) { res.redirect('/#agents?sarvamError=' + encodeURIComponent(e.publicMessage || e.message)); }
}));

r.post('/sarvam/finish-manual', h(async (req, res) => {
  if (!can(req.user, 'approve')) throw fail(403, 'Only approvers and admins can connect Sarvam.');
  await sarvam.finishAuthManual((req.body || {}).pasted);
  await audit(req.user, 'sarvam.connect', { manual: true });
  res.json(await sarvam.status());
}));

// Use a Sarvam login made elsewhere (Sarvam only allows sign-in from localhost or allow-listed addresses).
// The line comes from `npm run export-sarvam` on a computer where Connect works.
r.post('/sarvam/import-token', h(async (req, res) => {
  if (!can(req.user, 'approve')) throw fail(403, 'Only approvers and admins can connect Sarvam.');
  await sarvam.importConnection((req.body || {}).line, req.user.email);
  await audit(req.user, 'sarvam.import', {});
  res.json(await sarvam.status());
}));

r.get('/sarvam/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    await sarvam.finishAuth(String(req.query.code || ''), String(req.query.state || ''));
    await audit(req.user, 'sarvam.connect', {});
    res.redirect('/#agents');
  } catch (e) {
    res.redirect('/#agents?sarvamError=' + encodeURIComponent(e.publicMessage || e.message));
  }
});

// What Sarvam's MCP server offers this workspace (names and argument schemas only), for diagnosis.
r.get('/sarvam/tools', h(async (req, res) => {
  const tools = await sarvam.listTools();
  if (req.query.name) { const t = tools.find(x => x.name === req.query.name); if (!t) throw fail(404, 'No such tool.'); return res.json(t); }
  res.json({ tools: tools.map(t => ({ name: t.name, description: (t.description || '').slice(0, 200), operations: (((t.inputSchema || {}).properties || {}).operation || {}).enum || null })) });
}));

// Sarvam's own guidance (MCP resources), read-only. ?uri= reads one.
r.get('/sarvam/resources', h(async (req, res) => {
  if (req.query.uri) return res.json({ uri: req.query.uri, text: await sarvam.readResource(String(req.query.uri)) });
  res.json({ items: (await sarvam.listResources()).map(x => ({ uri: x.uri, name: x.name, description: (x.description || '').slice(0, 200) })) });
}));

// Every agent in the Sarvam workspace(read-only).
r.get('/sarvam/agents', h(async (req, res) => {
  const list = await sarvam.listAgents();
  res.json({ count: list.length, items: list.map(a => ({ id: a.id, name: a.name, status: a.status, latestVersion: a.latestVersion, updatedAt: a.updatedAt, keys: req.query.raw ? Object.keys(a.raw) : undefined, raw: req.query.raw && a === list[0] ? a.raw : undefined })) });
}));

r.delete('/sarvam/token', h(async (req, res) => {
  if (!can(req.user, 'approve')) throw fail(403, 'Only approvers and admins can remove the Sarvam login token.');
  await sarvam.clearToken();
  for (const a of await db.list('agents')) if (a.sarvamPullError) await db.put('agents', { ...a, sarvamPullError: null });
  await audit(req.user, 'sarvam.token.clear', {});
  res.json(await sarvam.status());
}));

// Pull every synced agent's prompt from Sarvam (also runs as part of Sync).
async function pullAll(user) {
  const out = { imported: 0, unchanged: 0, failed: 0, error: null };
  const havePrompt = new Set((await db.list('prompts')).map(p => p.agentId));
  for (const a of await db.list('agents')) {
    if (a.source === 'sarvam' && !havePrompt.has(a.id)) continue; // loaded when opened: reading a prompt in takes a while
    try { const x = await pullFromSarvam(a, user); x.changed ? out.imported++ : out.unchanged++; }
    catch (e) {
      out.failed++; out.error = e.publicMessage || e.message;
      await db.put('agents', { ...(await db.get('agents', a.id)), sarvamPullError: out.error });
      if (['sarvam_off', 'sarvam_no_token', 'sarvam_token'].includes(e.code)) break; // same failure for every agent
    }
  }
  return out;
}

r.post('/agents/pull-prompts', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot import prompts.');
  res.json(await pullAll(req.user));
}));

// "Load all prompts": reads EVERY agent's prompt and versions from Sarvam, including agents that only
// exist in Sarvam. It runs in the background (two agents at a time) and the page polls for progress, so
// a long run isn't cut off by the host's request time limit. One job at a time.
let pullJob = null;
async function runPullJob(job, agents, user) {
  const queue = [...agents];
  const worker = async () => {
    while (queue.length && job.state === 'running') {
      const a = queue.shift();
      job.current.push(a.name);
      try {
        const x = await pullFromSarvam(a, user);
        x.changed ? job.imported++ : job.unchanged++;
        if (x.warning) job.errors.push(`${a.name}: ${x.warning}`);
      } catch (e) {
        const m = e.publicMessage || e.message;
        job.failed++; job.errors.push(`${a.name}: ${m}`);
        await db.put('agents', { ...(await db.get('agents', a.id)), sarvamPullError: m });
        if (['sarvam_off', 'sarvam_no_token', 'sarvam_token'].includes(e.code)) { job.state = 'stopped'; job.stopped = m; } // same failure for every agent
      }
      job.current = job.current.filter(n => n !== a.name);
      job.done++;
    }
  };
  try { await Promise.all([worker(), worker()]); } catch (e) { job.state = 'stopped'; job.stopped = e.message; }
  if (job.state === 'running') job.state = 'done';
  job.finishedAt = now();
}
r.post('/agents/pull-all/start', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot import prompts.');
  if (pullJob && pullJob.state === 'running') return res.json(pullJob);
  const st = await sarvam.status();
  if (!st.hasToken || st.expired) throw fail(409, 'Connect Sarvam first: prompts are read through the Sarvam sign-in.');
  const agents = await db.list('agents');
  pullJob = { id: uid(), state: 'running', startedAt: now(), total: agents.length, done: 0, imported: 0, unchanged: 0, failed: 0, current: [], errors: [], by: req.user.email };
  runPullJob(pullJob, agents, req.user);
  await audit(req.user, 'agents.pull_all', { total: agents.length });
  res.json(pullJob);
}));
r.get('/agents/pull-all/status', h(async (req, res) => res.json(pullJob || { state: 'idle' })));

r.post('/agents/:id/pull', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot import prompts.');
  const a = await db.get('agents', req.params.id);
  if (!a) throw fail(404, 'Unknown agent.');
  try { res.json(await pullFromSarvam(a, req.user)); }
  catch (e) { await db.put('agents', { ...(await db.get('agents', a.id)), sarvamPullError: e.publicMessage || e.message }); throw e; }
}));

// Manual fallback: the prompt pasted or uploaded as text.
r.post('/agents/:id/import', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot import prompts.');
  const a = await db.get('agents', req.params.id);
  if (!a) throw fail(404, 'Unknown agent.');
  const text = String((req.body || {}).text || '');
  if (text.trim().length < 200) throw fail(400, 'Paste the full prompt from Sarvam (at least a few paragraphs).');
  let sarvamVersion = Number((req.body || {}).sarvamVersion) || null;
  sarvamVersion = sarvamVersion || a.catalogVersion || null;
  res.json(await importText(a, text, sarvamVersion, req.user, 'Sarvam import', { sarvamText: text.split(String.fromCharCode(13)).join('').trim() }));
}));

// ======================= Call review =======================
// Every call Sarvam handled for the agent, by date. Read from Sarvam's analytics API.
async function loadAgent(id) { const a = await db.get('agents', id); if (!a) throw fail(404, 'Unknown agent.'); await require('../lib/agentKind').fromAgent(a); return a; }
const IID_RE = /^\d{8}\/[A-Za-z0-9:._-]{6,120}$/;
const iidOf = req => { const id = String(req.query.iid || (req.body || {}).iid || ''); if (!IID_RE.test(id)) throw fail(400, 'Bad call id.'); return id; };

r.get('/agents/:id/interactions', h(async (req, res) => {
  const a = await loadAgent(req.params.id);
  const day = s => (/^\d{4}-\d\d-\d\d$/.test(String(s || '')) ? s : null);
  const to = day(req.query.to) || new Date().toISOString().slice(0, 10), from = day(req.query.from) || new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  // Dates are the reviewer's local (IST) days: from 00:00 IST to the end of the "to" day.
  const out = await listCalls(a, `${from}T00:00:00+05:30`, `${to}T23:59:59+05:30`, Number(req.query.offset) || 0);
  res.json({ ...out, from, to });
}));

// Where calls come from, in order: the Sarvam API key (no daily sign-in), then the Sarvam
// MCP sign-in. The first that answers wins; if none does, the first error is shown.
async function mcpCalls(appId, from, to, offset) {
  const r = await sarvam.callTool('analytics', { operation: 'report', id: 'interactions', params: { app_id: appId, start_datetime: new Date(from).toISOString(), end_datetime: new Date(to).toISOString(), offset, sort_by: 'start_datetime', sort_order: 'desc' } });
  // The MCP report writes times as IST text ("Oct 08, 2026, 03:38:31 PM"): turn them into real timestamps.
  const iso = s => { const t = Date.parse(String(s || '').replace(/,/g, '') + ' GMT+0530'); return isNaN(t) ? null : new Date(t).toISOString(); };
  const items = (r.items || []).map(x => ({ ...sarvamRest.row({ ...x, start_datetime: null }), at: iso(x.start_datetime), hasAudio: undefined }));
  const total = Number((r.pagination && r.pagination.total) || r.total) || items.length;
  return { items, total, offset, more: r.pagination ? !!r.pagination.more : offset + items.length < total };
}
async function listCalls(a, from, to, offset) {
  const errs = [];
  if (sarvamRest.enabled()) { try { return await sarvamRest.list(a.sarvamAppId, { from, to, offset }); } catch (e) { errs.push(e.publicMessage || e.message); } }
  const st = await sarvam.status();
  if (st.hasToken && !st.expired) { try { return await mcpCalls(a.sarvamAppId, from, to, offset); } catch (e) { errs.push(e.publicMessage || e.message); } }
  throw fail(502, errs[0] || 'There is no source for calls here. Set SARVAM_API_KEY in the environment (best: it never expires), or connect Sarvam.');
}

// Transcript with each turn's place in the recording. Sarvam's MCP analytics has the timings; the
// REST transcript (no timings) is the fallback when Sarvam isn't connected here.
const transcriptCache = new Map();
async function transcriptFor(a, iid) {
  const key = a.sarvamAppId + '|' + iid;
  if (transcriptCache.has(key)) return transcriptCache.get(key);
  let out = null;
  try {
    const [date, identifier] = iid.split('/');
    const t = await sarvam.callTool('analytics', { operation: 'report', id: 'transcript', params: { date, identifier, app_id: a.sarvamAppId } });
    if (Array.isArray(t.transcript) && t.transcript.length) {
      out = { timed: true, turns: t.transcript.map(m => ({ role: m.role === 'assistant' ? 'agent' : m.role, text: m.content || '', language: m.language_name || '', start: m.audio_start_time ?? null, end: m.audio_end_time ?? null, state: m.state_name || '', tools: m.tools || null })) };
    }
  } catch (_) { /* fall back to the API key */ }
  if (!out && sarvamRest.enabled()) { try { out = await sarvamRest.transcript(a.sarvamAppId, iid); } catch (_) { /* no timings */ } }
  if (!out) throw fail(502, "Couldn't read this transcript. Set SARVAM_API_KEY in the environment, or connect Sarvam.");
  transcriptCache.set(key, out);
  if (transcriptCache.size > 100) transcriptCache.delete(transcriptCache.keys().next().value);
  return out;
}
r.get('/agents/:id/interactions/transcript', h(async (req, res) => {
  const a = await loadAgent(req.params.id);
  res.json(await transcriptFor(a, iidOf(req)));
}));

// The recording, downloaded once and kept on disk, then served with range support
// so the player can jump to any turn.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REC_DIR = path.join(__dirname, '..', '..', 'data', 'recordings');
const recPending = new Map();
r.get('/agents/:id/interactions/audio', h(async (req, res) => {
  const a = await loadAgent(req.params.id);
  const iid = iidOf(req);
  const file = path.join(REC_DIR, crypto.createHash('sha1').update(a.sarvamAppId + '|' + iid).digest('hex') + '.wav');
  if (!fs.existsSync(file)) {
    if (!recPending.has(file)) recPending.set(file, (async () => {
      if (!sarvamRest.enabled()) throw fail(502, 'No way to fetch the recording: set SARVAM_API_KEY in the environment.');
      const rec = await sarvamRest.recording(a.sarvamAppId, iid);
      fs.mkdirSync(REC_DIR, { recursive: true });
      fs.writeFileSync(file + '.part', rec.data); fs.renameSync(file + '.part', file);
      const all = fs.readdirSync(REC_DIR).filter(f => f.endsWith('.wav')).map(f => ({ f, t: fs.statSync(path.join(REC_DIR, f)).mtimeMs })).sort((x, y) => y.t - x.t);
      all.slice(150).forEach(x => { try { fs.unlinkSync(path.join(REC_DIR, x.f)); } catch (_) { } }); // keep the 150 most recent
    })().finally(() => recPending.delete(file)));
    await recPending.get(file);
  }
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(file, { headers: { 'Content-Type': 'audio/wav' } });
}));

// Flag a mistake at one turn of a call. The AI reads the exact prompt version that handled the call,
// finds what caused it and suggests the fix; the result lands in "Make a change" as a feedback item,
// so several flagged calls can be fixed together in one new version.
// ---------- Call review (+/-) and error frequency ----------
// The prompt an agent had on a given call: the builder's copy of that Sarvam version, else read from Sarvam, else the live one.
async function promptForCall(a, sv) {
  const prompt = (await db.list('prompts')).find(p => p.agentId === a.id);
  if (!prompt) throw fail(409, `Load ${a.name}'s prompt first.`);
  const versions = (await db.list('versions', v => v.promptId === prompt.id)).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const latest = versions[versions.length - 1], live = versions.find(v => v.status === 'live');
  const known = sv && versions.find(v => Number(v.sarvamVersion) === Number(sv) && v.sarvamText);
  let text = known ? known.sarvamText : null, note = '';
  if (!text && sv) { try { text = (await sarvam.promptText(a.sarvamAppId, sv)).text; } catch (_) { /* below */ } }
  if (!text) { text = (live && live.sarvamText) || (pushLib.sarvamTextFor(live, latest) || {}).text || ''; note = sv ? ` (Sarvam v${sv} couldn't be read; the live prompt was used)` : ''; }
  if (!text) throw fail(409, `${a.name}'s prompt text isn't loaded. Reload it from Sarvam first.`);
  return { prompt, latest, text, note };
}
// The main agent a call's findings belong to: a UAT agent's findings go to the agent it tests.
async function mainAgentOf(a) { return (await db.list('agents')).find(x => x.uatAgentId === a.id) || a; }
const reviewId = (a, iid) => `${a.id}::${iid}`;

r.post('/agents/:id/interactions/review', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot review calls.');
  const a = await loadAgent(req.params.id), iid = iidOf(req);
  const main = await mainAgentOf(a); await require('../lib/agentKind').fromAgent(main);
  const { observations, callVersion, at } = req.body || {};
  const old = await db.get('callReviews', reviewId(a, iid));
  const allObs = [...new Set([...((old && old.observations) || []), ...String(observations || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)])];
  const t = await transcriptFor(a, iid);
  const sv = Number(callVersion) || (old && old.version) || null;
  const pc = await promptForCall(a, sv);
  const out = await ai.reviewCall({ text: pc.text, turns: t.turns, observations: allObs.join('\n'), callInfo: [sv ? `handled by Sarvam version ${sv}` : '', at ? `on ${at}` : '', a.id !== main.id ? `a UAT test call for ${main.name}` : ''].filter(Boolean).join(', ') });
  const doc = await db.put('callReviews', { id: reviewId(a, iid), agentId: a.id, mainAgentId: main.id, iid, at: at || (old && old.at) || null, version: sv, callType: out.callType, summary: out.summary,
    items: out.items.map(x => ({ ...x, addedAs: ((old && old.items) || []).find(o => o.text === x.text && o.addedAs) ? old.items.find(o => o.text === x.text).addedAs : null })),
    observations: allObs, diagnosedOn: sv ? `Sarvam v${sv}${pc.note}` : `live prompt${pc.note}`, by: req.user.email, reviewedAt: now(), provider: out.provider, uat: a.id !== main.id });
  await audit(req.user, 'call.review', { agent: a.id, iid, plus: out.items.filter(x => x.sign === '+').length, minus: out.items.filter(x => x.sign === '-').length });
  res.json(doc);
}));
r.get('/agents/:id/interactions/review', h(async (req, res) => { const a = await loadAgent(req.params.id); res.json((await db.get('callReviews', reviewId(a, iidOf(req)))) || null); }));

// Every reviewed call of this agent and of its UAT agent, for the error frequency chart.
r.get('/agents/:id/reviews', h(async (req, res) => {
  const a = await loadAgent(req.params.id);
  const ids = new Set([a.id, a.uatAgentId].filter(Boolean));
  const list = await db.list('callReviews', x => ids.has(x.agentId) || x.mainAgentId === a.id);
  await require('../lib/agentKind').fromAgent(a);
  res.json({ items: list.map(x => ({ id: x.id, agentId: x.agentId, iid: x.iid, at: x.at, version: x.version, callType: x.callType, uat: !!x.uat, plus: x.items.filter(i => i.sign === '+').length,
    minus: x.items.filter(i => i.sign === '-').map(i => i.category) })), categories: ai.MISTAKE_CATS, callTypes: ai.CALL_TYPES[require('../lib/agentKind').kind().t] });
}));

// Chosen "-" points become feedback items on the main agent, already placed in its prompt: fix them on Changes.
r.post('/agents/:id/interactions/review/fixes', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot add feedback.');
  const a = await loadAgent(req.params.id), iid = iidOf(req);
  const rv = await db.get('callReviews', reviewId(a, iid));
  if (!rv) throw fail(404, 'Review this call first.');
  const main = await mainAgentOf(a);
  const prompt = (await db.list('prompts')).find(p => p.agentId === main.id);
  if (!prompt) throw fail(409, `Load ${main.name}'s prompt first.`);
  const versions = (await db.list('versions', v => v.promptId === prompt.id)).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const latest = versions[versions.length - 1];
  const t = await transcriptFor(a, iid).catch(() => ({ turns: [] }));
  const picks = ((req.body || {}).indexes || []).map(Number).filter(i => rv.items[i] && rv.items[i].sign === '-' && !rv.items[i].addedAs);
  if (!picks.length) throw fail(400, 'Pick at least one mistake that is not added yet.');
  // Where in the prompt: the section holding the quoted passage, else the AI places it when you click "Find where each item goes".
  const secOf = q => { if (!q) return null; const n = s => String(s).replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ').trim(); const nq = n(q); return latest.order.find(sec => n(latest.sections[sec] || '').includes(nq)) || null; };
  const made = [];
  for (const i of picks) {
    const x = rv.items[i], sec = secOf(x.quote), ti = x.turn;
    const excerpt = ti != null ? t.turns.slice(Math.max(0, ti - 2), ti + 2).map((y, k) => ({ i: Math.max(0, ti - 2) + k, role: y.role, text: String(y.text).slice(0, 600) })) : null;
    const item = await db.put('feedback', { id: uid(), promptId: prompt.id, text: x.text, source: rv.uat ? 'UAT call review' : 'Call review', status: sec ? 'mapped' : 'new', by: req.user.email,
      map: sec ? { section: sec, block: '', layer: 'L6', type: x.category || 'behaviour', severity: 'medium', scope: 'client', cause: x.cause, diagnosis: x.why, fix: x.fix, quotes: x.quote ? [{ text: x.quote }] : [], via: 'ai', diagnosedOn: rv.diagnosedOn } : null,
      mappedAgainst: sec ? latest.v : undefined, call: { iid, at: rv.at, turn: ti, start: ti != null && t.turns[ti] ? t.turns[ti].start : null, sarvamVersion: rv.version, excerpt, agentId: a.id, uat: rv.uat } });
    rv.items[i].addedAs = item.id; made.push(item.id);
  }
  await db.put('callReviews', rv);
  await audit(req.user, 'call.review_fixes', { agent: a.id, main: main.id, iid, items: made.length });
  res.json({ added: made.length, to: main.name, promptId: prompt.id, review: rv });
}));

r.post('/agents/:id/interactions/flag', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot add feedback.');
  const a = await loadAgent(req.params.id);
  const iid = iidOf(req);
  const { turn, note, callVersion, at } = req.body || {};
  const prompt = (await db.list('prompts')).find(p => p.agentId === a.id);
  if (!prompt) throw fail(409, 'Load this agent\'s prompt first.');
  const t = await transcriptFor(a, iid);
  const ti = Number(turn);
  if (!(ti >= 0 && ti < t.turns.length)) throw fail(400, 'Pick a line of the transcript.');
  const versions = (await db.list('versions', v => v.promptId === prompt.id)).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const latest = versions[versions.length - 1];
  const live = versions.find(v => v.status === 'live');
  // The prompt the agent actually had on this call: the builder's copy of that Sarvam version, else read it from Sarvam.
  const sv = Number(callVersion) || null;
  let text = null, textNote = '';
  const known = sv && versions.find(v => v.sarvamVersion === sv && v.sarvamText);
  if (known) text = known.sarvamText;
  else if (sv) { try { text = (await sarvam.promptText(a.sarvamAppId, sv)).text; } catch (_) { /* fall back below */ } }
  if (!text) { text = (live && live.sarvamText) || (pushLib.sarvamTextFor(live, latest) || {}).text || ''; textNote = sv ? ` (Sarvam v${sv} couldn't be read, so the live prompt was used)` : ''; }
  if (!text) throw fail(409, 'This agent\'s prompt text isn\'t loaded. Reload it from Sarvam first.');
  const callInfo = [sv ? `handled by Sarvam version ${sv}` : '', at ? `on ${at}` : ''].filter(Boolean).join(', ');
  const map = await ai.diagnoseCall(prompt, latest, { text, turns: t.turns, turn: ti, note: String(note || '').slice(0, 1000), callInfo });
  const excerpt = t.turns.slice(Math.max(0, ti - 3), ti + 2).map((x, k) => ({ i: Math.max(0, ti - 3) + k, role: x.role, text: x.text.slice(0, 600) }));
  const item = await db.put('feedback', { id: uid(), promptId: prompt.id, text: String(note || '').trim() || map.what || 'Mistake flagged on a call', source: 'Call review', status: 'mapped', by: req.user.email,
    map: { ...map, diagnosedOn: sv ? `Sarvam v${sv}${textNote}` : `live prompt${textNote}` }, mappedAgainst: latest.v,
    call: { iid, at: at || null, turn: ti, start: t.turns[ti].start, sarvamVersion: sv, excerpt } });
  await audit(req.user, 'call.flag', { agent: a.id, iid, turn: ti, item: item.id });
  res.json(item);
}));

// Several flagged lines on one call, each with "what happened" and "what should have happened",
// diagnosed together. One feedback item per root cause, so linked mistakes get one fix.
r.post('/agents/:id/interactions/flag-group', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot add feedback.');
  const a = await loadAgent(req.params.id);
  const iid = iidOf(req);
  const { issues, note, callVersion, at } = req.body || {};
  const prompt = (await db.list('prompts')).find(p => p.agentId === a.id);
  if (!prompt) throw fail(409, 'Load this agent\'s prompt first.');
  const t = await transcriptFor(a, iid);
  const list = (Array.isArray(issues) ? issues : []).map(x => ({ turn: Number(x.turn), happened: String(x.happened || '').trim().slice(0, 1500), should: String(x.should || '').trim().slice(0, 1500) }))
    .filter(x => x.turn >= 0 && x.turn < t.turns.length).sort((x, y) => x.turn - y.turn).slice(0, 12);
  if (!list.length) throw fail(400, 'Flag at least one line.');
  const versions = (await db.list('versions', v => v.promptId === prompt.id)).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const latest = versions[versions.length - 1], live = versions.find(v => v.status === 'live');
  const sv = Number(callVersion) || null;
  let text = null;
  const known = sv && versions.find(v => Number(v.sarvamVersion) === sv && v.sarvamText);
  if (known) text = known.sarvamText;
  else if (sv) { try { text = (await sarvam.promptText(a.sarvamAppId, sv)).text; } catch (_) { } }
  if (!text) text = (live && live.sarvamText) || (pushLib.sarvamTextFor(live, latest) || {}).text || '';
  if (!text) throw fail(409, 'This agent\'s prompt text isn\'t loaded. Reload it from Sarvam first.');
  const callInfo = [sv ? `handled by Sarvam version ${sv}` : '', at ? `on ${at}` : ''].filter(Boolean).join(', ');
  const g = await ai.diagnoseGroup(prompt, latest, { text, turns: t.turns, issues: list, note: String(note || '').slice(0, 1000), callInfo });
  if (!g.causes.length) throw fail(502, 'The AI didn\'t return a diagnosis. Try again.');
  const created = [];
  for (const c of g.causes) {
    const mine = c.issues.map(n => list[n - 1]).filter(Boolean);
    if (!mine.length) continue;
    const idx = new Set(); mine.forEach(x => { for (let k = Math.max(0, x.turn - 2); k <= Math.min(t.turns.length - 1, x.turn + 1); k++) idx.add(k); });
    const excerpt = [...idx].sort((x, y) => x - y).slice(0, 16).map(k => ({ i: k, role: t.turns[k].role, text: t.turns[k].text.slice(0, 500) }));
    const textOut = mine.map(x => `At ${t.turns[x.turn].start != null ? Math.floor(t.turns[x.turn].start / 60) + ':' + String(Math.floor(t.turns[x.turn].start % 60)).padStart(2, '0') : 'line ' + x.turn}: ${x.happened || '(see call)'}${x.should ? ` → should have: ${x.should}` : ''}`).join('\n');
    created.push(await db.put('feedback', { id: uid(), promptId: prompt.id, text: textOut.slice(0, 3000), source: 'Call review', status: 'mapped', by: req.user.email, mappedAgainst: latest.v,
      map: { ...c, what: c.title, diagnosedOn: sv ? `Sarvam v${sv}` : 'live prompt', groupSummary: g.summary },
      call: { iid, at: at || null, turn: mine[0].turn, start: t.turns[mine[0].turn].start, sarvamVersion: sv, excerpt, issues: mine, group: true } }));
  }
  await audit(req.user, 'call.flag_group', { agent: a.id, iid, issues: list.length, causes: created.length });
  res.json({ summary: g.summary, items: created });
}));

// ======================= Agent settings: variables, languages, voice =======================
let voicesCache = null;
async function voices() {
  if (voicesCache && voicesCache.at > Date.now() - 3600e3) return voicesCache.list;
  // The catalogue is paged (50 a page); read it all, up to 10 pages.
  const items = [];
  for (let offset = 0, i = 0; i < 10; i++) {
    const v = await sarvam.callTool('agents', { operation: 'list_voices', params: { offset, limit: 100 } });
    const page = v.items || [];
    items.push(...page);
    const more = v.pagination ? v.pagination.more : page.length >= 50;
    if (!more || !page.length) break;
    offset = v.pagination && v.pagination.next_offset != null ? v.pagination.next_offset : offset + page.length;
  }
  const seen = new Set();
  const list = items.filter(x => x.internal_id && !seen.has(x.internal_id) && seen.add(x.internal_id)).map(x => ({ id: x.internal_id, name: x.display_name || x.voice_id, gender: x.gender || '', languages: x.preferred_languages || [], description: x.description || '' })).sort((a, b) => a.name.localeCompare(b.name));
  voicesCache = { at: Date.now(), list };
  return list;
}
// What the agent has now (in the newest committed Sarvam version), plus the choices.
r.get('/agents/:id/config', h(async (req, res) => {
  const a = await loadAgent(req.params.id);
  const prompt = (await db.list('prompts')).find(p => p.agentId === a.id);
  const live = prompt && (await db.list('versions', v => v.promptId === prompt.id && v.status === 'live'))[0];
  const version = (live && live.sarvamVersion) || (await sarvam.committedVersions(a.sarvamAppId)).pop();
  const g = await sarvam.callTool('agents', { operation: 'get', id: a.sarvamAppId, params: { app_version: version, include: ['variables', 'config.text_to_speech_config', 'config.language_config'] } });
  if (g && g.ok === false) throw fail(502, `Sarvam refused to read the agent: ${(g.error && g.error.detail) || 'unknown error'}`);
  const cfg = g.config || {}, lc = cfg.language_config || {}, tts = cfg.text_to_speech_config || {};
  const vars = (g.variables && (g.variables.agent_variables || g.variables)) || {};
  res.json({ sarvamVersion: version,
    languages: { initial: lc.initial_language_name || '', supported: lc.supported_languages || [] },
    voice: { id: tts.internal_id || '', pace: (tts.speech_settings || {}).pace ?? 1, pitch: (tts.speech_settings || {}).pitch ?? 0 },
    variables: Object.values(vars).map(v => ({ name: v.name, description: String(v.description || '').trim(), type: v.type || 'string', value: v.value || '', afterCall: !!v.update_post_interaction, postPrompt: v.post_interaction_prompt || '', oneOf: v.one_of || [] })),
    voices: await voices().catch(() => []),
    allLanguages: ['Hindi', 'English', 'Bengali', 'Gujarati', 'Kannada', 'Malayalam', 'Marathi', 'Odia', 'Punjabi', 'Tamil', 'Telugu', 'Assamese', 'Konkani'] });
}));

// ======================= New agent from an existing one =======================
// Sarvam copies the agent (its prompt, greeting, variables, voice, tools) as a new agent, which is
// committed as its v1 and brought into the builder like any other agent.
r.post('/agents/clone', h(async (req, res) => {
  if (!can(req.user, 'approve')) throw fail(403, 'Only approvers and admins can create agents in Sarvam.');
  const { from, name, version, greeting, client } = req.body || {};
  const src = await loadAgent(String(from || ''));
  const nm = String(name || '').trim();
  if (nm.length < 3) throw fail(400, 'Give the new agent a name.');
  if ((await db.list('agents')).some(x => x.name.toLowerCase() === nm.toLowerCase())) throw fail(409, 'An agent with that name already exists.');
  const args = { clone_from: src.sarvamAppId, name: nm.slice(0, 80) };
  if (Number(version)) args.clone_version = Number(version);
  if (greeting && String(greeting).trim()) args.config = { intro_message_config: { audio: String(greeting).trim() } };
  const out = await sarvam.callTool('configure_agent', args);
  if (out && out.ok === false) throw fail(409, `Sarvam refused to create the agent: ${(out.error && (out.error.detail || out.error.message)) || 'unknown error'}`);
  const appId = out.id || (out.details && (out.details.app_id || out.details.id));
  if (!appId) throw fail(502, 'Sarvam created the agent but didn\'t say its id. Check Sarvam, then Refresh.');
  if (!(await sarvam.committedVersions(appId)).length) await sarvam.commit(appId, `Created in the Prompt Builder from ${src.name}${args.clone_version ? ` v${args.clone_version}` : ''} by ${req.user.email}`);
  const { id, syncedAt, sarvam: _s, sarvamPromptHash, sarvamPulledAt, sarvamPullError, sarvamDraftAhead, talkSeconds, callsPlaced, callsAnswered, uatAgentId, ...keep } = src;
  const agent = await db.put('agents', { ...keep, id: appId, sarvamAppId: appId, name: nm, client: String(client || src.client || '').trim(), source: 'builder', clonedFrom: { id: src.id, name: src.name, version: args.clone_version || null }, catalogVersion: 1, talkSeconds: 0, callsPlaced: 0, callsAnswered: 0, createdAt: now() });
  await audit(req.user, 'agent.clone', { from: src.id, to: appId, name: nm });
  let pulled = null;
  try { pulled = await pullFromSarvam(agent, req.user); } catch (e) { await db.put('agents', { ...(await db.get('agents', appId)), sarvamPullError: e.publicMessage || e.message }); }
  res.json({ agentId: appId, name: nm, pulled: !!pulled });
}));

// Link a UAT (test) agent: approved changes go there first, then are promoted to this agent.
r.patch('/agents/:id', h(async (req, res) => {
  if (!can(req.user, 'approve')) throw fail(403, 'Only approvers and admins can change this.');
  const a = await loadAgent(req.params.id);
  const { uatAgentId, template, templateNote, agentType } = req.body || {};
  // Collections or sales: decides which skeleton and rule library the agent belongs to.
  if (agentType !== undefined) { if (!['collections', 'sales'].includes(agentType)) throw fail(400, 'Agent type is collections or sales.'); a.agentType = agentType; }
  if (uatAgentId !== undefined) {
    if (uatAgentId && (uatAgentId === a.id || !(await db.get('agents', uatAgentId)))) throw fail(400, 'Pick a different agent as the UAT agent.');
    a.uatAgentId = uatAgentId || null;
  }
  // Template-approved: this agent's prompt sections may be reused when building new agents.
  if (template !== undefined) {
    if (template && !(await db.list('prompts')).some(p => p.agentId === a.id)) throw fail(409, 'Load this agent\'s prompt first, then mark it as a template.');
    a.template = !!template;
    a.templateNote = template ? String(templateNote || a.templateNote || '').slice(0, 300) : null;
    a.templateBy = template ? req.user.email : null; a.templateAt = template ? now() : null;
  }
  await db.put('agents', a);
  await audit(req.user, 'agent.update', { agent: a.id, uatAgentId: a.uatAgentId, template: a.template, agentType: a.agentType });
  res.json(a);
}));

module.exports = r;
module.exports.pullFromSarvam = pullFromSarvam;
