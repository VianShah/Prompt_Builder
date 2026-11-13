// AI tasks behind the rule library and the 3-step New prompt.
//
// Every agent type (collections, sales) has its own skeleton and its own library:
//   skeleton : the section structure every prompt of that type follows (Greeting + the parts of the
//              Instructions), derived from the live agents (or from documents when there are none)
//   library  : rules grouped by section, extracted from all live agents, near-duplicates merged
// A new prompt is assembled from library rules section by section; "Refine" tailors one rule to the
// new agent and saves it back to the library as a variant.
//
// Placeholders: [[param]] = a value filled per agent (client name, product facts...);
// {{variable}} = a Sarvam call variable, always kept exactly as written.
const llm = require('./llm');

const TYPES = { collections: 'Collections', sales: 'Sales' };
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'section';
const clip = (s, n) => String(s || '').slice(0, n);
const err = msg => Object.assign(new Error(msg), { code: 'invalid_json', publicMessage: msg });

// ---------- skeleton ----------
function normSkeleton(d, agentType) {
  const seen = new Set();
  const sections = (Array.isArray(d.sections) ? d.sections : []).filter(x => x && x.title).map(x => {
    let id = slug(x.id || x.title); while (seen.has(id)) id += '-2'; seen.add(id);
    return { id, title: clip(x.title, 80), mandatory: x.mandatory !== false, desc: clip(x.desc, 300), aliases: (Array.isArray(x.aliases) ? x.aliases : []).map(a => clip(a, 80)).slice(0, 8), kb: !!x.kb };
  }).slice(0, 30);
  if (!sections.length) throw err('The AI found no common sections. Check that the agents have prompts loaded, then try again.');
  return { agentType, greeting: { desc: clip((d.greeting && d.greeting.desc) || d.greetingDesc || 'The first line the agent speaks.', 300) }, sections };
}

// The parts every prompt of this type has, in order. prompts: [{ agent, greeting, text }]
async function deriveSkeleton({ agentType, prompts }) {
  const list = (prompts || []).filter(p => p && String(p.text || '').trim()).slice(0, 25);
  if (!list.length) throw err('No agent of this type has a prompt in the builder yet. Load the prompts from Sarvam first.');
  const per = Math.max(3000, Math.floor(140000 / list.length));
  const req = `These are the prompts of ${list.length} live ${TYPES[agentType] || agentType} voice agents (Indian lending, phone calls). Sarvam takes every prompt as a GREETING (the first line spoken) plus INSTRUCTIONS.
Work out the standard STRUCTURE of the Instructions that these agents share: the sections, in the order they usually appear (for example Introduction, Environment, Objective, Rules, Conversation flow, Objections, Knowledge base, Closing — use the agents' own section names where they agree).
- "mandatory": true when (nearly) every agent has the section, false when only some do.
- "desc": one sentence on what the section holds.
- "aliases": other headings agents use for the same section.
- "kb": true for the section that holds product facts / FAQs (at most one).
Only sections that really appear in the prompts. Do not invent sections.

Reply with only JSON: {"greeting": {"desc": "one sentence"}, "sections": [{"id": "snake_case", "title": "Title", "mandatory": true, "desc": "", "aliases": [""], "kb": false}]}

PROMPTS:
${list.map((p, i) => `=== AGENT ${i + 1}: ${clip(p.agent, 120)} ===\nGREETING: ${clip(p.greeting, 600)}\nINSTRUCTIONS:\n${clip(p.text, per)}`).join('\n\n')}`;
  const r = await llm.json(req, { maxTokens: 6000, timeoutMs: 300000 });
  return { ...normSkeleton(r.data || {}, agentType), derivedFrom: list.map(p => p.agent), provider: r.provider };
}

// ---------- extract one agent's rules ----------
const secLine = s => `- ${s.id}: ${s.title}${s.aliases && s.aliases.length ? ` (also called: ${s.aliases.join(', ')})` : ''}${s.desc ? ` — ${s.desc}` : ''}`;
async function extractRules({ skeleton, agent, client, text }) {
  const T = String(text || '');
  const req = `Split this voice agent's prompt into RULES and place each in a section of the standard structure below.
A rule is one self-contained instruction or step (a short paragraph or a few lines). Keep the agent's wording and language exactly (Hindi stays Hindi), but replace the client's company name with [[client_name]], the agent's own name with [[agent_name]], and other client-only fixed facts (product names, helpline numbers, fees) with [[snake_case]] placeholders. Keep {{call_variables}} exactly as written. Remove references to the prompt's own numbering ("as in rule 7").
Cover the whole prompt: every instruction ends up in exactly one rule. Skip only headings.
"title" is a 2–6 word name for what the rule governs (e.g. "Identity check before details", "Partial payment ladder").
"source" is the exact passage the rule came from, copied character for character.

STANDARD SECTIONS:
${skeleton.sections.map(secLine).join('\n')}

AGENT: ${clip(agent, 120)}${client ? ` (client: ${clip(client, 80)})` : ''}
PROMPT (${T.length} characters):
<<<
${T.slice(0, 150000)}
>>>

Reply with only JSON: {"rules": [{"section": "section id", "title": "", "text": "", "source": ""}]}`;
  const r = await llm.json(req, { maxTokens: 24000, timeoutMs: 420000 });
  const ids = new Set(skeleton.sections.map(s => s.id));
  const rules = ((r.data && r.data.rules) || []).filter(x => x && String(x.text || '').trim()).map(x => ({
    section: ids.has(x.section) ? x.section : skeleton.sections[0].id, title: clip(x.title || 'Rule', 80), text: String(x.text).trim(), source: clip(x.source, 4000),
  })).slice(0, 120);
  return { rules, provider: r.provider };
}

// ---------- merge near-duplicates across agents (one section at a time) ----------
// rules: [{ agent, title, text }] -> groups: [{ title, purpose, members: [i], text }]
async function mergeSection({ section, rules }) {
  if (rules.length === 1) return { groups: [{ title: rules[0].title, purpose: '', members: [0], text: rules[0].text }] };
  const req = `Below are rules from several voice agents for the same section: "${section.title}"${section.desc ? ` (${section.desc})` : ''}.
Group the rules that govern the SAME behaviour (they may be worded differently). For each group:
- "title": 2–6 words naming the behaviour
- "purpose": one sentence
- "members": the rule numbers in the group
- "text": the clearest, most complete wording from the group (copy one member's text; you may add a missing condition from another member, never invent one). Keep [[placeholders]] and {{variables}} exactly.
Rules that differ in a real POLICY choice (e.g. one allows partial payments, one does not) belong in different groups.
Every rule number appears in exactly one group.

RULES:
${rules.map((x, i) => `[${i + 1}] (${clip(x.agent, 60)}) ${x.title}\n${clip(x.text, 2500)}`).join('\n\n')}

Reply with only JSON: {"groups": [{"title": "", "purpose": "", "members": [1, 2], "text": ""}]}`;
  const r = await llm.json(req, { maxTokens: 16000, timeoutMs: 300000 });
  const used = new Set();
  const groups = ((r.data && r.data.groups) || []).map(g => ({ title: clip(g.title || 'Rule', 80), purpose: clip(g.purpose, 300), members: (g.members || []).map(n => Number(n) - 1).filter(i => i >= 0 && i < rules.length && !used.has(i) && used.add(i)), text: String(g.text || '').trim() }))
    .filter(g => g.members.length).map(g => ({ ...g, text: g.text || rules[g.members[0]].text }));
  // Anything the model left out becomes its own group, so no rule is lost.
  rules.forEach((x, i) => { if (!used.has(i)) groups.push({ title: x.title, purpose: '', members: [i], text: x.text }); });
  return { groups, provider: r.provider };
}

// ---------- pick the best rules for a new agent ----------
// candidates: { sectionId: [{ ref, title, purpose, text, agents, status }] }
async function bestModules({ skeleton, info, candidates }) {
  const secs = skeleton.sections.filter(s => (candidates[s.id] || []).length);
  if (!secs.length) return { picks: [], gaps: skeleton.sections.filter(s => s.mandatory).map(s => s.id) };
  const req = `Assemble the prompt of a NEW ${TYPES[skeleton.agentType] || ''} voice agent from a library of proven rules taken from live agents.
THE NEW AGENT: ${JSON.stringify(info).slice(0, 3000)}

For each section, choose the rules this agent needs: everything its objective, product and client policy call for, and nothing that contradicts them. Where several rules cover the same behaviour, choose the one that fits this agent best; prefer approved rules. Give a one-sentence reason per pick. List mandatory sections that no rule covers as gaps.

${secs.map(s => `## SECTION ${s.id}: ${s.title}${s.mandatory ? ' (mandatory)' : ''}\n${candidates[s.id].map(c => `[${c.ref}] ${c.title}${c.status === 'approved' ? ' (approved)' : ''} · used by ${(c.agents || []).slice(0, 4).join(', ') || 'built-in'}\n${clip(c.purpose, 200)}\n${clip(c.text, 900)}`).join('\n\n')}`).join('\n\n').slice(0, 160000)}

Reply with only JSON: {"picks": [{"section": "section id", "ref": "the [ref]", "reason": ""}], "gaps": ["section id"]}`;
  const r = await llm.json(req, { maxTokens: 8000, timeoutMs: 300000 });
  const refs = new Set(Object.values(candidates).flat().map(c => c.ref));
  return {
    picks: ((r.data && r.data.picks) || []).filter(p => p && refs.has(String(p.ref))).map(p => ({ section: String(p.section), ref: String(p.ref), reason: clip(p.reason, 300) })),
    gaps: ((r.data && r.data.gaps) || []).map(String).filter(id => skeleton.sections.some(s => s.id === id)), provider: r.provider,
  };
}

// ---------- refine one rule for this agent ----------
async function refineRule({ text, title, section, info, note }) {
  const req = `Tailor this rule of a voice-agent prompt to a NEW agent. Keep what the rule is for, every condition and number that still applies, and every {{call_variable}} exactly. Fill [[placeholders]] you can fill from the agent's details; leave the ones you can't. Change only what this agent's client, product, objective, policy or language need. Do not add new behaviour the details don't call for.
SECTION: ${section || ''}
RULE TITLE: ${title || ''}
RULE:
${String(text).slice(0, 6000)}

THE NEW AGENT: ${JSON.stringify(info).slice(0, 3000)}
${note ? `THE ENGINEER ASKS: ${clip(note, 1000)}\n` : ''}
Reply with only JSON: {"text": "the tailored rule", "changes": "one sentence on what changed and why"}`;
  const r = await llm.json(req, { maxTokens: 4000 });
  const out = String((r.data && r.data.text) || '').trim();
  if (!out) throw err('The AI returned no rule text. Try Refine again.');
  return { text: out, changes: clip(r.data.changes, 400), provider: r.provider };
}

// ---------- a library from documents (agent types with no live agents yet, e.g. sales) ----------
async function libraryFromDocs({ agentType, docs, skeleton }) {
  const list = (docs || []).filter(d => d && String(d.text || '').trim()).slice(0, 20);
  const body = list.map(d => `=== FILE: ${clip(d.name, 160)} ===\n${clip(d.text, 40000)}`).join('\n\n').slice(0, 180000);
  const req = `Design the prompt structure and the rules for a ${TYPES[agentType] || agentType} phone voice agent (India), using ONLY the client documents below (scripts, product sheets, policies, compliance notes).
${skeleton ? `Use this existing structure:\n${skeleton.sections.map(secLine).join('\n')}` : `First propose the structure of the Instructions: the sections in order (e.g. Introduction, Environment, Objective, Compliance and disclosures, Eligibility, Pitch, Objection handling, Consent, Closing). "mandatory" true for sections every agent of this type needs. Mark the product-facts section with "kb": true.`}
Then write the rules for each section: short, self-contained instructions the agent follows on a call. Use [[snake_case]] placeholders for client-specific values and {{snake_case}} for values that come with each call (customer name, offer amount). Never invent facts, fees, offers or compliance wording that the documents don't state; where something is needed but missing, write [CONFIRM: what is missing].

Reply with only JSON: {${skeleton ? '' : '"greeting": {"desc": ""}, "sections": [{"id": "", "title": "", "mandatory": true, "desc": "", "aliases": [], "kb": false}], '}"rules": [{"section": "section id", "title": "", "text": "", "src": "file name"}], "greeting": {"text": "a suggested greeting, or empty"}}

DOCUMENTS:
${body}`;
  const r = await llm.json(req, { maxTokens: 20000, timeoutMs: 420000 });
  const d = r.data || {};
  const sk = skeleton || { ...normSkeleton(d, agentType), derivedFrom: list.map(x => x.name) };
  const ids = new Set(sk.sections.map(s => s.id));
  const rules = (d.rules || []).filter(x => x && String(x.text || '').trim()).map(x => ({ section: ids.has(slug(x.section)) ? slug(x.section) : ids.has(x.section) ? x.section : sk.sections[0].id, title: clip(x.title || 'Rule', 80), text: String(x.text).trim(), src: clip(x.src, 160) })).slice(0, 150);
  return { skeleton: sk, rules, greeting: clip(d.greeting && d.greeting.text, 600), provider: r.provider };
}

// ---------- split a source agent's prompt into the skeleton's sections (no AI: by headings) ----------
function splitBySkeleton(text, skeleton) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const match = h => { const n = norm(h); return skeleton.sections.find(s => [s.title, s.id, ...(s.aliases || [])].some(a => norm(a) && (n === norm(a) || n.includes(norm(a))))); };
  const out = Object.fromEntries(skeleton.sections.map(s => [s.id, []])), extra = [];
  let cur = null, buf = [];
  const flush = () => { const t = buf.join('\n').trim(); if (t) (cur ? out[cur] : extra).push(t); buf = []; };
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    const h = line.match(/^#{1,4}\s+(.+?)\s*#*$/) || line.match(/^\*\*([^*]{3,80})\*\*\s*:?\s*$/);
    if (h) { const s = match(h[1].replace(/^\d+[.)]\s*/, '')); if (s) { flush(); cur = s.id; continue; } }
    if (!line.trim() && buf.join('\n').length > 400) { flush(); continue; }
    buf.push(line);
  }
  flush();
  return { sections: out, unplaced: extra };
}

module.exports = { TYPES, slug, deriveSkeleton, extractRules, mergeSection, bestModules, refineRule, libraryFromDocs, splitBySkeleton };
