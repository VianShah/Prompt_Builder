const express = require('express');
const db = require('../db');
const pushLib = require('../lib/sarvamPush');
const core = require('../../shared/promptcore');
const { can } = require('../auth');
const config = require('../config');
const ai = require('../lib/aiTasks');
const { uid, now, h, fail, audit, bump } = require('../lib/util');

const { saveOnTop } = require('../lib/versions');
const r = express.Router();
const kind = require('../lib/agentKind');
const sortV = vs => vs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

async function loadPrompt(id) {
  const p = await db.get('prompts', id);
  if (!p) throw fail(404, 'Prompt not found.');
  await kind.fromPrompt(p); // collections or sales, for the AI instructions
  return p;
}
const strip = v => { const { sections, ...rest } = v; return rest; };
// Settings changes (variables, languages, voice) not yet live travel with every later version.
const carrySettings = base => (base && base.configPatch && base.status !== 'live' ? { configPatch: base.configPatch, configSummary: base.configSummary || [] } : {});

r.get('/prompts', h(async (req, res) => {
  const [prompts, versions, agents] = await Promise.all([db.list('prompts'), db.list('versions'), db.list('agents')]);
  res.json({ prompts: prompts.map(p => {
    const vs = sortV(versions.filter(v => v.promptId === p.id));
    const latest = vs[vs.length - 1], live = vs.find(v => v.status === 'live');
    return { id: p.id, name: p.name, agentId: p.agentId, agent: agents.find(a => a.id === p.agentId) || null, createdAt: p.createdAt,
      latest: latest ? strip(latest) : null, live: live ? strip(live) : null, versionCount: vs.length,
      pending: vs.filter(v => v.status === 'pending').length };
  }) });
}));

// Create from the builder wizard.
r.post('/prompts', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot create prompts.');
  const { name, cfg, sections, order, version, agentId } = req.body || {};
  if (!cfg || !sections || !Array.isArray(order)) throw fail(400, 'Missing prompt content.');
  const p = await db.put('prompts', { id: uid(), name: name || 'Untitled', agentId: agentId || null, cfg, createdBy: req.user.email });
  const v = await db.put('versions', { id: uid(), promptId: p.id, v: version || '1.0', sections, order, note: 'Created in the builder', src: 'Builder', by: req.user.email, status: 'draft', history: [{ at: now(), by: req.user.email, action: 'created' }] });
  await db.put('prompts', { ...p, latestVersionId: v.id });
  await audit(req.user, 'prompt.create', { prompt: p.id, version: v.v });
  res.json({ promptId: p.id, versionId: v.id });
}));

r.get('/prompts/:id', h(async (req, res) => {
  const p = await loadPrompt(req.params.id);
  const versions = sortV(await db.list('versions', v => v.promptId === p.id));
  const agent = p.agentId ? await db.get('agents', p.agentId) : null;
  // Each version's length as it reads (or will read) in Sarvam: instructions and greeting.
  const live = versions.find(v => v.status === 'live');
  const withChars = versions.map(v => {
    const t = pushLib.sarvamTextFor(live, v);
    const text = t ? t.text : core.toMarkdown(core.header(p.cfg, v.v), v.order, v.sections, false).trim();
    const greeting = v.greeting || ((v.sarvamMeta || (live && live.sarvamMeta) || {}).greeting) || '';
    return { ...v, chars: text.length, greetingChars: greeting.length };
  });
  res.json({ prompt: p, versions: withChars, agent });
}));

r.patch('/prompts/:id', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot edit prompts.');
  const p = await loadPrompt(req.params.id);
  const { name, agentId } = req.body || {};
  if (name) p.name = String(name).slice(0, 120);
  if (agentId !== undefined) p.agentId = agentId || null;
  await db.put('prompts', p);
  // A prompt built for a type (e.g. sales) makes its agent that type, so the agent joins that library.
  if (p.agentId && p.agentType) { const a = await db.get('agents', p.agentId); if (a && a.agentType !== p.agentType) await db.put('agents', { ...a, agentType: p.agentType }); }
  res.json({ ok: true });
}));

r.get('/versions/:vid/markdown', h(async (req, res) => {
  const v = await db.get('versions', req.params.vid);
  if (!v) throw fail(404, 'Version not found.');
  const p = await loadPrompt(v.promptId);
  const md = core.toMarkdown(core.header(p.cfg, v.v), v.order, v.sections, req.query.tags !== '0');
  res.type('text/markdown').send(md);
}));

// The prompt as it is (live) or will be (any other version) in Sarvam: original text and order,
// plus the agent's greeting, variables and languages from the live version.
r.get('/versions/:vid/sarvam-text', h(async (req, res) => {
  const v = await db.get('versions', req.params.vid);
  if (!v) throw fail(404, 'Version not found.');
  const live = (await db.list('versions', x => x.promptId === v.promptId && x.status === 'live'))[0];
  const t = pushLib.sarvamTextFor(live, v);
  const meta = (v.sarvamMeta || (live && live.sarvamMeta)) || null;
  res.json({ text: t ? t.text : null, exact: t ? t.exact : false, edits: t ? t.edits || 0 : 0, liveSarvamVersion: live ? live.sarvamVersion : null, meta,
    greeting: v.greeting || (meta && meta.greeting) || '', greetingChanged: !!(v.greeting && meta && v.greeting.trim() !== (meta.greeting || '').trim()) });
}));

// Edit the prompt text (and greeting) by hand: saved as a new draft version on top of the latest.
// The text is the full prompt as it reads in Sarvam; it is regrouped into sections again so feedback
// can still be traced, but the text itself is kept exactly as typed.
r.post('/prompts/:id/edit', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot change prompts.');
  const p = await loadPrompt(req.params.id);
  const vs = sortV(await db.list('versions', x => x.promptId === p.id));
  const base = vs[vs.length - 1];
  if (!base) throw fail(409, 'This prompt has no versions yet.');
  const live = vs.find(x => x.status === 'live');
  const CR = String.fromCharCode(13);
  const typed = String((req.body || {}).text || '').split(CR).join('');
  const greeting = typeof (req.body || {}).greeting === 'string' ? req.body.greeting.trim() : null;
  if (typed.trim().length < 20) throw fail(400, 'The prompt text is empty.');
  const cur = pushLib.sarvamTextFor(live, base);
  const curText = cur ? cur.text : core.toMarkdown(core.header(p.cfg, base.v), base.order, base.sections, false).trim();
  // Browsers turn every line break in a text box into "\n". Some Sarvam prompts use "\r\n", so the
  // typed changes are applied onto the original text: untouched parts keep their exact line breaks.
  const flat = curText.split(CR).join('');
  let text = curText;
  if (typed.trim() !== flat.trim()) {
    const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const e of pushLib.textEdits(flat, typed)) {
      const m = text.match(new RegExp(e.old_text.split('\n').map(escRe).join('\\r?\\n')));
      if (!m) { text = typed; break; }
      const nl = m[0].includes(CR + '\n') ? CR + '\n' : '\n';
      text = text.slice(0, m.index) + e.new_text.split('\n').join(nl) + text.slice(m.index + m[0].length);
    }
    if (!flat.trim()) text = typed.trim();
  }
  const curGreeting = base.greeting || (((base.sarvamMeta || (live && live.sarvamMeta)) || {}).greeting) || '';
  const textChanged = text !== curText, greetChanged = greeting != null && greeting !== curGreeting.trim();
  if (!textChanged && !greetChanged) throw fail(400, 'Nothing changed.');
  const imp = textChanged ? await ai.resplit(text, base, 'Edited by hand') : { sections: base.sections, order: base.order };
  const what = [textChanged && 'prompt text', greetChanged && 'greeting'].filter(Boolean).join(' and ');
  const note = String((req.body || {}).note || '').trim() || `Edited ${what} by hand`;
  const { ver, updated } = await saveOnTop(p, base, { sections: imp.sections, order: imp.order, ...(imp.titles ? { titles: imp.titles } : {}), note, src: 'Hand edit',
    sarvamText: text, sourceChunks: null, ...(greetChanged ? { greeting } : base.greeting ? { greeting: base.greeting } : {}), ...carrySettings(base) }, req.user, note);
  await audit(req.user, 'prompt.edit', { prompt: p.id, version: ver.v, text: textChanged, greeting: greetChanged, updated });
  res.json({ versionId: ver.id, v: ver.v, updated, charsBefore: curText.length, charsAfter: text.length });
}));

// ---- Optimize: shorten a cluttered prompt (duplicates, contradictions, wordiness) ----
// Proposes exact edits on the latest version's full text; nothing is saved until /apply.
async function latestText(p) {
  const vs = sortV(await db.list('versions', x => x.promptId === p.id));
  const base = vs[vs.length - 1];
  if (!base) throw fail(409, 'This prompt has no versions yet.');
  const live = vs.find(x => x.status === 'live');
  const t = pushLib.sarvamTextFor(live, base);
  const text = t ? t.text : core.toMarkdown(core.header(p.cfg, base.v), base.order, base.sections, false).trim();
  const greeting = base.greeting || (((base.sarvamMeta || (live && live.sarvamMeta)) || {}).greeting) || '';
  return { base, live, text, greeting };
}
// Big repeated blocks (e.g. the whole prompt pasted twice, once with markdown escapes) found without
// the AI: runs of paragraphs that already appeared earlier, compared ignoring escapes and spacing.
function repeatedBlocks(text) {
  const paras = [];
  const sep = /(?:\r?\n[ \t]*){2,}/g;
  let last = 0, m;
  while ((m = sep.exec(text))) { if (m.index > last) paras.push({ s: last, e: m.index }); last = m.index + m[0].length; }
  if (last < text.length) paras.push({ s: last, e: text.length });
  const norm = s => s.replace(/\\([*_[\]#`.()!>+-])/g, '$1').replace(/\s+/g, ' ').trim().toLowerCase();
  const seen = new Set();
  paras.forEach(pp => { pp.n = norm(text.slice(pp.s, pp.e)); pp.dup = pp.n.length >= 40 && seen.has(pp.n); if (pp.n.length >= 40) seen.add(pp.n); pp.neutral = pp.n.length < 40; });
  const runs = [];
  for (let i = 0; i < paras.length; i++) {
    if (!paras[i].dup) continue;
    let j = i, k = i;
    while (k + 1 < paras.length && (paras[k + 1].dup || paras[k + 1].neutral)) { k++; if (paras[k].dup) j = k; }
    const size = paras.slice(i, j + 1).reduce((n, pp) => n + (pp.dup ? pp.n.length : 0), 0);
    if (size >= 1500) runs.push({ s: paras[i].s, e: paras[j].e, size, count: paras.slice(i, j + 1).filter(pp => pp.dup).length });
    i = j;
  }
  return runs.map(r0 => ({ old: text.slice(r0.s, r0.e), count: r0.count })).filter(r0 => text.indexOf(r0.old) === text.lastIndexOf(r0.old))
    .map(r0 => ({ type: 'duplicate', title: `Repeated block: ${r0.count} paragraphs already in the prompt`, changesBehaviour: false,
      reason: `These ${r0.count} paragraphs (${r0.old.length.toLocaleString('en-IN')} characters) repeat text that appears earlier in the prompt, word for word apart from formatting. Deleting the repeat keeps every rule.`,
      old_text: r0.old, new_text: '', saved: r0.old.length }));
}

r.post('/prompts/:id/optimize', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot change prompts.');
  const p = await loadPrompt(req.params.id);
  const { base, text, greeting } = await latestText(p);
  if (text.length < 500) throw fail(400, 'This prompt is too short to need optimizing.');
  const dups = repeatedBlocks(text);
  // The AI reads the text without the repeats, so it spends its effort on real clutter; its edits are
  // still checked against the full text.
  let deduped = text; dups.forEach(d => { deduped = deduped.replace(d.old_text, ''); });
  const out = await ai.optimizePrompt(deduped, { focus: String((req.body || {}).focus || '').slice(0, 500), greeting });
  // The AI's edits were checked against the de-duplicated text. One that is ambiguous in the full text
  // (its passage is also in the repeat) works once the repeat is removed: flag it, apply it after.
  const aiEdits = out.edits.map(e => ({ ...e, afterRepeat: dups.length > 0 && ai.applyEdits(text, [e]).failed.length > 0 }));
  const edits = [...dups.map(d => ({ ...d, repeat: true })), ...aiEdits].map((e, i) => ({ ...e, id: i }));
  res.json({ ...out, edits, repeated: dups.length, chars: text.length, versionId: base.id, v: base.v });
}));
r.post('/prompts/:id/optimize/apply', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot change prompts.');
  const p = await loadPrompt(req.params.id);
  const { base, text } = await latestText(p);
  const { versionId, edits, note } = req.body || {};
  if (versionId !== base.id || (req.body.rev != null && Number(req.body.rev) !== (base.rev || 0))) throw fail(409, `The prompt changed since it was optimized (now v${base.v}). Run Optimize again.`, 'stale');
  const list = (Array.isArray(edits) ? edits : []).filter(e => e && typeof e.old_text === 'string' && typeof e.new_text === 'string');
  if (!list.length) throw fail(400, 'Tick at least one change.');
  if (list.some(e => e.afterRepeat) && !list.some(e => e.repeat)) throw fail(400, 'Some ticked changes only work once the repeated block is removed. Tick the repeated block too, or untick them.');
  // Repeated blocks go first, so the other changes then match exactly once.
  const ordered = [...list.filter(e => e.repeat), ...list.filter(e => !e.repeat)];
  const out = ai.applyEdits(text, ordered.map(e => ({ old_text: e.old_text, new_text: e.new_text })));
  if (out.failed.length) throw fail(409, `${out.failed.length} change${out.failed.length > 1 ? 's' : ''} no longer match${out.failed.length > 1 ? '' : 'es'} the text (two ticked changes may overlap). Untick ${out.failed.length > 1 ? 'them' : 'it'} or run Optimize again.`, 'stale');
  const newText = out.text.replace(/\n{3,}/g, '\n\n').trim();
  const imp = await ai.resplit(newText, base, 'Optimized');
  const types = [...new Set(list.map(e => e.type).filter(Boolean))];
  const what = `Optimized: ${list.length} change${list.length > 1 ? 's' : ''} (${types.join(', ') || 'cleanup'}), ${text.length - newText.length >= 0 ? '−' : '+'}${Math.abs(text.length - newText.length).toLocaleString('en-IN')} characters`;
  const { ver, updated } = await saveOnTop(p, base, { sections: imp.sections, order: imp.order, ...(imp.titles ? { titles: imp.titles } : {}), note: String(note || '').trim() || what, src: 'Optimize',
    sarvamText: newText, sourceChunks: null, ...(base.greeting ? { greeting: base.greeting } : {}), ...carrySettings(base),
    optimized: list.map(e => ({ type: e.type, title: String(e.title || '').slice(0, 120), changesBehaviour: !!e.changesBehaviour })) }, req.user, what);
  await audit(req.user, 'prompt.optimize', { prompt: p.id, version: ver.v, changes: list.length, before: text.length, after: newText.length, updated });
  res.json({ versionId: ver.id, v: ver.v, updated, charsBefore: text.length, charsAfter: newText.length });
}));

// Change the agent's variables, languages or voice. Saved as a new draft version (same prompt text)
// carrying a Sarvam config patch, so it goes through approval and push like any prompt change.
// Sarvam checks the patch first (dry run, nothing written).
r.post('/prompts/:id/settings', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot change agents.');
  const p = await loadPrompt(req.params.id);
  const agent = p.agentId ? await db.get('agents', p.agentId) : null;
  if (!agent || !agent.sarvamAppId) throw fail(409, 'This prompt is not linked to a Sarvam agent.');
  const vs = sortV(await db.list('versions', x => x.promptId === p.id));
  const base = vs[vs.length - 1];
  const { languages, voice, variables, note } = req.body || {};
  const patch = {}, summary = [];
  if (languages) {
    const sup = (languages.supported || []).map(String).filter(Boolean);
    if (!sup.length) throw fail(400, 'Pick at least one language.');
    if (!sup.includes(languages.initial)) throw fail(400, 'The starting language must be one of the languages it speaks.');
    patch.language_config = { initial_language_name: languages.initial, supported_languages: sup, lid_supported_languages: sup };
    summary.push(`Languages: starts in ${languages.initial}, speaks ${sup.join(', ')}`);
  }
  if (voice && (voice.id || voice.pace != null || voice.pitch != null)) {
    const tts = { config_version: '2.0' }, ss = {};
    if (voice.id) tts.internal_id = String(voice.id);
    if (voice.pace != null) { const n = Number(voice.pace); if (!(n >= 0.9 && n <= 1.4)) throw fail(400, 'Pace must be between 0.9 and 1.4.'); ss.pace = n; }
    if (voice.pitch != null) { const n = Number(voice.pitch); if (!(n >= -0.2 && n <= 0.2)) throw fail(400, 'Pitch must be between -0.2 and 0.2.'); ss.pitch = n; }
    if (Object.keys(ss).length) tts.speech_settings = ss;
    patch.text_to_speech_config = tts;
    summary.push(`Voice: ${[voice.name || (voice.id ? 'changed' : ''), voice.pace != null ? `pace ${voice.pace}` : '', voice.pitch != null ? `pitch ${voice.pitch}` : ''].filter(Boolean).join(', ')}`);
  }
  if (Array.isArray(variables) && variables.length) {
    const av = {};
    for (const v of variables) {
      const name = String(v.name || '').trim();
      if (!/^[a-z_][a-z0-9_]{0,60}$/i.test(name)) throw fail(400, `"${name}" isn't a valid variable name (letters, numbers and _ only).`);
      if (v.remove) { av[name] = null; summary.push(`Removed variable {{${name}}}`); continue; }
      const e = { name, description: String(v.description || '').trim() || ' ', type: v.type || 'string', value: String(v.value || ''), update_post_interaction: !!v.afterCall };
      if (v.afterCall) { if (!String(v.postPrompt || '').trim()) throw fail(400, `{{${name}}} is filled after the call, so say how to fill it.`); e.post_interaction_prompt = String(v.postPrompt).trim(); }
      av[name] = e;
      summary.push(`${v.isNew ? 'Added' : 'Changed'} variable {{${name}}}${v.afterCall ? ' (filled after the call)' : ''}`);
    }
    patch.llm_config = { agent_config: { agent_variables: av } };
  }
  if (!summary.length) throw fail(400, 'Nothing changed.');
  // Sarvam validates the patch against the agent now, so a bad value is caught here and not at push time.
  const prev = carrySettings(base);
  const merged = pushLib.deepMerge(prev.configPatch || {}, patch);
  await require('../lib/sarvam').editDraft(agent.sarvamAppId, [], true, { config: merged });
  const { ver, updated } = await saveOnTop(p, base, { sections: base.sections, order: base.order, note: String(note || '').trim() || summary.join('; '), src: 'Settings',
    ...(base.sarvamText ? { sarvamText: base.sarvamText, sourceChunks: base.sourceChunks || null } : {}), ...(base.greeting ? { greeting: base.greeting } : {}),
    configPatch: merged, configSummary: [...(prev.configSummary || []), ...summary] }, req.user, summary.join('; '));
  await audit(req.user, 'prompt.settings', { prompt: p.id, version: ver.v, summary, updated });
  res.json({ versionId: ver.id, v: ver.v, summary, updated });
}));

// ---- Approval workflow: draft → pending → approved → live (confirmed in Sarvam) ----
async function loadVersion(vid) {
  const v = await db.get('versions', vid);
  if (!v) throw fail(404, 'Version not found.');
  return v;
}
const step = (v, user, action, note) => { v.history = v.history || []; v.history.push({ at: now(), by: user.email, action, note: note || '' }); };

r.post('/versions/:vid/submit', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot submit versions.');
  const v = await loadVersion(req.params.vid);
  if (!['draft', 'rejected'].includes(v.status)) throw fail(409, `This version is ${v.status}; only drafts can be sent for approval.`);
  v.status = 'pending'; step(v, req.user, 'submitted', req.body && req.body.note);
  await db.put('versions', v); await audit(req.user, 'version.submit', { version: v.id });
  res.json(strip(v));
}));

r.post('/versions/:vid/approve', h(async (req, res) => {
  if (!can(req.user, 'approve')) throw fail(403, 'Only approvers can approve.');
  const v = await loadVersion(req.params.vid);
  if (v.status !== 'pending') throw fail(409, 'Only versions waiting for approval can be approved.');
  // With a second approver required, nobody who wrote or edited the draft may approve it (admins excepted).
  const authors = [v.by, ...(v.editedBy || [])];
  if (!config.selfApprove && authors.includes(req.user.email) && req.user.role !== 'admin') throw fail(409, 'Someone who did not write or edit this version must approve it.');
  v.status = 'approved'; v.approvedBy = req.user.email; v.approvedAt = now(); step(v, req.user, 'approved', req.body && req.body.note);
  await db.put('versions', v); await audit(req.user, 'version.approve', { version: v.id });
  res.json(strip(v));
}));

r.post('/versions/:vid/reject', h(async (req, res) => {
  if (!can(req.user, 'approve')) throw fail(403, 'Only approvers can reject.');
  const v = await loadVersion(req.params.vid);
  if (v.status !== 'pending') throw fail(409, 'Only versions waiting for approval can be rejected.');
  const note = String((req.body || {}).note || '').trim();
  if (!note) throw fail(400, 'Say why it was rejected, so the author can fix it.');
  v.status = 'rejected'; step(v, req.user, 'rejected', note);
  await db.put('versions', v); await audit(req.user, 'version.reject', { version: v.id, note });
  res.json(strip(v));
}));

async function markLive(p, v, user, sarvamVersion, action) {
  const all = await db.list('versions', x => x.promptId === p.id && x.id !== v.id && x.status === 'live');
  for (const o of all) { o.status = action === 'rollback' ? 'rolled_back' : 'superseded'; step(o, user, o.status); await db.put('versions', o); }
  v.status = 'live'; v.sarvamVersion = sarvamVersion; v.liveAt = now(); v.liveBy = user.email; step(v, user, action, `Sarvam v${sarvamVersion}`);
  await db.put('versions', v);
  await db.put('prompts', { ...p, liveVersionId: v.id });
}

// After the approved text has been pasted into Sarvam and committed: confirm the new Sarvam version.
r.post('/versions/:vid/go-live', h(async (req, res) => {
  if (!can(req.user, 'golive')) throw fail(403, 'Only approvers can take a version live.');
  const v = await loadVersion(req.params.vid);
  if (v.status !== 'approved') throw fail(409, 'Approve this version before taking it live.');
  const p = await loadPrompt(v.promptId);
  const agent = p.agentId ? await db.get('agents', p.agentId) : null;
  const { sarvamVersion: given, force } = req.body || {};
  let sv = Number(given) || null;
  if (agent && agent.sarvamAppId) {
    // Ask Sarvam itself which versions are committed 
    let newest = null;
    try { const c = await require('../lib/sarvam').committedVersions(agent.sarvamAppId); newest = c[c.length - 1] || null; } catch (_) { /* ask for the number */ }
    if (!newest && !sv) throw fail(400, 'Enter the Sarvam version number you committed.');
    sv = sv || newest;
    if (newest && sv > newest) throw fail(409, `Sarvam's newest version for this agent is v${newest}. v${sv} doesn't exist yet.`);
    const live = (await db.list('versions', x => x.promptId === p.id && x.status === 'live'))[0];
    if (live && live.sarvamVersion === sv && !force) throw fail(409, `Sarvam still shows v${sv}, the version already live. Paste the approved prompt into Sarvam and commit it first.`, 'same_version');
  } else if (!sv) throw fail(400, 'Enter the Sarvam version number you committed.');
  await markLive(p, v, req.user, sv, 'went_live');
  await audit(req.user, 'version.go_live', { version: v.id, sarvamVersion: sv, });
  res.json({ ok: true, sarvamVersion: sv });
}));

// Apply a version's own edits onto newer text. An edit whose result is already there (the same fix
// reached Sarvam another way) counts as done, not as a conflict.
function applyOwn(text, own) {
  const flat = x => String(x).replace(/\s+/g, ' ').trim();
  const pending = own.filter(e => !(e.new_text.trim() && flat(text).includes(flat(e.new_text))));
  const out = ai.applyEdits(text, pending);
  return { text: out.text, failed: out.failed, already: own.length - pending.length };
}

// Which Sarvam version a version's changes were made on: the nearest ancestor (through basedOn) that
// came from or went to Sarvam. null when it can't be told (older versions without basedOn).
function builtOnOf(v, versions) {
  const byId = id => versions.find(x => x.id === id);
  let cur = v.basedOn ? byId(v.basedOn) : null, guard = 0;
  while (cur && !cur.sarvamVersion && guard++ < 50) cur = cur.basedOn ? byId(cur.basedOn) : null;
  return cur && cur.sarvamVersion ? Number(cur.sarvamVersion) : null;
}

// Rebuild a version on the newest Sarvam version: take only ITS OWN changes (built-on text → its text)
// and apply them to what Sarvam has now. Fixes pushed in between are kept. Refuses when a change
// touches text that was changed since (then the fix needs drafting again).
r.post('/versions/:vid/rebase', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot change prompts.');
  const v = await loadVersion(req.params.vid);
  if (v.status === 'live') throw fail(409, 'This version is already live.');
  const p = await loadPrompt(v.promptId);
  const agent = p.agentId ? await db.get('agents', p.agentId) : null;
  if (!agent) throw fail(409, 'This prompt is not linked to an agent.');
  const sarvam = require('../lib/sarvam');
  const versions = sortV(await db.list('versions', x => x.promptId === p.id));
  const live = versions.find(x => x.status === 'live');
  const builtOn = builtOnOf(v, versions);
  const committed = await sarvam.committedVersions(agent.sarvamAppId);
  const newest = committed[committed.length - 1];
  if (!builtOn) throw fail(409, 'Can\'t tell which Sarvam version this was built on. Draft the change again on the live version.');
  if (builtOn === newest) throw fail(409, `Already built on the newest Sarvam version (v${newest}).`, 'up_to_date');
  const textAt = async sv => { const bv = versions.find(x => Number(x.sarvamVersion) === Number(sv) && x.sarvamText); return bv ? bv.sarvamText : (await sarvam.promptText(agent.sarvamAppId, sv)).text; };
  const [A, N] = await Promise.all([textAt(builtOn), textAt(newest)]);
  const t = pushLib.sarvamTextFor(live, v);
  if (!t) throw fail(409, 'Couldn\'t work out this version\'s full text.');
  const own = pushLib.textEdits(A, t.text);
  if (!own.length) throw fail(409, 'This version has no changes of its own.');
  const out = applyOwn(N, own);
  if (out.already === own.length) throw fail(409, `Everything in this version is already in Sarvam v${newest}. Nothing to rebuild.`, 'up_to_date');
  if (out.failed.length) throw fail(409, `${out.failed.length} of this version's ${own.length} change${own.length > 1 ? 's' : ''} touch text that was changed in Sarvam v${newest}, so they can't be moved over safely. Draft those fixes again on the live version.`, 'rebase_conflict');
  const text = out.text;
  const imp = await ai.resplit(text, v, `Rebuilt on Sarvam v${newest}`);
  const newBase = versions.find(x => Number(x.sarvamVersion) === Number(newest)) || live;
  const was = v.status;
  Object.assign(v, { sections: imp.sections, order: imp.order, ...(imp.titles ? { titles: imp.titles } : {}), sarvamText: text, sourceChunks: null, basedOn: newBase ? newBase.id : v.basedOn, rev: (v.rev || 0) + 1, uat: null,
    status: ['pending', 'approved'].includes(was) ? 'draft' : was === 'rejected' ? 'draft' : was });
  step(v, req.user, 'rebased', `Rebuilt on Sarvam v${newest} (was built on v${builtOn}): ${own.length} change${own.length > 1 ? 's' : ''} moved over${['pending', 'approved'].includes(was) ? '; needs approval again' : ''}`);
  if (['pending', 'approved'].includes(was)) { v.approvedBy = null; v.approvedAt = null; }
  await db.put('versions', v);
  await audit(req.user, 'version.rebase', { version: v.id, from: builtOn, to: newest, edits: own.length });
  res.json({ ok: true, v: v.v, builtOn, newest, moved: own.length, chars: text.length, reapprove: ['pending', 'approved'].includes(was) });
}));

// ---- Lost fixes: changes that went live once but are no longer in the live prompt ----
const linesOf = s => new Set(String(s || '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(l => l.length > 3));
async function textOfSarvam(agent, versions, sv) {
  const bv = versions.find(x => Number(x.sarvamVersion) === Number(sv) && x.sarvamText);
  return bv ? bv.sarvamText : (await require('../lib/sarvam').promptText(agent.sarvamAppId, sv)).text;
}
async function lostFixes(p) {
  const agent = p.agentId ? await db.get('agents', p.agentId) : null;
  const versions = sortV(await db.list('versions', x => x.promptId === p.id));
  const live = versions.find(x => x.status === 'live');
  if (!agent || !live || !live.sarvamText) return [];
  const latest = versions[versions.length - 1];
  const nowLines = linesOf(live.sarvamText), draftLines = latest !== live ? linesOf((pushLib.sarvamTextFor(live, latest) || {}).text) : nowLines;
  const out = [];
  for (const f of versions.filter(x => x.pushed && x.id !== live.id && x.sarvamText)) {
    const on = builtOnOf(f, versions);
    if (!on) continue;
    let base; try { base = await textOfSarvam(agent, versions, on); } catch (_) { continue; }
    const had = linesOf(base);
    const added = [...linesOf(f.sarvamText)].filter(l => !had.has(l));
    if (!added.length) continue;
    const missing = added.filter(l => !nowLines.has(l));
    if (missing.length * 2 < added.length) continue; // mostly still there (or reworded since by a later fix)
    out.push({ versionId: f.id, v: f.v, sarvamVersion: Number(f.sarvamVersion), builtOn: on, note: f.note || '', added: added.length, missing: missing.length,
      restoredInDraft: missing.every(l => draftLines.has(l)), sample: missing.slice(0, 6) });
  }
  // A lost fix that a later lost fix was built on top of (and reworded) counts as restored once that
  // later fix is back: its lines were deliberately replaced, not lost.
  for (const x of out) {
    const later = out.find(y => y !== x && y.builtOn >= x.sarvamVersion && y.restoredInDraft);
    if (!x.restoredInDraft && later) { x.restoredInDraft = true; x.coveredBy = later.v; }
  }
  return out;
}
r.get('/prompts/:id/lost-fixes', h(async (req, res) => res.json({ items: await lostFixes(await loadPrompt(req.params.id)) })));

// Re-apply one lost fix: only its own changes (its built-on Sarvam text → its text), applied on top of
// the latest text (the open draft if there is one, else the live prompt). Saved as a draft.
r.post('/prompts/:id/restore-fix', h(async (req, res) => {
  if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot change prompts.');
  const p = await loadPrompt(req.params.id);
  const agent = p.agentId ? await db.get('agents', p.agentId) : null;
  const versions = sortV(await db.list('versions', x => x.promptId === p.id));
  const f = versions.find(x => x.id === (req.body || {}).versionId);
  if (!agent || !f || !f.sarvamText) throw fail(404, 'That version was not found.');
  const on = builtOnOf(f, versions);
  if (!on) throw fail(409, 'Can\'t tell which version that fix was built on.');
  const live = versions.find(x => x.status === 'live');
  const base = versions[versions.length - 1];
  const cur = (pushLib.sarvamTextFor(live, base) || {}).text || live.sarvamText;
  const own = pushLib.textEdits(await textOfSarvam(agent, versions, on), f.sarvamText);
  const out = applyOwn(cur, own);
  if (out.already === own.length) throw fail(409, `Everything in v${f.v} is already in the prompt.`, 'up_to_date');
  if (out.failed.length) throw fail(409, `${out.failed.length} of the ${own.length} change${own.length > 1 ? 's' : ''} in v${f.v} touch text that has changed since, so they can't be restored automatically. Restore an earlier lost fix first if there is one, or re-add this fix as feedback.`, 'restore_conflict');
  const imp = await ai.resplit(out.text, base, `Restored v${f.v}`);
  const what = `Restored lost fix v${f.v} (Sarvam v${f.sarvamVersion}): ${String(f.note || '').slice(0, 160)}`;
  const { ver, updated } = await saveOnTop(p, base, { sections: imp.sections, order: imp.order, ...(imp.titles ? { titles: imp.titles } : {}), note: what, src: 'Restore', sarvamText: out.text, sourceChunks: null,
    ...(base.greeting ? { greeting: base.greeting } : {}), ...carrySettings(base), restored: [...(base.restored && base.status !== 'live' ? base.restored : []), f.id] }, req.user, what);
  await audit(req.user, 'version.restore_fix', { prompt: p.id, from: f.v, into: ver.v, updated });
  res.json({ versionId: ver.id, v: ver.v, updated, moved: own.length, charsBefore: cur.length, charsAfter: out.text.length });
}));

// One step instead of copy → paste → commit → confirm: write the approved version's changed
// passages into the agent's Sarvam draft, commit it as a new Sarvam version,
// and mark it live here. { dryRun: true } checks everything with Sarvam and writes nothing.
r.post('/versions/:vid/push', h(async (req, res) => {
  const { dryRun, allowDraftChanges, target } = req.body || {};
  const v = await loadVersion(req.params.vid);
  const p = await loadPrompt(v.promptId);
  const agent = p.agentId ? await db.get('agents', p.agentId) : null;
  if (!agent || !agent.sarvamAppId) throw fail(409, 'This prompt is not linked to a Sarvam agent yet. Pick the agent it belongs to, then push.', 'not_linked');
  const live = (await db.list('versions', x => x.promptId === p.id && x.status === 'live'))[0];

  // UAT: make the linked test agent match this version exactly (prompt, greeting, settings), so it can
  // be tried on real calls before it is approved and promoted to the live agent.
  if (target === 'uat') {
    if (!can(req.user, 'edit')) throw fail(403, 'Your role cannot push to UAT.');
    if (v.status === 'live') throw fail(409, 'This version is already live.');
    const uat = agent.uatAgentId ? await db.get('agents', agent.uatAgentId) : null;
    if (!uat) throw fail(409, 'No UAT agent is linked. Open the agent\'s ⋯ menu and set one.', 'no_uat');
    const liveGreeting = (live && live.sarvamMeta && live.sarvamMeta.greeting) || '';
    const next = { ...v, greeting: v.greeting || liveGreeting, configPatch: pushLib.deepMerge((live && live.configPatch) || {}, v.configPatch || {}) };
    if (!Object.keys(next.configPatch).length) delete next.configPatch;
    let out;
    try { out = await pushLib.push({ agent: uat, live: null, next, cfg: p.cfg, user: req.user, dryRun: !!dryRun, allowDraftChanges: !!allowDraftChanges }); }
    catch (e) { if (/no changes compared/.test(e.message)) throw fail(409, `${uat.name} already has exactly this version.`, 'same_as_uat'); throw e; }
    if (dryRun) return res.json({ ...out, target: 'uat', uatName: uat.name });
    v.uat = { agentId: uat.id, name: uat.name, sarvamVersion: out.version, at: now(), by: req.user.email };
    step(v, req.user, 'pushed_to_uat', `${uat.name} · Sarvam v${out.version}`);
    await db.put('versions', v);
    require('./agents').pullFromSarvam(await db.get('agents', uat.id), req.user).catch(() => { }); // keep the UAT agent's own page current
    await audit(req.user, 'version.push_uat', { version: v.id, uat: uat.id, sarvamVersion: out.version });
    return res.json({ ok: true, target: 'uat', uatName: uat.name, sarvamVersion: out.version, edits: out.edits });
  }

  if (!can(req.user, 'golive')) throw fail(403, 'Only approvers can take a version live.');
  if (v.status !== 'approved') throw fail(409, 'Approve this version before taking it live.');

  const builtOn = builtOnOf(v, sortV(await db.list('versions', x => x.promptId === p.id)));
  const out = await pushLib.push({ agent, live, next: v, cfg: p.cfg, user: req.user, dryRun: !!dryRun, allowDraftChanges: !!allowDraftChanges, builtOn });
  if (dryRun) return res.json({ ...out, builtOn });

  if (v.sarvamText !== out.text) v.sourceChunks = null; // passages are re-derived from the committed text when needed
  v.sarvamText = out.text;
  if (live && live.sarvamMeta) v.sarvamMeta = { ...live.sarvamMeta, ...(out.greeting ? { greeting: out.greeting } : {}) };
  v.pushed = { at: now(), by: req.user.email, edits: out.edits, sarvamVersion: out.version, draftIncluded: out.draftDirty };
  await markLive(p, v, req.user, out.version, 'went_live');
  // Next sync sees this exact text and doesn't import it again as a separate version.
  await db.put('agents', { ...(await db.get('agents', agent.id)), sarvamPromptHash: out.newHash, sarvamPulledAt: now(), sarvamPullError: null });
  await audit(req.user, 'version.push', { version: v.id, sarvamVersion: out.version, edits: out.edits, draftIncluded: out.draftDirty });
  res.json({ ok: true, sarvamVersion: out.version, edits: out.edits });
}));

// Roll back: Sarvam keeps no "which version is live" switch for the builder to flip, so going back means
// pushing the earlier version's text as a new Sarvam version. This only explains that; the UI offers it as "Push this again".
r.post('/versions/:vid/rollback', h(async (req, res) => {
  if (!can(req.user, 'rollback')) throw fail(403, 'Only approvers and admins can roll back.');
  const v = await loadVersion(req.params.vid);
  if (!v.sarvamVersion || !['superseded', 'rolled_back'].includes(v.status)) throw fail(409, 'Only a version that was live before can be rolled back to.');
  const p = await loadPrompt(v.promptId);
  const agent = p.agentId ? await db.get('agents', p.agentId) : null;
  if (!agent || !agent.sarvamAppId) throw fail(409, 'This prompt is not linked to a Sarvam agent, so there is nothing to roll back.');
  // Sarvam only: commit the old version's prompt text again as a new Sarvam version, so the newest
  // version (what calls use when nothing is pinned) is the old prompt. Prompt text only; greeting and
  // settings stay as they are now.
  const out = await recommit(agent, v, req.user);
  v.sarvamText = out.text; v.sourceChunks = null;
  v.rolledBackFrom = { sarvamVersion: Number(v.sarvamVersion), at: now(), by: req.user.email };
  await markLive(p, v, req.user, out.version, 'rollback');
  await db.put('agents', { ...(await db.get('agents', agent.id)), sarvamPromptHash: out.hash, sarvamPulledAt: now(), sarvamPullError: null });
  await audit(req.user, 'version.rollback', { version: v.id, from: v.rolledBackFrom.sarvamVersion, sarvamVersion: out.version, recommitted: true });
  res.json({ ok: true, recommitted: true, sarvamVersion: out.version, from: v.rolledBackFrom.sarvamVersion });
}));

// Commit an earlier Sarvam version's prompt text as a new Sarvam version. Refuses when Sarvam's draft
// holds edits nobody committed (they would go live unreviewed), and checks the committed text after.
async function recommit(agent, v, user) {
  const sarvam = require('../lib/sarvam');
  const appId = agent.sarvamAppId;
  const committed = await sarvam.committedVersions(appId);
  const newest = committed[committed.length - 1];
  if (!newest) throw fail(409, 'Sarvam has no committed version of this agent.');
  const [old, top, draft] = await Promise.all([sarvam.promptText(appId, v.sarvamVersion), sarvam.promptText(appId, newest), sarvam.promptText(appId, null)]);
  if (old.hash === top.hash) return { version: newest, text: top.text, hash: top.hash }; // already the newest text
  if (draft.hash !== top.hash) throw fail(409, `Sarvam's draft for ${agent.name} has edits nobody committed. Commit or discard them in Sarvam, then roll back again.`, 'draft_dirty');
  const edits = pushLib.textEdits(draft.text, old.text);
  await sarvam.editDraft(appId, edits, true);
  await sarvam.editDraft(appId, edits, false);
  const version = await sarvam.commit(appId, `Prompt Builder rollback: prompt of Sarvam v${v.sarvamVersion} (builder v${v.v}) by ${user.email}`);
  const after = await sarvam.promptText(appId, version);
  const norm = s => s.replace(/\s+/g, ' ').trim();
  if (norm(after.text) !== norm(old.text)) throw fail(502, `Committed as Sarvam v${version}, but its text differs from v${v.sarvamVersion}. Check the agent in Sarvam.`, 'sarvam_edit');
  return { version, text: after.text, hash: after.hash };
}

r.get('/approvals', h(async (req, res) => {
  const [versions, prompts] = await Promise.all([db.list('versions', v => ['pending', 'approved'].includes(v.status)), db.list('prompts')]);
  res.json({ items: versions.map(v => ({ ...strip(v), promptName: (prompts.find(p => p.id === v.promptId) || {}).name })) });
}));

r.get('/core-changes', h(async (req, res) => res.json({ items: (await db.list('coreChanges')).reverse() })));
r.get('/audit', h(async (req, res) => res.json({ items: (await db.list('audit')).reverse().slice(0, 200) })));

module.exports = r;
