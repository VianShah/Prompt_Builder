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
  if (!p) throw fail(409, `${agent.name} has no prompt in the builder yet. Open it and load its prompt from Sarvam first.`);
  const vs = sortV(await db.list('versions', x => x.promptId === p.id));
  const base = vs[vs.length - 1], live = vs.find(x => x.status === 'live');
  const t = pushLib.sarvamTextFor(live, base);
  const text = t ? t.text : core.toMarkdown(core.header(p.cfg, base.v), base.order, base.sections, false).trim();
  const variables = [...new Set((text.match(/\{\{\s*(\w+)\s*\}\}/g) || []).map(s => s.replace(/[{}\s]/g, '')))].slice(0, 60);
  const greeting = base.greeting || (((base.sarvamMeta || (live && live.sarvamMeta)) || {}).greeting) || '';
  return { agent, prompt: p, base, live, text, variables, greeting };
}

module.exports = { agentText };
