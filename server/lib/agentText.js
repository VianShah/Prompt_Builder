// The agent's current full prompt as it reads in Sarvam (latest version), its call variables and greeting.
const db = require('../db');
const pushLib = require('./sarvamPush');
const core = require('../../shared/promptcore');
const { fail } = require('./util');
const sortV = vs => vs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

async function agentText(agentId) {
  const agent = await db.get('agents', agentId);
  if (!agent) throw fail(404, 'Unknown agent.');
  const p = (await db.list('prompts')).find(x => x.agentId === agent.id);
  if (p) await require('./agentKind').fromPrompt(p);
  if (!p) throw fail(409, `${agent.name} has no prompt in the builder yet. Open it and load its prompt from Sarvam first.`);
  const vs = sortV(await db.list('versions', x => x.promptId === p.id));
  const base = vs[vs.length - 1], live = vs.find(x => x.status === 'live');
  const t = pushLib.sarvamTextFor(live, base);
  const text = t ? t.text : core.toMarkdown(core.header(p.cfg, base.v), base.order, base.sections, false).trim();
  const variables = [...new Set((text.match(/\{\{\s*(\w+)\s*\}\}/g) || []).map(s => s.replace(/[{}\s]/g, '')))].slice(0, 60);
  const greeting = base.greeting || (((base.sarvamMeta || (live && live.sarvamMeta)) || {}).greeting) || '';
  return { agent, prompt: p, base, live, text, variables, greeting };
}

// The prompt to LEARN from: the agent's newest committed version in Sarvam, read fresh, unless a version
// was chosen for this agent (agent.bestVersion). Returns the text with the version it came from, so the
// result can say which version it used. Without a Sarvam sign-in the builder's own copy is used, flagged
// when it may be older than Sarvam's newest; a chosen version is never replaced by a copy.
async function agentSource(agentId, { signal } = {}) {
  const sarvam = require('./sarvam');
  const a = await db.get('agents', agentId);
  if (!a) throw fail(404, 'Unknown agent.');
  const want = a.bestVersion ? Number(a.bestVersion) : null;
  const st = await sarvam.status();
  if (a.sarvamAppId && st.hasToken && !st.expired) {
    if (signal && signal.aborted) throw Object.assign(new Error('Stopped.'), { code: 'cancelled', publicMessage: 'Stopped.' });
    const committed = await sarvam.committedVersions(a.sarvamAppId);
    const newest = committed[committed.length - 1] || null;
    const version = want || newest;
    if (!version) throw fail(409, `${a.name} has no committed version in Sarvam yet. Commit one in Sarvam first.`);
    if (want && !committed.includes(want)) throw fail(409, `${a.name} has no committed v${want} in Sarvam (it has ${committed.join(', ')}). Choose another version.`);
    const ex = await sarvam.promptText(a.sarvamAppId, version);
    if (a.sarvamNewest !== newest) await db.put('agents', { ...(await db.get('agents', a.id)), sarvamNewest: newest, sarvamCheckedAt: new Date().toISOString() });
    return { agent: a, text: ex.text, version, newest, latest: version === newest, chosen: !!want, via: 'sarvam' };
  }
  if (want) throw fail(409, `${a.name} is set to learn from v${want}, which can only be read from Sarvam. Connect Sarvam first.`);
  const t = await agentText(agentId);
  const have = t.live && t.live.sarvamVersion ? Number(t.live.sarvamVersion) : null;
  return { agent: a, text: t.text, version: have, newest: a.sarvamNewest || null, latest: !!have && (!a.sarvamNewest || have >= Number(a.sarvamNewest)), chosen: false, via: 'stored',
    note: `Sarvam isn't connected, so the builder's copy${have ? ` (Sarvam v${have})` : ''} was used${a.sarvamNewest && have && have < Number(a.sarvamNewest) ? `. Sarvam has v${a.sarvamNewest}, which is newer` : ''}.` };
}

module.exports = { agentText, agentSource };
