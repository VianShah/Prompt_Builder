// Talks to the existing Kollect dashboard (Kollect-StateMachine on Render). Uses only endpoints Kollect already has:
//   GET  /api/agent-catalog                       -> agents (Sarvam ones carry appId, appVersion, variables)
//   GET  /api/agent-versions?appId=…&refresh=1    -> { latest, pinned, active, mode, versions }
//   POST /api/agent-versions { appId, version }   -> pin a Sarvam version (null = back to latest)
const config = require('../config');

const STAGE_TO_BUCKET = { 'Pre-due': 'predue', 'Bucket X': 'b1', 'Bucket 1': 'b1', 'Bucket 2': 'b31', 'Bucket 3': 'b61' };
const TONE_TO_PERSONA = { Empathetic: 'friendly', Friendly: 'friendly', Professional: 'compliant', Firm: 'firm', Aggressive: 'pushy', Urgent: 'urgency' };

function enabled() { return !!config.kollect.baseUrl; }

async function call(path, opts = {}) {
  if (!enabled()) throw Object.assign(new Error('KOLLECT_BASE_URL is not set.'), { code: 'kollect_off' });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000); // Kollect's version probe can take a while; Render free tier also cold-starts
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.kollect.apiKey) headers['X-Builder-Key'] = config.kollect.apiKey;
    const res = await fetch(config.kollect.baseUrl + path, { ...opts, headers, signal: ctl.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `Kollect returned HTTP ${res.status}`), { code: 'kollect_http', status: res.status });
    return body;
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('Kollect did not answer in 30 seconds (it may be waking up). Try again.'), { code: 'kollect_timeout' });
    if (!e.code) { e.code = 'kollect_network'; e.message = `Could not reach Kollect at ${config.kollect.baseUrl}. Is it running?`; e.publicMessage = e.message; }
    throw e;
  } finally { clearTimeout(timer); }
}

const asList = v => Array.isArray(v) ? v : (typeof v === 'string' ? (v.match(/[A-Za-z0-9_]+/g) || []) : []);

async function listSarvamAgents() {
  const body = await call('/api/agent-catalog');
  return (body.agents || []).filter(a => a.appId).map(a => ({
    id: a.appId,
    kollectId: a.id,
    name: a.name,
    client: a.client || a.badge || '',
    service: a.service, line: a.line,
    product: (a.products || [])[0] || '',
    stage: a.stage || '',
    bucket: STAGE_TO_BUCKET[a.stage] || 'b1',
    personaTone: a.personaTone || '', persona: TONE_TO_PERSONA[a.personaTone] || 'compliant', toneNote: a.toneNote || '',
    languages: a.languages || [],
    status: a.status || '',
    description: a.description || '',
    sarvamAppId: a.appId,
    catalogVersion: Number(a.appVersion) || 1,
    variables: asList(a.variables),
    provider: a.provider || 'Sarvam',
    talkSeconds: Number(a.talkSeconds) || 0, callsPlaced: Number(a.callsPlaced) || 0, callsAnswered: Number(a.callsAnswered) || 0,
  }));
}
const versions = (appId, refresh) => call(`/api/agent-versions?appId=${encodeURIComponent(appId)}${refresh ? '&refresh=1' : ''}`);
const pin = (appId, version) => call('/api/agent-versions', { method: 'POST', body: JSON.stringify({ appId, version: version == null ? null : Number(version) }) });

// Tell Kollect which Sarvam versions are committed, so it never calls the uncommitted draft.
const reportCommitted = (appId, versions) => call('/api/agent-versions/committed', { method: 'POST', body: JSON.stringify({ appId, versions }) });
const calls = (appId, limit = 50) => call(`/api/agent-calls?appId=${encodeURIComponent(appId)}&limit=${limit}`);

// Every call Sarvam handled for an agent (Kollect reads Sarvam's analytics with its API key).
const q = o => new URLSearchParams(o).toString();
const interactions = (appId, from, to, offset = 0) => call(`/api/agent-interactions?${q({ appId, from, to, offset })}`);
const transcript = (appId, id) => call(`/api/agent-interactions/transcript?${q({ appId, id })}`);

// The call recording as a Buffer (WAV). Not through call(): it isn't JSON and can take a while.
async function recording(appId, id) {
  if (!enabled()) throw Object.assign(new Error('KOLLECT_BASE_URL is not set.'), { code: 'kollect_off' });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const headers = config.kollect.apiKey ? { 'X-Builder-Key': config.kollect.apiKey } : {};
    const res = await fetch(`${config.kollect.baseUrl}/api/agent-interactions/recording?${q({ appId, id })}`, { headers, signal: ctl.signal });
    if (!res.ok) { const b = await res.json().catch(() => ({})); throw Object.assign(new Error(b.error || `Kollect returned HTTP ${res.status}`), { code: 'kollect_http', status: res.status }); }
    return { type: res.headers.get('content-type') || 'audio/wav', data: Buffer.from(await res.arrayBuffer()) };
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('The recording took longer than a minute to download. Try again.'), { code: 'kollect_timeout' });
    throw e;
  } finally { clearTimeout(timer); }
}

module.exports = { enabled, listSarvamAgents, versions, pin, calls, interactions, transcript, recording, reportCommitted, STAGE_TO_BUCKET, TONE_TO_PERSONA };
