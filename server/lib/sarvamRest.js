// Calls straight from Sarvam's analytics REST API, with the Voice Agents API key (SARVAM_API_KEY).
// Unlike the MCP sign-in (about 24 hours, no renewal) the key doesn't expire daily, so the Calls tab
// keeps working with no sign-in and without Kollect. The key can read calls, transcripts and recordings;
// it can't read an agent's prompt (that needs the MCP sign-in).
//   GET /api/analytics/v1/{org}/{ws}/{app}/interactions?start_datetime&end_datetime&offset&limit&sort_by&sort_order
//   GET …/{app}/transcripts/{interaction_id}   -> { messages: [{ turn_id, role, content, language_name }] }
//   GET …/{app}/recordings/{interaction_id}    -> audio/wav
const config = require('../config');

const BASE = 'https://apps.sarvam.ai/api/analytics/v1';
const enabled = () => !!(config.sarvam.apiKey && config.sarvam.orgId && config.sarvam.workspaceId);
const base = appId => `${BASE}/${config.sarvam.orgId}/${config.sarvam.workspaceId}/${encodeURIComponent(appId)}`;
const err = (status, msg) => Object.assign(new Error(msg), { status, publicMessage: msg, code: 'sarvam_rest' });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function get(url, { ms = 25000, raw = false } = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(url, { headers: { 'X-API-Key': config.sarvam.apiKey }, signal: ctl.signal });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) { await res.arrayBuffer().catch(() => { }); await wait(1500 * attempt); continue; } // Sarvam rate-limits back-to-back calls
      if (res.status === 401 || res.status === 403) throw err(502, 'Sarvam refused the API key (SARVAM_API_KEY). Check it in the environment settings.');
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw err(res.status === 404 ? 404 : 502, res.status === 404 ? 'Sarvam has no such recording or call.' : `Sarvam analytics returned HTTP ${res.status}${b.detail ? `: ${String(b.detail).slice(0, 160)}` : ''}`); }
      return raw ? res : res.json();
    } catch (e) {
      if (e.name === 'AbortError') { if (attempt < 4) continue; throw err(504, 'Sarvam analytics did not answer in time.'); }
      if (e.code === 'sarvam_rest') throw e;
      if (attempt >= 4) throw err(502, `Could not reach Sarvam analytics: ${e.message}`);
      await wait(1000 * attempt);
    } finally { clearTimeout(timer); }
  }
}

// Sarvam sends UTC times without a zone ("2026-10-13T11:17:13").
const utc = s => (s && /^\d{4}-\d\d-\d\dT[\d:.]+$/.test(s) ? s + 'Z' : s || null);
const num = v => (v == null || v === '' ? null : Number(v));

// One call row in the shape the Calls tab uses. Handles both this API's and the MCP report's field names.
function row(x) {
  return {
    id: x.interaction_id,
    at: utc(x.start_datetime || x.attempted_at),
    durationSeconds: Math.round(Number(x.duration_in_seconds) || 0),
    language: x.language_name || '',
    messages: Number(x.num_messages) || 0,
    direction: x.channel_direction || '',
    endedBy: x.ended_by || x.end_reason || '',
    failure: x.failure_reason && x.failure_reason !== 'NO_FAILURE_REASON' ? x.failure_reason : '',
    version: num(x.app_version),
    test: Number(x.is_debug_call) === 1,
    contact: x.user_contact_masked || '',
    campaign: x.campaign_id && x.campaign_id !== 'NO_CAMPAIGN_ID' ? x.campaign_id : '',
    hasAudio: !!x.audio_url,
    agentResponseSeconds: num(x.average_agent_response_time_in_seconds),
    goal: x.goal_overall_status || '',
    variables: x.agent_variables || null,
  };
}

async function list(appId, { from, to, offset = 0, limit = 50 }) {
  const q = new URLSearchParams({ start_datetime: new Date(from).toISOString(), end_datetime: new Date(to).toISOString(), offset: String(offset), limit: String(Math.min(100, limit)), sort_by: 'start_datetime', sort_order: 'desc' });
  const body = await get(`${base(appId)}/interactions?${q}`);
  const items = (body.items || []).map(row);
  const total = Number(body.total) || items.length;
  return { items, total, offset: Number(offset), more: Number(offset) + items.length < total };
}

async function transcript(appId, interactionId) {
  const body = await get(`${base(appId)}/transcripts/${interactionId}`);
  return { timed: false, turns: (body.messages || []).map(m => ({ role: m.role === 'assistant' ? 'agent' : m.role === 'user' ? 'user' : m.role, text: m.content || '', language: m.language_name || '', start: null, end: null })) };
}

// The recording as a Buffer (WAV).
async function recording(appId, interactionId) {
  const res = await get(`${base(appId)}/recordings/${interactionId}`, { ms: 90000, raw: true });
  return { type: res.headers.get('content-type') || 'audio/wav', data: Buffer.from(await res.arrayBuffer()) };
}

module.exports = { enabled, row, list, transcript, recording };
