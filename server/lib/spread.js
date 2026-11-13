// Spreading a fix marked "every agent".
// 1. When it's applied, the fix goes into the library: as a new version of the library rule the changed
//    text came from (if this prompt used one), else as a new entry.
// 2. The approver sees the other agents of the same type (those using that rule or with the same
//    wording first) and picks which get it. Each picked agent gets a draft with the fix worked into its
//    own wording; nothing goes live without the usual approval.
const db = require('../db');
const core = require('../../shared/promptcore');
const mt = require('./moduleTasks');
const ai = require('./aiTasks');
const { agentText } = require('./agentText');
const { saveOnTop } = require('./versions');
const { uid, now, audit } = require('./util');

const norm = s => String(s || '').replace(/<!--.*?-->/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const slug = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'FIX';
const vnum = v => String(v).split('.').map(Number);
const bumpV = v => { const [a, b] = vnum(v); return `${a}.${(b || 0) + 1}`; };

// What the fix changed: runs of changed lines per section, as { sec, old, new }.
function changedPassages(before, after) {
  const out = [];
  for (const sec of Object.keys(after || {})) {
    const ops = core.lineDiff(String((before || {})[sec] || ''), String(after[sec] || ''));
    let cur = null;
    const flush = () => { if (cur && (cur.new.trim() || cur.old.trim())) out.push(cur); cur = null; };
    for (const [k, t] of ops) {
      if (/^<!--.*-->$/.test(String(t).trim())) continue;
      if (k === 'c') { flush(); continue; }
      cur = cur || { sec, old: '', new: '' };
      if (k === 'd') cur.old += (cur.old ? '\n' : '') + t; else cur.new += (cur.new ? '\n' : '') + t;
    }
    flush();
  }
  return out.filter(x => x.new.trim());
}

const typeOfPrompt = async p => p.agentType || ((p.agentId && (await db.get('agents', p.agentId)) || {}).agentType) || 'collections';

// Called when a fix marked "every agent" is applied. Returns { moduleDocId, moduleId, v, updated }.
async function recordSharedFix({ prompt, base, item, before, after, user }) {
  const passages = changedPassages(before, after);
  if (!passages.length) return null;
  const type = await typeOfPrompt(prompt);
  const agent = prompt.agentId ? await db.get('agents', prompt.agentId) : null;
  // The library rule the changed text came from, if this prompt used one.
  const used = new Set((base.usesModules || []).map(u => u.moduleId).filter(Boolean));
  let parent = null;
  if (used.size) {
    const mods = await db.list('modules', m => used.has(m.moduleId));
    for (const m of mods) if (passages.some(ps => ps.old && (m.rules || []).some(r => norm(r.text).includes(norm(ps.old)) || norm(ps.old).includes(norm(r.text))))) { if (!parent || vnum(m.v)[1] > vnum(parent.v)[1]) parent = m; }
  }
  const note = `Fix from ${agent ? agent.name : prompt.name}: ${String(item.text).slice(0, 160)}`;
  if (parent) {
    const all = await db.list('modules', m => m.moduleId === parent.moduleId);
    const top = all.reduce((a, m) => (vnum(m.v)[0] * 1000 + (vnum(m.v)[1] || 0) > vnum(a.v)[0] * 1000 + (vnum(a.v)[1] || 0) ? m : a), parent);
    const rules = (top.rules || []).map(r => { let t = r.text; passages.forEach(ps => { if (ps.old && t.includes(ps.old)) t = t.replace(ps.old, ps.new); }); return { ...r, text: t }; });
    const doc = await db.put('modules', { ...top, id: uid(), v: bumpV(top.v), status: 'draft', createdAt: undefined, approvedBy: null, approvedAt: null, runs: {}, rules, origin: 'fix',
      fromFix: { feedbackId: item.id, promptId: prompt.id, v: base.v, text: item.text }, history: [...(top.history || []), { at: now(), by: user.email, action: 'fixed', note }] });
    await audit(user, 'library.fix', { module: doc.moduleId, v: doc.v, from: prompt.id });
    return { moduleDocId: doc.id, moduleId: doc.moduleId, v: doc.v, updated: true, passages };
  }
  let mid = `${type === 'sales' ? 'S' : 'C'}-FIX-${slug(item.text)}`;
  for (let n = 2; (await db.list('modules', m => m.moduleId === mid)).length; n++) mid = `${mid.replace(/-\d+$/, '')}-${n}`;
  const sec = item.map && item.map.section;
  const doc = await db.put('modules', { id: uid(), moduleId: mid, v: '1.0', status: 'draft', agentType: type, section: sec || null, origin: 'fix',
    title: String(item.draft && item.draft.summary || item.text).slice(0, 90), purpose: String(item.text).slice(0, 300), topic: String(item.text).slice(0, 300),
    rules: passages.map((ps, i) => ({ id: `R${i + 1}`, title: `Fix ${i + 1}`, slot: ps.sec, text: ps.new })), options: [], params: [], requires: [], exits: [], policyDeps: [], tests: [],
    sourceAgents: agent ? [{ id: agent.id, name: agent.name }] : [], fromFix: { feedbackId: item.id, promptId: prompt.id, v: base.v, text: item.text, old: passages.map(ps => ps.old).filter(Boolean) },
    owner: user.email, history: [{ at: now(), by: user.email, action: 'fixed', note }] });
  await audit(user, 'library.fix', { module: mid, from: prompt.id });
  return { moduleDocId: doc.id, moduleId: mid, v: '1.0', updated: false, passages };
}

// The other agents of the same type, the likeliest first.
async function candidates(item) {
  const prompt = await db.get('prompts', item.promptId);
  const type = await typeOfPrompt(prompt);
  const mod = item.spread && await db.get('modules', item.spread.moduleDocId);
  const olds = (item.spread && item.spread.passages || []).map(ps => norm(ps.old)).filter(x => x.length > 12);
  const [agents, prompts, versions] = await Promise.all([db.list('agents'), db.list('prompts'), db.list('versions')]);
  const out = [];
  for (const a of agents.filter(x => (x.agentType || 'collections') === type && x.id !== prompt.agentId)) {
    const p = prompts.find(x => x.agentId === a.id); if (!p) continue;
    const vs = versions.filter(v => v.promptId === p.id).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    const latest = vs[vs.length - 1]; if (!latest) continue;
    const text = norm(latest.sarvamText || Object.values(latest.sections || {}).join('\n'));
    const usesRule = !!(mod && (latest.usesModules || []).some(u => u.moduleId === mod.moduleId));
    const sameWording = olds.some(o => text.includes(o));
    const done = (item.spread.done || {})[a.id];
    out.push({ id: a.id, name: a.name, client: a.client || '', usesRule, sameWording, done: done || null });
  }
  return out.sort((x, y) => (y.usesRule + y.sameWording) - (x.usesRule + x.sameWording) || x.name.localeCompare(y.name));
}

// Apply the fix to the chosen agents, one at a time (background job; progress in jobs[itemId]).
const jobs = {};
async function run(item, agentIds, user) {
  const J = jobs[item.id];
  const mod = await db.get('modules', item.spread.moduleDocId);
  const rules = (mod.rules || []).map(r => ({ id: r.id, title: r.title, slot: r.slot, text: r.text }));
  for (const id of agentIds) {
    const res = { id, at: now() };
    try {
      const a = await agentText(id);
      res.name = a.agent.name;
      const loc = await mt.moduleLocate(a.text, rules, { topic: item.text, variables: a.variables });
      const edits = loc.edits.filter(e => e.action !== 'skip' && e.ok);
      if (!edits.length) { res.result = loc.edits.some(e => e.action === 'skip') ? 'already has it' : 'nothing to change'; }
      else {
        const out = ai.applyEdits(a.text, edits.map(e => ({ old_text: e.old_text, new_text: e.new_text })));
        const newText = out.text.replace(/\n{3,}/g, '\n\n').trim();
        const imp = await ai.resplit(newText, a.base, 'Spread fix');
        const uses = [...(a.base.usesModules || []).filter(u => u.moduleId !== mod.moduleId), { moduleId: mod.moduleId, moduleVersion: mod.v, docId: mod.id }];
        const what = `Fix spread from ${item.spread.fromName || 'another agent'}: ${String(item.text).slice(0, 100)}`;
        const { ver } = await saveOnTop(a.prompt, a.base, { sections: imp.sections, order: imp.order, ...(imp.titles ? { titles: imp.titles } : {}), note: what, src: 'Spread fix', sarvamText: newText, sourceChunks: null,
          ...(a.base.greeting ? { greeting: a.base.greeting } : {}), usesModules: uses }, user, what);
        res.result = 'draft'; res.v = ver.v; res.promptId = a.prompt.id; res.edits = edits.length;
      }
    } catch (e) { res.result = 'failed'; res.error = e.publicMessage || e.message; }
    J.results.push(res); J.done++;
    const fresh = await db.get('feedback', item.id);
    if (fresh && fresh.spread) { fresh.spread.done = { ...(fresh.spread.done || {}), [id]: res }; await db.put('feedback', fresh); }
  }
  J.state = 'done'; J.finishedAt = now();
  await audit(user, 'fix.spread', { item: item.id, module: mod.moduleId, agents: agentIds.length, drafts: J.results.filter(r => r.result === 'draft').length });
}

module.exports = { changedPassages, recordSharedFix, candidates, run, jobs };
