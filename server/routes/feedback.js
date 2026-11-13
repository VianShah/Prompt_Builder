const express = require('express');
const db = require('../db');
const ai = require('../lib/aiTasks');
const core = require('../../shared/promptcore');
const pushLib = require('../lib/sarvamPush');
const { can } = require('../auth');
const { uid, now, h, fail, audit, bump, clone } = require('../lib/util');

const r = express.Router();
const kind = require('../lib/agentKind');
// Load a prompt and note its agent type (collections / sales) for the AI instructions.
const getPrompt = async id => { const p = await db.get('prompts', id); if (p) await kind.fromPrompt(p); return p; };
async function latestVersion(promptId) {
  const vs = (await db.list('versions', v => v.promptId === promptId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!vs.length) throw fail(409, 'This prompt has no versions yet.');
  return vs[vs.length - 1];
}
const { saveOnTop } = require('../lib/versions');
// Prompt length in Sarvam before (version v) and after (v with these sections).
async function lengths(p, v, sections) {
  const live = (await db.list('versions', x => x.promptId === p.id && x.status === 'live'))[0];
  const cur = pushLib.sarvamTextFor(live, v);
  const ref = v.sarvamText ? v : live;
  const next = pushLib.deriveText(ref, sections, v.order);
  return { before: cur ? cur.text.length : null, after: next ? next.text.length : null };
}
// A drafted fix is out of date when a section it changes no longer reads as it did when drafted.
const draftStale = (d, base) => d.before ? Object.entries(d.before).some(([s, t]) => (base.sections[s] || '') !== t) : d.baseVersionId !== base.id;
const carrySettings = base => (base && base.configPatch && base.status !== 'live' ? { configPatch: base.configPatch, configSummary: base.configSummary || [] } : {});
async function loadItem(id) { const it = await db.get('feedback', id); if (!it) throw fail(404, 'Feedback item not found.'); return it; }

r.get('/prompts/:id/feedback', h(async (req, res) => {
  res.json({ items: await db.list('feedback', f => f.promptId === req.params.id) });
}));

r.post('/prompts/:id/feedback', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot add feedback.');
  const p = await getPrompt(req.params.id);
  if (!p) throw fail(404, 'Prompt not found.');
  const { items, raw, source } = req.body || {};
  const texts = Array.isArray(items) ? items.map(String) : core.splitFeedback(raw || '');
  if (!texts.length) throw fail(400, 'No feedback items found.');
  const out = [];
  for (const t of texts.slice(0, 200)) out.push(await db.put('feedback', { id: uid(), promptId: p.id, text: t.slice(0, 2000), source: source || 'UAT', status: 'new', by: req.user.email }));
  await audit(req.user, 'feedback.add', { prompt: p.id, count: out.length });
  res.json({ added: out.length });
}));

r.post('/prompts/:id/feedback/map', h(async (req, res) => {
  const p = await getPrompt(req.params.id);
  if (!p) throw fail(404, 'Prompt not found.');
  const v = await latestVersion(p.id);
  const items = (await db.list('feedback', f => f.promptId === p.id && f.status === 'new')).slice(0, 40);
  if (!items.length) return res.json({ mapped: 0 });
  const maps = await ai.mapFeedback(p, v, items);
  for (let i = 0; i < items.length; i++) await db.put('feedback', { ...items[i], map: maps[i], status: 'mapped', mappedAgainst: v.v });
  res.json({ mapped: items.length, via: maps[0] && maps[0].via, provider: maps[0] && maps[0].provider, fallbackReason: maps[0] && maps[0].fallbackReason });
}));

r.patch('/feedback/:id', h(async (req, res) => {
  const it = await loadItem(req.params.id);
  const { status, section, promote, removeGuidance, scope } = req.body || {};
  // Who the fix is for: this agent only, or every agent (logged as a shared fix when applied).
  if (scope && it.map && ['client', 'shared'].includes(scope)) { it.map = { ...it.map, scope }; if (scope === 'shared' && it.promote === undefined) it.promote = true; }
  if (removeGuidance != null && Array.isArray(it.guidance)) it.guidance = it.guidance.filter((_, i) => i !== Number(removeGuidance));
  if (status && ['mapped', 'dismissed', 'new'].includes(status)) it.status = status;
  if (promote !== undefined) it.promote = !!promote;
  if (section && it.map) {
    const v = await latestVersion(it.promptId);
    const tags = core.blockTags(v.sections[section] || '');
    it.map = { ...it.map, section, block: tags[0] ? tags[0].id : '', layer: tags[0] ? tags[0].layer : it.map.layer };
    it.draft = null;
  }
  await db.put('feedback', it);
  res.json(it);
}));

// ---- Regression tests: every fixed issue becomes a test that is re-run before a push ----
r.get('/prompts/:id/tests', h(async (req, res) => res.json({ items: await db.list('tests', t => t.promptId === req.params.id) })));

// Make tests for fixed (and waiting) feedback that doesn't have one yet.
r.post('/prompts/:id/tests/build', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot add tests.');
  const p = await getPrompt(req.params.id);
  if (!p) throw fail(404, 'Prompt not found.');
  const have = new Set((await db.list('tests', t => t.promptId === p.id)).map(t => t.feedbackId));
  const items = (await db.list('feedback', f => f.promptId === p.id && ['applied', 'mapped'].includes(f.status) && !have.has(f.id))).slice(0, 15);
  if (!items.length) return res.json({ added: 0 });
  const made = await ai.buildTests(items.map(f => ({ text: f.text, fix: f.map && f.map.fix, notes: (f.guidance || []).map(g => g.text), excerpt: f.call && f.call.excerpt })));
  let added = 0;
  for (const t of made) {
    const f = items[t.item - 1]; if (!f) continue;
    await db.put('tests', { id: uid(), promptId: p.id, feedbackId: f.id, title: t.title || f.text.slice(0, 60), customer: t.customer, expect: t.expect, avoid: t.avoid, by: req.user.email, runs: {} });
    added++;
  }
  res.json({ added });
}));

r.delete('/tests/:id', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot remove tests.');
  await db.del('tests', req.params.id);
  res.json({ ok: true });
}));

// Run every test against one version (default: the latest). Simulated with the AI model playing the
// agent with that version's exact prompt, so it works on drafts before anything is pushed.
r.post('/prompts/:id/tests/run', h(async (req, res) => {
  const p = await getPrompt(req.params.id);
  if (!p) throw fail(404, 'Prompt not found.');
  const versions = (await db.list('versions', x => x.promptId === p.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const live = versions.find(x => x.status === 'live');
  const v = versions.find(x => x.id === (req.body || {}).versionId) || versions[versions.length - 1];
  const t = pushLib.sarvamTextFor(live, v);
  const text = t ? t.text : core.toMarkdown(core.header(p.cfg, v.v), v.order, v.sections, false);
  const greeting = v.greeting || ((v.sarvamMeta || (live && live.sarvamMeta) || {}).greeting) || '';
  const tests = (await db.list('tests', x => x.promptId === p.id)).slice(0, 20);
  if (!tests.length) throw fail(400, 'No tests yet. Make tests from fixed feedback first.');
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const results = [];
  for (let i = 0; i < tests.length; i += 3) { // three at a time
    results.push(...await Promise.all(tests.slice(i, i + 3).map(async x => {
      try { return { x, r: await ai.runTest(text, greeting, x, today) }; } catch (e) { return { x, r: { pass: null, why: e.message, replies: [] } }; }
    })));
  }
  for (const { x, r: rr } of results) await db.put('tests', { ...x, runs: { ...(x.runs || {}), [v.id]: { pass: rr.pass, why: rr.why, replies: rr.replies, at: now(), v: v.v, rev: v.rev || 0 } } });
  const passed = results.filter(x => x.r.pass === true).length, failed = results.filter(x => x.r.pass === false).length;
  await db.put('versions', { ...(await db.get('versions', v.id)), tests: { passed, failed, total: results.length, at: now(), rev: v.rev || 0 } });
  res.json({ v: v.v, passed, failed, errors: results.length - passed - failed });
}));

// ---- A whole call transcript from UAT: what went wrong ----
// Read against a chosen version of the prompt (default: the live one, which is what calls use).
r.post('/prompts/:id/transcript/analyze', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot add feedback.');
  const p = await getPrompt(req.params.id);
  if (!p) throw fail(404, 'Prompt not found.');
  const transcript = String((req.body || {}).transcript || '').trim();
  if (transcript.length < 80) throw fail(400, 'Paste or upload the whole call transcript (at least a few lines).');
  const versions = (await db.list('versions', x => x.promptId === p.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const live = versions.find(x => x.status === 'live');
  const v = versions.find(x => x.id === (req.body || {}).versionId) || live || versions[versions.length - 1];
  if (!v) throw fail(409, 'This prompt has no versions yet.');
  const t = pushLib.sarvamTextFor(live, v);
  const text = t ? t.text : core.toMarkdown(core.header(p.cfg, v.v), v.order, v.sections, false);
  const out = await ai.analyzeTranscript(p, v, { text, transcript, note: String((req.body || {}).note || '').slice(0, 1000) });
  res.json({ ...out, versionId: v.id, versionV: v.v, sarvamVersion: v.sarvamVersion || null });
}));

// Add the mistakes the reviewer ticked as feedback items, already diagnosed and ready to draft.
r.post('/prompts/:id/transcript/add', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot add feedback.');
  const p = await getPrompt(req.params.id);
  if (!p) throw fail(404, 'Prompt not found.');
  const { mistakes, label, versionV, provider } = req.body || {};
  const list = (Array.isArray(mistakes) ? mistakes : []).filter(m => m && m.what).slice(0, 12);
  if (!list.length) throw fail(400, 'Tick at least one mistake to add.');
  const latest = await latestVersion(p.id);
  const cut = (s, n) => String(s || '').slice(0, n);
  const out = [];
  for (const m of list) {
    const section = latest.order.includes(m.section) ? m.section : latest.order[0];
    out.push(await db.put('feedback', { id: uid(), promptId: p.id, text: cut(m.what, 600), source: 'UAT transcript', status: 'mapped', by: req.user.email, mappedAgainst: latest.v,
      map: { section, block: cut(m.block, 80), layer: cut(m.layer, 4) || 'L6', type: cut(m.type, 30) || 'behaviour', severity: ['high', 'medium', 'low'].includes(m.severity) ? m.severity : 'medium',
        scope: m.scope === 'shared' ? 'shared' : 'client', what: cut(m.what, 600), cause: cut(m.cause, 20), quotes: (Array.isArray(m.quotes) ? m.quotes : []).slice(0, 2).map(q => ({ text: cut(q.text, 1500), found: !!q.found })),
        diagnosis: cut(m.why, 1500), fix: cut(m.fix, 1500), via: 'ai', provider: cut(provider, 80), diagnosedOn: versionV ? `v${cut(versionV, 12)}` : '' },
      call: { upload: true, label: cut(label, 120), turn: 1, excerpt: [...(m.customer ? [{ i: 0, role: 'user', text: cut(m.customer, 600) }] : []), { i: 1, role: 'agent', text: cut(m.moment, 600) }] } }));
  }
  await audit(req.user, 'transcript.add', { prompt: p.id, items: out.length });
  res.json({ added: out.length });
}));

// Remove a feedback item for good (a mistake, a duplicate, or no longer relevant). A fix already
// applied stays in its version; only the feedback record and its notes go.
r.delete('/feedback/:id', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot remove feedback.');
  const it = await loadItem(req.params.id);
  await db.del('feedback', it.id);
  await audit(req.user, 'feedback.delete', { item: it.id, prompt: it.promptId, status: it.status, text: it.text.slice(0, 200) });
  res.json({ ok: true });
}));

r.post('/feedback/:id/draft', h(async (req, res) => {
  const it = await loadItem(req.params.id);
  if (!it.map) throw fail(409, 'Map this item to a section first.');
  const p = await getPrompt(it.promptId);
  const v = await latestVersion(it.promptId);
  // Reviewer notes: extra details or corrections the AI must build into the fix. Kept on the item,
  // so every later draft (including a batch fix) uses all of them.
  // guidance: the reviewer's own note (string), and/or suggestions they ticked from "Check this fix" (list).
  const g = (req.body || {}).guidance;
  const fresh = (Array.isArray(g) ? g : [g]).map(x => typeof x === 'object' && x ? x : { text: x }).map(x => ({ text: String(x.text || '').trim().slice(0, 3000), from: x.from === 'check' ? 'check' : 'you' })).filter(x => x.text);
  const note = fresh.length > 0;
  if (note) it.guidance = [...(it.guidance || []), ...fresh.map(x => ({ ...x, at: now(), by: req.user.email }))];
  let d;
  try { d = await ai.draftFix(p, v, it); }
  catch (e) { if (note) await db.put('feedback', it); throw e; } // keep the notes even if this draft failed
  // What the touched sections looked like when drafted: the fix can still be applied later as long as
  // those sections haven't changed, even if other fixes were added to the draft meanwhile.
  const before = {}; Object.keys(d.sections || { [it.map.section]: 1 }).forEach(s => { before[s] = v.sections[s] || ''; });
  const len = await lengths(p, v, { ...v.sections, ...(d.sections || { [it.map.section]: d.revised }) });
  it.draft = { ...d, before, charsBefore: len.before, charsAfter: len.after, baseVersionId: v.id, baseV: v.v, at: now() };
  if (it.check) it.prevCheck = it.check; // the check was of the old draft
  it.check = null;
  await db.put('feedback', it);
  res.json(it);
}));

// Edit or undo one part of a drafted fix: the client sends the section's new text (line breaks as
// "\n"); the change is re-applied onto the drafted text so untouched lines keep their exact endings.
function keepLineEnds(orig, typed) {
  const CR = String.fromCharCode(13);
  const flat = orig.split(CR).join('');
  if (flat === typed) return orig;
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let text = orig;
  for (const e of pushLib.textEdits(flat, typed)) {
    const m = text.match(new RegExp(e.old_text.split('\n').map(escRe).join('\\r?\\n')));
    if (!m) return typed;
    const nl = m[0].includes(CR + '\n') ? CR + '\n' : '\n';
    text = text.slice(0, m.index) + e.new_text.split('\n').join(nl) + text.slice(m.index + m[0].length);
  }
  return text;
}
r.patch('/feedback/:id/draft', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot change fixes.');
  const it = await loadItem(req.params.id);
  if (!it.draft) throw fail(409, 'There is no drafted fix to change.');
  const p = await getPrompt(it.promptId);
  const v = await latestVersion(it.promptId);
  if (draftStale(it.draft, v)) throw fail(409, 'The prompt changed since this fix was drafted. Draft it again.', 'stale_draft');
  const { section, text } = req.body || {};
  const sections = { ...(it.draft.sections || { [it.map.section]: it.draft.revised }) };
  if (!section || sections[section] == null || typeof text !== 'string') throw fail(400, 'That part of the fix was not found.');
  const next = keepLineEnds(sections[section], text.split(String.fromCharCode(13)).join(''));
  const base = v.sections[section] || '';
  if (next.trim() === base.trim()) delete sections[section]; else sections[section] = next.trim();
  if (!Object.keys(sections).length) { it.draft = null; it.check = null; await db.put('feedback', it); return res.json(it); } // everything undone
  const len = await lengths(p, v, { ...v.sections, ...sections });
  it.draft = { ...it.draft, sections, revised: sections[it.map.section] != null ? sections[it.map.section] : base, changedSections: Object.keys(sections),
    charsBefore: len.before, charsAfter: len.after, editedByHand: true, editedAt: now() };
  if (it.check) it.prevCheck = it.check;
  it.check = null; // the check was of the earlier wording
  await db.put('feedback', it);
  res.json(it);
}));

// "Check this fix": a second AI read of the drafted fix. Walks customer cases through the changed
// prompt and turns each problem into a suggestion the reviewer can tick and redraft with.
r.post('/feedback/:id/check', h(async (req, res) => {
  const it = await loadItem(req.params.id);
  if (!it.draft) throw fail(409, 'Draft a fix first, then check it.');
  const p = await getPrompt(it.promptId);
  const v = await latestVersion(it.promptId);
  if (draftStale(it.draft, v)) throw fail(409, 'The prompt changed since this fix was drafted. Draft it again, then check.', 'stale_draft');
  const c = await ai.critiqueFix(p, v, it);
  it.check = { ...c, at: now(), draftAt: it.draft.at };
  await db.put('feedback', it);
  res.json(it);
}));

// Apply a drafted or hand-edited section as a new draft version built on the latest version.
r.post('/feedback/:id/apply', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot change prompts.');
  const it = await loadItem(req.params.id);
  if (!it.map) throw fail(409, 'Map this item to a section first.');
  const p = await getPrompt(it.promptId);
  const base = await latestVersion(it.promptId);
  const text = typeof (req.body || {}).text === 'string' ? req.body.text : (it.draft && it.draft.revised);
  if (!text) throw fail(400, 'Nothing to apply. Draft a fix or edit the section first.');
  if (it.draft && !req.body.text && draftStale(it.draft, base)) throw fail(409, `The part of the prompt this fix changes was edited after it was drafted (now v${base.v}). Click Draft again; your notes are kept.`, 'stale_draft');
  const sec = it.map.section;
  const sections = clone(base.sections);
  // A drafted fix may change lines in several sections; a hand edit changes the mapped section only.
  if (!req.body.text && it.draft && it.draft.sections) Object.assign(sections, it.draft.sections);
  else { if ((base.sections[sec] || '') === text) throw fail(400, 'That text is the same as the current section.'); sections[sec] = text; }
  const note = (req.body && req.body.note) || (it.draft && !req.body.text ? it.draft.summary : 'Edited by hand: ' + it.text.slice(0, 90));
  // Carry the full Sarvam text forward: the base's text with only this section's passages changed.
  const ref = base.sarvamText ? base : (await db.list('versions', x => x.promptId === p.id && x.status === 'live'))[0];
  const st = pushLib.deriveText(ref, sections, base.order);
  const charsBefore = (await lengths(p, base, base.sections)).before;
  const { ver, updated } = await saveOnTop(p, base, { sections, order: base.order, note, src: it.source, sec, feedbackIds: [it.id],
    sarvamText: st ? st.text : null, sourceChunks: st ? st.sourceChunks : null, ...(base.greeting ? { greeting: base.greeting } : {}), ...carrySettings(base) },
    req.user, `Fix from feedback: ${it.text.slice(0, 120)}`);
  it.status = 'applied'; it.appliedIn = ver.v; it.appliedVersionId = ver.id;
  if (it.map.scope === 'shared' && it.promote !== false) {
    it.promoted = true;
    await db.put('coreChanges', { id: uid(), block: it.map.block, sec, note, feedback: it.text, from: p.name, v: ver.v, by: req.user.email, status: 'to merge into shared blocks' });
  }
  await db.put('feedback', it);
  await audit(req.user, 'feedback.apply', { item: it.id, version: ver.v, updated });
  res.json({ versionId: ver.id, v: ver.v, updated, charsBefore, charsAfter: st ? st.text.length : null });
}));

// Fix several feedback items in ONE new version: each fix is drafted on top of the previous ones, so
// two items in the same section don't overwrite each other. Items already drafted on the latest
// version and in different sections keep their draft; the rest are drafted now.
r.post('/prompts/:id/feedback/apply-batch', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot change prompts.');
  const p = await getPrompt(req.params.id);
  if (!p) throw fail(404, 'Prompt not found.');
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(String) : [];
  const items = (await Promise.all(ids.map(id => db.get('feedback', id)))).filter(it => it && it.promptId === p.id && it.status === 'mapped' && it.map);
  if (items.length < 1) throw fail(400, 'Pick at least one item to fix.');
  if (items.length > 12) throw fail(400, 'Fix at most 12 items in one version, so the change stays reviewable.');
  const base = await latestVersion(p.id);
  const sections = clone(base.sections);
  const done = [], failed = [];
  for (const it of items) {
    const sec = it.map.section;
    try {
      // Reuse a draft only if nothing it touches has been changed by an earlier fix in this batch.
      const touched = it.draft && (it.draft.sections ? Object.keys(it.draft.sections) : [sec]);
      const reuse = it.draft && touched.every(s => sections[s] === (it.draft.before ? it.draft.before[s] : it.draft.baseVersionId === base.id ? base.sections[s] : null));
      const d = reuse ? it.draft : await ai.draftFix(p, { ...base, sections }, it);
      const changed = d.sections || { [sec]: d.revised };
      if (!Object.keys(changed).length || Object.entries(changed).every(([s, t]) => t === sections[s])) throw new Error('No change was drafted.');
      Object.assign(sections, changed);
      done.push({ it, summary: d.summary });
    } catch (e) { failed.push({ id: it.id, text: it.text.slice(0, 80), error: e.message }); }
  }
  if (!done.length) throw fail(502, `No fix could be drafted: ${failed.map(f => f.error).join('; ')}`);
  const ref = base.sarvamText ? base : (await db.list('versions', x => x.promptId === p.id && x.status === 'live'))[0];
  const st = pushLib.deriveText(ref, sections, base.order);
  const note = String((req.body || {}).note || '').trim() || `${done.length} fix${done.length > 1 ? 'es' : ''} from ${[...new Set(done.map(d => d.it.source))].join(' and ').toLowerCase()}: ${done.map(d => d.summary).join(' ')}`.slice(0, 600);
  const charsBefore = (await lengths(p, base, base.sections)).before;
  const { ver, updated } = await saveOnTop(p, base, { sections, order: base.order, note, src: 'Feedback batch', feedbackIds: done.map(d => d.it.id),
    fixes: done.map(d => ({ id: d.it.id, text: d.it.text.slice(0, 200), section: d.it.map.section, summary: d.summary, call: d.it.call ? { iid: d.it.call.iid, turn: d.it.call.turn } : null })),
    sarvamText: st ? st.text : null, sourceChunks: st ? st.sourceChunks : null, ...(base.greeting ? { greeting: base.greeting } : {}), ...carrySettings(base) },
    req.user, `Fixes ${done.length} feedback item${done.length > 1 ? 's' : ''}`);
  for (const { it, summary } of done) {
    it.status = 'applied'; it.appliedIn = ver.v; it.appliedVersionId = ver.id;
    if (it.map.scope === 'shared' && it.promote !== false) { it.promoted = true; await db.put('coreChanges', { id: uid(), block: it.map.block, sec: it.map.section, note: summary, feedback: it.text, from: p.name, v: ver.v, by: req.user.email, status: 'to merge into shared blocks' }); }
    await db.put('feedback', it);
  }
  await audit(req.user, 'feedback.apply_batch', { prompt: p.id, version: ver.v, items: done.length, failed: failed.length });
  res.json({ versionId: ver.id, v: ver.v, updated, applied: done.length, failed, charsBefore, charsAfter: st ? st.text.length : null });
}));

module.exports = r;
