// Module library. A module is a reusable set of rules for one behaviour. Creating, editing or approving
// a module never touches an agent. An agent changes only when someone applies a module to THAT agent,
// which saves a draft on that agent (to be approved and pushed like any change).
const express = require('express');
const db = require('../db');
const ai = require('../lib/aiTasks');
const mt = require('../lib/moduleTasks');
const pushLib = require('../lib/sarvamPush');
const core = require('../../shared/promptcore');
const { can } = require('../auth');
const config = require('../config');
const { uid, now, h, fail, audit } = require('../lib/util');
const { saveOnTop } = require('../lib/versions');

const r = express.Router();
const sortV = vs => vs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const vnum = v => String(v).split('.').map(Number);
const cmpV = (a, b) => { const x = vnum(a), y = vnum(b); return (x[0] - y[0]) || ((x[1] || 0) - (y[1] || 0)); };

const { agentText } = require('../lib/agentText');

// Which agents use which module version (from each prompt's latest and live versions).
async function usage() {
  const out = [];
  const prompts = await db.list('prompts'), agents = await db.list('agents'), versions = await db.list('versions');
  for (const p of prompts) {
    const vs = sortV(versions.filter(v => v.promptId === p.id));
    const picks = [vs[vs.length - 1], vs.find(v => v.status === 'live')].filter(Boolean);
    const seen = new Set();
    for (const v of picks) for (const u of (v.usesModules || [])) {
      const k = u.moduleId + '|' + v.id; if (seen.has(k)) continue; seen.add(k);
      out.push({ moduleId: u.moduleId, moduleVersion: u.moduleVersion, promptId: p.id, agent: (agents.find(a => a.id === p.agentId) || {}).name || p.name, version: v.v, status: v.status });
    }
  }
  return out;
}

r.get('/modules', h(async (req, res) => {
  const all = await db.list('modules');
  const use = await usage();
  const ids = [...new Set(all.map(m => m.moduleId))];
  res.json({ library: require('../lib/libraryStore').status(), items: ids.map(id => {
    const vs = all.filter(m => m.moduleId === id).sort((a, b) => cmpV(a.v, b.v));
    const latest = vs[vs.length - 1];
    return { id: latest.id, moduleId: id, v: latest.v, title: latest.title, status: latest.status, purpose: latest.purpose, rules: latest.rules.length, tests: (latest.tests || []).length,
      versions: vs.map(x => ({ id: x.id, v: x.v, status: x.status })), usedBy: use.filter(u => u.moduleId === id) };
  }) });
}));

r.get('/modules/:id', h(async (req, res) => {
  const m = await db.get('modules', req.params.id);
  if (!m) throw fail(404, 'Module not found.');
  const vs = (await db.list('modules', x => x.moduleId === m.moduleId)).sort((a, b) => cmpV(a.v, b.v));
  res.json({ module: m, versions: vs.map(x => ({ id: x.id, v: x.v, status: x.status })), usedBy: (await usage()).filter(u => u.moduleId === m.moduleId) });
}));

// Cut a behaviour out of an agent's prompt into a new module (draft). Reads the agent; changes nothing.
r.post('/modules/extract', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot create modules.');
  const { agentId, topic, moduleId, title } = req.body || {};
  const mid = String(moduleId || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '-').slice(0, 40);
  if (mid.length < 3) throw fail(400, 'Give the module an ID, e.g. PTP-DATES.');
  if ((await db.list('modules', m => m.moduleId === mid)).length) throw fail(409, `A module called ${mid} already exists.`);
  if (String(topic || '').trim().length < 15) throw fail(400, 'Describe the behaviour to extract (a sentence or two).');
  const a = await agentText(String(agentId || ''));
  const have = (await db.list('tests', t => t.promptId === a.prompt.id));
  const out = await mt.moduleExtract(a.text, { topic: String(topic).trim(), title: String(title || mid).trim(), tests: have.map((t, i) => ({ i: i + 1, title: t.title, expect: t.expect })) });
  // The agent's regression tests that check this behaviour travel with the module.
  const tests = (out.testIndexes || []).map(i => have[i - 1]).filter(Boolean).map(t => ({ title: t.title, customer: t.customer, expect: t.expect, avoid: t.avoid || '' }));
  const doc = await db.put('modules', { id: uid(), moduleId: mid, v: '1.0', status: 'draft', title: String(title || mid).trim(), topic: String(topic).trim(), ...out, tests,
    owner: req.user.email, source: { agentId: a.agent.id, agent: a.agent.name, promptId: a.prompt.id, version: a.base.v, versionStatus: a.base.status, at: now() },
    history: [{ at: now(), by: req.user.email, action: 'extracted', note: `From ${a.agent.name} v${a.base.v} (${a.base.status})` }] });
  await audit(req.user, 'module.extract', { module: mid, from: a.agent.id, rules: out.rules.length });
  res.json(doc);
}));

// Edit a module. A draft is edited in place; an approved module is never changed: its edit becomes the
// next version (draft), so agents that use the approved one are unaffected until they upgrade.
r.patch('/modules/:id', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot edit modules.');
  let m = await db.get('modules', req.params.id);
  if (!m) throw fail(404, 'Module not found.');
  const b = req.body || {};
  let forked = false;
  if (m.status === 'approved') {
    const vs = (await db.list('modules', x => x.moduleId === m.moduleId)).sort((x, y) => cmpV(x.v, y.v));
    const top = vs[vs.length - 1];
    if (top.status === 'draft') m = top; // a newer draft already exists: edit that
    else { const nv = `${vnum(top.v)[0]}.${(vnum(top.v)[1] || 0) + 1}`; m = await db.put('modules', { ...top, id: uid(), v: nv, status: 'draft', createdAt: undefined, approvedBy: null, approvedAt: null, runs: {},
      history: [{ at: now(), by: req.user.email, action: 'new_version', note: `v${nv} started from v${top.v}` }] }); forked = true; }
  }
  for (const k of ['title', 'purpose', 'trigger']) if (typeof b[k] === 'string') m[k] = b[k].slice(0, 600);
  for (const k of ['requires', 'exits', 'policyDeps']) if (Array.isArray(b[k])) m[k] = b[k].map(String).slice(0, 30);
  if (Array.isArray(b.options)) m.options = b.options.map(o => ({ id: String(o.id), label: String(o.label || o.id), desc: String(o.desc || ''), default: o.default !== false })).slice(0, 20);
  if (Array.isArray(b.rules)) m.rules = m.rules.map(x => { const e = b.rules.find(y => y.id === x.id); return e && typeof e.text === 'string' && e.text.trim() ? { ...x, text: e.text.trim() } : x; });
  m.history = [...(m.history || []), { at: now(), by: req.user.email, action: 'edited', note: '' }];
  await db.put('modules', m);
  await audit(req.user, 'module.edit', { module: m.moduleId, v: m.v, forked });
  res.json({ module: m, forked });
}));

r.post('/modules/:id/approve', h(async (req, res) => {
  if (!can(req.user, 'approve')) throw fail(403, 'Only approvers can approve a module.');
  const m = await db.get('modules', req.params.id);
  if (!m) throw fail(404, 'Module not found.');
  if (m.status !== 'draft') throw fail(409, 'Only a draft can be approved.');
  if (!config.selfApprove && m.owner === req.user.email && req.user.role !== 'admin') throw fail(409, 'Someone other than the author must approve this module.');
  // Fail closed: a module goes into the library only with rules and no unresolved [CONFIRM] placeholders.
  // Tests are shown as a recommendation on the module page (rules extracted from live agents start without them).
  const problems = [];
  const text = m.rules.map(x => x.text).join('\n');
  if (/\[CONFIRM[:\]]/i.test(text)) problems.push('it still has [CONFIRM: …] placeholders');
  if (!m.rules.length) problems.push('it has no rules');
  if (problems.length) throw fail(409, `Can't approve yet: ${problems.join('; ')}.`);
  m.status = 'approved'; m.approvedBy = req.user.email; m.approvedAt = now();
  m.history = [...(m.history || []), { at: now(), by: req.user.email, action: 'approved', note: '' }];
  await db.put('modules', m);
  await audit(req.user, 'module.approve', { module: m.moduleId, v: m.v });
  res.json(m);
}));

// Show exactly what using this module would do to one agent. Saves NOTHING.
r.post('/modules/:id/preview', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot do this.');
  const m = await db.get('modules', req.params.id);
  if (!m) throw fail(404, 'Module not found.');
  const { agentId, options, params } = req.body || {};
  const a = await agentText(String(agentId || ''));
  const opts = Object.fromEntries((m.options || []).map(o => [o.id, options && o.id in options ? !!options[o.id] : o.default]));
  const prm = { ...(params || {}) };
  const rules = m.rules.map(x => ({ id: x.id, title: x.title, slot: x.slot, text: mt.renderRule(x.text, opts, prm).trim() })).filter(x => x.text);
  const loc = await mt.moduleLocate(a.text, rules, { topic: m.topic || m.title, variables: a.variables });
  const unfilled = [...new Set(rules.flatMap(x => x.text.match(/\[\[\w+\]\]/g) || []))];
  res.json({ module: m.moduleId, v: m.v, status: m.status, agent: a.agent.name, agentChars: a.text.length, options: opts, edits: loc.edits.map((e, i) => ({ ...e, id: i })), unfilled, provider: loc.provider });
}));

// Use the module for this ONE agent: the chosen changes are saved as a draft on that agent's prompt.
r.post('/modules/:id/apply', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot change prompts.');
  const m = await db.get('modules', req.params.id);
  if (!m) throw fail(404, 'Module not found.');
  if (m.status !== 'approved') throw fail(409, 'This module is still a draft. Approve it before using it for an agent.');
  const { agentId, edits, options, params } = req.body || {};
  const a = await agentText(String(agentId || ''));
  const list = (Array.isArray(edits) ? edits : []).filter(e => e && e.action !== 'skip' && typeof e.old_text === 'string' && typeof e.new_text === 'string');
  if (!list.length) throw fail(400, 'Tick at least one change.');
  if (list.some(e => /\[\[\w+\]\]/.test(e.new_text))) throw fail(400, 'Some text still has [[placeholders]]. Fill in the module settings for this agent first.');
  const out = ai.applyEdits(a.text, list.map(e => ({ old_text: e.old_text, new_text: e.new_text })));
  if (out.failed.length) throw fail(409, `${out.failed.length} change${out.failed.length > 1 ? 's' : ''} no longer match this agent's prompt (it changed since the preview). Preview again.`, 'stale');
  const newText = out.text.replace(/\n{3,}/g, '\n\n').trim();
  const imp = await ai.resplit(newText, a.base, `Module ${m.moduleId}`);
  const carry = (a.base.usesModules || []).filter(u => u.moduleId !== m.moduleId);
  const uses = [...carry, { moduleId: m.moduleId, moduleVersion: m.v, docId: m.id, options: options || {}, params: params || {}, rules: list.map(e => e.rule) }];
  const what = `Module ${m.moduleId} v${m.v}: ${list.length} rule${list.length > 1 ? 's' : ''} (${list.filter(e => e.action === 'replace').length} replaced, ${list.filter(e => e.action === 'insert').length} added)`;
  const { ver, updated } = await saveOnTop(a.prompt, a.base, { sections: imp.sections, order: imp.order, ...(imp.titles ? { titles: imp.titles } : {}), note: what, src: 'Module', sarvamText: newText, sourceChunks: null,
    ...(a.base.greeting ? { greeting: a.base.greeting } : {}), ...((a.base.configPatch && a.base.status !== 'live') ? { configPatch: a.base.configPatch, configSummary: a.base.configSummary || [] } : {}), usesModules: uses }, req.user, what);
  await audit(req.user, 'module.apply', { module: m.moduleId, v: m.v, agent: a.agent.id, version: ver.v, updated });
  res.json({ versionId: ver.id, v: ver.v, updated, agent: a.agent.name, charsBefore: a.text.length, charsAfter: newText.length });
}));

// Run the module's tests against an agent's latest prompt (simulated: the AI plays that agent).
r.post('/modules/:id/tests/run', h(async (req, res) => {
  const m = await db.get('modules', req.params.id);
  if (!m) throw fail(404, 'Module not found.');
  if (!(m.tests || []).length) throw fail(400, 'This module has no tests.');
  const a = await agentText(String((req.body || {}).agentId || ''));
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const results = [];
  for (let i = 0; i < m.tests.length; i += 3) results.push(...await Promise.all(m.tests.slice(i, i + 3).map(async t => {
    try { return { title: t.title, ...(await ai.runTest(a.text, a.greeting, t, today)) }; } catch (e) { return { title: t.title, pass: null, why: e.message, replies: [] }; }
  })));
  const summary = { agentId: a.agent.id, agent: a.agent.name, v: a.base.v, at: now(), passed: results.filter(x => x.pass === true).length, failed: results.filter(x => x.pass === false).length, total: results.length, results: results.map(x => ({ title: x.title, pass: x.pass, why: x.why })) };
  m.runs = { ...(m.runs || {}), [a.agent.id]: summary };
  await db.put('modules', m);
  res.json(summary);
}));

// Delete a draft module that no agent uses.
r.delete('/modules/:id', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot delete modules.');
  const m = await db.get('modules', req.params.id);
  if (!m) throw fail(404, 'Module not found.');
  if (m.status !== 'draft') throw fail(409, 'Only a draft can be deleted. An approved module stays in the library.');
  if ((await usage()).some(u => u.docId === m.id)) throw fail(409, 'An agent uses this module.');
  await db.del('modules', m.id);
  await audit(req.user, 'module.delete', { module: m.moduleId, v: m.v });
  res.json({ ok: true });
}));

module.exports = r;
