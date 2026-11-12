// Shared by server and browser: assembly, markdown, validation, diff, feedback heuristics.
// In the browser, blocks.js is loaded first and its top-level names are visible here.
const PB = (typeof module !== "undefined" && module.exports) ? require("./blocks") :
  { BLOCKS, blockById, SECTIONS, CANON, secTitle, BUCKETS, bucketT, PERSONAS, personaById, SCHEMA };

const words = s => (String(s).match(/\S+/g) || []).length;
const tagLine = b => `<!-- ${b.id} · ${b.layer} · ${b.src} -->`;
const TAG_RE = /^<!-- ([A-Za-z0-9-]+) · (L\d) · (.*) -->$/;

function assemble(c) {
  return c.order.map(sec => ({ sec, blocks: PB.BLOCKS.filter(b => b.sec === sec && b.when(c)).map(b => ({ b, on: !c.off.includes(b.id), text: b.text(c) })) }));
}
function sectionsFrom(c) {
  const out = {};
  assemble(c).forEach(s => { out[s.sec] = s.blocks.filter(x => x.on).map(x => tagLine(x.b) + "\n" + x.text).join("\n\n"); });
  return out;
}
function header(c, version) {
  return `# ${(c.client && c.client.name) || "[Client]"} · Collections voice agent · ${PB.bucketT(c.bucket)}\n` +
    `Version ${version} · Persona: ${(PB.personaById(c.persona) || { t: c.persona }).t} · Product: ${c.client.product}\n`;
}
function toMarkdown(head, order, sections, tags) {
  let md = head + "\n";
  order.forEach((sec, i) => {
    let body = sections[sec] || "";
    if (!tags) body = body.replace(/^<!--.*-->\n?/gm, "");
    if (!body.trim()) return;
    md += `\n## ${i + 1}. ${PB.secTitle(sec)}\n\n${body.trim()}\n`;
  });
  return md;
}
function blockTags(text) {
  return (String(text).match(/^<!--.*-->$/gm) || []).map(l => { const m = l.match(TAG_RE); return m ? { id: m[1], layer: m[2], src: m[3] } : null; }).filter(Boolean);
}

function personaBlock(p, c) {
  if (p.id === "pushy" && (!c.policy.proposePartial || !c.policy.askHowMuch)) return "Client policy bans proposing partials or asking how much. Pushy relies on both.";
  if (p.id === "urgency" && !c.policy.escalation && !c.policy.upside && c.policy.brokenPromise !== "strict") return "Policy allows no escalation line, upside framing or strict broken-promise mode, so there is nothing for urgency to work with.";
  return null;
}

function validate(c) {
  const v = []; const add = (lvl, t, d, step) => v.push({ lvl, t, d, step });
  const cl = c.client;
  if (!cl.name) add("err", "Client name is missing", "Needed for the greeting, policy summary and fraud line.", 0);
  if (!cl.agentName) add("err", "Agent name is missing", "The persona and greeting use it.", 0);
  if (cl.callingAs === "agency" && !cl.agency) add("err", "Agency name is missing", "You're calling on behalf of the client, so the agency must be named.", 0);
  if (!cl.languages.length) add("err", "No languages selected", "Pick at least one supported language.", 0);
  const p = PB.personaById(c.persona); const blk = personaBlock(p, c);
  if (blk) add("err", `Persona "${p.t}" conflicts with client policy`, blk, 4);
  const rec = PB.BUCKETS.find(b => b.id === c.bucket).rec;
  if (!rec.includes(c.persona)) add("warn", `"${p.t}" is unusual for ${PB.bucketT(c.bucket)}`, `Suggested: ${rec.map(r => PB.personaById(r).t).join(", ")}.`, 4);
  if ((c.persona === "friendly" || c.persona === "compliant") && c.policy.brokenPromise === "strict") add("warn", "Strict broken-promise mode with a soft persona", "Policy wins: the agent will call out the broken promise even though the persona is soft. Check this is intended.", 2);
  const missingReq = PB.SCHEMA.filter(s => s.req && !c.mapping[s.k]);
  if (missingReq.length) add("err", `${missingReq.length} required variable${missingReq.length > 1 ? "s" : ""} not mapped`, missingReq.map(s => s.k).join(", "), 5);
  const all = Object.values(sectionsFrom(c)).join("\n");
  const used = [...new Set((all.match(/\{([a-z_]+)\}/g) || []).map(x => x.slice(1, -1)))];
  const unmapped = used.filter(k => !c.mapping[k]);
  if (unmapped.length) add("err", "Prompt uses variables with no column", unmapped.map(k => "{" + k + "}").join(", ") + " appear in blocks but aren't mapped.", 5);
  if (c.policy.dateModel === "monthend" && !c.mapping.month_end_date) add("warn", "Month-end date model without {month_end_date}", "Map the column or switch to rolling windows.", 5);
  if (c.policy.spokenOverdue && !c.mapping.total_overdue) add("err", "Overdue is spoken but not mapped", "Map {total_overdue} or turn off speaking it.", 5);
  if (!c.kb.facts.length && !c.kb.faqs.length) add("warn", "Knowledge base is empty", "Without facts the agent can only deflect product questions.", 6);
  else if (c.kb.faqs.length < 3) add("info", "Knowledge base is thin", `${c.kb.faqs.length} FAQ${c.kb.faqs.length === 1 ? "" : "s"}. Aim for the top 5–10 questions from real calls.`, 6);
  if (c.order.some((s, i) => s !== PB.CANON[i])) add("warn", "Section order differs from the canonical order", "Rules must stay first. Other moves are allowed but make prompts harder to compare.", 7);
  if (c.order[0] !== "rules") add("err", "Non-negotiable rules are not first", "Move them back to position 1.", 7);
  if (c.off.includes("OBJ-DECEASED")) add("err", "Deceased handling is off", "This is a compliance-critical special case. Switch it back on.", 7);
  if (!c.policy.channels.length) add("err", "No payment channel", "Add at least one channel in Client policy.", 2);
  const w = words(all.replace(/<!--.*-->/g, ""));
  add(w > 4500 ? "warn" : "ok", `Prompt length: about ${w.toLocaleString()} words`, w > 4500 ? "Long prompts drift. Look for blocks to trim." : "Well under the length where the old 22-page prompts drifted.", 7);
  if (!v.some(x => x.lvl === "err")) add("ok", "No blocking issues", "You can generate this prompt.", 8);
  const rank = { err: 0, warn: 1, info: 2, ok: 3 }; return v.sort((a, b) => rank[a.lvl] - rank[b.lvl]);
}

const DRIVERS = {
  "FLOW-PARTIAL-LADDER": "Partial payments", "FLOW-PARTIAL-ACCEPT": "Partial payments",
  "FLOW-BROKEN-STRICT": "Broken-promise mode", "FLOW-BROKEN-NEUTRAL": "Broken-promise mode",
  "DATE-ROLLING": "Date model", "DATE-MONTHEND": "Date model",
  "OBJ-MERCHANT": "Product", "OBJ-JOBLOSS": "Product", "OBJ-WAIVER": "Waiver policy", "OBJ-SETTLE": "Waiver policy"
};
function movingParts(c) {
  return Object.entries(DRIVERS).map(([id, label]) => { const b = PB.blockById(id); return { id, label, on: b.when(c) && !c.off.includes(id), b }; }).filter(x => x.on);
}

function lineDiff(a, b) {
  const A = String(a).split("\n"), B = String(b).split("\n"), n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { out.push(["c", A[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(["d", A[i++]]); else out.push(["a", B[j++]]); }
  while (i < n) out.push(["d", A[i++]]); while (j < m) out.push(["a", B[j++]]);
  return out;
}

const KEYMAP = [
  ["identity", /wife|husband|spouse|third.?party|wrong person|wrong number|identity|rpc|dodge|hello\?|confirm(ed)? (the )?(customer|borrower)|someone else|picked up/i, "ID-GATE"],
  ["flows", /how much|kitna|partial|ptp|promise|ladder|persua|cibil|urgency|negotiat/i, "FLOW-PERSUADE"],
  ["objections", /deceased|died|death|fraud|abuse|abusive|lawyer|legal|rbi|salary|no money|job|merchant|return|waiver|discount|settle|human|manager/i, "OBJ-DECEASED"],
  ["speech", /₹|rupee|symbol|number|digit|pronounc|read (out)?|script/i, "PLT-SPEECH"],
  ["hygiene", /filler|achha|umm|silence|interrupt|noise|audio|repeat|loop/i, "PLT-HYGIENE"],
  ["opening", /opening|greet|first line|intro|recording/i, "OPEN-GREET"],
  ["persona", /tone|robotic|rude|pushy|soft|warm|friendly|harsh|aggressive|too long|sounds/i, "PER"],
  ["kb", /branch|product|emi detail|faq|knowledge|wrong info|told (them|the customer) (that|yes)|channel|cash/i, "KB-CLIENT"],
  ["dates", /date|tomorrow|month.?end|next week|days/i, "DATE-MONTHEND"],
  ["language", /language|hindi|marathi|tamil|telugu|bengali|english|switch/i, "PLT-LANG"],
  ["closing", /disposition|end(ed)? the call|hang|close|closing/i, "CLOSE-END"],
  ["rules", /threat|compliance|calling hours|after 7|promise.*(score|update)/i, "CORE-NN-01"]
];
function heuristicMap(text, order, sections) {
  for (const [sec, re, bid] of KEYMAP) {
    if (re.test(text) && order.includes(sec)) {
      const tags = blockTags(sections[sec] || "");
      const t = tags.find(x => x.id === bid) || tags[0];
      const layer = t ? t.layer : ((PB.blockById(bid) || {}).layer || "L6");
      return { section: sec, block: t ? t.id : "", layer, type: /never|compliance|threat|deceased|wife|husband/i.test(text) ? "compliance" : "behaviour",
        severity: /never|compliance|deceased|wife|husband|third/i.test(text) ? "high" : "medium", scope: ["L0", "L1"].includes(layer) ? "shared" : "client",
        diagnosis: "Matched by keywords. Check the section before editing.", fix: "Review the section and edit it by hand.", via: "rules" };
    }
  }
  return { section: order.includes("persona") ? "persona" : order[0], block: "", layer: "L4", type: "unclear", severity: "low", scope: "client", diagnosis: "No keyword match. Assign the section by hand.", fix: "", via: "rules" };
}

function splitFeedback(raw) {
  const lines = String(raw).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = []; let cur = null;
  const hdr = /^(uat|round|feedback|from|date)\b/i;
  for (const l of lines) {
    const m = l.match(/^(\d+[.)]|[-*•])\s+(.*)$/);
    if (m) { if (cur) items.push(cur); cur = m[2]; }
    else if (cur && l.length < 200 && !hdr.test(l)) cur += " " + l;
    else if (!cur && hdr.test(l)) continue;
    else { if (cur) items.push(cur); cur = l; }
  }
  if (cur) items.push(cur);
  return items.filter(x => x.length > 8);
}

// Split an existing (imported) prompt into numbered chunks: headings start a new chunk, blank lines separate paragraphs.
function chunkPrompt(text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  const chunks = []; let cur = [];
  const isHeading = l => /^(#{1,6}\s|\*\*[^*]+\*\*\s*:?\s*$|[A-Z][A-Z0-9 &/()'-]{3,60}:?\s*$|(section|step|state)\s*\d+)/i.test(l.trim()) && l.trim().length < 90;
  const flush = () => { const t = cur.join("\n").trim(); if (t) chunks.push(t); cur = []; };
  for (const l of lines) {
    if (isHeading(l) && cur.length) flush();
    if (!l.trim() && cur.length && cur.join("\n").length > 600) { flush(); continue; }
    cur.push(l);
  }
  flush();
  return chunks;
}
const SECTION_HINTS = [
  ["rules", /non.?negotiable|rule|never|must not|compliance|do not|guardrail/i],
  ["persona", /persona|you are|role|personality|tone|character/i],
  ["speech", /speech|tts|pronounc|numbers? in words|script/i],
  ["inputs", /variable|input|\{[a-z_]+\}.*:|call data|context/i],
  ["identity", /identity|rpc|right party|verify|confirm.*(name|person)|third.?party/i],
  ["opening", /greet|opening|introduc|first message/i],
  ["flows", /flow|state|ptp|promise to pay|partial|negotiat|persua|payment/i],
  ["objections", /objection|special case|deceased|abuse|dispute|fraud|refus|excuse/i],
  ["kb", /knowledge|faq|product|policy details/i],
  ["dates", /date|time|calendar|day/i],
  ["language", /language|hindi|english|multilingual/i],
  ["hygiene", /silence|filler|interrupt|noise|hygiene|unclear audio/i],
  ["closing", /clos|end_interaction|disposition|end the call|goodbye/i]
];
function heuristicSectionFor(chunk) {
  const head = chunk.split("\n")[0];
  for (const [sec, re] of SECTION_HINTS) if (re.test(head)) return sec;
  for (const [sec, re] of SECTION_HINTS) if (re.test(chunk.slice(0, 400))) return sec;
  return "flows";
}

const PromptCore = { words, tagLine, assemble, sectionsFrom, header, toMarkdown, blockTags, personaBlock, validate, movingParts, lineDiff, heuristicMap, splitFeedback, chunkPrompt, heuristicSectionFor };
if (typeof module !== "undefined" && module.exports) module.exports = PromptCore;
