// Rule library per agent type, and the 3-step New prompt built on it.
// Loaded after app.js and uses its helpers (api, esc, run, toast, render, L, R, ACT, ROUTES...).
//
// Library page: confirm the structure (skeleton) of each agent type, fill the library from the live
// agents (or from documents), and approve entries.
// New prompt:   1 Client info · 2 Source (a live agent, or a clean slate) · 3 Review: the Greeting and every
// section, filled from the library (by hand or "Use the best modules"), each rule refinable.

const NP_TYPES = [["collections", "Collections"], ["sales", "Sales"]];
const npTypeT = t => (NP_TYPES.find(x => x[0] === t) || [t, t])[1];
R.libs = R.libs || {};
async function loadLibType(type, force) { if (!R.libs[type] || force) R.libs[type] = await api("GET", `/library/${type}`); return R.libs[type]; }
const libOf = type => R.libs[type] || null;
const npRid = () => Math.random().toString(36).slice(2, 10);

// ---------- New prompt state ----------
function npState() {
  if (!L.np) L.np = { step: 0, info: { type: "collections", client: "", legal: "", agentName: "", gender: "female", product: "", productDesc: "", objective: "", languages: ["Hindi", "English"], callingAs: "lender", bucket: "b1" }, source: { kind: "blank", agentId: "" }, greeting: "", secs: {}, name: "" };
  return L.np;
}
// Built-in block text with this agent's details (client name, product, persona...).
function npCfg(info) {
  const c = baseCfg();
  Object.assign(c.client, { name: info.client || "", legal: info.legal || "", agentName: info.agentName || "", agentGender: info.gender === "male" ? "male" : "female", productDesc: info.productDesc || "" });
  if (PRODUCTS.includes(info.product)) c.client.product = info.product;
  if ((info.languages || []).length) c.client.languages = info.languages.filter(l => LANGS.includes(l));
  if (info.bucket) c.bucket = info.bucket;
  return c;
}
function builtinText(b, info) { const blk = blockById(b.id); try { return blk ? String(blk.text(npCfg(info))).trim() : b.text; } catch (_) { return b.text; } }
// Library entries for one section: modules of this type + built-ins (collections).
function sectionEntries(type, secId, info) {
  const lib = libOf(type); if (!lib) return [];
  const mods = lib.entries.filter(e => e.section === secId && e.rules.length).map(e => ({ ...e, text: e.rules.map(r => r.text).join("\n\n") }));
  const bis = lib.builtins.filter(b => b.section === secId).map(b => ({ ...b, status: "approved", agents: [], text: builtinText(b, info) }));
  return [...mods.sort((a, b) => (b.status === "approved") - (a.status === "approved") || b.agents.length - a.agents.length), ...bis];
}
const npRules = (np, id) => np.secs[id] || (np.secs[id] = []);
function npAdd(np, secId, rule) {
  const list = npRules(np, secId);
  if (rule.ref && list.some(x => x.ref === rule.ref)) return false;
  if (list.some(x => x.text.trim() === String(rule.text).trim())) return false;
  list.push({ id: npRid(), ...rule }); return true;
}
const npAllText = np => [np.greeting, ...Object.values(np.secs).flat().map(x => x.text)].join("\n");
// Checks flag what still needs attention. They never block saving a draft; each has its own fix.
const npOtherClients = (np, all) => {
  const mine = String(np.info.client || "").trim().toLowerCase();
  const others = [...new Set([...(R.agents || []).map(a => a.client), ...Object.values(R.libs || {}).flatMap(l => (l && l.agents || []).map(a => a.client))].map(c => String(c || "").trim()).filter(c => c.length > 2 && c.toLowerCase() !== mine))];
  return others.filter(c => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(all));
};
const npOpenNotes = np => Object.entries(np.secs).flatMap(([sec, list]) => list.flatMap(x => (x.notes || []).filter(n => !n.done).map(n => ({ sec, rule: x, note: n }))));
function npChecks(np, sk) {
  const out = [];
  if (!np.greeting.trim()) out.push({ lvl: "warn", t: "Greeting is empty", d: "Sarvam needs a greeting before this agent can go live.", fix: "greet" });
  sk.sections.filter(s => s.mandatory && !npRules(np, s.id).length).forEach(s => out.push({ lvl: "warn", t: `${s.title} is empty`, d: "Part of the standard structure.", sec: s.id, fix: "sec" }));
  const all = npAllText(np);
  const params = [...new Set((all.match(/\[\[(\w+)\]\]/g) || []).map(x => x.slice(2, -2)))];
  if (params.length) out.push({ lvl: "warn", t: `${params.length} placeholder${params.length === 1 ? "" : "s"} to fill`, d: "Values only this client has.", params, fix: "params" });
  if (/\[CONFIRM[:\]]/i.test(all)) out.push({ lvl: "warn", t: "Some rules still contain [CONFIRM: …]", d: "Turn them into questions beside their rules, and the rule text reads cleanly.", fix: "confirm" });
  const hits = npOtherClients(np, all);
  if (hits.length) out.push({ lvl: "err", t: `Mentions another client: ${hits.join(", ")}`, d: "Rules copied from other agents carry their client's name.", hits, fix: "client" });
  const open = npOpenNotes(np);
  if (open.length) out.push({ lvl: "info", t: `${open.length} question${open.length === 1 ? "" : "s"} to answer`, d: "Shown beside their rules. Answer them, or save and answer later.", fix: "notes" });
  return out;
}
// Suggested values for common placeholders, from the client details.
function npParamGuess(np, k) {
  const i = np.info, n = k.toLowerCase();
  if (/agent_?name/.test(n)) return i.agentName || "";
  if (/legal/.test(n)) return i.legal || "";
  if (/client|company|lender|brand|bank/.test(n)) return i.client || "";
  if (/product/.test(n)) return i.product || "";
  return "";
}
// "[CONFIRM: minimum income]" in a rule -> clean text + a question beside the rule.
function npTakeAsks(text, asks) {
  const qs = [...(asks || [])];
  const clean = String(text || "").replace(/\s*\[CONFIRM:?\s*([^\]]*)\]/gi, (m, what) => { if (what.trim()) qs.push(`Confirm: ${what.trim()}`); return what.trim() ? ` ${what.trim()}` : ""; }).replace(/\s{2,}/g, " ").trim();
  return { text: clean, notes: qs.map(ask => ({ id: npRid(), ask })) };
}
const npGreetExample = np => `Namaste {{customer_name}}, main ${np.info.agentName || "Meera"} ${np.info.gender === "male" ? "bol raha" : "bol rahi"} hoon ${np.info.client || "KreditBee"} se.`;
const npVars = np => [...new Set((npAllText(np).match(/\{\{\s*(\w+)\s*\}\}/g) || []).map(s => s.replace(/[{}\s]/g, "")))];

// ---------- New prompt view ----------
const NP_STEPS = ["Client", "Source", "Review"];
function viewNewPrompt() {
  const np = npState(), lib = libOf(np.info.type);
  const steps = `<div class="np-steps">${NP_STEPS.map((s, i) => `<button type="button" data-act="np-step" data-i="${i}" aria-current="${i === np.step ? "step" : "false"}" ${i > 0 && !lib ? "disabled" : ""}><span class="n">${i + 1}</span>${s}</button>`).join('<span class="sep">—</span>')}</div>`;
  const body = [npClient, npSource, npReview][np.step](np, lib);
  return `<div class="view-head"><div><h1>New prompt</h1><p>${npTypeT(np.info.type)} agent${np.info.client ? ` for ${esc(np.info.client)}` : ""} · saved in this browser as you go</p></div>
   <div class="row" style="gap:8px"><button class="btn ghost" data-act="np-reset">Start over</button></div></div>
   ${steps}<div class="np-body">${body}</div>`;
}
const npField = (label, k, val, hint = "", ph = "") => `<label class="f">${label}${hint ? ` <span class="hint">${hint}</span>` : ""}<input type="text" data-np="info.${k}" id="np-${k}" value="${esc(val || "")}" placeholder="${esc(ph)}"></label>`;
const npSeg = (k, opts, val) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-act="np-set" data-k="${k}" data-v="${esc(v)}" aria-pressed="${val === v}">${esc(l)}</button>`).join("")}</div>`;
function npClient(np, lib) {
  const i = np.info;
  return `<div class="stack">
   <div><h2>Client</h2><p class="muted">Who the agent works for and what it must achieve. The library and the AI use this to pick and tailor rules.</p></div>
   <div class="row" style="gap:10px"><span class="small muted">Agent type</span>${npSeg("type", NP_TYPES, i.type)}</div>
   <div class="fgrid">${npField("Client name", "client", i.client, "(as the agent says it)", "e.g. KreditBee")}${npField("Legal name", "legal", i.legal)}</div>
   <div class="fgrid">${npField("Agent name", "agentName", i.agentName, "", "e.g. Meera")}${npField("Product", "product", i.product, "", i.type === "sales" ? "e.g. Platinum credit card" : "e.g. Personal loan")}</div>
   <label class="f">Objective <span class="hint">(what a successful call achieves)</span><textarea rows="3" data-np="info.objective" id="np-objective" placeholder="${i.type === "sales" ? "e.g. Explain the card's benefits to pre-approved customers and get consent to start the application." : "e.g. Get a promise to pay with a date from customers 1–30 days overdue."}">${esc(i.objective)}</textarea></label>
   <label class="f">Anything else the rules should know <span class="hint">(policy, tone, what's not allowed)</span><textarea rows="2" data-np="info.productDesc" id="np-desc">${esc(i.productDesc)}</textarea></label>
   ${trow("Agent voice", "Sets gendered verb forms (bol rahi / bol raha).", npSeg("gender", [["female", "Female"], ["male", "Male"]], i.gender))}
   <div><div class="lbl">Languages</div><div class="row" style="gap:6px">${LANGS.map(l => `<button type="button" class="btn sm" data-act="np-lang" data-l="${l}" aria-pressed="${(i.languages || []).includes(l)}">${l}</button>`).join("")}</div></div>
   ${lib && lib.skeleton && lib.skeleton.starter ? `<div class="small muted">There's no ${npTypeT(i.type).toLowerCase()} library yet, so this prompt starts from the standard ${npTypeT(i.type).toLowerCase()} structure and you write or draft its rules. Once the agent is live, its rules go into the library for the next one.</div>` : ""}
   <div class="step-foot"><span></span><button class="btn primary" data-act="np-step" data-i="1" ${lib ? "" : "disabled"}>Next: Source →</button></div></div>`;
}
function npSource(np, lib) {
  const agents = (lib.agents || []).filter(a => a.hasPrompt), s = np.source;
  return `<div class="stack">
   <div><h2>Source</h2><p class="muted">Start from an agent that's already live, or from a clean slate with the standard ${npTypeT(np.info.type).toLowerCase()} structure. Either way you fill and refine every section in Review.</p></div>
   <div class="choice">
    <button type="button" class="opt" data-act="np-src" data-k="agent" aria-pressed="${s.kind === "agent"}"><b>A live agent</b><span>Its greeting and rules fill the sections. ${agents.length} ${npTypeT(np.info.type).toLowerCase()} agent${agents.length === 1 ? "" : "s"} available.</span></button>
    <button type="button" class="opt" data-act="np-src" data-k="blank" aria-pressed="${s.kind === "blank"}"><b>Clean slate</b><span>Greeting and the ${lib.skeleton.sections.length} standard sections, empty. Fill them from the library.</span></button>
   </div>
   ${s.kind === "agent" ? (agents.length ? `<label class="f">Agent<select data-np="source.agentId" id="np-src-agent"><option value="">Choose…</option>${agents.map(a => `<option value="${esc(a.id)}" ${s.agentId === a.id ? "selected" : ""}>${esc(a.name)}${a.client ? ` · ${esc(a.client)}` : ""}</option>`).join("")}</select></label>` : `<div class="small muted">No ${npTypeT(np.info.type).toLowerCase()} agent has a prompt in the builder yet.</div>`) : ""}
   <div class="small muted">The structure: <b>Greeting</b> · ${lib.skeleton.sections.map(x => `${esc(x.title)}${x.mandatory ? "" : " <span class='muted'>(optional)</span>"}`).join(" · ")}</div>
   ${Object.values(np.secs).flat().length ? `<div class="small" style="color:var(--warn)">Continuing replaces the ${Object.values(np.secs).flat().length} rules already in Review.</div>` : ""}
   <div class="step-foot"><button class="btn ghost" data-act="np-step" data-i="0">← Back</button><button class="btn primary" data-act="np-go-review" ${s.kind === "agent" && !s.agentId ? "disabled" : ""}>Next: Review →</button></div></div>`;
}
function npRuleRow(np, secId, x, sk) {
  const open = (x.notes || []).filter(n => !n.done);
  if (!open.length) return npRuleBox(np, secId, x, sk);
  return `<div class="np-row">${npRuleBox(np, secId, x, sk)}<div class="np-notes">${open.map(n => `<div class="np-note" id="np-note-${n.id}"><div class="small"><b>Question</b> ${esc(n.ask)}</div>
    <input type="text" id="np-ans-${n.id}" placeholder="Your answer">
    <div class="row" style="gap:8px"><button class="btn sm primary ai" data-act="np-note-apply" data-id="${x.id}" data-n="${n.id}">Apply</button><a href="#" class="small" data-act="np-note-x" data-id="${x.id}" data-n="${n.id}">Dismiss</a></div></div>`).join("")}</div></div>`;
}
function npRuleBox(np, secId, x, sk) {
  const ed = R.npEdit === x.id, rf = R.npRefine === x.id;
  const origin = x.refined ? `<span class="chip acc">refined · saved to library</span>` : x.ref && x.ref.startsWith("B:") ? `<span class="chip">built-in</span>` : x.ref ? `<span class="chip">library${x.agents && x.agents.length ? ` · ${x.agents.length} agent${x.agents.length === 1 ? "" : "s"}` : ""}</span>` : x.from && x.from.agent ? `<span class="chip">from ${esc(x.from.agent)}</span>` : `<span class="chip">written here</span>`;
  return `<div class="np-rule ${ed || rf ? "on" : ""}">
   ${ed ? `<textarea rows="${Math.min(12, Math.max(3, Math.ceil(x.text.length / 90)))}" id="np-ed-${x.id}">${esc(x.text)}</textarea>
     <div class="row" style="gap:6px"><button class="btn sm primary" data-act="np-ed-save" data-sec="${secId}" data-id="${x.id}">Save</button><button class="btn sm ghost" data-act="np-ed-cancel">Cancel</button></div>`
   : `<div class="np-text">${mdInline(x.text).replace(/\n/g, "<br>")}</div>`}
   ${x.reason ? `<div class="small muted">${x.refined ? "Refined" : x.ref ? "Picked because" : "Note"}: ${esc(x.reason)}</div>` : ""}
   ${rf ? `<div class="stack" style="gap:6px"><input type="text" id="np-rf-note" placeholder="Optional: what to change, e.g. firmer tone, mention the app"><div class="row" style="gap:6px"><button class="btn sm primary ai" data-act="np-refine-go" data-sec="${secId}" data-id="${x.id}">Refine for ${esc(np.info.client || "this agent")}</button><button class="btn sm ghost" data-act="np-refine-x">Cancel</button><span class="small muted">The refined rule replaces this one and is saved to the library as a variant.</span></div></div>` : ""}
   ${!ed && !rf ? `<div class="np-acts">${origin}<span class="sp"></span><a href="#" data-act="np-refine" data-id="${x.id}">Refine</a><a href="#" data-act="np-ed" data-id="${x.id}">Edit</a><a href="#" data-act="np-mv" data-sec="${secId}" data-id="${x.id}" data-d="-1" title="Move up">↑</a><a href="#" data-act="np-rm" data-sec="${secId}" data-id="${x.id}" class="danger">Remove</a></div>` : ""}
  </div>`;
}
function npBrowser(np, sec) {
  const q = (R.npQ || "").toLowerCase();
  const list = sectionEntries(np.info.type, sec.id, np.info).filter(e => !q || (e.title + " " + e.text).toLowerCase().includes(q));
  const have = new Set(npRules(np, sec.id).map(x => x.ref).filter(Boolean));
  return `<div class="np-lib"><div class="row" style="gap:8px;justify-content:space-between"><b class="small">Library · ${esc(sec.title)}</b><input type="text" id="np-q" data-np-q placeholder="Search" value="${esc(R.npQ || "")}" style="max-width:220px"><a href="#" class="small" data-act="np-lib-x">Close</a></div>
   ${list.length ? list.map(e => { const open = R.npOpen === e.ref; return `<div class="np-entry ${open ? "open" : ""}">
     <div class="row" style="gap:8px;align-items:flex-start"><a href="#" class="np-et" data-act="np-open" data-ref="${esc(e.ref)}">${esc(e.title)}</a>
      <span class="small muted" style="flex:1">${e.builtin ? "built-in" : e.agents.length ? `used by ${e.agents.slice(0, 3).map(esc).join(", ")}${e.agents.length > 3 ? ` +${e.agents.length - 3}` : ""}` : e.variantOf ? "refined variant" : ""}${!e.builtin && e.status !== "approved" ? ` · <span style="color:var(--warn)">draft</span>` : ""}</span>
      ${have.has(e.ref) ? `<span class="small muted">added</span>` : `<button class="btn sm" data-act="np-add" data-sec="${sec.id}" data-ref="${esc(e.ref)}">Add</button>`}</div>
     ${open ? `<div class="np-text small" style="margin-top:6px">${mdInline(e.text).replace(/\n/g, "<br>")}</div>${e.alternatives ? `<div class="small muted">${e.alternatives} other wording${e.alternatives === 1 ? "" : "s"} from other agents on the Library page.</div>` : ""}` : ""}</div>`; }).join("")
   : `<div class="small muted">Nothing in the library for this section${q ? " matches" : " yet"}.</div>`}</div>`;
}
function npReview(np, lib) {
  const sk = lib.skeleton, checks = npChecks(np, sk), vars = npVars(np);
  const filled = sk.sections.filter(s => npRules(np, s.id).length).length;
  return `<div class="stack">
   <div class="row" style="justify-content:space-between;align-items:flex-end"><div><h2>Review</h2><p class="muted">${filled} of ${sk.sections.length} sections filled. Add rules from the library, or let the AI choose the best ones for this agent.</p></div>
    ${lib.entries.length || lib.builtins.length ? `<button class="btn primary ai" data-act="np-best" ${aiOn() ? "" : "disabled title='No AI model configured'"}>Use the best modules</button>`
      : `<button class="btn primary ai" data-act="np-draft" ${aiOn() ? "" : "disabled title='No AI model configured'"} title="Writes a first draft of every section from the client details${kbImp().files.some(f => f.status === "ready") ? " and the documents you added" : ""}">Draft the sections with AI</button>`}</div>
   ${sk.starter ? `<div class="small muted">Standard ${npTypeT(np.info.type).toLowerCase()} structure (the library has none confirmed yet). ${lib.entries.length ? "" : "Nothing in the library yet: draft the sections with AI, write them, or add facts from documents."}</div>` : ""}
   ${R.npBestNote ? `<div class="small muted">${esc(R.npBestNote)}</div>` : ""}
   <section class="np-sec"><div class="np-sh"><h3>Greeting</h3><span class="chip">required</span><span class="small muted">${esc(sk.greeting.desc || "")}</span></div>
    <textarea rows="2" data-np="greeting" id="np-greeting" placeholder="e.g. Namaste {{customer_name}}, main ${esc(np.info.agentName || "Meera")} bol rahi hoon ${esc(np.info.client || "KreditBee")} se.">${esc(np.greeting)}</textarea></section>
   ${sk.sections.map(s => { const rules = npRules(np, s.id); return `<section class="np-sec" id="np-sec-${s.id}"><div class="np-sh"><h3>${esc(s.title)}</h3>${s.mandatory ? `<span class="chip ${rules.length ? "" : "err"}">required</span>` : ""}<span class="small muted">${esc(s.desc || "")}</span></div>
     ${rules.map(x => npRuleRow(np, s.id, x, sk)).join("")}
     ${R.npLib === s.id ? npBrowser(np, s) : ""}
     ${R.npNew === s.id ? `<div class="np-rule on"><textarea rows="3" id="np-new-text" placeholder="Write the rule"></textarea><div class="row" style="gap:6px"><button class="btn sm primary" data-act="np-new-save" data-sec="${s.id}">Add rule</button><button class="btn sm ghost" data-act="np-new-x">Cancel</button></div></div>` : ""}
     <div class="row" style="gap:12px"><a href="#" class="small" data-act="np-lib" data-sec="${s.id}">+ From library (${sectionEntries(np.info.type, s.id, np.info).length})</a><a href="#" class="small" data-act="np-new" data-sec="${s.id}">+ Write a rule</a>${s.kb ? `<a href="#" class="small" data-act="np-kb" data-sec="${s.id}">+ From documents</a>` : ""}</div>
     ${s.kb && R.npKb === s.id ? kbImportPanel() : ""}</section>`; }).join("")}
   <section class="np-sec"><div class="np-sh"><h3>Checks</h3></div>
    ${checks.length ? checks.map(c => npCheckRow(np, c)).join("") : `<div class="vitem ok"><span class="ic">✓</span><div class="vt"><b>No open issues</b></div></div>`}
    ${vars.length ? `<div class="small muted">Call variables used: ${vars.map(v => `<code>{{${esc(v)}}}</code>`).join(" ")}</div>` : ""}
    <div class="row" style="gap:8px"><button class="btn sm ai" data-act="np-review" ${aiOn() ? "" : "disabled"}>AI review</button><span class="small muted">Reads the whole prompt for contradictions and gaps, and proposes fixes.</span></div>
    ${R.npReview ? npReviewList(np, sk) : ""}</section>
   <div class="step-foot"><button class="btn ghost" data-act="np-step" data-i="1">← Back</button>
    <div class="row" style="gap:8px"><input type="text" data-np="name" id="np-name" placeholder="Name, e.g. ${esc(np.info.client || "KreditBee")} · ${esc(npTypeT(np.info.type))}" value="${esc(np.name)}" style="width:260px"><button class="btn primary" data-act="np-save" title="${checks.length ? `${checks.length} open issue${checks.length === 1 ? "" : "s"} will be saved with the draft` : "Save as draft"}">Save as draft</button></div></div>
   ${checks.length ? `<div class="small muted" style="text-align:right">Open issues don't stop you saving: they're kept with the draft and shown on its page.</div>` : ""}
  </div>`;
}
function npCheckRow(np, c) {
  const btn = (act, label, extra = "") => `<button class="btn sm" data-act="${act}" ${extra}>${label}</button>`;
  const fixes = c.fix === "greet" ? btn("np-fix-greet", "Use the example")
    : c.fix === "sec" ? btn("np-draft-sec", "Draft with AI", `data-sec="${c.sec}" ${aiOn() ? "" : "disabled"}`) + btn("np-lib", "From library", `data-sec="${c.sec}"`)
    : c.fix === "confirm" ? btn("np-fix-confirm", "Make them questions")
    : c.fix === "client" ? btn("np-fix-client", `Replace with ${esc(np.info.client || "this client")}`, np.info.client ? "" : "disabled title='Enter the client name in step 1'")
    : c.fix === "notes" ? btn("np-notes-go", "Show the first")
    : "";
  const params = c.fix === "params" ? `<div class="np-params">${c.params.map(k => `<label class="f"><code>[[${esc(k)}]]</code><input type="text" id="np-p-${esc(k)}" value="${esc(npParamGuess(np, k))}" placeholder="Value for ${esc(k.replace(/_/g, " "))}"></label>`).join("")}<div>${btn("np-fill", "Fill")}</div></div>` : "";
  return `<div class="vitem ${c.lvl}"><span class="ic">${c.lvl === "err" ? "✕" : c.lvl === "info" ? "?" : "!"}</span><div class="vt" style="flex:1"><b>${esc(c.t)}</b><span>${esc(c.d)}</span>${params}</div><div class="row" style="gap:6px;align-self:center">${fixes}</div></div>`;
}
function npReviewList(np, sk) {
  const list = R.npReview || [];
  if (!list.length) return `<div class="vitem ok"><span class="ic">✓</span><div class="vt"><b>No issues found by the AI review</b></div></div>`;
  return list.map((r, i) => { const f = r.fix; return `<div class="fb" style="gap:8px"><b>${esc(r.issue)}</b><div class="small muted">${esc(r.suggestion)}</div>
   ${!f ? "" : f.type === "setting" ? `<div class="small">${esc(f.change)}</div>` : `${diffHtml(f.type === "edit" ? f.before : "", f.text, { bare: true })}<div>${r.applied ? `<span class="small" style="color:var(--ok)">✓ Applied</span>` : `<button class="btn sm primary" data-act="np-fix" data-i="${i}">Apply fix</button>`}</div>`}</div>`; }).join("");
}

// ---------- Library page ----------
function viewLibraryPage() {
  if (R.modId && R.modDoc) return viewModule();
  const type = R.libType || "collections", lib = libOf(type);
  const tabs = `<div class="subtabs">${NP_TYPES.map(([k, l]) => `<button data-act="lib-type" data-type="${k}" aria-pressed="${k === type}">${l}</button>`).join("")}</div>`;
  if (!lib) return `<div class="view-head"><div><h1>Library</h1></div></div>${tabs}<div class="loading">Loading…</div>`;
  const sk = lib.skeleton && !lib.skeleton.starter ? lib.skeleton : null, prop = R.skDraft && R.skDraft.type === type ? R.skDraft : null, job = lib.job;
  const withPrompt = lib.agents.filter(a => a.hasPrompt).length;
  const head = `<div class="view-head"><div><h1>Library</h1><p>The standard structure and the proven rules for ${npTypeT(type).toLowerCase()} agents. New prompts are built from them.</p></div>${sk ? `<a class="btn primary" href="#create" data-act="np-start" data-type="${type}">+ New ${npTypeT(type).toLowerCase()} prompt</a>` : ""}</div>${libLine()}`;
  // 1. structure
  const skPanel = prop ? skEditor(prop) : sk ? `<details class="np-sec"><summary><b>Structure</b> <span class="small muted">· Greeting + ${sk.sections.length} sections, confirmed by ${esc((sk.confirmedBy || "").split("@")[0])}</span></summary>
     <div class="small" style="margin-top:8px">Greeting · ${sk.sections.map(s => `${esc(s.title)}${s.mandatory ? "" : " (optional)"}`).join(" · ")}</div><div class="row" style="margin-top:8px"><button class="btn sm" data-act="sk-edit">Edit structure</button></div></details>`
    : `<section class="np-sec"><h3>1 · Confirm the structure</h3><p class="small muted">Every ${npTypeT(type).toLowerCase()} prompt follows one structure: a Greeting, then the sections of the Instructions. ${withPrompt ? `The AI can read the ${withPrompt} ${npTypeT(type).toLowerCase()} agent${withPrompt === 1 ? "" : "s"} with a prompt and propose it.` : "No agent of this type has a prompt yet: draft it from the client's documents."}</p>
     <div class="row" style="gap:8px">${withPrompt ? `<button class="btn primary ai" data-act="sk-derive">Derive from ${withPrompt} agent${withPrompt === 1 ? "" : "s"}</button>` : ""}<button class="btn ${withPrompt ? "" : "primary"} ai" data-act="lib-docs-toggle">Draft from documents</button><button class="btn ghost" data-act="sk-blank">Write it myself</button></div></section>`;
  // 2. fill
  const fill = sk ? `<section class="np-sec"><div class="row" style="justify-content:space-between"><div><h3>Rules</h3><p class="small muted">${lib.entries.length} entries${lib.builtins.length ? ` + ${lib.builtins.length} built-in blocks` : ""}. Extracted rules start as drafts; approve the ones that are right.</p></div>
     <div class="row" style="gap:8px">${withPrompt ? `<button class="btn ai" data-act="lib-extract" ${job && job.state === "running" ? "disabled" : ""}>${lib.entries.length ? "Update" : "Build"} from ${withPrompt} agent${withPrompt === 1 ? "" : "s"}</button>` : ""}<button class="btn ai" data-act="lib-docs-toggle">Add from documents</button></div></div>
     ${job && job.state === "running" ? `<div class="small">${esc(job.step || "Working")}… ${job.done} of ${job.total}</div><div class="bar" style="max-width:none;height:6px"><i style="width:${Math.round(100 * job.done / Math.max(1, job.total))}%"></i></div>` : job && job.state === "done" ? `<div class="small muted">Last build: ${job.read} agent${job.read === 1 ? "" : "s"} read, ${job.created} new entries, ${job.updated} updated${job.errors.length ? ` · <span style="color:var(--warn)">${job.errors.length} problem${job.errors.length === 1 ? "" : "s"}: ${esc(job.errors.slice(0, 2).join("; "))}</span>` : ""}.</div>` : job && job.state === "failed" ? `<div class="small" style="color:var(--err)">The build failed: ${esc(job.error || "")}</div>` : ""}
     ${sk.sections.map(s => { const es = lib.entries.filter(e => e.section === s.id), bs = lib.builtins.filter(b => b.section === s.id); return `<div class="lib-sec"><div class="np-sh"><h3>${esc(s.title)}</h3><span class="small muted">${es.length} entr${es.length === 1 ? "y" : "ies"}${bs.length ? ` · ${bs.length} built-in` : ""}</span></div>
       ${es.map(e => `<a class="lib-row" href="#" data-act="lib-entry" data-id="${e.id}"><span class="t">${esc(e.title)}</span><span class="small muted">${e.variantOf ? "variant · " : ""}${e.agents.length ? `${e.agents.length} agent${e.agents.length === 1 ? "" : "s"}` : e.origin === "refined" ? "refined" : ""}${e.alternatives ? ` · ${e.alternatives} other wording${e.alternatives === 1 ? "" : "s"}` : ""}</span>${statusPill(e.status)}</a>`).join("") || `<div class="small muted">No entries yet.</div>`}</div>`; }).join("")}</section>` : "";
  const docs = R.libDocs ? libDocsPanel(type, lib) : "";
  // agents and their type
  const others = (R.agents || []).filter(a => a.sarvamAppId);
  const agentsPanel = `<details class="np-sec"><summary><b>Agents and their type</b> <span class="small muted">· ${lib.agents.length} ${npTypeT(type).toLowerCase()}</span></summary><div class="stack" style="gap:6px;margin-top:10px">
    ${others.map(a => `<div class="row" style="justify-content:space-between"><span>${esc(a.name)} <span class="small muted">${esc(a.client || "")}</span></span>${canDo("approve") ? npSegAgent(a) : `<span class="small muted">${npTypeT(a.agentType || "collections")}</span>`}</div>`).join("") || `<div class="small muted">No agents loaded. Refresh on the Agents page.</div>`}</div></details>`;
  return head + tabs + `<div class="stack">${skPanel}${docs}${fill}${agentsPanel}</div>`;
}
const npSegAgent = a => `<div class="seg">${NP_TYPES.map(([k, l]) => `<button type="button" data-act="agent-type" data-id="${esc(a.id)}" data-v="${k}" aria-pressed="${(a.agentType || "collections") === k}">${l}</button>`).join("")}</div>`;
function skEditor(p) {
  return `<section class="np-sec"><h3>Structure${p.derivedFrom && p.derivedFrom.length ? ` <span class="small muted">· proposed from ${p.derivedFrom.length} source${p.derivedFrom.length === 1 ? "" : "s"}</span>` : ""}</h3>
   <p class="small muted">Order, names and which sections every prompt must have. Prompts are checked against this.</p>
   <label class="f">Greeting <span class="hint">(always required)</span><input type="text" data-sk="greeting" id="sk-greet" value="${esc(p.greeting.desc)}"></label>
   ${p.sections.map((s, i) => `<div class="sk-row"><input type="text" data-sk="title" data-i="${i}" id="sk-t-${i}" value="${esc(s.title)}"><input type="text" data-sk="desc" data-i="${i}" id="sk-d-${i}" value="${esc(s.desc)}" placeholder="What it holds">
     <label class="check small"><input type="checkbox" data-sk-check="mandatory" data-i="${i}" ${s.mandatory ? "checked" : ""}> required</label><label class="check small" title="The section for product facts and FAQs"><input type="checkbox" data-sk-check="kb" data-i="${i}" ${s.kb ? "checked" : ""}> facts</label>
     <a href="#" data-act="sk-mv" data-i="${i}" data-d="-1">↑</a><a href="#" data-act="sk-mv" data-i="${i}" data-d="1">↓</a><a href="#" class="danger" data-act="sk-rm" data-i="${i}">✕</a></div>`).join("")}
   <div><a href="#" class="small" data-act="sk-add">+ Add a section</a></div>
   ${p.rules && p.rules.length ? `<div class="small muted">${p.rules.length} rules drafted from the documents are saved to the library when you confirm.</div>` : ""}
   <div class="row" style="gap:8px">${canDo("approve") ? `<button class="btn primary" data-act="sk-save">Confirm structure</button>` : `<span class="small muted">An approver confirms the structure.</span>`}<a href="#" class="small" data-act="sk-cancel">Cancel</a></div></section>`;
}
function libDocsPanel(type, lib) {
  const I = kbImp(), ready = I.files.filter(f => f.status === "ready");
  return `<section class="np-sec"><h3>From documents</h3><p class="small muted">Scripts, product sheets, policies, compliance notes. The AI drafts ${lib.skeleton ? "rules for each section" : "the structure and its rules"}, using only what the documents say; missing details are marked [CONFIRM: …].</p>
   <div class="dropzone" id="kbDrop">Drop files or folders, or <label style="color:var(--accent);cursor:pointer;text-decoration:underline">choose files<input type="file" id="kbFiles" multiple accept=".xlsx,.xls,.csv,.docx,.pptx,.pdf,.txt,.md,.json,.html,.htm,.jpg,.jpeg,.png,.gif,.webp" hidden></label></div>
   ${I.files.length ? `<div class="small">${I.files.map(f => `${esc(f.name)} <span class="muted">(${f.status === "ready" ? `${fmtN((f.text || "").length)} characters` : esc(f.note || f.status)})</span>`).join(" · ")}</div>` : ""}
   <div class="row" style="gap:8px"><button class="btn primary ai" data-act="lib-docs-go" ${ready.length ? "" : "disabled"}>Draft from ${ready.length} file${ready.length === 1 ? "" : "s"}</button><a href="#" class="small" data-act="lib-docs-toggle">Close</a></div></section>`;
}

// ---------- actions ----------
const npFind = (np, id) => { for (const [sec, list] of Object.entries(np.secs)) { const i = list.findIndex(x => x.id === id); if (i >= 0) return { sec, list, i, x: list[i] }; } return null; };
Object.assign(ACT, {
  "np-step": el => { const np = npState(); np.step = +el.dataset.i; R.npLib = null; commit(); window.scrollTo(0, 0); },
  "np-reset": () => { if (!confirm("Start a new prompt from scratch? This clears the one in progress.")) return; L.np = null; R.npReview = null; R.npBestNote = null; commit(); },
  "np-set": el => { const np = npState(), k = el.dataset.k; np.info[k] = el.dataset.v; commit(); if (k === "type") loadLibType(el.dataset.v).then(render).catch(e => toast(e.message)); },
  "np-lang": el => { const i = npState().info, l = el.dataset.l; i.languages = i.languages.includes(l) ? i.languages.filter(x => x !== l) : [...i.languages, l]; commit(); },
  "np-src": el => { npState().source.kind = el.dataset.k; commit(); },
  "np-go-review": el => run(el, async () => {
    const np = npState(), type = np.info.type, sk = libOf(type).skeleton;
    np.secs = Object.fromEntries(sk.sections.map(s => [s.id, []]));
    if (np.source.kind === "agent") {
      const r = await api("POST", `/library/${type}/source`, { agentId: np.source.agentId });
      Object.entries(r.sections).forEach(([sec, list]) => list.forEach(x => npAdd(np, sec, { text: x.text, title: x.title || "", from: x.from })));
      np.greeting = r.greeting || np.greeting; np.sourceAgent = r.agent;
      toast(`${r.agent.name}'s prompt is in place${r.via === "ai" ? " (sections placed by the AI)" : ""}.`);
    } else np.sourceAgent = null;
    np.step = 2; R.npReview = null; commit(); window.scrollTo(0, 0);
  }, "Loading…"),
  "np-best": el => run(el, async () => {
    const np = npState(), type = np.info.type;
    const r = await api("POST", `/library/${type}/best`, { info: np.info });
    const all = [...libOf(type).entries.map(e => ({ ...e, text: e.rules.map(x => x.text).join("\n\n") })), ...libOf(type).builtins.map(b => ({ ...b, agents: [], text: builtinText(b, np.info) }))];
    let n = 0;
    r.picks.forEach(p => { const e = all.find(x => x.ref === p.ref); if (e && npAdd(np, p.section, { text: e.text, title: e.title, ref: e.ref, agents: e.agents, reason: p.reason })) n++; });
    R.npBestNote = `The AI added ${n} rule${n === 1 ? "" : "s"}${r.gaps.length ? `; nothing in the library covers ${r.gaps.map(g => (libOf(type).skeleton.sections.find(s => s.id === g) || {}).title || g).join(", ")}` : ""}. Remove what doesn't fit, Refine the rest.`;
    commit();
  }, "Choosing the best rules…"),
  "np-draft": el => run(el, async () => {
    const np = npState(), type = np.info.type;
    const docs = kbImp().files.filter(f => f.status === "ready").map(f => ({ name: f.name, text: f.text || [...f.facts.map(x => `${x.k}: ${x.v}`), ...f.faqs.map(x => `Q: ${x.q}\nA: ${x.a}`)].join("\n") }));
    const r = await api("POST", `/library/${type}/draft`, { info: np.info, docs });
    const ids = new Set(libOf(type).skeleton.sections.map(s => s.id));
    const only = el.dataset.sec || null;
    let n = 0, q = 0; r.rules.forEach(x => { const sec = ids.has(x.section) ? x.section : libOf(type).skeleton.sections[0].id; if (only && sec !== only) return;
      const c = npTakeAsks(x.text, x.asks); if (npAdd(np, sec, { text: c.text, title: x.title, from: { agent: "AI draft" }, notes: c.notes })) { n++; q += c.notes.length; } });
    if (!only && !np.greeting.trim() && r.greeting) np.greeting = npTakeAsks(r.greeting).text;
    R.npBestNote = `The AI drafted ${n} rule${n === 1 ? "" : "s"}${q ? `, with ${q} question${q === 1 ? "" : "s"} for you beside them` : ""}. Check every one.`;
    commit();
  }, "Drafting (about a minute)…"),
  "np-draft-sec": el => ACT["np-draft"](el),
  "np-fix-greet": () => { const np = npState(); np.greeting = npGreetExample(np); commit(); },
  "np-fill": () => { const np = npState(), vals = {};
    $$('[id^="np-p-"]').forEach(i => { if (i.value.trim()) vals[i.id.slice(5)] = i.value.trim(); });
    if (!Object.keys(vals).length) return toast("Type a value first.");
    const fill = t => String(t).replace(/\[\[(\w+)\]\]/g, (m, k) => vals[k] != null ? vals[k] : m);
    np.greeting = fill(np.greeting); Object.values(np.secs).flat().forEach(x => { x.text = fill(x.text); }); commit(); toast("Filled."); },
  "np-fix-confirm": () => { const np = npState(); let q = 0;
    Object.values(np.secs).flat().forEach(x => { if (/\[CONFIRM/i.test(x.text)) { const c = npTakeAsks(x.text); x.text = c.text; x.notes = [...(x.notes || []), ...c.notes]; q += c.notes.length; } });
    commit(); toast(`${q} question${q === 1 ? "" : "s"} now beside ${q === 1 ? "its rule" : "their rules"}.`); },
  "np-fix-client": () => { const np = npState(), to = np.info.client; if (!to) return; const hits = npOtherClients(np, npAllText(np));
    const re = new RegExp(`\\b(${hits.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi");
    np.greeting = np.greeting.replace(re, to); Object.values(np.secs).flat().forEach(x => { x.text = x.text.replace(re, to); }); commit(); toast(`Replaced with ${to}. Check the agent's name too.`); },
  "np-notes-go": () => { const o = npOpenNotes(npState())[0]; if (!o) return; const el = document.getElementById(`np-note-${o.note.id}`); if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); const i = $(`#np-ans-${o.note.id}`); if (i) i.focus({ preventScroll: true }); } },
  "np-note-x": el => { const f = npFind(npState(), el.dataset.id); const n = f && (f.x.notes || []).find(y => y.id === el.dataset.n); if (n) n.done = true; commit(); },
  "np-note-apply": el => run(el, async () => {
    const np = npState(), f = npFind(np, el.dataset.id); if (!f) return;
    const n = (f.x.notes || []).find(y => y.id === el.dataset.n), ans = (($(`#np-ans-${el.dataset.n}`) || {}).value || "").trim();
    if (!ans) throw new Error("Type the answer first.");
    const sec = libOf(np.info.type).skeleton.sections.find(s => s.id === f.sec) || {};
    const r = await api("POST", `/library/${np.info.type}/refine`, { ref: f.x.ref || null, text: f.x.text, title: f.x.title || sec.title, section: f.sec, info: np.info, save: false,
      note: `The engineer answered the question "${n.ask}": ${ans}. Work this answer into the rule exactly; change nothing else.` });
    f.x.text = r.text; if (r.ref) { f.x.ref = r.ref; f.x.refined = true; } n.done = true; n.answer = ans; commit();
  }, "Applying…"),
  "np-lib": el => { R.npLib = R.npLib === el.dataset.sec ? null : el.dataset.sec; R.npOpen = null; render(); const s = document.getElementById(`np-sec-${el.dataset.sec}`); if (s) s.scrollIntoView({ block: "start", behavior: "smooth" }); },
  "np-lib-x": () => { R.npLib = null; render(); },
  "np-open": el => { R.npOpen = R.npOpen === el.dataset.ref ? null : el.dataset.ref; render(); },
  "np-add": el => { const np = npState(), e = sectionEntries(np.info.type, el.dataset.sec, np.info).find(x => x.ref === el.dataset.ref); if (e && npAdd(np, el.dataset.sec, { text: e.text, title: e.title, ref: e.ref, agents: e.agents })) commit(); },
  "np-new": el => { R.npNew = el.dataset.sec; render(); const t = $("#np-new-text"); if (t) t.focus(); },
  "np-new-x": () => { R.npNew = null; render(); },
  "np-new-save": el => { const t = ($("#np-new-text") || {}).value || ""; if (!t.trim()) return; npAdd(npState(), el.dataset.sec, { text: t.trim() }); R.npNew = null; commit(); },
  "np-ed": el => { R.npEdit = el.dataset.id; R.npRefine = null; render(); },
  "np-ed-cancel": () => { R.npEdit = null; render(); },
  "np-ed-save": el => { const f = npFind(npState(), el.dataset.id), t = ($(`#np-ed-${el.dataset.id}`) || {}).value; if (f && t != null && t.trim()) { f.x.text = t.trim(); f.x.edited = true; } R.npEdit = null; commit(); },
  "np-rm": el => { const f = npFind(npState(), el.dataset.id); if (f) f.list.splice(f.i, 1); commit(); },
  "np-mv": el => { const f = npFind(npState(), el.dataset.id); if (f && f.i > 0) [f.list[f.i - 1], f.list[f.i]] = [f.list[f.i], f.list[f.i - 1]]; commit(); },
  "np-refine": el => { R.npRefine = el.dataset.id; R.npEdit = null; render(); },
  "np-refine-x": () => { R.npRefine = null; render(); },
  "np-refine-go": el => run(el, async () => {
    const np = npState(), f = npFind(np, el.dataset.id); if (!f) return;
    const sec = libOf(np.info.type).skeleton.sections.find(s => s.id === f.sec) || {};
    const r = await api("POST", `/library/${np.info.type}/refine`, { ref: f.x.ref || null, text: f.x.text, title: f.x.title || sec.title, section: f.sec, info: np.info, note: ($("#np-rf-note") || {}).value || "" });
    Object.assign(f.x, { text: r.text, ref: r.ref, refined: true, reason: r.changes, agents: [] });
    R.npRefine = null; commit(); loadLibType(np.info.type, true).catch(() => { });
    toast(`Refined, and saved to the library as ${r.moduleId}.`);
  }, "Refining…"),
  "np-kb": el => { R.npKb = R.npKb === el.dataset.sec ? null : el.dataset.sec; R.kbTarget = R.npKb ? { sec: R.npKb } : null; render(); },
  "np-review": el => run(el, async () => {
    const np = npState(), sk = libOf(np.info.type).skeleton;
    const blocks = [{ id: "GREETING", sec: "greeting", locked: false, text: np.greeting }, ...sk.sections.flatMap(s => npRules(np, s.id).map(x => ({ id: x.id, sec: s.id, locked: false, text: x.text })))];
    const r = await api("POST", "/ai/review", { blocks, steps: ["Client", "Source"] });
    R.npReview = r.issues; render();
  }, "Reviewing (about a minute)…"),
  "np-fix": el => { const np = npState(), r = (R.npReview || [])[+el.dataset.i]; if (!r || !r.fix || r.applied) return; const f = r.fix;
    if (f.type === "edit") { if (f.block === "GREETING") np.greeting = f.text; else { const x = npFind(np, f.block); if (!x) return toast("That rule changed since the review."); x.x.text = f.text; } }
    else if (f.type === "add") npAdd(np, npRules(np, f.sec) && libOf(np.info.type).skeleton.sections.some(s => s.id === f.sec) ? f.sec : libOf(np.info.type).skeleton.sections[0].id, { text: f.text, reason: "Added by the AI review" });
    r.applied = true; commit(); },
  "np-save": el => run(el, async () => {
    const np = npState(), sk = libOf(np.info.type).skeleton;
    const issues = npChecks(np, sk).filter(c => c.fix !== "notes").map(c => ({ t: c.t, d: c.d }));
    const questions = npOpenNotes(np).map(o => ({ section: (sk.sections.find(s => s.id === o.sec) || {}).title || o.sec, rule: o.rule.text.slice(0, 200), ask: o.note.ask }));
    const r = await api("POST", `/library/${np.info.type}/compose`, { name: np.name, info: np.info, greeting: np.greeting, sourceAgentId: np.sourceAgent ? np.sourceAgent.id : null, issues, questions,
      sections: sk.sections.map(s => ({ id: s.id, title: s.title, rules: npRules(np, s.id).map(x => ({ text: x.text, ref: x.ref || null })) })) });
    L.np = null; R.npReview = null; R.npBestNote = null; saveLocal(); await loadPrompts(true);
    R.curId = r.promptId; R.agentId = null; R.tab = "prompt"; location.hash = "#improve";
    const open = r.openIssues + r.openQuestions;
    toast(open ? `Saved as a draft with ${open} open item${open === 1 ? "" : "s"}, listed on its page.` : "Saved as a draft. Send it for approval, then push it to a Sarvam agent.");
  }, "Saving…"),
  "np-start": el => { const np = npState(); if (np.info.type !== el.dataset.type) { L.np = null; npState().info.type = el.dataset.type; } saveLocal(); },
  // library page
  "lib-type": el => { R.libType = el.dataset.type; R.skDraft = null; R.libDocs = false; render(); loadLibType(el.dataset.type).then(render).catch(e => toast(e.message)); },
  "lib-open": el => { R.libType = el.dataset.type; },
  "lib-entry": el => run(el, async () => { await loadMod(el.dataset.id); render(); window.scrollTo(0, 0); }),
  "sk-derive": el => run(el, async () => { const type = R.libType || "collections"; const r = await api("POST", `/library/${type}/skeleton/derive`); R.skDraft = { type, ...r }; render(); }, "Reading the agents…"),
  "sk-blank": () => { const type = R.libType || "collections"; const st = JSON.parse(JSON.stringify(libOf(type).skeleton)); delete st.starter; R.skDraft = { type, ...st }; render(); },
  "sk-edit": () => { const type = R.libType || "collections"; R.skDraft = { type, ...JSON.parse(JSON.stringify(libOf(type).skeleton)) }; delete R.skDraft.starter; render(); },
  "sk-cancel": () => { R.skDraft = null; render(); },
  "sk-add": () => { R.skDraft.sections.push({ id: "", title: "New section", mandatory: false, desc: "", aliases: [] }); render(); },
  "sk-rm": el => { R.skDraft.sections.splice(+el.dataset.i, 1); render(); },
  "sk-mv": el => { const a = R.skDraft.sections, i = +el.dataset.i, j = i + (+el.dataset.d); if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; render(); },
  "sk-save": el => run(el, async () => { const type = R.libType || "collections", d = R.skDraft;
    await api("PUT", `/library/${type}/skeleton`, { greeting: d.greeting, sections: d.sections, derivedFrom: d.derivedFrom });
    if (d.rules && d.rules.length) { const r = await api("POST", `/library/${type}/from-docs/save`, { rules: d.rules }); toast(`Structure confirmed; ${r.created} rules saved to the library as drafts.`); } else toast("Structure confirmed.");
    R.skDraft = null; await loadLibType(type, true); render(); }, "Saving…"),
  "lib-extract": el => run(el, async () => { const type = R.libType || "collections"; libOf(type).job = await api("POST", `/library/${type}/extract/start`); render(); pollLib(type); }),
  "lib-docs-toggle": () => { R.libDocs = !R.libDocs; R.kbTarget = null; render(); },
  "lib-docs-go": el => run(el, async () => { const type = R.libType || "collections", I = kbImp();
    const r = await api("POST", `/library/${type}/from-docs`, { docs: I.files.filter(f => f.status === "ready").map(f => ({ name: f.name, text: f.text || [...f.facts.map(x => `${x.k}: ${x.v}`), ...f.faqs.map(x => `Q: ${x.q}\nA: ${x.a}`)].join("\n") })) });
    R.libDocs = false; R.kbImp = null;
    if (r.skeleton) { R.skDraft = { type, ...r.skeleton, rules: r.rules }; toast("Check the proposed structure, then confirm it."); }
    else { await loadLibType(type, true); toast(`${r.created} new rule${r.created === 1 ? "" : "s"} added to the library as drafts.`); }
    render(); }, "Reading the documents…"),
  "agent-type": el => run(el, async () => { await api("PATCH", `/agents/${el.dataset.id}`, { agentType: el.dataset.v }); await loadAgents(true); await Promise.all(NP_TYPES.map(([t]) => loadLibType(t, true))); render(); }),
});
async function pollLib(type) {
  for (;;) { await new Promise(r => setTimeout(r, 2000)); let j; try { j = await api("GET", `/library/${type}/extract/status`); } catch (_) { return; }
    if (libOf(type)) libOf(type).job = j; if (route() === "modules") render();
    if (j.state !== "running") { await loadLibType(type, true); if (route() === "modules") render(); return; } }
}

// Inputs: new prompt fields, the structure editor, the library search box.
document.addEventListener("input", e => {
  const el = e.target;
  if (el.dataset.np) { const np = npState(), [a, b] = el.dataset.np.split("."); if (b) np[a][b] = el.value; else np[a] = el.value; saveLocal(); if (el.tagName === "SELECT") render(); return; }
  if (el.dataset.npQ != null) { R.npQ = el.value; render(); const q = $("#np-q"); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } return; }
  if (el.dataset.sk && R.skDraft) { if (el.dataset.sk === "greeting") R.skDraft.greeting.desc = el.value; else R.skDraft.sections[+el.dataset.i][el.dataset.sk] = el.value; }
});
document.addEventListener("change", e => {
  const el = e.target;
  if (el.dataset.np && el.tagName === "SELECT") { const np = npState(), [a, b] = el.dataset.np.split("."); np[a][b] = el.value; saveLocal(); render(); }
  if (el.dataset.skCheck && R.skDraft) R.skDraft.sections[+el.dataset.i][el.dataset.skCheck] = el.checked;
});

// Routes: New prompt and the Library page replace the 10-step wizard and the module list.
ROUTES.create = { view: viewNewPrompt, load: async () => { await loadAgents(); await loadLibType(npState().info.type); } };
ROUTES.modules = { view: viewLibraryPage, load: async () => { await Promise.all([loadAgents(true), loadPrompts(true)]); const mr = await api("GET", "/modules"); R.lib = mr.library; await loadLibType(R.libType || "collections", true); if (R.modId) await loadMod(R.modId); const j = libOf(R.libType || "collections").job; if (j && j.state === "running") pollLib(R.libType || "collections"); } };

// Tab in an empty box whose grey example starts with "e.g." puts the example in as real text.
const exampleOf = el => { const ph = el && el.getAttribute && el.getAttribute("placeholder"); const m = ph && ph.match(/e\.g\.?,?\s*([\s\S]+)$/i); return m ? m[1].replace(/[…]+\s*$/, "").trim() : null; };
const tabHint = (() => { const d = document.createElement("div"); d.className = "tab-hint"; d.textContent = "Tab ⇥ to use the example"; d.hidden = true; document.body.appendChild(d); return d; })();
const fillable = el => el && el.matches && el.matches("input[type=text], input:not([type]), textarea") && !el.value && exampleOf(el);
function placeHint(el) { if (!fillable(el)) { tabHint.hidden = true; return; } const r = el.getBoundingClientRect(); tabHint.style.top = `${r.bottom + 4}px`; tabHint.style.left = `${Math.max(8, r.right - 190)}px`; tabHint.hidden = false; }
document.addEventListener("focusin", e => placeHint(e.target));
document.addEventListener("focusout", () => { tabHint.hidden = true; });
document.addEventListener("input", e => placeHint(e.target));
window.addEventListener("scroll", () => { if (!tabHint.hidden) placeHint(document.activeElement); }, true);
document.addEventListener("keydown", e => {
  if (e.key !== "Tab" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
  const el = e.target; if (!fillable(el)) return;
  e.preventDefault();
  const id = el.id; el.value = exampleOf(el);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const now = (id && document.getElementById(id)) || el; // a redraw may have replaced the box
  now.focus(); try { now.setSelectionRange(now.value.length, now.value.length); } catch (_) { }
  tabHint.hidden = true;
});
