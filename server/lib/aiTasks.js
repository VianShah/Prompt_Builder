// Prompts sent to the LLM, and the deterministic fallbacks used when no LLM is configured or it fails.
const llm = require('./llm');
const K = require('./agentKind').kind; // collections or sales, for this request
const PB = require('../../shared/blocks');
const core = require('../../shared/promptcore');

const LAYER_TEXT = 'L0 voice platform core (shared by every client), L1 compliance core (shared), L2 client profile, L3 client collection policy, L4 persona, L5 DPD bucket strategy, L6 flow modules, L7 objection library, L8 knowledge base, L9 variable schema.';
const SEC_LAYER = { rules: 'L1', persona: 'L4', speech: 'L0', inputs: 'L9', identity: 'L1', opening: 'L2', flows: 'L6', objections: 'L7', kb: 'L8', dates: 'L3', language: 'L0', hygiene: 'L0', closing: 'L0' };

// A section's title: the version's own (New prompt structures), else the builder's.
const secT = (v, s) => (v && v.titles && v.titles[s]) || PB.secTitle(s);
function sectionIndex(v) {
  return v.order.map(sec => {
    const t = v.sections[sec] || '';
    const ids = core.blockTags(t).map(x => `${x.id}(${x.layer})`);
    return `### ${sec} (${secT(v, sec)}) blocks: ${ids.join(', ')}\n${t.replace(/<!--.*-->\n?/g, '').slice(0, 1600)}`;
  }).join('\n\n');
}

async function mapFeedback(prompt, version, items) {
  const cfg = prompt.cfg || {};
  const text = `You map feedback on a ${K().t} voice-agent prompt (${K().domain}) to the prompt section and block that causes the problem.

Layers: ${LAYER_TEXT}
Client: ${(cfg.client && cfg.client.name) || prompt.name}, ${(cfg.client && cfg.client.product) || ''}, ${PB.bucketT(cfg.bucket || 'b1')}.

PROMPT SECTIONS (id, title, block ids, then text):
${sectionIndex(version)}

FEEDBACK ITEMS:
${items.map((it, i) => `${i + 1}. ${it.text}`).join('\n')}

For each feedback item return one object:
{"i": item number, "section": one of [${version.order.join(', ')}], "block": the block id in that section most responsible, or "", "layer": "L0".."L9", "type": "compliance"|"behaviour"|"tone"|"speech"|"knowledge"|"policy"|"platform", "severity": "high"|"medium"|"low" (high = compliance or customer harm), "scope": "shared" if every client's prompt should get this fix (platform, speech, identity, compliance learnings), else "client", "diagnosis": one sentence on why the current text allows this, or say the text already forbids it and the rule must be stronger, "fix": one sentence describing the change as a general rule that handles every similar case (not only this example), made to the existing rule that already covers this (name it); suggest a new rule only if nothing covers it}
Reply with only a JSON array.`;
  let results = [], provider = null, error = null;
  try { const r = await llm.json(text); results = Array.isArray(r.data) ? r.data : []; provider = r.provider; }
  catch (e) { error = e.code === 'no_llm' ? 'no_llm' : (e.code || 'llm_failed'); }
  return items.map((it, i) => {
    const r = results.find(x => Number(x.i) === i + 1);
    if (r && version.order.includes(r.section)) {
      const tags = core.blockTags(version.sections[r.section] || '');
      const tag = tags.find(t => t.id === r.block);
      return { section: r.section, block: tag ? tag.id : (tags[0] ? tags[0].id : ''), layer: /^L\d$/.test(r.layer) ? r.layer : (tag ? tag.layer : SEC_LAYER[r.section]),
        type: String(r.type || 'behaviour'), severity: ['high', 'medium', 'low'].includes(r.severity) ? r.severity : 'medium', scope: r.scope === 'shared' ? 'shared' : 'client',
        diagnosis: String(r.diagnosis || ''), fix: String(r.fix || ''), via: 'ai', provider };
    }
    return { ...core.heuristicMap(it.text, version.order, version.sections), fallbackReason: error };
  });
}

// Draft the fix as small edits (old passage → new passage), not a rewrite of the whole section.
// Sections of real prompts run to 20,000+ characters; asking for the whole section back overflowed
// the reply and every other line risked being reworded. The edits are applied here, exactly.
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function applyEdits(cur, edits) {
  let text = cur;
  const failed = [];
  for (const e of edits) {
    const oldT = String(e.old_text || ''), newT = String(e.new_text || '');
    if (!oldT.trim()) { text = text.trim() ? `${text.replace(/\s+$/, '')}\n\n${newT.trim()}` : newT.trim(); continue; } // add at the end
    // Match line breaks either way (some Sarvam prompts use \r\n) and tolerate trailing spaces.
    const re = new RegExp(oldT.trim().split(/\r?\n/).map(l => escRe(l.replace(/\s+$/, ''))).join('[ \\t]*\\r?\\n'));
    const m = text.match(re);
    if (!m || text.slice(m.index + m[0].length).match(re)) { failed.push(oldT.slice(0, 80)); continue; }
    const nl = m[0].includes('\r\n') ? '\r\n' : '\n';
    text = text.slice(0, m.index) + newT.trim().split(/\r?\n/).join(nl) + text.slice(m.index + m[0].length);
  }
  return { text, failed };
}
// The AI sees the WHOLE prompt (every section) and is told to change the rules that already govern
// the behaviour, wherever they are, rather than bolt a new rule onto the section the feedback was
// mapped to. A new line is added only when nothing in the prompt covers the situation.
const draftErr = msg => Object.assign(new Error(msg), { code: 'invalid_json', publicMessage: msg });
// The reviewer's own notes on the fix, and the draft they weren't happy with, for a redraft.
function reviewerBlock(version, item) {
  const notes = (item.guidance || []).filter(g => g && g.text);
  if (!notes.length) return '';
  const prev = item.draft;
  let prevText = '';
  if (prev) {
    const changed = prev.sections || { [item.map.section]: prev.revised };
    const lines = [];
    for (const [s, t] of Object.entries(changed)) {
      const before = (version.sections[s] || '').split(/\r?\n/), after = String(t || '').split(/\r?\n/);
      before.filter(l => l.trim() && !after.includes(l)).forEach(l => lines.push(`- removed: ${l}`));
      after.filter(l => l.trim() && !before.includes(l)).forEach(l => lines.push(`+ added: ${l}`));
    }
    prevText = `\nTHE PREVIOUS DRAFT (the reviewer has read it and given the notes above):\nSummary: ${prev.summary || ''}\n${lines.slice(0, 30).join('\n').slice(0, 6000)}\n`;
  }
  return `
THE REVIEWER'S NOTES ON THE FIX (oldest first). These come from the person who heard the call. Where they differ from the feedback, the diagnosis or the suggested fix above, THE NOTES WIN. Include every specific detail they ask for, and drop anything they say is wrong:
${notes.map((g, i) => `${i + 1}. ${g.text}`).join('\n')}
${prevText}`;
}

async function draftFix(prompt, version, item) {
  const m = item.map;
  const reviewer = reviewerBlock(version, item);
  const order = [m.section, ...version.order.filter(s => s !== m.section)];
  const secs = order.filter(s => (version.sections[s] || '').trim() || s === m.section);
  const ask = (retryNote) => `Fix one piece of feedback in a ${K().t} voice-agent prompt by EDITING THE EXISTING PROMPT. Reply with the smallest edits, not a rewrite.

How to fix it:
0. Fix the BEHAVIOUR, not just this one example. Work out the general situation behind the feedback (e.g. "the customer gives several dates" rather than "the customer said 17th then 31st") and make the rules handle every case of it. Use the feedback's own case as an example only if it helps the agent.
1. Work inside the existing rules of the section the feedback was mapped to. Find the line(s) that govern this behaviour (the rule, flow step, example line or script the agent followed) and fix THOSE. Touch other sections only to remove a line that would contradict the fix. Never rewrite the whole prompt.
2. Decide for yourself how to change each rule:
   - "replaced": the rule's logic is wrong or too narrow, so write it again in full (same place, same style);
   - "modified": the rule is mostly right, so reword it or add a clause, condition or example;
   - "added": nothing in the prompt covers this, so add ONE new bullet or line next to the most closely related rule. Never add a new heading or section.
3. If another line contradicts the fix, change or remove it too, so the prompt never says two different things.
4. If the prompt already forbids the behaviour, make that rule stronger in place: name the exact phrase to avoid and say what to say instead.

Format rules:
- Each edit names its "section" (one of the ids below) and replaces an exact passage. "old_text" must be copied character for character from that section (one or more whole lines) and must appear only once in it. "new_text" replaces it. To delete a line, give an empty new_text. If the section is empty, use "" as old_text.
- Never change or remove lines that start with "<!--" (block tags).
- Keep wording, language and script as they are wherever the fix doesn't need a change: English stays English; Hindi (Devanagari or Hinglish) stays in the same script.
- Keep {{variables}} and markdown (headings, bullets, bold, escaped characters like \\*) exactly as the prompt writes them.
- Never add threats, outcome promises or amounts that aren't in the prompt.
${retryNote || ''}
Client: ${prompt.name}. The feedback was mapped to: ${secT(version, m.section)} (${m.section}), but the lines to change may be in any section.
Feedback: ${item.text}
${m.diagnosis ? `Diagnosis: ${m.diagnosis}\n` : ''}${m.fix ? `Suggested fix: ${m.fix}\n` : ''}${(m.quotes || []).length ? `Prompt lines the diagnosis found responsible: ${m.quotes.map(q => JSON.stringify(q.text)).join(' | ')}\n` : ''}${reviewer}
THE PROMPT, BY SECTION:
${secs.map(s => `=== SECTION ${s} (${secT(version, s)}) ===\n${version.sections[s] || '(empty)'}`).join('\n\n')}

Reply with only JSON: {"edits": [{"section": "section id", "old_text": "...", "new_text": "..."}], "how": "replaced" if you rewrote an existing rule, "modified" if you reworded or extended existing lines, "added" if you had to add a new line (use the strongest that applies), "summary": "one sentence on which existing rule changed and how"${reviewer ? `, "understood": "one or two sentences restating what the reviewer's notes asked for, so they can check you understood them"` : ''}}`;
  const run = async note => {
    const r = await llm.json(ask(note), { maxTokens: 6000 });
    const edits = (r.data && Array.isArray(r.data.edits) ? r.data.edits : []).filter(e => e && typeof e.new_text === 'string').map(e => ({ ...e, section: version.order.includes(e.section) ? e.section : m.section }));
    const changed = {}, failed = [];
    for (const sec of [...new Set(edits.map(e => e.section))]) {
      const cur = changed[sec] != null ? changed[sec] : (version.sections[sec] || '');
      const out = applyEdits(cur, edits.filter(e => e.section === sec));
      failed.push(...out.failed.map(f => `${sec}: ${f}`));
      changed[sec] = out.text;
    }
    return { r, edits, changed, failed };
  };
  let x = await run();
  if (!x.edits.length) throw draftErr('The AI didn\'t suggest a change. Try Draft again, or Edit by hand.');
  if (x.failed.length) {
    x = await run(`- Your previous answer quoted text that isn't in its section exactly once: ${x.failed.map(f => JSON.stringify(f)).join(', ')}. Copy old_text exactly from the named section.`);
    if (x.failed.length || !x.edits.length) throw draftErr('The AI\'s edit didn\'t match the prompt text exactly. Try Draft again, or use Edit by hand.');
  }
  const sections = {};
  for (const [sec, t] of Object.entries(x.changed)) if (t.trim() !== (version.sections[sec] || '').trim()) sections[sec] = t.trim();
  if (!Object.keys(sections).length) throw draftErr('The AI\'s edit didn\'t change anything. Try Draft again, or Edit by hand.');
  let lost = 0;
  for (const [sec, t] of Object.entries(sections)) lost += ((version.sections[sec] || '').match(/^<!--.*-->\r?$/gm) || []).map(l => l.replace(/\r$/, '')).filter(l => !t.includes(l)).length;
  const d = x.r.data || {};
  return { sections, revised: sections[m.section] != null ? sections[m.section] : (version.sections[m.section] || ''), changedSections: Object.keys(sections),
    how: ['replaced', 'added'].includes(d.how) ? d.how : 'modified', summary: String(d.summary || 'Prompt revised'), understood: reviewer ? String(d.understood || '') : '', notesUsed: (item.guidance || []).length, lostTags: lost, edits: x.edits.length, provider: x.r.provider };
}

async function review(markdown) {
  const text = `Review this ${K().t} voice-agent prompt (${K().domain}). Look for: contradictions between sections; persona lines that could override compliance or client policy; common collection-call situations with no handling; compliance risks (threats, disclosure to third parties, promises of outcomes, invented facts). Ignore style.
Reply with only a JSON array of up to 8 objects: {"section": "section title", "severity": "high"|"medium"|"low", "issue": "one sentence", "suggestion": "one sentence"}. Return [] if there are no real issues.

PROMPT:
${markdown.slice(0, 120000)}`;
  const r = await llm.json(text);
  return { issues: (Array.isArray(r.data) ? r.data : []).filter(x => x && x.issue), provider: r.provider };
}

// Review a prompt built in the wizard AND propose a fix for each issue, so it can be applied in place:
//   edit    : new wording for one block (only blocks that aren't locked)
//   add     : a new rule appended to a section (also how a locked block is strengthened)
//   setting : the real cause is a choice on an earlier wizard step; say which step and what to change
async function reviewWithFixes({ blocks, steps }) {
  const list = (Array.isArray(blocks) ? blocks : []).filter(x => x && x.id && x.text != null).slice(0, 200);
  const stepNames = (Array.isArray(steps) ? steps : []).map(String).slice(0, 12);
  const secs = [...new Set(list.map(x => x.sec))];
  const req = `Review this ${K().t} voice-agent prompt (${K().domain}) and FIX what you find. Look for: contradictions between blocks; persona lines that could override compliance or client policy; common collection-call situations with no handling; compliance risks (threats, disclosure to third parties, promises of outcomes, invented facts). Ignore style and wording preferences.

The prompt is made of blocks. For each issue give exactly one fix:
- "edit": rewrite ONE block that is not locked. "block" = its id, "new_text" = the whole new text of that block. Change only what the issue needs; keep every other rule, {variable} and number in the block exactly.
- "add": add a short new rule to a section ("section" = section id, "text" = the rule, one or two sentences). Use this when nothing covers the situation, or when the block at fault is locked.
- "setting": when the real cause is a choice made on one of these setup steps: ${stepNames.join(', ')}. "step" = the step name exactly, "change" = what to set it to, in one sentence.
Locked blocks are shared compliance and platform rules: never edit them.

Reply with only a JSON array of up to 8 objects:
{"section": "section id", "severity": "high"|"medium"|"low", "issue": "one sentence", "suggestion": "one sentence on the fix", "fix": {"type": "edit"|"add"|"setting", "block": "", "new_text": "", "text": "", "step": "", "change": ""}}
Return [] if there are no real issues.

SECTION IDS: ${secs.join(', ')}

BLOCKS (in prompt order):
${list.map(x => `[${x.id}] section=${x.sec}${x.locked ? ' LOCKED' : ''}\n${String(x.text).slice(0, 4000)}`).join('\n\n').slice(0, 150000)}`;
  const r = await llm.json(req, { maxTokens: 12000, timeoutMs: 240000 });
  const byId = new Map(list.map(x => [x.id, x]));
  const issues = (Array.isArray(r.data) ? r.data : []).filter(x => x && x.issue).slice(0, 8).map(x => {
    const f = x.fix || {}, out = { section: String(x.section || ''), severity: ['high', 'medium', 'low'].includes(x.severity) ? x.severity : 'medium', issue: String(x.issue), suggestion: String(x.suggestion || '') };
    const b = byId.get(String(f.block || ''));
    if (f.type === 'edit' && b && !b.locked && String(f.new_text || '').trim() && f.new_text !== b.text) out.fix = { type: 'edit', block: b.id, sec: b.sec, before: b.text, text: String(f.new_text).trim() };
    else if ((f.type === 'add' || (f.type === 'edit' && b && b.locked)) && String(f.text || f.new_text || '').trim()) out.fix = { type: 'add', sec: secs.includes(f.section) ? f.section : (b ? b.sec : secs.includes(x.section) ? x.section : 'rules'), text: String(f.text || f.new_text).trim() };
    else if (f.type === 'setting' && stepNames.includes(String(f.step))) out.fix = { type: 'setting', step: String(f.step), change: String(f.change || x.suggestion || '') };
    return out;
  });
  return { issues, provider: r.provider };
}

async function kbDraft({ notes, client, product }) {
  const text = `Turn these product notes into a knowledge base for a ${K().agent} for ${client || 'a lender'} (${product || 'loan'}).
Rules: only use facts stated in the notes. Write FAQs the way a borrower would ask on a phone call. Answers are one or two sentences, say what the agent says or does, and never promise an outcome (no "will be waived/approved/updated"). Never write specific rupee amounts; refer to them as the amount on the account.
Reply with only JSON: {"facts":[{"k":"topic","v":"what the agent may say"}],"faqs":[{"q":"customer question","a":"agent answer"}],"oos":"one out-of-scope line, or empty string"}

NOTES:
${String(notes).slice(0, 20000)}`;
  const r = await llm.json(text);
  const d = r.data || {};
  return { facts: (d.facts || []).filter(x => x && x.k && x.v).map(x => ({ k: String(x.k), v: String(x.v) })),
    faqs: (d.faqs || []).filter(x => x && x.q && x.a).map(x => ({ q: String(x.q), a: String(x.a) })), oos: d.oos ? String(d.oos) : '', provider: r.provider };
}

// Pictures and scanned pages in the client's folder -> the text they carry, as a document the knowledge-base
// import reads like any other. Claude reads each batch of images; nothing is added until a person ticks it.
async function readImagesToText({ images, label }) {
  const list = (Array.isArray(images) ? images : []).slice(0, 8);
  const prompt = `These ${list.length === 1 ? 'is an image' : `are ${list.length} images`} from a lender's documents (product brochures, rate cards, offer screenshots, policy pages, scanned pages) for a phone voice agent. File: ${String(label || 'images').slice(0, 160)}.
Transcribe everything that carries information, in reading order: all text, headings, tables (as rows of "column: value"), fees, limits, rates, dates, eligibility and conditions, footnotes, and what a chart or diagram shows. Keep numbers, percentages and currency exactly as printed, and keep the language printed (Hindi stays Hindi).
Do not describe the design (colours, layout, logos). Do not guess at anything unreadable: write [unreadable] for it. If an image has no information (a photo of a person, decoration), write "No information." for it.
${list.length > 1 ? 'Start each image with "Image N:" on its own line.' : ''}
Reply with plain text only.`;
  const text = await llm.readImages(prompt, list);
  return { text: String(text || '').trim(), provider: 'Claude (Bedrock)' };
}

// Knowledge base from documents (product sheets, policy PDFs, FAQ files...). The browser extracts the
// text and sends it in batches; each batch comes back as facts and FAQs that name the file they came
// from, for a person to review before anything is added. Only what the documents say is used.
const KB_KINDS = ['product', 'policy', 'process', 'contact', 'other'];
async function kbFromDocs({ docs, client, product, agentType }) {
  const list = (Array.isArray(docs) ? docs : []).filter(d => d && String(d.text || '').trim()).slice(0, 20);
  const body = list.map(d => `=== FILE: ${String(d.name || 'document').slice(0, 160)} ===\n${String(d.text).slice(0, 40000)}`).join('\n\n');
  const req = `You build the knowledge base for a phone voice agent (${agentType || 'collections'}) for ${client || 'a lender'}${product ? `, product: ${product}` : ''}. The agent may state ONLY facts in this knowledge base, so it must be exact.

Read the documents below and extract:
- facts: short, self-contained statements the agent may say. "k" is a 2–5 word topic, "v" is the fact in one or two plain sentences. "kind" is one of ${KB_KINDS.join(', ')}: product (features, fees, limits, eligibility), policy (rules the lender has set: waivers, settlements, charges, what may or may not be offered), process (how to pay, how to raise a request, timelines), contact (channels, numbers, hours).
- faqs: questions a customer would really ask on a call, in their words, with the agent's answer in one or two sentences.
- oos: one line the agent says when a question isn't covered (only if the documents suggest one; else empty).

Rules:
- Use only what the documents state. Never add, infer or generalise. If documents disagree, keep both facts and say so in "v".
- Keep fees, limits, dates and percentages exactly as written. Never write amounts that belong to one customer's account.
- Answers say what the agent says or does. Never promise an outcome the documents don't guarantee (no "will be waived/approved").
- "src" is the FILE name each item came from, exactly as given.
- Skip boilerplate, headers, legal footers, and anything about internal staff only.
- English, even if the documents mix languages.

Reply with only JSON: {"facts":[{"k":"","v":"","kind":"","src":""}],"faqs":[{"q":"","a":"","src":""}],"oos":""}

DOCUMENTS:
${body}`;
  const r = await llm.json(req, { maxTokens: 12000, timeoutMs: 240000 });
  const d = r.data || {}, names = list.map(x => String(x.name || ''));
  const srcOf = v => { const t = String(v || ''); return names.find(n => n === t) || names.find(n => t && (n.includes(t) || t.includes(n))) || (names.length === 1 ? names[0] : t); };
  return {
    facts: (d.facts || []).filter(x => x && x.k && x.v).map(x => ({ k: String(x.k).slice(0, 120), v: String(x.v).slice(0, 800), kind: KB_KINDS.includes(x.kind) ? x.kind : 'other', src: srcOf(x.src) })).slice(0, 120),
    faqs: (d.faqs || []).filter(x => x && x.q && x.a).map(x => ({ q: String(x.q).slice(0, 300), a: String(x.a).slice(0, 800), src: srcOf(x.src) })).slice(0, 120),
    oos: d.oos ? String(d.oos).slice(0, 300) : '', provider: r.provider,
  };
}

// Import an existing Sarvam prompt without rewording it: split into chunks, let the LLM (or keyword rules) assign each
// chunk to one of the 13 sections, then rebuild each section from the original text in its original order.
// Re-split a whole prompt into sections after it was edited or rebuilt. A version with its own structure
// (built with New prompt) keeps it: the text is split at its "## Title" headings. Others use importPrompt.
function splitOwn(text, base) {
  const byTitle = new Map(Object.entries(base.titles).map(([id, t]) => [String(t).trim().toLowerCase(), id]));
  const sections = {}, order = [], titles = { ...base.titles };
  let cur = null, buf = [];
  const flush = () => { if (cur) sections[cur] = buf.join('\n').trim(); buf = []; };
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { flush(); const t = h[1].trim(); let id = byTitle.get(t.toLowerCase()); if (!id) { id = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `section-${order.length + 1}`; titles[id] = t; byTitle.set(t.toLowerCase(), id); } cur = id; if (!order.includes(id)) order.push(id); continue; }
    if (!cur) { cur = order[0] || Object.keys(base.titles)[0] || 'introduction'; if (!order.includes(cur)) order.push(cur); }
    buf.push(line);
  }
  flush();
  return { sections, order, titles };
}
async function resplit(text, base, label) {
  if (base && base.titles && /^##\s+\S/m.test(String(text || ''))) return { ...splitOwn(text, base), via: 'own headings' };
  return importPrompt(text, label);
}

async function importPrompt(rawText, sourceLabel) {
  const chunks = core.chunkPrompt(rawText);
  let assign = {}, provider = null, via = 'rules';
  if (chunks.length) {
    try {
      const text = `Assign each numbered chunk of an existing ${K().t} voice-agent prompt to exactly one section.
Sections: ${PB.SECTIONS.map(s => `${s.id} (${s.t})`).join(', ')}.
Use "rules" for hard do/don't rules, "kb" for product facts and FAQs, "flows" for the main conversation states, "objections" for objection handling and special cases.

CHUNKS:
${chunks.map((c, i) => `[${i + 1}] ${c.slice(0, 500)}`).join('\n\n')}

Reply with only a JSON array: [{"i": chunk number, "section": section id}]`;
      const r = await llm.json(text);
      (Array.isArray(r.data) ? r.data : []).forEach(x => { if (PB.CANON.includes(x.section)) assign[Number(x.i) - 1] = x.section; });
      provider = r.provider; via = 'ai';
    } catch (e) { via = 'rules'; }
  }
  const bySec = {};
  chunks.forEach((c, i) => { const sec = assign[i] || core.heuristicSectionFor(c); (bySec[sec] = bySec[sec] || []).push(c); });
  const sections = {};
  PB.CANON.forEach(sec => {
    sections[sec] = bySec[sec] ? `<!-- IMP-${sec.toUpperCase()} · ${SEC_LAYER[sec]} · ${sourceLabel} -->\n` + bySec[sec].join('\n\n') : '';
  });
  return { sections, order: [...PB.CANON], chunks: chunks.length, via, provider, counts: Object.fromEntries(Object.entries(bySec).map(([k, v]) => [k, v.length])) };
}

// A reviewer flagged one moment in a real call. Find what in the prompt made the agent do it (or
// failed to stop it), quoting the prompt exactly, and say the smallest fix. Returns a feedback map.
async function diagnoseCall(prompt, version, { text, turns, turn, note, callInfo }) {
  const fmt = (t, i) => `[${i}] ${t.role === 'agent' ? 'AGENT' : t.role === 'user' ? 'CUSTOMER' : String(t.role).toUpperCase()}: ${t.text}`;
  const lo = Math.max(0, turn - 12), hi = Math.min(turns.length, turn + 6);
  const text0 = String(text || '').slice(0, 150000);
  const req = `A reviewer is listening to a real ${K().call} made by a voice agent (${K().domain}) and flagged a mistake. Find why the agent did it, using the agent's prompt below.

Reviewer's note on turn [${turn}]: ${note || '(no note: work out what went wrong at that turn)'}
${callInfo ? `Call details: ${callInfo}\n` : ''}
TRANSCRIPT (turns ${lo}-${hi - 1}; the flagged turn is [${turn}]):
${turns.slice(lo, hi).map((t, k) => fmt(t, lo + k)).join('\n')}

THE AGENT'S PROMPT (exactly as the agent received it):
<<<
${text0}
>>>

Work out the cause. It is one of: "missing" (the prompt never covers this situation), "unclear" (a rule exists but is vague or easy to misread), "conflict" (two parts of the prompt pull in different directions), "ignored" (the prompt clearly says the right thing and the model didn't follow it), "data" (a wrong or missing call input/variable caused it).
Reply with only JSON:
{"what": "one sentence: what the agent did wrong at that turn",
 "cause": "missing" | "unclear" | "conflict" | "ignored" | "data",
 "quotes": ["up to 3 passages copied EXACTLY, character for character, from the prompt, that caused it or should have stopped it; [] if cause is missing"],
 "why": "two sentences at most: how those passages (or their absence) led to what the agent said",
 "fix": "one or two sentences: a general change that stops this and every similar case (not only this exact example), made to the existing lines you quoted (reword, tighten, add a clause or an example) wherever possible; suggest a new line only if the cause is 'missing'. For 'ignored', say how to make that rule stronger in place (name the exact phrase to avoid, give the line to say instead)",
 "section": one of [${version.order.join(', ')}] — the builder section the fix belongs in,
 "severity": "high" | "medium" | "low" (high = compliance, threats, wrong amounts, disclosure to someone else),
 "type": "compliance" | "behaviour" | "tone" | "speech" | "knowledge" | "policy" | "platform",
 "scope": "shared" if every client's agent would need this fix, else "client"}`;
  const r = await llm.json(req, { maxTokens: 3000 });
  const d = r.data || {};
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const flat = norm(text0);
  const quotes = (Array.isArray(d.quotes) ? d.quotes : []).map(String).filter(Boolean).map(q => ({ text: q, found: flat.includes(norm(q)) }));
  const section = version.order.includes(d.section) ? d.section : (core.heuristicMap(`${note} ${d.fix || ''}`, version.order, version.sections).section);
  const tags = core.blockTags(version.sections[section] || '');
  return {
    section, block: tags[0] ? tags[0].id : '', layer: tags[0] ? tags[0].layer : SEC_LAYER[section] || 'L6',
    type: String(d.type || 'behaviour'), severity: ['high', 'medium', 'low'].includes(d.severity) ? d.severity : 'medium', scope: d.scope === 'shared' ? 'shared' : 'client',
    what: String(d.what || ''), cause: ['missing', 'unclear', 'conflict', 'ignored', 'data'].includes(d.cause) ? d.cause : 'unclear',
    quotes, diagnosis: String(d.why || ''), fix: String(d.fix || ''), via: 'ai', provider: r.provider,
  };
}


// ---- Agent factory: build a new agent's prompt from template agents + the client's brief ----
// Sarvam's own prompt skeleton (from sarvam://playbooks/agents), in its required order.
const SKELETON = [
  ['persona', 'Persona', 'Role, who the agent works for, scripted answer to "Are you AI?"'],
  ['environment', 'Environment & Situation', 'Channel, call direction, who the user is and why they are called now'],
  ['objective', 'Objective', 'Primary goal and the second-best outcome'],
  ['style', 'Speaking style rules', 'Turn length, spoken-form rules, address forms, one question then stop'],
  ['facts', 'Facts', 'Stable product facts and the call variables as {{name}}'],
  ['guidelines', 'Conversation guidelines', 'The phased flow: identity, opener, payment, objections, dates, closing, every branch ending somewhere'],
  ['guardrails', 'Guardrails', 'Rule-conflict order, compliance, confidentiality, unhappy paths, affirmative rules'],
];
const briefText = b => Object.entries({
  'Client (as the agent says it)': b.client, 'Legal name': b.legalName, Product: b.product, 'Bucket / DPD': b.bucket, 'Agent type': b.agentType,
  'Agent name': b.agentName, 'Agent voice': b.gender, Tone: b.tone, Languages: (b.languages || []).join(', '), 'Success = ': b.success,
  'Allowed policies': b.policies, 'Must / must not': b.compliance, 'Other notes': b.notes,
}).filter(([, v]) => v && String(v).trim()).map(([k, v]) => `${k}: ${v}`).join('\n');

// Which template sections to reuse for each part of the new prompt, and what's missing.
async function factoryMap(brief, materials, templates) {
  const req = `You are planning a new voice agent's prompt (Indian lending and similar phone calls) from reusable sections of APPROVED TEMPLATE agents. Pick, for each part of Sarvam's prompt skeleton, the template sections that are the best starting point for THIS client, and say what has to be newly written.

THE NEW AGENT:
${briefText(brief)}
${materials ? `\nCLIENT MATERIAL (product info / sample calls), excerpt:\n${materials.slice(0, 12000)}\n` : ''}
SARVAM'S PROMPT SKELETON (target parts, in order):
${SKELETON.map(([id, t, d]) => `- ${id}: ${t} (${d})`).join('\n')}

TEMPLATE AGENTS AND THEIR SECTIONS (agent id, section id, preview):
${templates.map(t => `=== AGENT ${t.id}: ${t.name} (${t.client || 'client ?'}, ${t.product || ''} ${t.stage || ''}, tone ${t.tone || '?'}${t.tests ? `, regression tests ${t.tests}` : ''})${t.note ? ` note: ${t.note}` : ''}
${t.sections.map(s => `[${s.id}] ${s.title}: ${s.preview}`).join('\n')}`).join('\n\n').slice(0, 90000)}

For each skeleton part: choose 0 to 3 template sections (agent id + section id) to build it from, ranked best first. Prefer sections that fit this client's product, bucket, tone and language, and agents whose tests pass. Then list what the brief or client material needs that none of those sections cover (these become NEW lines).
Reply with only JSON:
{"similar": [{"agent": "agent id", "why": "one sentence on why this agent is close"}],
 "parts": [{"part": "skeleton part id", "sources": [{"agent": "agent id", "section": "section id", "why": "short"}], "gaps": ["what has to be newly written"]}]}`;
  const r = await llm.json(req, { maxTokens: 6000, timeoutMs: 180000 });
  const d = r.data || {};
  const ids = new Set(templates.map(t => t.id));
  const secOk = (a, s) => { const t = templates.find(x => x.id === a); return t && t.sections.some(x => x.id === s); };
  return {
    similar: (Array.isArray(d.similar) ? d.similar : []).filter(x => x && ids.has(x.agent)).map(x => ({ agent: x.agent, why: String(x.why || '') })),
    parts: SKELETON.map(([id, title]) => {
      const p = (Array.isArray(d.parts) ? d.parts : []).find(x => x && x.part === id) || {};
      return { part: id, title, sources: (Array.isArray(p.sources) ? p.sources : []).filter(s => s && secOk(s.agent, s.section)).slice(0, 3).map(s => ({ agent: s.agent, section: s.section, why: String(s.why || '') })),
        gaps: (Array.isArray(p.gaps) ? p.gaps : []).map(String).filter(Boolean).slice(0, 8) };
    }),
    provider: r.provider,
  };
}

// Write the new prompt: Sarvam's skeleton, built from the chosen template sections, adapted to the
// client, with every newly written line listed so it can be shown as NEW.
async function factoryAssemble(brief, materials, parts, guidance) {
  const req = `Write the full prompt for a NEW voice agent, following Sarvam's own prompt-writing guidance exactly (below). Build each part from the TEMPLATE SECTIONS given for it: keep what works, adapt names, product, amounts and variables to this client, drop what doesn't apply. Add what the brief and client material need that the templates don't cover.

THE NEW AGENT:
${briefText(brief)}
${materials ? `\nCLIENT MATERIAL (product info / sample calls). Use its facts, its customers' real questions and objections, and the style that worked; never invent facts beyond it:\n${materials.slice(0, 30000)}\n` : ''}
SARVAM'S PROMPT GUIDANCE (follow it):
${String(guidance || '').slice(0, 14000)}

PARTS AND THEIR TEMPLATE SECTIONS:
${parts.map(p => `=== ${p.title} (${p.part})
${p.sources.length ? p.sources.map(s => `--- from ${s.agentName} / ${s.sectionTitle}:\n${s.text}`).join('\n') : '(no template section: write it new)'}
${p.gaps.length ? `Needs, not covered by the templates: ${p.gaps.join('; ')}` : ''}`).join('\n\n').slice(0, 120000)}

Rules: "## " headings only, one per part, in the skeleton order. English in Latin script. Call values as {{snake_case}} variables. No amounts, dates or names written as fixed text where a variable belongs. Never invent product facts, fees or policies the brief and material don't give; where something is needed but unknown, write a clear placeholder like [CONFIRM: late fee amount] so it is caught in review.
Reply with only JSON:
{"name": "agent name derived from what the call does",
 "greeting": "the opening line, under 25 words, with variables",
 "parts": [{"part": "skeleton part id", "text": "the full text of this part, starting with its ## heading", "from": ["agent id / section id used"], "newLines": ["each line in this part that is newly written, copied exactly"]}],
 "variables": [{"name": "snake_case", "description": "what it holds", "example": "sample value", "afterCall": false}],
 "outcomes": ["the call outcomes the flow can reach"],
 "placeholders": ["every [CONFIRM: ...] you left"]}`;
  const r = await llm.json(req, { maxTokens: 32000, timeoutMs: 420000 });
  const d = r.data || {};
  const out = (Array.isArray(d.parts) ? d.parts : []).filter(p => p && p.text).map(p => ({ part: String(p.part || ''), text: String(p.text).trim(), from: (p.from || []).map(String), newLines: (p.newLines || []).map(String).filter(Boolean) }));
  if (!out.length) throw draftErr('The AI didn\'t return a prompt. Try Build again.');
  return { name: String(d.name || ''), greeting: String(d.greeting || ''), parts: out, variables: (Array.isArray(d.variables) ? d.variables : []).filter(v => v && /^[a-z_][a-z0-9_]*$/i.test(v.name || '')).map(v => ({ name: v.name, description: String(v.description || ''), example: String(v.example || ''), afterCall: !!v.afterCall })),
    outcomes: (d.outcomes || []).map(String), placeholders: (d.placeholders || []).map(String), provider: r.provider };
}

// Check a prompt against Sarvam's guidance and common collections pitfalls.
async function factoryReview(text, greeting, brief, guidance) {
  const req = `Review a new voice agent's prompt against Sarvam's prompt-writing guidance (below) and the client brief. Find real problems only: missing skeleton parts or wrong order, monologues or lists read aloud, more than one question per turn, missing stop-and-wait, identity not confirmed before account details, missing unhappy paths (wrong person, busy, callback, hostility, dispute, silence, already paid), dead-end branches, missing confidentiality guardrail or "Are you AI?" answer, rule-conflict order missing, first-person or hedging wording, hand-written non-English lines, timing directives, invented facts, unfilled [CONFIRM] placeholders, brief requirements not covered.

BRIEF:
${briefText(brief)}

GUIDANCE:
${String(guidance || '').slice(0, 14000)}

GREETING: ${greeting}
PROMPT:
<<<
${String(text).slice(0, 120000)}
>>>

Reply with only JSON: {"score": 0-100, "summary": "one sentence", "issues": [{"severity": "high" | "medium" | "low", "part": "which part", "issue": "one sentence", "fix": "one sentence instruction to fix it"}]}. At most 12 issues, most serious first.`;
  const r = await llm.json(req, { maxTokens: 6000, timeoutMs: 240000 });
  const d = r.data || {};
  return { score: Number(d.score) || null, summary: String(d.summary || ''), provider: r.provider,
    issues: (Array.isArray(d.issues) ? d.issues : []).filter(x => x && x.issue).slice(0, 12).map(x => ({ severity: ['high', 'medium', 'low'].includes(x.severity) ? x.severity : 'medium', part: String(x.part || ''), issue: String(x.issue), fix: String(x.fix || '') })) };
}

// Apply reviewer notes / review fixes to a whole prompt as exact edits (nothing else changes).
async function factoryRevise(text, notes, guidance) {
  const req = `Revise this voice agent prompt to address the notes below. Make the smallest edits that fully address each note; keep everything else exactly as it is. Follow Sarvam's guidance where relevant.

NOTES:
${notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}

GUIDANCE (excerpt):
${String(guidance || '').slice(0, 8000)}

PROMPT:
<<<
${text}
>>>

Each edit replaces an exact passage: "old_text" copied exactly from the prompt (whole lines, appearing once), "new_text" its replacement ("" deletes; to add, include the line before it in both).
Reply with only JSON: {"edits": [{"old_text": "...", "new_text": "..."}], "summary": "one sentence"}`;
  const r = await llm.json(req, { maxTokens: 12000, timeoutMs: 240000 });
  const edits = ((r.data && r.data.edits) || []).filter(e => e && typeof e.old_text === 'string' && typeof e.new_text === 'string');
  const out = applyEdits(text, edits);
  return { text: out.text, applied: edits.length - out.failed.length, failed: out.failed.length, summary: String((r.data && r.data.summary) || ''), provider: r.provider };
}

// ---- Regression tests ----
// Turn fixed feedback into small test cases: what the customer says, what the agent must and must not do.
async function buildTests(items) {
  const req = `Turn each piece of feedback about a ${K().agent} (${K().domain}) into a short regression test that checks the problem doesn't come back.

${items.map((it, i) => `ITEM ${i + 1}
Feedback: ${it.text}
${it.fix ? `Fix that was applied: ${it.fix}\n` : ''}${(it.notes || []).length ? `Reviewer notes: ${it.notes.join(' | ')}\n` : ''}${(it.excerpt || []).length ? `From the real call:\n${it.excerpt.map(x => `${x.role === 'agent' ? 'Agent' : 'Customer'}: ${x.text}`).join('\n')}\n` : ''}`).join('\n')}
For each item write: the customer's lines that set up the situation, starting AFTER identity is confirmed and the overdue amount was raised (1 to 4 lines, in the same language the call used, Hindi stays Hindi; if there was no call, write natural lines), what the agent MUST do in its reply to the last line, and what it must NOT do. Use concrete details (dates relative to today, e.g. "today is the 7th, customer says the 17th").
Reply with only JSON: {"tests": [{"item": item number, "title": "short name", "customer": ["line 1", "line 2"], "expect": "what the agent must do", "avoid": "what it must not do"}]}`;
  const r = await llm.json(req, { maxTokens: 8000 });
  return ((r.data && r.data.tests) || []).filter(t => t && Array.isArray(t.customer) && t.customer.length && t.expect).map(t => ({ item: Number(t.item), title: String(t.title || ''), customer: t.customer.map(String).slice(0, 6), expect: String(t.expect), avoid: String(t.avoid || '') }));
}
// Play one test against a prompt: the model acts as the agent (simulated, not Sarvam's own runtime),
// then a separate read judges the reply against the test.
async function runTest(text, greeting, test, today) {
  const sim = `You ARE the voice agent below. Follow its prompt exactly, as you would on a live phone call. Reply only as the agent.
Today is ${today}. Call variables you don't have: assume sensible values (customer name Rahul, EMI amount 4500, 15 days overdue).

AGENT PROMPT:
<<<
${String(text).slice(0, 150000)}
>>>

The call so far (identity is already confirmed and the overdue EMI has been raised: the test starts after that, so do not ask who you are speaking with again unless the test lines make it necessary):
Agent: ${greeting || '(greeting)'}
Customer: Haan, main Rahul hi bol raha hoon.
Agent: [confirms, states the overdue EMI of 4500 rupees, 15 days pending, and asks for payment today, as the prompt says]
${test.customer.map((l, i) => `Customer: ${l}${i < test.customer.length - 1 ? '\nAgent: [reply ' + (i + 1) + ']' : ''}`).join('\n')}

Write the agent's reply to EACH customer line in order, as the agent would speak them.
Reply with only JSON: {"replies": ["reply to line 1", "reply to line 2", ...]}`;
  let s; try { s = await llm.json(sim, { maxTokens: 3000 }); } catch (e) { s = await llm.json(sim, { maxTokens: 4000 }); } // one retry on a garbled reply
  const replies = ((s.data && s.data.replies) || []).map(String);
  const transcript = test.customer.map((l, i) => `Customer: ${l}\nAgent: ${replies[i] || '(no reply)'}`).join('\n');
  const judge = `A regression test for a ${K().agent}. Judge ONLY the agent's last reply (and the earlier ones if the test is about the sequence).
Today in this simulation is ${today}. If the test was written for a different "today", shift its dates by the difference before judging (e.g. "tomorrow" means the day after ${today}; a halfway date is halfway between ${today} and the customer's date). Judge the behaviour, not wording or small rounding.`;
  const judgeBody = `
Must do: ${test.expect}
Must not do: ${test.avoid || '(nothing specific)'}

CONVERSATION:
${transcript}

Reply with only JSON: {"pass": true | false, "why": "one sentence"}`;
  let j; try { j = await llm.json(judge + judgeBody, { maxTokens: 600 }); } catch (e) { j = await llm.json(judge + judgeBody, { maxTokens: 1000 }); } // one retry on a garbled reply
  return { pass: !!(j.data && j.data.pass), why: String((j.data && j.data.why) || ''), replies, provider: s.provider };
}

// Optimize a prompt that has grown long and cluttered: rules said twice, rules that contradict,
// wordy passages, dead references. Returns exact edits on the full text, each with its reason and
// whether it changes what the agent does (those are left for the reviewer to decide).
async function optimizePrompt(text, { focus, greeting } = {}) {
  const T = String(text || '');
  const req = `You are tidying a long voice-agent prompt (${K().t}, ${K().domain}). It has grown through many fixes and now has noise. Make it shorter and cleaner WITHOUT losing anything the agent needs.

Find and fix, in this order of value:
1. "contradiction": two places that tell the agent different things. Propose ONE resolution (keep the stricter or more recent-looking rule, and say which you chose and why). Mark changesBehaviour true.
2. "duplicate": the same rule, list or example stated in more than one place. Keep the clearest copy in the most logical place and delete or shorten the others to a short pointer only if needed.
3. "verbose": a passage that can say the same thing in fewer words: repeated qualifiers, long-winded examples, stacked caveats, the same example given three ways.
4. "outdated": references to sections, tools, variables or steps that no longer exist in the prompt, or leftover notes.
5. "unclear": wording the agent could read two ways; rewrite so it can only be read one way (this may be longer).

Hard rules:
- Never drop the MEANING of any rule, condition, exception, number, script line or example that changes behaviour. Shorter must mean the same.
- Never weaken compliance lines (recording disclosure, identity checks, no disclosure to third parties, no threats, calling hours, no outcome promises).
- Keep {{variables}}, tool names (e.g. end_interaction, log_disposition), markdown headings and numbering style, and every language and script exactly as the prompt uses them. Hindi stays in the same script.
- Never shorten, merge or replace with a pointer any line the agent SPEAKS word for word (end_message lines, quoted scripts, closings, disclosures), even if the same line appears elsewhere: the agent must find it whole where it needs it. Cross-references are fine only for instructions, never for spoken lines.
- Do not reorganise the whole prompt or rename headings. Make targeted edits.
${focus ? `- The reviewer asked you to focus on: ${focus}\n` : ''}${greeting ? `- The agent's greeting (spoken first; don't duplicate it in the prompt): ${greeting}\n` : ''}
Each edit replaces an exact passage: "old_text" copied character for character from the prompt (whole lines), appearing only once in it; "new_text" is what replaces it ("" deletes it).

THE PROMPT (${T.length} characters):
<<<
${T.slice(0, 160000)}
>>>

Reply with only JSON:
{"summary": "two sentences: the main sources of clutter",
 "edits": [{"type": "contradiction" | "duplicate" | "verbose" | "outdated" | "unclear",
   "title": "short name of the change",
   "reason": "one sentence: what was wrong and what you did",
   "changesBehaviour": true | false,
   "old_text": "...", "new_text": "..."}]}
Up to 25 edits, biggest win first. Keep reasons short.`;
  const r = await llm.json(req, { maxTokens: 24000, timeoutMs: 300000 });
  const d = r.data || {};
  const edits = [];
  for (const e of (Array.isArray(d.edits) ? d.edits : []).slice(0, 25)) {
    if (!e || typeof e.old_text !== 'string' || !e.old_text.trim() || typeof e.new_text !== 'string') continue;
    // Keep only edits whose old text is in the prompt exactly once (line breaks either way).
    const out = applyEdits(T, [e]);
    if (out.failed.length) continue;
    edits.push({ id: edits.length, type: ['contradiction', 'duplicate', 'verbose', 'outdated', 'unclear'].includes(e.type) ? e.type : 'verbose',
      title: String(e.title || ''), reason: String(e.reason || ''), changesBehaviour: !!e.changesBehaviour || e.type === 'contradiction',
      old_text: e.old_text, new_text: e.new_text, saved: e.old_text.length - e.new_text.length });
  }
  return { summary: String(d.summary || ''), edits, dropped: (Array.isArray(d.edits) ? d.edits.length : 0) - edits.length, provider: r.provider };
}

// A whole call transcript (uploaded or pasted from UAT) read against the prompt the agent had.
// Lists only what went wrong: each mistake with the moment, its cause in the prompt and a general fix.
async function analyzeTranscript(prompt, version, { text, transcript, note }) {
  const req = `You review a full call made by a ${K().agent} (${K().domain}) during UAT. Find EVERYTHING the agent did wrong on this call. Do not list what went well.

Look for: compliance problems (recording disclosure, identity check before details, telling a third party about the debt, threats or pressure, calling-hours, promises of outcomes, invented facts or amounts), wrong or missed policy steps (dates, partial payment, promise-to-pay, payment link, escalation), wrong facts or amounts, ignoring what the customer said, repeating itself, asking needless questions, not answering a question, wrong language or script, robotic or unnatural speech, interrupting, bad closing or a missing disposition. Also note a missed opportunity that cost the call (e.g. never asked for a date).
${note ? `The reviewer says: ${note}\n` : ''}
TRANSCRIPT (as given; speakers may be labelled in any way):
<<<
${String(transcript).slice(0, 60000)}
>>>

THE AGENT'S PROMPT (what the agent was told):
<<<
${String(text || '').slice(0, 140000)}
>>>

For each mistake, find why it happened in the prompt: "missing" (nothing covers it), "unclear", "conflict" (two rules pull different ways), "ignored" (the prompt says the right thing and the agent didn't follow it), or "data" (a wrong or missing call input). Merge repeats of the same mistake into one entry. Most serious first.
Reply with only JSON:
{"summary": "two sentences: how the call went wrong overall",
 "mistakes": [{"moment": "the agent's words at that point, copied from the transcript (shorten with … if long)",
   "customer": "what the customer said just before, copied from the transcript, or \\"\\"",
   "what": "one sentence: what the agent did wrong",
   "cause": "missing" | "unclear" | "conflict" | "ignored" | "data",
   "quotes": ["up to 2 passages copied EXACTLY from the prompt that caused it or should have stopped it; [] if missing"],
   "why": "one or two sentences: how the prompt led to it",
   "fix": "one or two sentences: a general change to the existing rules that stops this and every similar case",
   "section": one of [${version.order.join(', ')}],
   "severity": "high" | "medium" | "low" (high = compliance, customer harm, wrong amounts),
   "type": "compliance" | "behaviour" | "tone" | "speech" | "knowledge" | "policy" | "platform",
   "scope": "shared" if every client's agent would need the fix, else "client"}]}
At most 12 mistakes. Keep every field short.`;
  const r = await llm.json(req, { maxTokens: 12000 });
  const d = r.data || {};
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const flat = norm(String(text || '').slice(0, 140000));
  const mistakes = (Array.isArray(d.mistakes) ? d.mistakes : []).filter(x => x && x.what).slice(0, 12).map(x => {
    const section = version.order.includes(x.section) ? x.section : core.heuristicMap(`${x.what} ${x.fix || ''}`, version.order, version.sections).section;
    const tags = core.blockTags(version.sections[section] || '');
    return { moment: String(x.moment || ''), customer: String(x.customer || ''), what: String(x.what), why: String(x.why || ''), fix: String(x.fix || ''),
      cause: ['missing', 'unclear', 'conflict', 'ignored', 'data'].includes(x.cause) ? x.cause : 'unclear',
      quotes: (Array.isArray(x.quotes) ? x.quotes : []).map(String).filter(Boolean).slice(0, 2).map(q => ({ text: q, found: flat.includes(norm(q)) })),
      section, block: tags[0] ? tags[0].id : '', layer: tags[0] ? tags[0].layer : SEC_LAYER[section] || 'L6',
      severity: ['high', 'medium', 'low'].includes(x.severity) ? x.severity : 'medium', type: String(x.type || 'behaviour'), scope: x.scope === 'shared' ? 'shared' : 'client' };
  });
  return { summary: String(d.summary || ''), mistakes, provider: r.provider };
}

// "Check this fix": a second, critical read of a drafted fix before it's applied. Walks likely
// customer cases through the revised rules, finds gaps, conflicts, over-narrow wording and risks,
// and turns each problem into a note the reviewer can tick to redraft with.
async function critiqueFix(prompt, version, item) {
  const m = item.map, d = item.draft;
  if (!d) throw draftErr('Draft a fix first.');
  const changed = d.sections || { [m.section]: d.revised };
  const diff = Object.entries(changed).map(([s, t]) => {
    const before = (version.sections[s] || '').split(/\r?\n/), after = String(t).split(/\r?\n/);
    const NL = String.fromCharCode(10);
    const removed = before.filter(l => l.trim() && !after.includes(l)).map(l => '- ' + l);
    const added = after.filter(l => l.trim() && !before.includes(l)).map(l => '+ ' + l);
    return [`=== ${secT(version, s)} ===`, ...removed, ...added].join(NL);
  }).join(String.fromCharCode(10, 10));
  const full = { ...version.sections, ...changed };
  const notes = (item.guidance || []).map((g, i) => `${i + 1}. ${g.text}`).join(String.fromCharCode(10));
  const req = `You are a strict reviewer of a proposed fix to a ${K().t} voice-agent prompt (${K().domain}). Another AI drafted the fix from feedback. Pick it apart before it goes live.

Feedback: ${item.text}
${m.diagnosis ? `Diagnosis: ${m.diagnosis}
` : ''}${notes ? `Reviewer's notes (these are requirements; check the fix meets every one):
${notes}
` : ''}
THE PROPOSED CHANGE (- removed line, + added line):
${diff.slice(0, 20000)}

THE WHOLE PROMPT WITH THE CHANGE APPLIED, BY SECTION:
${version.order.filter(s => (full[s] || '').trim()).map(s => `=== ${secT(version, s)} ===\n${full[s]}`).join('\n\n').slice(0, 140000)}

Check:
1. Does it fix the general behaviour, or only the exact example in the feedback?
2. Walk 5 to 8 realistic customer cases through the CHANGED prompt (variations of the feedback's situation plus edge cases: invalid dates, dates near today, month ends, the customer changing their mind, refusals, Hindi replies). For each, say what the agent would now do and whether that is right.
3. Does it contradict or duplicate any other rule anywhere in the prompt?
4. Does it meet every reviewer note?
5. Compliance and tone risks: pressure, threats, invented facts or amounts, disclosure.
6. Is anything vague enough that the agent could read it two ways?

Reply with only JSON:
{"verdict": "ready" | "needs work",
 "headline": "one sentence overall judgement",
 "cases": [{"case": "what the customer says or does", "agent": "what the agent would do under the changed prompt", "ok": true | false, "why": "only if not ok: one short sentence"}],
 "suggestions": [{"issue": "one sentence: the problem", "note": "an instruction to the AI that redrafts the fix, written as the reviewer would say it", "severity": "high" | "medium" | "low"}]}
Give suggestions only for real problems (0 to 6), [] if the fix is ready. Keep every field short: at most 30 words each.`;
  const r = await llm.json(req, { maxTokens: 12000 });
  const x = r.data || {};
  return { verdict: x.verdict === 'ready' ? 'ready' : 'needs work', headline: String(x.headline || ''), provider: r.provider,
    cases: (Array.isArray(x.cases) ? x.cases : []).filter(c => c && c.case).slice(0, 10).map(c => ({ case: String(c.case), agent: String(c.agent || ''), ok: c.ok !== false, why: String(c.why || '') })),
    suggestions: (Array.isArray(x.suggestions) ? x.suggestions : []).filter(s => s && s.note).slice(0, 8).map(s => ({ issue: String(s.issue || ''), note: String(s.note), severity: ['high', 'medium', 'low'].includes(s.severity) ? s.severity : 'medium' })) };
}

// Several mistakes flagged on one call, each with what happened and what should have happened, read
// TOGETHER: issues with the same root cause are grouped, so they get one fix instead of several.
async function diagnoseGroup(prompt, version, { text, turns, issues, note, callInfo }) {
  const fmt = (t, i) => `[${i}] ${t.role === 'agent' ? 'AGENT' : t.role === 'user' ? 'CUSTOMER' : String(t.role).toUpperCase()}: ${t.text}`;
  const req = `A reviewer listened to a real ${K().call} (${K().domain}) and flagged several moments where the agent went wrong. For each they wrote what happened and what should have happened. Find the ROOT CAUSES in the agent's prompt. Group issues that come from the same cause; one cause can explain several issues.
${note ? `Reviewer's overall note: ${note}\n` : ''}${callInfo ? `Call details: ${callInfo}\n` : ''}
FLAGGED ISSUES:
${issues.map((x, k) => `ISSUE ${k + 1} at turn [${x.turn}]
  What happened: ${x.happened || '(not written: work it out from the transcript)'}
  What should have happened: ${x.should || '(not written)'}`).join('\n')}

FULL TRANSCRIPT:
${turns.map(fmt).join('\n').slice(0, 40000)}

THE AGENT'S PROMPT (exactly as the agent had it):
<<<
${String(text || '').slice(0, 140000)}
>>>

For each root cause: which issues it explains, the cause type ("missing" | "unclear" | "conflict" | "ignored" | "data"), up to 3 passages copied EXACTLY from the prompt, why it led to those issues, and ONE general fix to the existing rules that makes every one of those issues go the way the reviewer said it should (not only these exact examples).
Reply with only JSON:
{"summary": "one or two sentences: what links these mistakes",
 "causes": [{"issues": [issue numbers], "title": "short name", "cause": "...", "quotes": ["..."], "why": "...", "fix": "...",
   "section": one of [${version.order.join(', ')}], "severity": "high" | "medium" | "low", "type": "compliance" | "behaviour" | "tone" | "speech" | "knowledge" | "policy" | "platform", "scope": "shared" | "client"}]}
Every issue must belong to exactly one cause.`;
  const r = await llm.json(req, { maxTokens: 8000 });
  const d = r.data || {};
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const flat = norm(String(text || '').slice(0, 140000));
  const causes = (Array.isArray(d.causes) ? d.causes : []).filter(c => c && c.fix).map(c => {
    const section = version.order.includes(c.section) ? c.section : core.heuristicMap(`${c.title} ${c.fix}`, version.order, version.sections).section;
    const tags = core.blockTags(version.sections[section] || '');
    return { issues: (Array.isArray(c.issues) ? c.issues : []).map(Number).filter(n => n >= 1 && n <= issues.length), title: String(c.title || ''),
      cause: ['missing', 'unclear', 'conflict', 'ignored', 'data'].includes(c.cause) ? c.cause : 'unclear',
      quotes: (Array.isArray(c.quotes) ? c.quotes : []).map(String).filter(Boolean).slice(0, 3).map(q => ({ text: q, found: flat.includes(norm(q)) })),
      diagnosis: String(c.why || ''), fix: String(c.fix), section, block: tags[0] ? tags[0].id : '', layer: tags[0] ? tags[0].layer : SEC_LAYER[section] || 'L6',
      severity: ['high', 'medium', 'low'].includes(c.severity) ? c.severity : 'medium', type: String(c.type || 'behaviour'), scope: c.scope === 'shared' ? 'shared' : 'client' };
  });
  // Any issue the model forgot to place gets its own cause slot, so nothing a reviewer flagged is dropped.
  const placed = new Set(causes.flatMap(c => c.issues));
  issues.forEach((x, k) => { if (!placed.has(k + 1) && causes[0]) causes[0].issues.push(k + 1); });
  return { summary: String(d.summary || ''), causes, provider: r.provider };
}

// Plain-language summary of how two agents' prompts differ, for the Compare page.
async function compareSummary(a, b) {
  const side = (x, k) => `AGENT ${k}: ${x.name} (${x.client || 'client unknown'})
Greeting: ${x.greeting || '(none)'}
Languages: ${x.languages || '(unknown)'}
Prompt:
<<<
${String(x.text || '').slice(0, 70000)}
>>>`;
  const req = `Compare two ${K().t} voice-agent prompts (${K().domain}). A team lead wants to know how the two agents will behave differently on real calls.
Cover what matters: compliance (recording disclosure, identity check, third-party disclosure, threats, calling hours), collection policy (partial payment, promise-to-pay, waivers, links, escalation), tone, branding (who the agent says it is and calls for), product facts, languages, objection handling, closing. Skip wording differences that don't change behaviour.

${side(a, 'A')}

${side(b, 'B')}

Reply with only JSON:
{"headline": "one sentence on the biggest practical difference",
 "differences": [{"area": "short area name", "a": "what A does, one sentence", "b": "what B does, one sentence", "risk": "high" | "medium" | "low" (high = a compliance or customer-harm gap on one side)}],
 "same": "one sentence on what they share"}
At most 10 differences, most important first.`;
  const r = await llm.json(req, { maxTokens: 4000 });
  const d = r.data || {};
  return { headline: String(d.headline || ''), same: String(d.same || ''), provider: r.provider,
    differences: (Array.isArray(d.differences) ? d.differences : []).filter(x => x && x.area).slice(0, 10).map(x => ({ area: String(x.area), a: String(x.a || ''), b: String(x.b || ''), risk: ['high', 'medium', 'low'].includes(x.risk) ? x.risk : 'low' })) };
}

module.exports = { resplit, readImagesToText, reviewWithFixes, kbFromDocs, SKELETON, factoryMap, factoryAssemble, factoryReview, factoryRevise, diagnoseGroup, buildTests, runTest, optimizePrompt, applyEdits, analyzeTranscript, critiqueFix, mapFeedback, draftFix, review, kbDraft, importPrompt, diagnoseCall, compareSummary };
