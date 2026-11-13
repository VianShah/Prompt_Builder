// Module library tasks. A module is a reusable set of rules for one behaviour (e.g. payment dates),
// with settings, the call values it needs, the outcomes it can reach, and tests.
// Rule text uses two kinds of placeholder:
//   [[client_name]]                      a value filled in when the module is used for an agent
//   <<if family_suggestion>>…<<end>>     a passage kept only when that option is on
// ({{call_variable}} is left alone: it is a Sarvam call value.)
const llm = require('./llm');
const K = require('./agentKind').kind;
const PB = require('../../shared/blocks');
const { applyEdits } = require('./aiTasks');

const draftErr = msg => Object.assign(new Error(msg), { code: 'invalid_json', publicMessage: msg });

function renderRule(text, options, params) {
  return String(text || '')
    .replace(/<<if (\w+)>>([\s\S]*?)<<end>>/g, (_, k, body) => (options && options[k] ? body : ''))
    .replace(/\[\[(\w+)\]\]/g, (m, k) => (params && params[k] != null && String(params[k]).trim() !== '' ? String(params[k]) : m));
}

// Cut one behaviour out of an agent's prompt into a module.
async function moduleExtract(text, { topic, title, tests }) {
  const T = String(text || '');
  const NL = String.fromCharCode(10);
  const testBlock = (tests || []).length
    ? NL + 'EXISTING REGRESSION TESTS of this agent. List, by number, only the ones that check THIS behaviour (not other behaviours):' + NL + tests.map(t => `${t.i}. ${t.title}: ${String(t.expect).slice(0, 160)}`).join(NL) + NL
    : '';
  const req = `You are building a reusable MODULE for a library of voice-agent prompt behaviours (${K().t}, ${K().domain}). Take the behaviour below out of this agent's prompt so other agents can use it.

THE BEHAVIOUR TO EXTRACT: ${topic}
Module title: ${title}

THE AGENT'S PROMPT (${T.length} characters):
<<<
${T.slice(0, 160000)}
>>>

Find EVERY rule, step, example line and script in the prompt that governs this behaviour, wherever it sits (rules, call inputs, flows, objections, dates and so on), including rules that only apply it inside another flow (for example the date step inside a partial-payment flow). Then write the module:

- One entry per rule. "source" is the exact passage(s) from the prompt that the rule came from: copy character for character, whole lines. "text" is the same rule, client-neutral: keep the wording and the language of the source (Hindi stays Hindi), but replace the client's company name and any client-specific fixed facts with [[param_name]] placeholders, and keep {{call_variables}} exactly as written.
- Where the source makes a POLICY CHOICE that another client might decide differently (for example "suggest arranging money from friends or family", "suggest an earlier date", "accept next-month dates on the last day"), wrap that passage in <<if option_id>> ... <<end>> inside the rule text and list the option. The option's default is how this source agent behaves.
- Remove references to the source prompt's own numbering or layout (for example "RULE 8", "RULE 10", "the Facts section", "Guardrails"). Refer to another rule of this module by its title instead (for example "per the Calendar-validity check rule"). Keep the {{call_variables}} and the content of the rule.
- Do not weaken or drop any condition, number or exception. Do not add new rules.
- "slot" is the builder section the rule normally sits in: one of [${PB.CANON.join(', ')}].

Also fill in: purpose (one sentence), trigger (when the module applies), requires (the {{call_variable}} names the rules need), exits (the outcomes or dispositions this behaviour can end in), policyDeps (policy decisions the rules depend on, in words).

${testBlock}
Reply with only JSON:
{"purpose": "...", "trigger": "...", "requires": ["call_variable"], "exits": ["..."], "policyDeps": ["..."],
 "params": [{"name": "client_name", "label": "How the client is named", "example": "..."}],
 "options": [{"id": "snake_case", "label": "short", "desc": "one sentence on what it changes", "default": true}],
 "rules": [{"id": "R1", "title": "short name", "slot": "section id", "text": "...", "source": "..."}],
 "tests": [numbers of the regression tests that check this behaviour]}
At most 14 rules. Keep titles and descriptions short.`;
  const r = await llm.json(req, { maxTokens: 24000, timeoutMs: 420000 });
  const d = r.data || {};
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const flat = norm(T);
  const rules = (Array.isArray(d.rules) ? d.rules : []).filter(x => x && x.text && String(x.text).trim()).slice(0, 14).map((x, i) => ({
    id: String(x.id || `R${i + 1}`), title: String(x.title || `Rule ${i + 1}`), slot: PB.CANON.includes(x.slot) ? x.slot : 'flows', text: String(x.text).trim(),
    source: String(x.source || '').trim(), sourceFound: !!x.source && flat.includes(norm(x.source)),
  }));
  if (!rules.length) throw draftErr('The AI found no rules for that behaviour. Describe it more specifically and try again.');
  return {
    purpose: String(d.purpose || ''), trigger: String(d.trigger || ''), requires: (d.requires || []).map(String), exits: (d.exits || []).map(String), policyDeps: (d.policyDeps || []).map(String),
    params: (Array.isArray(d.params) ? d.params : []).filter(p => p && /^\w+$/.test(p.name || '')).map(p => ({ name: p.name, label: String(p.label || p.name), example: String(p.example || '') })),
    options: (Array.isArray(d.options) ? d.options : []).filter(o => o && /^\w+$/.test(o.id || '')).map(o => ({ id: o.id, label: String(o.label || o.id), desc: String(o.desc || ''), default: o.default !== false })),
    rules, testIndexes: (Array.isArray(d.tests) ? d.tests : []).map(Number).filter(Number.isInteger), provider: r.provider,
  };
}

// Put a module's (already rendered) rules into another agent's prompt: replace the agent's own
// passages for the same behaviour, add a rule where the agent has nothing, skip what is already there.
async function moduleLocate(agentText, rules, { topic, variables }) {
  const T = String(agentText || '');
  const req = `Add the rules of a reusable module to this voice agent's prompt, as exact edits. The behaviour: ${topic}

For EACH module rule below, decide:
- "replace": the agent already has a passage covering this behaviour (it may be worded differently or be part of a longer line). Give that passage as old_text, copied exactly from the agent's prompt (whole lines, appearing once), and new_text = the module rule, rewritten ONLY as needed so its {{call_variables}} use this agent's own variable names (listed below) and it fits the line it replaces. Keep the rule's meaning and conditions exactly.
- "insert": nothing in the agent covers it. Give "after": an exact line of the agent's prompt next to the most related content, and new_text = the rule.
- "skip": the agent already says exactly this. Say why.
Never change anything else in the agent's prompt. Never remove content about other behaviours: if an old passage mixes this behaviour with others, edit only the part about this behaviour.

THIS AGENT'S CALL VARIABLES: ${(variables || []).join(', ') || '(unknown)'}

MODULE RULES:
${rules.map(x => `[${x.id}] ${x.title} (usually in: ${x.slot})\n${x.text}`).join('\n\n')}

THE AGENT'S PROMPT (${T.length} characters):
<<<
${T.slice(0, 160000)}
>>>

Reply with only JSON: {"edits": [{"rule": "R1", "action": "replace" | "insert" | "skip", "old_text": "...", "after": "...", "new_text": "...", "reason": "one short sentence"}]}`;
  const r = await llm.json(req, { maxTokens: 24000, timeoutMs: 420000 });
  const out = [];
  for (const e of ((r.data && r.data.edits) || [])) {
    const rule = rules.find(x => x.id === e.rule); if (!rule) continue;
    if (e.action === 'skip') { out.push({ rule: rule.id, title: rule.title, action: 'skip', reason: String(e.reason || ''), old_text: '', new_text: '', ok: true }); continue; }
    const anchor = e.action === 'insert' ? String(e.after || '') : String(e.old_text || '');
    if (!anchor.trim()) continue;
    const new_text = e.action === 'insert' ? `${anchor}\n${String(e.new_text || rule.text).trim()}` : String(e.new_text || '');
    const ok = applyEdits(T, [{ old_text: anchor, new_text }]).failed.length === 0;
    out.push({ rule: rule.id, title: rule.title, action: e.action === 'insert' ? 'insert' : 'replace', reason: String(e.reason || ''), old_text: anchor, new_text, ok });
  }
  return { edits: out, provider: r.provider };
}

module.exports = { renderRule, moduleExtract, moduleLocate };
