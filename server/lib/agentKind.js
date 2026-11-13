// Which kind of agent (collections or sales) the current request is about, so every AI instruction
// describes the right thing: a sales agent is never analysed as a collections agent.
// Set per request (AsyncLocalStorage), read by the AI tasks.
const { AsyncLocalStorage } = require('async_hooks');
const db = require('../db');

const als = new AsyncLocalStorage();
const DESC = {
  collections: { t: 'collections', agent: 'collections voice agent', domain: 'Indian lending, multilingual phone calls', call: 'collections call' },
  sales: { t: 'sales', agent: 'sales voice agent', domain: 'credit cards and lending products in India, multilingual phone calls', call: 'sales call' },
};
const middleware = (req, res, next) => als.run({ type: 'collections' }, next);
function set(type) { const s = als.getStore(); if (s && DESC[type]) s.type = type; }
const kind = () => DESC[(als.getStore() || {}).type] || DESC.collections;
// From a prompt (its own type, else its agent's).
async function fromPrompt(p) {
  let t = p && p.agentType;
  if (!t && p && p.agentId) { const a = await db.get('agents', p.agentId); t = a && a.agentType; }
  set(t || 'collections');
  return kind();
}
async function fromAgent(a) { set((a && a.agentType) || 'collections'); return kind(); }
module.exports = { middleware, set, kind, fromPrompt, fromAgent, DESC };
