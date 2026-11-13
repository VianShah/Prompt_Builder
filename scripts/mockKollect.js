// Local stand-in for the Kollect dashboard (and, for tests, an OpenAI-compatible LLM) so the builder can be run
// end to end without touching production. Not used on Render.
//   node scripts/mockKollect.js            -> http://localhost:3009
//   KOLLECT_BASE_URL=http://localhost:3009
//   CATALOG=/path/to/Kollect-StateMachine/server/agentCatalog.json  (optional: use the real catalog file)
//   POST /mock/commit {appId}  simulates committing a new version in Sarvam
const fs = require('fs');
const express = require('express');
const app = express();
app.use(express.json({ limit: '4mb' }));

const SAMPLE = [
  { id: 'snapmint-call-forwarding', name: 'Call forwarding Snapmint agent', service: 'Retail debt collections', line: 'Collections', products: ['BNPL'], stage: 'Bucket 1', objective: 'Payment collection', personaTone: 'Professional', badge: 'SnapMint', client: 'SnapMint', appId: 'SnapMint-Ko-328fab61-cb49', appVersion: 3, variables: ['user_name', 'customer_name', 'emi_amount', 'today_date', 'prior_context', 'link_live'], languages: ['Hindi', 'English', 'Hinglish'], status: 'Live', provider: 'Sarvam (Samvaad)', description: 'SnapMint collections voice with call forwarding.' },
  { id: 'fatak-pay-aggressive', name: 'Aggressive', service: 'Retail debt collections', line: 'Collections', products: ['Personal Loan'], stage: 'Bucket 2', objective: 'Payment collection', personaTone: 'Firm', toneNote: 'Aggressive', badge: 'Fatak Pay', client: 'Fatak Pay', appId: 'Fatak-Pay---43dcb102-c5c6', appVersion: 2, variables: "['user_name', 'customer_name', 'product_type', 'link_live', 'today_date', 'prior_context', 'dpd', 'emi_amount', 'emi_due_date']", languages: ['Hindi', 'English'], status: 'Live', provider: 'Sarvam (Samvaad)', description: 'Assertive retail collections voice for Fatak Pay.' },
  { id: 'demo-not-sarvam', name: 'Demo persona', service: 'Cold sales', products: ['Credit Card'], personaTone: 'Friendly', status: 'Demo' }
];
const catalog = process.env.CATALOG ? JSON.parse(fs.readFileSync(process.env.CATALOG, 'utf8')) : SAMPLE;
const latest = {}; const pins = {};
catalog.filter(a => a.appId).forEach(a => { latest[a.appId] = Number(a.appVersion) || 1; });
const state = appId => ({ appId, latest: latest[appId], pinned: pins[appId] || null, active: pins[appId] || latest[appId], mode: pins[appId] ? 'pinned' : 'latest', checkedAt: new Date().toISOString(), versions: Array.from({ length: latest[appId] }, (_, i) => latest[appId] - i) });

app.get('/api/agent-catalog', (req, res) => res.json({ agents: catalog, facets: {} }));
app.get('/api/agent-versions', (req, res) => latest[req.query.appId] ? res.json(state(req.query.appId)) : res.status(404).json({ error: 'Unknown agent' }));
app.post('/api/agent-versions', (req, res) => {
  const { appId, version } = req.body || {};
  if (!latest[appId]) return res.status(404).json({ error: 'Unknown agent' });
  if (version == null) delete pins[appId];
  else if (version > latest[appId]) return res.status(400).json({ error: `Version ${version} doesn't exist in Sarvam for this agent.` });
  else pins[appId] = Number(version);
  res.json(state(appId));
});
app.post('/mock/commit', (req, res) => { latest[req.body.appId]++; res.json(state(req.body.appId)); });

// Minimal OpenAI-compatible LLM for tests (set GLM_BEDROCK_BASE_URL=http://localhost:3009/openai/v1, any GLM key).
app.post('/openai/v1/chat/completions', (req, res) => {
  const p = req.body.messages.map(m => m.content).join('\n');
  let out;
  if (p.includes('Assign each numbered chunk')) {
    const n = (p.match(/^\[(\d+)\]/gm) || []).length;
    const secs = ['rules', 'persona', 'speech', 'inputs', 'identity', 'opening', 'flows', 'objections', 'kb', 'dates', 'language', 'hygiene', 'closing'];
    out = Array.from({ length: n }, (_, i) => ({ i: i + 1, section: secs[Math.min(i, secs.length - 1)] }));
  } else if (p.includes('You map feedback')) {
    const n = (p.split('FEEDBACK ITEMS:')[1].match(/^\d+\. /gm) || []).length;
    out = Array.from({ length: n }, (_, i) => ({ i: i + 1, section: i % 2 ? 'identity' : 'flows', block: '', layer: i % 2 ? 'L1' : 'L6', type: 'behaviour', severity: 'medium', scope: i % 2 ? 'shared' : 'client', diagnosis: 'mock diagnosis', fix: 'mock fix' }));
  } else if (p.includes('Rewrite one section')) {
    const cur = p.split('CURRENT SECTION TEXT:\n')[1].split('\n\nReply with only JSON')[0];
    out = { revised: cur + '\n- Never ask the customer how much they can pay.', summary: 'Added an explicit ban on asking how much.' };
  } else if (p.includes('You build the knowledge base for a phone voice agent')) {
    const files = [...p.matchAll(/=== FILE: (.+?) ===/g)].map(m => m[1]);
    out = { facts: files.flatMap((f, i) => [{ k: `Late fee ${i + 1}`, v: `A late fee applies as written in ${f}.`, kind: i % 2 ? 'policy' : 'product', src: f }, { k: 'Payment channels', v: 'UPI, net banking or the app.', kind: 'contact', src: f }]),
      faqs: files.map(f => ({ q: 'Can I pay by UPI?', a: 'Yes, through the payment link.', src: f })), oos: "I don't have that information; I'll note it for the team." };
  } else if (p.includes('and FIX what you find')) {
    const blk = id => { const m = p.split(`[${id}] `)[1]; return m ? m.split('\n').slice(1).join('\n').split('\n\n[')[0] : ''; };
    const greet = blk('OPEN-GREET');
    out = [
      { section: 'opening', severity: 'medium', issue: 'The greeting does not say the call may be recorded.', suggestion: 'Mention recording in the greeting.', fix: { type: 'edit', block: 'OPEN-GREET', new_text: greet + '\nSay once that the call may be recorded for quality.' } },
      { section: 'objections', severity: 'high', issue: 'Nothing covers a customer who says they lost their job this month.', suggestion: 'Add a hardship rule.', fix: { type: 'add', section: 'objections', text: 'If the customer has lost their job: respond with empathy, do not push for payment today, and offer a callback.' } },
      { section: 'rules', severity: 'high', issue: 'The compliance core does not forbid calling relatives.', suggestion: 'Strengthen it.', fix: { type: 'edit', block: 'CORE-NN-01', new_text: 'Never call relatives.' } },
      { section: 'persona', severity: 'low', issue: 'The persona is softer than the bucket usually needs.', suggestion: 'Use Compliant + firm.', fix: { type: 'setting', step: 'Persona', change: 'Pick Compliant + firm.' } },
    ];
  } else if (p.includes('Review this collections')) out = [];
  else out = { facts: [], faqs: [], oos: '' };
  res.json({ choices: [{ message: { content: JSON.stringify(out) } }] });
});

const port = Number(process.env.MOCK_PORT || 3009);
app.listen(port, () => console.log(`Mock Kollect on http://localhost:${port} (${catalog.filter(a => a.appId).length} Sarvam agents)`));
