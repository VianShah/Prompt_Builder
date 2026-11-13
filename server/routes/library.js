// The rule library per agent type, and the 3-step New prompt built on it.
//   GET  /library/:type                     skeleton, library entries, built-in blocks, agents of the type
//   POST /library/:type/skeleton/derive     AI proposes the skeleton from the live agents (nothing saved)
//   PUT  /library/:type/skeleton            save the confirmed skeleton
//   POST /library/:type/extract/start       background job: every agent's prompt -> rules -> merged -> drafts
//   GET  /library/:type/extract/status
//   POST /library/:type/from-docs           AI drafts skeleton + rules from documents (types with no agents)
//   POST /library/:type/source              a live agent's prompt split into the skeleton's sections
//   POST /library/:type/best                the best-fitting rules for a new agent, per section
//   POST /library/:type/refine              tailor one rule to the new agent; saved to the library as a variant
//   POST /library/:type/compose             save the assembled prompt as a draft (then approve and push as usual)
const express = require('express');
const db = require('../db');
const PB = require('../../shared/blocks');
const lt = require('../lib/libraryTasks');
const ai = require('../lib/aiTasks');
const { agentText } = require('../lib/agentText');
const { can } = require('../auth');
const { uid, now, h, fail, audit } = require('../lib/util');

const r = express.Router();
const typeOf = req => { const t = req.params.type; if (!lt.TYPES[t]) throw fail(404, 'Agent type is collections or sales.'); return t; };
const agentTypeOf = a => a.agentType || 'collections';
const vnum = v => String(v).split('.').map(Number);
const cmpV = (a, b) => { const x = vnum(a), y = vnum(b); return (x[0] - y[0]) || ((x[1] || 0) - (y[1] || 0)); };
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim();

async function skeletonOf(type) { return (await db.list('skeletons', s => s.agentType === type))[0] || null; }
// Latest version of every library entry of this type.
async function entriesOf(type) {
  const all = await db.list('modules', m => (m.agentType || 'collections') === type);
  const by = new Map();
  all.forEach(m => { const cur = by.get(m.moduleId); if (!cur || cmpV(m.v, cur.v) > 0) by.set(m.moduleId, m); });
  return [...by.values()];
}
// Agents of this type that have a prompt in the builder.
async function agentsOf(type) {
  const [agents, prompts] = await Promise.all([db.list('agents'), db.list('prompts')]);
  return agents.filter(a => agentTypeOf(a) === type).map(a => ({ id: a.id, name: a.name, client: a.client || '', hasPrompt: prompts.some(p => p.agentId === a.id) }));
}

// Built-in blocks (collections only), placed into the skeleton's sections by name.
const BUILTIN_HINTS = {
  rules: ['rule', 'compliance', 'guardrail', 'non negotiable', 'restriction', 'do not'], persona: ['persona', 'role', 'identity of', 'introduction', 'about you', 'character'],
  speech: ['speech', 'voice', 'tts', 'speaking style'], inputs: ['input', 'variable', 'environment', 'context', 'data'], identity: ['identity', 'verification', 'rpc', 'right party'],
  opening: ['opening', 'greeting', 'introduction', 'start'], flows: ['flow', 'conversation', 'objective', 'payment', 'collection', 'steps'], objections: ['objection', 'special case', 'edge case', 'handling'],
  kb: ['knowledge', 'product', 'faq', 'facts'], dates: ['date', 'time', 'calendar'], language: ['language'], hygiene: ['hygiene', 'silence', 'interruption', 'conversation rules'], closing: ['closing', 'disposition', 'end', 'wrap'],
};
function builtinSection(sk, builderSec) {
  const hints = BUILTIN_HINTS[builderSec] || [builderSec];
  const hit = sk.sections.find(s => hints.some(k => norm([s.title, s.id, ...(s.aliases || [])].join(' ')).includes(k)));
  return (hit || (builderSec === 'kb' && sk.sections.find(s => s.kb)) || sk.sections[0]).id;
}
// A wizard-style config from the new agent's details, so built-in blocks read with this client's values.
function cfgFrom(info) {
  const c = PB.baseCfg(); const i = info || {};
  Object.assign(c.client, { name: i.client || '', legal: i.legal || '', agentName: i.agentName || '', product: PB.PRODUCTS.includes(i.product) ? i.product : c.client.product, productDesc: i.productDesc || '', agentGender: i.gender === 'male' ? 'male' : 'female' });
  if (Array.isArray(i.languages) && i.languages.length) c.client.languages = i.languages.filter(l => PB.LANGS.includes(l));
  if (i.callingAs === 'agency') { c.client.callingAs = 'agency'; c.client.agency = i.agency || ''; }
  if (i.bucket && PB.BUCKETS.some(b => b.id === i.bucket)) c.bucket = i.bucket;
  return c;
}
function builtinsFor(type, sk, info) {
  if (type !== 'collections' || !sk) return [];
  const c = cfgFrom(info);
  return PB.BLOCKS.filter(b => b.when(c) && b.id !== 'VAR-SCHEMA' && b.id !== 'KB-CLIENT').map(b => ({
    ref: `B:${b.id}`, builtin: true, id: b.id, title: b.t, section: builtinSection(sk, b.sec), layer: b.layer, locked: b.edit === 'locked', src: b.src, text: String(b.text(c)).trim(),
  }));
}
const entryView = m => ({ ref: `M:${m.id}`, id: m.id, moduleId: m.moduleId, v: m.v, title: m.title, purpose: m.purpose || '', section: m.section || null, status: m.status, origin: m.origin || 'extracted',
  agents: (m.sourceAgents || []).map(a => a.name), variantOf: m.variantOf || null, alternatives: (m.alternatives || []).length, rules: (m.rules || []).map(x => ({ id: x.id, title: x.title, text: x.text })) });

r.get('/library/:type', h(async (req, res) => {
  const type = typeOf(req);
  const [sk, entries, agents] = await Promise.all([skeletonOf(type), entriesOf(type), agentsOf(type)]);
  res.json({ type, skeleton: sk, entries: entries.map(entryView), builtins: builtinsFor(type, sk, {}), agents, job: jobs[type] || null });
}));

r.post('/library/:type/skeleton/derive', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot do this.');
  const type = typeOf(req);
  const prompts = [];
  for (const a of (await agentsOf(type)).filter(x => x.hasPrompt)) { try { const t = await agentText(a.id); prompts.push({ agent: a.name, greeting: t.greeting, text: t.text }); } catch (_) { /* skip */ } }
  res.json(await lt.deriveSkeleton({ agentType: type, prompts }));
}));

r.put('/library/:type/skeleton', h(async (req, res) => {
  if (!can(req.user, 'approve')) throw fail(403, 'Only approvers can confirm the structure.');
  const type = typeOf(req);
  const b = req.body || {};
  if (!Array.isArray(b.sections) || !b.sections.length) throw fail(400, 'The structure needs at least one section.');
  const seen = new Set();
  const sections = b.sections.filter(s => s && String(s.title || '').trim()).map(s => { let id = lt.slug(s.id || s.title); while (seen.has(id)) id += '-2'; seen.add(id); return { id, title: String(s.title).trim().slice(0, 80), mandatory: s.mandatory !== false, desc: String(s.desc || '').slice(0, 300), aliases: (s.aliases || []).map(String).slice(0, 8), kb: !!s.kb }; });
  const old = await skeletonOf(type);
  const doc = await db.put('skeletons', { id: old ? old.id : `skeleton-${type}`, agentType: type, greeting: { desc: String((b.greeting && b.greeting.desc) || 'The first line the agent speaks.').slice(0, 300) }, sections,
    derivedFrom: b.derivedFrom || (old && old.derivedFrom) || [], confirmedBy: req.user.email, confirmedAt: now(), history: [...((old && old.history) || []), { at: now(), by: req.user.email, action: old ? 'updated' : 'confirmed' }] });
  await audit(req.user, 'skeleton.save', { type, sections: sections.length });
  res.json(doc);
}));

// ---------- bulk extract: every agent of the type -> rules -> merged per section -> draft entries ----------
const jobs = {};
async function saveGroup(type, sk, sec, g, members, user) {
  const agents = [...new Map(members.map(m => [m.agentId, { id: m.agentId, name: m.agent }])).values()];
  const existing = (await entriesOf(type)).find(m => m.section === sec.id && norm(m.title) === norm(g.title));
  if (existing) { // seen before: record the extra agents and wordings, never overwrite an entry
    const known = new Set((existing.sourceAgents || []).map(a => a.id));
    existing.sourceAgents = [...(existing.sourceAgents || []), ...agents.filter(a => !known.has(a.id))];
    existing.alternatives = [...(existing.alternatives || []), ...members.filter(m => norm(m.text) !== norm(existing.rules[0] && existing.rules[0].text)).map(m => ({ agent: m.agent, text: m.text }))].slice(0, 12);
    await db.put('modules', existing);
    return false;
  }
  let mid = `${type === 'sales' ? 'S' : 'C'}-${lt.slug(sec.id).toUpperCase()}-${lt.slug(g.title).toUpperCase()}`.slice(0, 60);
  for (let n = 2; (await db.list('modules', m => m.moduleId === mid)).length; n++) mid = `${mid.replace(/-\d+$/, '')}-${n}`;
  await db.put('modules', { id: uid(), moduleId: mid, v: '1.0', status: 'draft', agentType: type, section: sec.id, title: g.title, purpose: g.purpose, topic: g.title, origin: 'extracted',
    rules: [{ id: 'R1', title: g.title, slot: sec.id, text: g.text }], requires: [...new Set((g.text.match(/\{\{\s*(\w+)\s*\}\}/g) || []).map(s => s.replace(/[{}\s]/g, '')))],
    params: [...new Set((g.text.match(/\[\[(\w+)\]\]/g) || []).map(s => s.slice(2, -2)))].map(p => ({ name: p, label: p.replace(/_/g, ' '), example: '' })),
    options: [], exits: [], policyDeps: [], tests: [], sourceAgents: agents, alternatives: members.filter(m => norm(m.text) !== norm(g.text)).map(m => ({ agent: m.agent, text: m.text })).slice(0, 12),
    owner: user.email, history: [{ at: now(), by: user.email, action: 'extracted', note: `From ${agents.map(a => a.name).join(', ')}` }] });
  return true;
}
async function runExtract(type, user) {
  const J = jobs[type];
  const sk = await skeletonOf(type);
  const agents = (await agentsOf(type)).filter(a => a.hasPrompt);
  J.total = agents.length + sk.sections.length; J.done = 0;
  const pool = [];
  for (const a of agents) {
    J.step = `Reading ${a.name}`;
    try { const t = await agentText(a.id); const out = await lt.extractRules({ skeleton: sk, agent: a.name, client: a.client, text: t.text }); out.rules.forEach(x => pool.push({ ...x, agent: a.name, agentId: a.id })); J.read++; }
    catch (e) { J.errors.push(`${a.name}: ${e.publicMessage || e.message}`); }
    J.done++;
  }
  for (const sec of sk.sections) {
    J.step = `Merging ${sec.title}`;
    const rules = pool.filter(x => x.section === sec.id);
    if (rules.length) {
      try { const { groups } = await lt.mergeSection({ section: sec, rules }); for (const g of groups) { if (await saveGroup(type, sk, sec, g, g.members.map(i => rules[i]), user)) J.created++; else J.updated++; } }
      catch (e) { J.errors.push(`${sec.title}: ${e.publicMessage || e.message}`); }
    }
    J.done++;
  }
  J.state = 'done'; J.step = ''; J.finishedAt = now();
  await audit(user, 'library.extract', { type, agents: J.read, created: J.created, updated: J.updated, errors: J.errors.length });
}
r.post('/library/:type/extract/start', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot do this.');
  const type = typeOf(req);
  if (jobs[type] && jobs[type].state === 'running') return res.json(jobs[type]);
  if (!(await skeletonOf(type))) throw fail(409, 'Confirm the structure (skeleton) first, so rules can be placed in its sections.');
  if (!(await agentsOf(type)).some(a => a.hasPrompt)) throw fail(409, 'No agent of this type has a prompt in the builder. Load the prompts from Sarvam first.');
  jobs[type] = { state: 'running', startedAt: now(), by: req.user.email, done: 0, total: 1, read: 0, created: 0, updated: 0, errors: [], step: 'Starting' };
  runExtract(type, req.user).catch(e => { Object.assign(jobs[type], { state: 'failed', error: e.publicMessage || e.message }); });
  res.json(jobs[type]);
}));
r.get('/library/:type/extract/status', h(async (req, res) => res.json(jobs[typeOf(req)] || { state: 'idle' })));

// ---------- library from documents (e.g. sales, where no agent exists yet) ----------
r.post('/library/:type/from-docs', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot do this.');
  const type = typeOf(req);
  const docs = (req.body || {}).docs;
  if (!Array.isArray(docs) || !docs.some(d => d && String(d.text || '').trim().length > 50)) throw fail(400, 'Add the client documents first.');
  const sk = await skeletonOf(type);
  const out = await lt.libraryFromDocs({ agentType: type, docs, skeleton: sk });
  let created = 0;
  if (sk) for (const sec of sk.sections) for (const x of out.rules.filter(y => y.section === sec.id)) { if (await saveGroup(type, sk, sec, { title: x.title, purpose: x.src ? `From ${x.src}` : '', text: x.text }, [{ agentId: `doc:${x.src}`, agent: x.src || 'documents', text: x.text }], req.user)) created++; }
  // Without a confirmed skeleton, the proposed structure and rules go back for review: rules are saved once it's confirmed.
  res.json({ skeleton: sk ? null : out.skeleton, rules: sk ? [] : out.rules, created, greeting: out.greeting, provider: out.provider });
}));
r.post('/library/:type/from-docs/save', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot do this.');
  const type = typeOf(req), sk = await skeletonOf(type);
  if (!sk) throw fail(409, 'Confirm the structure first.');
  let created = 0;
  for (const x of ((req.body || {}).rules || []).filter(y => y && y.text)) { const sec = sk.sections.find(s => s.id === x.section) || sk.sections[0]; if (await saveGroup(type, sk, sec, { title: x.title, purpose: x.src ? `From ${x.src}` : '', text: x.text }, [{ agentId: `doc:${x.src}`, agent: x.src || 'documents', text: x.text }], req.user)) created++; }
  res.json({ created });
}));

// ---------- New prompt ----------
// Start from a live agent: its prompt placed into the skeleton's sections (by headings; AI when headings don't match).
r.post('/library/:type/source', h(async (req, res) => {
  const type = typeOf(req), sk = await skeletonOf(type);
  if (!sk) throw fail(409, 'This agent type has no confirmed structure yet. Set it up on the Library page first.');
  const t = await agentText(String((req.body || {}).agentId || ''));
  const split = lt.splitBySkeleton(t.text, sk);
  const placed = Object.values(split.sections).flat().join('').length, total = t.text.length || 1;
  // One rule per paragraph, so each can be kept, refined or removed on its own.
  const paras = v => v.flatMap(x => x.split(/\n\s*\n/)).map(x => x.trim()).filter(Boolean);
  let sections = Object.fromEntries(Object.entries(split.sections).map(([k, v]) => [k, paras(v).map(text => ({ text, from: { agent: t.agent.name } }))])), via = 'headings';
  if (placed / total < 0.7) {
    try { const out = await lt.extractRules({ skeleton: sk, agent: t.agent.name, client: t.agent.client, text: t.text }); sections = Object.fromEntries(sk.sections.map(s => [s.id, out.rules.filter(x => x.section === s.id).map(x => ({ text: x.text, title: x.title, from: { agent: t.agent.name } }))])); via = 'ai'; }
    catch (e) { if (split.unplaced.length) sections[sk.sections[0].id] = [...(sections[sk.sections[0].id] || []), ...split.unplaced.map(text => ({ text, from: { agent: t.agent.name } }))]; }
  }
  res.json({ agent: { id: t.agent.id, name: t.agent.name }, greeting: t.greeting, sections, via, variables: t.variables });
}));

r.post('/library/:type/best', h(async (req, res) => {
  const type = typeOf(req), sk = await skeletonOf(type);
  if (!sk) throw fail(409, 'This agent type has no confirmed structure yet.');
  const info = (req.body || {}).info || {};
  const candidates = {};
  const add = (sec, c) => (candidates[sec] = candidates[sec] || []).push(c);
  (await entriesOf(type)).filter(m => m.section && (m.rules || []).length).forEach(m => add(m.section, { ref: `M:${m.id}`, title: m.title, purpose: m.purpose, text: m.rules.map(x => x.text).join('\n'), agents: (m.sourceAgents || []).map(a => a.name), status: m.status }));
  builtinsFor(type, sk, info).forEach(b => add(b.section, { ref: b.ref, title: b.title, purpose: `Built-in (${b.src})`, text: b.text, agents: [], status: 'approved' }));
  const out = await lt.bestModules({ skeleton: sk, info, candidates });
  res.json(out);
}));

// Refine: tailor one rule to this agent, and save the result to the library as a variant of its source.
r.post('/library/:type/refine', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot do this.');
  const type = typeOf(req);
  const { ref, text, title, section, info, note } = req.body || {};
  if (!String(text || '').trim()) throw fail(400, 'Nothing to refine.');
  const out = await lt.refineRule({ text, title, section, info, note });
  const parent = ref && String(ref).startsWith('M:') ? await db.get('modules', String(ref).slice(2)) : null;
  const base = parent ? parent.moduleId : `${type === 'sales' ? 'S' : 'C'}-${lt.slug(section || 'rule').toUpperCase()}-${lt.slug(title || 'rule').toUpperCase()}`.slice(0, 48);
  let mid = `${base}~${lt.slug((info && info.client) || 'variant').toUpperCase()}`.slice(0, 70);
  for (let n = 2; (await db.list('modules', m => m.moduleId === mid)).length; n++) mid = `${mid.replace(/-\d+$/, '')}-${n}`;
  const doc = await db.put('modules', { id: uid(), moduleId: mid, v: '1.0', status: 'draft', agentType: type, section: section || (parent && parent.section) || null,
    title: `${title || (parent && parent.title) || 'Rule'} · ${(info && info.client) || 'variant'}`.slice(0, 90), purpose: out.changes, topic: title || '', origin: 'refined',
    variantOf: parent ? { id: parent.id, moduleId: parent.moduleId, v: parent.v } : (ref && String(ref).startsWith('B:') ? { builtin: String(ref).slice(2) } : null),
    rules: [{ id: 'R1', title: title || 'Rule', slot: section || '', text: out.text }], options: [], params: [], requires: [], exits: [], policyDeps: [], tests: [], sourceAgents: [],
    refinedFor: { client: (info && info.client) || '', objective: (info && info.objective) || '' }, owner: req.user.email,
    history: [{ at: now(), by: req.user.email, action: 'refined', note: note ? String(note).slice(0, 300) : out.changes }] });
  await audit(req.user, 'library.refine', { type, from: ref || null, module: mid });
  res.json({ text: out.text, changes: out.changes, ref: `M:${doc.id}`, moduleId: mid, provider: out.provider });
}));

// Save: the Greeting plus the Instructions in the skeleton's order, as a draft version.
r.post('/library/:type/compose', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot create prompts.');
  const type = typeOf(req);
  const { name, info, greeting, sections, sourceAgentId } = req.body || {};
  if (!String(greeting || '').trim()) throw fail(400, 'Write the greeting first: Sarvam needs it.');
  const secs = (Array.isArray(sections) ? sections : []).map(s => ({ id: String(s.id), title: String(s.title || s.id), rules: (s.rules || []).map(x => String(x.text || '').trim()).filter(Boolean), refs: (s.rules || []).map(x => x.ref).filter(Boolean) })).filter(s => s.rules.length);
  if (!secs.length) throw fail(400, 'The instructions are empty.');
  const text = secs.map(s => `## ${s.title}\n\n${s.rules.join('\n\n')}`).join('\n\n');
  const imp = await ai.importPrompt(text, 'New prompt');
  const uses = [];
  for (const ref of secs.flatMap(s => s.refs)) { if (String(ref).startsWith('M:')) { const m = await db.get('modules', String(ref).slice(2)); if (m) uses.push({ moduleId: m.moduleId, moduleVersion: m.v, docId: m.id }); } else uses.push({ builtin: String(ref).slice(2) }); }
  const prompt = await db.put('prompts', { id: uid(), name: String(name || `${(info && info.client) || 'New'} · ${(info && info.agentName) || 'agent'}`).slice(0, 120), agentId: null, agentType: type, cfg: cfgFrom(info), info: info || {}, createdBy: req.user.email, sourceAgentId: sourceAgentId || null });
  const ver = await db.put('versions', { id: uid(), promptId: prompt.id, v: '1.0', status: 'draft', by: req.user.email, rev: 0, sections: imp.sections, order: imp.order, sarvamText: text, greeting: String(greeting).trim(),
    note: 'Built with New prompt', src: 'New prompt', usesModules: uses, skeletonSections: secs.map(s => s.id), history: [{ at: now(), by: req.user.email, action: 'created', note: `New prompt (${type})` }] });
  await db.put('prompts', { ...prompt, latestVersionId: ver.id });
  await audit(req.user, 'prompt.compose', { type, prompt: prompt.id, sections: secs.length, modules: uses.length });
  res.json({ promptId: prompt.id, versionId: ver.id, chars: text.length });
}));

module.exports = r;
