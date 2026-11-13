// Prompt Builder front end. Depends on /shared/blocks.js and /shared/promptcore.js (loaded first).
// Server data (agents, prompts, versions, feedback, approvals) comes from /api. The in-progress
// wizard draft is kept in this browser only, until it is saved as a prompt.

// ---------- Utilities ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const setPath = (o, p, v) => { const ks = p.split("."); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };
const fmtDate = t => t ? new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 3200); }
const layerChip = l => `<span class="chip lchip" style="background:var(--${String(l || "l6").toLowerCase()})">${esc(l)}</span>`;
const statusPill = s => `<span class="status st-${esc(s)}">${esc({ draft: "Draft", pending: "Waiting for approval", approved: "Approved", live: "Live", rejected: "Rejected", superseded: "Superseded", rolled_back: "Rolled back" }[s] || s)}</span>`;

async function api(method, path, body) {
  const res = await fetch("/api" + path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  if (res.status === 401 && path !== "/login") { showLogin(); throw new Error("Sign in to continue."); }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `Request failed (${res.status})`), { code: data && data.code, status: res.status, data });
  return data;
}
async function run(btn, fn, busyText) {
  const old = btn ? btn.textContent : ""; if (btn) { btn.disabled = true; if (busyText) btn.textContent = busyText; }
  try { return await fn(); } catch (e) { toast(e.message); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
}
// ---------- Change viewer ----------
// Every "what changed" view in the builder: one card per change, labelled Changed / New / Removed,
// with where it sits (the heading above it), Before and After side by side (or inline), and the exact
// words that changed highlighted. With opts.edit, each card on a drafted fix can be edited or undone.
const cvTok = s => s.match(/\s+|[^\s]+/g) || [];
function wordDiff(a, b) {
  const A = cvTok(a), B = cvTok(b), n = A.length, m = B.length;
  if (!n || !m || n * m > 2.5e6) return { left: a ? `<del>${esc(a)}</del>` : "", right: b ? `<ins>${esc(b)}</ins>` : "", inline: (a ? `<del>${esc(a)}</del>` : "") + (b ? `<ins>${esc(b)}</ins>` : "") };
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const seq = []; let i = 0, j = 0;
  const push = (k, t) => { const l = seq[seq.length - 1]; if (l && l.k === k) l.t += t; else seq.push({ k, t }); };
  while (i < n && j < m) { if (A[i] === B[j]) { push("s", A[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) push("d", A[i++]); else push("a", B[j++]); }
  while (i < n) push("d", A[i++]); while (j < m) push("a", B[j++]);
  // Long unchanged stretches inside a changed passage are shortened to their ends, so the eye lands on
  // what changed (unless "Show full text" is on). A word that only differs by whitespace counts as the same.
  const gap = t => { const w = t.trim().split(/\s+/).length; return `<span class="cv-gap">… ${w} unchanged word${w === 1 ? "" : "s"} …</span>`; };
  const same = (t, idx, last) => {
    if (R.cvFull || t.length <= 260) return esc(t);
    if (idx === 0) return gap(t.slice(0, -110)) + esc(t.slice(-110));
    if (idx === last) return esc(t.slice(0, 110)) + gap(t.slice(110));
    return esc(t.slice(0, 90)) + gap(t.slice(90, -90)) + esc(t.slice(-90));
  };
  const out = filter => { const s = seq.filter(filter); return s.map((x, i) => x.k === "s" ? same(x.t, i, s.length - 1) : /^\s+$/.test(x.t) ? esc(x.t) : x.k === "d" ? `<del>${esc(x.t)}</del>` : `<ins>${esc(x.t)}</ins>`).join(""); };
  return { left: out(x => x.k !== "a"), right: out(x => x.k !== "d"), inline: out(() => true) };
}
const isHead = l => /^\s*(#{1,6}\s+\S|\*\*[^*].*\*\*\s*:?\s*$|\\\*\\\*.+\\\*\\\*\s*$)/.test(l);
// Groups a line diff into changes, each with its context line above/below and the nearest heading.
function cvHunks(a, b) {
  const ops = lineDiff(String(a || "").replace(/\r/g, ""), String(b || "").replace(/\r/g, ""));
  // la / lb: line numbers (1-based) in the old and new text, so each change says where it is.
  const hs = []; let cur = null, head = "", lastCtx = null, la = 0, lb = 0;
  ops.forEach(([k, t], idx) => {
    if (k === "c") { la++; lb++; if (cur) { cur.post = t; hs.push(cur); cur = null; } if (isHead(t)) head = t; lastCtx = t; return; }
    if (!cur) cur = { del: [], add: [], pre: lastCtx, head, start: idx, aLine: la + 1, bLine: lb + 1 };
    if (k === "d") { la++; cur.del.push(t); if (isHead(t)) head = t; } else { lb++; cur.add.push(t); }
  });
  if (cur) hs.push(cur);
  return { ops, hunks: hs.map(h => {
    const kind = h.del.some(x => x.trim()) && h.add.some(x => x.trim()) ? "changed" : h.add.some(x => x.trim()) ? "new" : "removed";
    return { ...h, kind, label: kind === "new" ? "Added" : kind === "removed" ? "Removed" : cvSimilar(h.del.join(" "), h.add.join(" ")) >= 0.5 ? "Modified" : "Replaced" };
  }).filter(h => h.del.some(x => x.trim()) || h.add.some(x => x.trim())) };
}
// Share of words kept between before and after (0 = all new, 1 = same). "Modified" keeps at least half.
function cvSimilar(a, b) {
  const wa = String(a).toLowerCase().match(/[\p{L}\p{N}{}_]+/gu) || [], wb = String(b).toLowerCase().match(/[\p{L}\p{N}{}_]+/gu) || [];
  if (!wa.length || !wb.length) return 0;
  const pool = new Map(); wa.forEach(w => pool.set(w, (pool.get(w) || 0) + 1));
  let common = 0; wb.forEach(w => { const n = pool.get(w); if (n) { common++; pool.set(w, n - 1); } });
  return common / Math.max(wa.length, wb.length);
}
// "line 12" / "lines 12–14" in the old text and the new text.
function cvLines(h) {
  const r = (start, n) => n <= 1 ? `line ${start}` : `lines ${start}–${start + n - 1}`;
  if (h.kind === "new") return `new ${r(h.bLine, h.add.length)}`;
  if (h.kind === "removed") return `was ${r(h.aLine, h.del.length)}`;
  return `${r(h.aLine, h.del.length)} → ${r(h.bLine, h.add.length)}`;
}
const CV_KLASS = { Added: "new", Removed: "removed", Modified: "changed", Replaced: "replaced" };
const cvClip = (lines, max = 24) => lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more line${lines.length - max === 1 ? "" : "s"}`] : lines;
const cvHeadText = h => String(h || "").replace(/[#*\\_]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
function diffHtml(a, b, opts = {}) {
  const { hunks } = cvHunks(a, b);
  if (!hunks.length) return `<div class="cv"><div class="cv-bar"><span class="muted">No changes</span></div></div>`;
  const mode = R.diffMode || "split";
  const count = l => hunks.filter(h => h.label === l).length;
  const dChars = String(b || "").replace(/\r/g, "").length - String(a || "").replace(/\r/g, "").length;
  const bar = `<div class="cv-bar"><span>${["Modified", "Replaced", "Added", "Removed"].filter(l => count(l)).map(l => `<span class="cv-k ${CV_KLASS[l]}">${count(l)} ${l.toLowerCase()}</span>`).join(" ")} <span class="muted">· ${delta(dChars)} characters</span></span>
    <span class="row" style="gap:8px"><label class="check small"><input type="checkbox" data-act-check="cv-full" ${R.cvFull ? "checked" : ""}> Show full text</label><span class="seg cv-mode"><button type="button" data-act="diff-mode" data-m="split" aria-pressed="${mode === "split"}">Side by side</button><button type="button" data-act="diff-mode" data-m="inline" aria-pressed="${mode === "inline"}">Inline</button></span></span></div>`;
  const ctx = t => t != null && t.trim() ? `<div class="cv-ctx">${esc(t.length > 180 ? t.slice(0, 180) + "…" : t)}</div>` : "";
  const cards = hunks.map((h, hi) => {
    const before = cvClip(h.del).join("\n"), after = cvClip(h.add).join("\n");
    const w = h.kind === "changed" ? wordDiff(before, after) : { left: h.del.length ? `<del>${esc(before)}</del>` : "", right: h.add.length ? `<ins>${esc(after)}</ins>` : "", inline: h.kind === "new" ? `<ins>${esc(after)}</ins>` : `<del>${esc(before)}</del>` };
    const key = opts.edit ? `${opts.edit.id}|${opts.edit.section}|${hi}` : null;
    const editing = key && R.hunkEdit === key;
    const where = cvHeadText(h.head);
    const actions = opts.edit && !editing ? `<span class="cv-act">${h.kind !== "removed" ? `<button class="btn sm ghost" data-act="hunk-edit" data-k="${esc(key)}">✎ Edit</button>` : ""}<button class="btn sm ghost" data-act="hunk-undo" data-k="${esc(key)}" title="Drop just this part of the change">↺ Undo</button></span>` : "";
    const head = `<div class="cv-head"${opts.anchor ? ` id="${esc(opts.anchor)}-${hi}"` : ""}><span class="cv-k ${CV_KLASS[h.label]}">${h.label}</span><span class="small mono cv-ln">${opts.section ? esc(opts.section) + " · " : ""}${cvLines(h)}</span>${where ? `<span class="small muted">under “${esc(where)}”</span>` : ""}<span class="small muted">${delta(h.add.join("\n").length - h.del.join("\n").length)}</span>${actions}</div>`;
    if (editing) return `<div class="cv-card editing">${head}<div class="cv-edit"><div class="small muted">Edit what this part should say. Everything else in the fix stays as it is.</div>
      <textarea id="hunk-text" rows="${Math.min(14, Math.max(3, h.add.length + 1))}" class="mono">${esc(h.add.join("\n"))}</textarea>
      <div class="row" style="gap:6px"><button class="btn sm primary" data-act="hunk-save" data-k="${esc(key)}">Save this part</button><button class="btn sm" data-act="hunk-cancel">Cancel</button></div></div></div>`;
    const body = mode === "inline" || h.kind !== "changed"
      ? `<div class="cv-one">${ctx(h.pre)}<div class="cv-txt">${w.inline}</div>${ctx(h.post)}</div>`
      : `<div class="cv-split"><div class="cv-col"><div class="cv-lbl">Before</div>${ctx(h.pre)}<div class="cv-txt">${w.left}</div>${ctx(h.post)}</div><div class="cv-col"><div class="cv-lbl">After</div>${ctx(h.pre)}<div class="cv-txt">${w.right}</div>${ctx(h.post)}</div></div>`;
    return `<div class="cv-card ${h.kind}">${head}${body}</div>`;
  }).join("");
  return `<div class="cv">${opts.bare ? "" : bar}${cards}</div>`;
}
// Save an edited part of a drafted fix, or undo just that part.
function hunkChange(el, save) {
  const [id, section, hi] = el.dataset.k.split("|");
  const it = item(id); if (!it || !it.draft) return;
  const base = latestOf(R.cur).sections[section] || "";
  const after = (it.draft.sections || { [it.map.section]: it.draft.revised })[section];
  const text = cvRebuild(base, after, Number(hi), save ? (($("#hunk-text") || {}).value || "") : null);
  if (text == null) { toast("That part of the fix has changed. Reload the page."); return; }
  run(el, async () => {
    const r = await api("PATCH", `/feedback/${id}/draft`, { section, text });
    R.hunkEdit = null; await reloadCur();
    toast(!r.draft ? "Every part was undone, so the draft was removed. Draft it again or edit by hand." : save ? "Saved. Check the fix again if you want a second read." : "That part was undone.");
  }, save ? "Saving…" : "Undoing…");
}
// Rebuild a section's text with one change replaced (edited) or reverted (undone).
function cvRebuild(a, b, hi, replacement) {
  const { ops, hunks } = cvHunks(a, b);
  const h = hunks[hi]; if (!h) return null;
  const all = []; let cur = null;
  ops.forEach(([k], idx) => { if (k === "c") { cur = null; return; } if (!cur) { cur = { start: idx, end: idx }; all.push(cur); } cur.end = idx; });
  const target = all.find(x => x.start === h.start);
  const out = [];
  ops.forEach(([k, t], idx) => {
    const inT = target && idx >= target.start && idx <= target.end;
    if (inT) { if (idx === target.start) out.push(...(replacement == null ? ops.slice(target.start, target.end + 1).filter(o => o[0] === "d").map(o => o[1]) : replacement.split("\n"))); return; }
    if (k !== "d") out.push(t);
  });
  return out.join("\n");
}
function loadScript(src) { return new Promise((res, rej) => { if ($(`script[src="${src}"]`)) return res(); const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Couldn't load a file reader. Check your connection.")); document.head.appendChild(s); }); }
const XLSX_SRC = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const MAMMOTH_SRC = "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js";
async function fileToText(file) {
  if (/\.docx$/i.test(file.name)) { await loadScript(MAMMOTH_SRC); return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value; }
  return file.text();
}
async function readFeedbackFile(file) {
  const name = file.name.toLowerCase();
  if (/\.(txt|md|docx)$/.test(name)) return splitFeedback(await fileToText(file));
  if (/\.(csv|xlsx|xls)$/.test(name)) {
    await loadScript(XLSX_SRC);
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
    if (!rows.length) return [];
    const cols = Object.keys(rows[0]);
    const fcol = cols.find(k => /feedback|issue|comment|observation|remark|defect|problem|description/i.test(k));
    const ctx = cols.filter(k => /call|id|scenario|bucket|lang/i.test(k) && k !== fcol);
    return rows.map(r => { const main = fcol ? String(r[fcol]) : cols.map(k => r[k]).filter(Boolean).join(" · "); const pre = ctx.map(k => r[k] ? `${k}: ${r[k]}` : "").filter(Boolean).join(", "); return (pre ? `[${pre}] ` : "") + main; }).filter(x => x.trim().length > 8);
  }
  throw new Error("Use .xlsx, .csv, .docx, .txt or .md.");
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); }
  catch (e) { toast("Copy was blocked by the browser. Select the text and copy it."); }
}
function downloadText(name, text) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
const fileName = (cfg, v) => `${((cfg.client && cfg.client.name) || "prompt").replace(/\W+/g, "_")}_${cfg.bucket}_v${v}.md`;

// ---------- State ----------
const KEY = "pb.draft.v1";
let L; // local wizard draft
function loadLocal() { try { L = JSON.parse(localStorage.getItem(KEY)); } catch (e) { } if (!L || !L.cfg) L = { cfg: baseCfg(), step: 0, showTags: true, genVersion: "1.0", genTags: true, libFilter: "all" }; }
function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(L)); } catch (e) { } }
const R = { sarvam: null, me: null, health: null, agents: null, prompts: null, approvals: null, core: null, cur: null, feedback: null, curId: null, cmpOpen: null, viewPrompt: false, editing: {}, aiReview: null, headers: [] };
try { R.diffMode = localStorage.getItem("pb-diff-mode") || "split"; } catch (_) { R.diffMode = "split"; }
const canDo = a => R.me && ({ edit: ["editor", "approver", "admin"], approve: ["approver", "admin"], golive: ["approver", "admin"], rollback: ["approver", "admin"] }[a] || []).includes(R.me.role);
const aiOn = () => R.health && R.health.llm && R.health.llm.length > 0;

// ---------- Auth ----------
function showLogin() { $("#shell").hidden = true; $("#login").hidden = false; }
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault(); $("#lMsg").textContent = "";
  try { const r = await api("POST", "/login", { email: $("#lEmail").value, password: $("#lPass").value }); R.me = r.user; R.selfApprove = r.selfApprove !== false; boot(); }
  catch (err) { $("#lMsg").textContent = err.message; }
});
$("#logout").addEventListener("click", async () => { await api("POST", "/logout").catch(() => { }); location.reload(); });

// ---------- Data loaders ----------
async function loadAgents(force) { if (!R.agents || force) { const r = await api("GET", "/agents"); R.agents = r.agents; } return R.agents; }
async function loadPrompts(force) { if (!R.prompts || force) R.prompts = (await api("GET", "/prompts")).prompts; return R.prompts; }
async function loadCur(id) {
  R.curId = id || R.curId || (R.prompts && R.prompts[0] && R.prompts[0].id);
  if (!R.curId) { R.cur = null; return; }
  const [p, f, ts] = await Promise.all([api("GET", "/prompts/" + R.curId), api("GET", `/prompts/${R.curId}/feedback`), api("GET", `/prompts/${R.curId}/tests`).catch(() => ({ items: [] }))]);
  R.cur = p; R.feedback = f.items; R.tests = ts.items; R.agentId = p.agent ? p.agent.id : null;
  // Agent prompts: the text exactly as in Sarvam (original order, untouched wording), plus greeting and variables.
  R.sv = null;
  if (p.agent && p.agent.sarvamAppId) { try { R.sv = await api("GET", `/versions/${latestOf(p).id}/sarvam-text`); } catch (e) { R.sv = null; } }
}
const latestOf = cur => cur.versions[cur.versions.length - 1];
const mdOf = (cfg, v, tags = true) => toMarkdown(header(cfg, v.v), v.order, v.sections, tags);

// ---------- Router ----------
const ROUTES = {
  overview: { view: viewOverview, load: () => Promise.all([loadPrompts(true), loadAgents(true), api("GET", "/approvals").then(r => R.approvals = r.items), api("GET", "/core-changes").then(r => R.core = r.items)]) },
  agents: { view: viewAgents, load: async () => { await Promise.all([loadAgents(true), loadPrompts(true), api("GET", "/sarvam/status").then(r => R.sarvam = r).catch(() => R.sarvam = null)]); api("GET", "/agents/pull-all/status").then(j => { if (j && j.state === "running") { R.pullJob = j; pollPull(); } }).catch(() => { }); } },
  create: { view: () => "", load: null }, // New prompt: set in library.js
  improve: { view: viewImprove, load: async () => {
    await Promise.all([loadPrompts(true), loadAgents(true), api("GET", "/sarvam/status").then(r => R.sarvam = r).catch(() => R.sarvam = null)]);
    const ag = R.agentId && R.agents.find(a => a.id === R.agentId);
    if (ag && !ag.promptId) { R.cur = null; R.curId = null; return; }
    await loadCur(ag ? ag.promptId : undefined);
    const agent = R.agentId && R.agents.find(a => a.id === R.agentId);
    if (R.tab === "calls" && agent && (!R.calls || R.calls.agentId !== agent.id)) loadCalls(agent);
    if (R.tab === "settings" && agent && (!R.acfg || R.acfg.agentId !== agent.id)) loadCfg(agent);
    loadLost();
    if (R.pendingEdit) { R.pendingEdit = false; const t = R.sv && R.sv.text ? R.sv.text : mdOf(R.cur.prompt.cfg, latestOf(R.cur), false); R.editText = { text: t, orig: t, greeting: greetingNow(), og: greetingNow() }; }
  } },
  approvals: { view: viewApprovals, load: async () => { R.approvals = (await api("GET", "/approvals")).items; await Promise.all([loadPrompts(true), loadAgents()]); R.sarvam = await api("GET", "/sarvam/status").catch(() => null); } },
  compare: { view: viewCompare, load: async () => { await Promise.all([loadAgents(true), loadPrompts(true)]); R.cmpData = {}; cmpLoad(); } },
  library: { view: viewLibrary, load: () => api("GET", "/core-changes").then(r => R.core = r.items) },
  modules: { view: viewModules, load: async () => { await Promise.all([loadAgents(true), loadPrompts(true)]); const mr = await api("GET", "/modules"); R.mods = mr.items; R.lib = mr.library; if (R.modId) await loadMod(R.modId); } }
};
const route = () => { const h = location.hash.slice(1).split("?")[0]; return ROUTES[h] ? h : "agents"; };
function updateBadge() {
  const n = (R.approvals || []).filter(v => ["pending", "approved"].includes(v.status)).length, b = $("#apprCount");
  if (b) { b.textContent = n; b.hidden = !n; }
}
function render() {
  const a = document.activeElement, fid = a && a.id; let ss = null, se = null; try { ss = a.selectionStart; se = a.selectionEnd; } catch (e) { }
  const r = route();
  $$("#tabs a").forEach(x => x.setAttribute("aria-current", x.getAttribute("href") === "#" + r || (x.dataset.also || "").split(" ").includes(r) ? "page" : "false"));
  updateBadge();
  const audio = $("#callAudio");
  $("#app").innerHTML = ROUTES[r].view();
  wireAudio(audio);
  if (fid) { const el = document.getElementById(fid); if (el) { el.focus({ preventScroll: true }); try { if (ss != null) el.setSelectionRange(ss, se); } catch (e) { } } }
}
async function go() {
  const r = route();
  if (ROUTES[r].load) { $("#app").innerHTML = `<div class="loading">Loading…</div>`; try { await ROUTES[r].load(); } catch (e) { $("#app").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; } }
  render(); window.scrollTo(0, 0);
}
window.addEventListener("hashchange", go);
function refreshInsights() { /* the old wizard's live outline is gone */ }
function commit(full = true) { saveLocal(); if (full) render(); else refreshInsights(); }

// ---------- Small render helpers ----------
const seg = (path, opts, val) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-act="seg" data-path="${path}" data-val='${JSON.stringify(v)}' aria-pressed="${JSON.stringify(val) === JSON.stringify(v)}">${esc(l)}</button>`).join("")}</div>`;
const yn = (path, val) => seg(path, [[true, "Yes"], [false, "No"]], val);
const trow = (title, hint, ctrl) => `<div class="toggle-row"><div class="t"><b>${title}</b><span>${hint}</span></div>${ctrl}</div>`;
const field = (label, path, val, hint = "", type = "text") => `<label class="f">${label}${hint ? ` <span class="hint">${hint}</span>` : ""}<input type="${type}" id="f-${path.replace(/\./g, '-')}" data-bind="${path}" value="${esc(val)}"></label>`;
const STEPS = ["Client", "Source", "Review"]; // New prompt

// ---------- OVERVIEW ----------
function viewOverview() {
  const k = (n, l, href) => `<a class="kpi" href="${href}" style="text-decoration:none;color:inherit"><b>${n}</b><span>${l}</span></a>`;
  const live = (R.prompts || []).filter(p => p.live).length;
  const pending = (R.approvals || []).filter(v => v.status === "pending").length;
  const create = STEPS.map((s, i) => `<span class="st"><i>${String(i + 1).padStart(2, "0")}</i>${s}</span>`).join('<span class="ar">→</span>');
  const improve = ["Refresh agents from Sarvam", "Import the live Sarvam prompt", "Bring in UAT feedback", "Map items to section and block", "Draft or hand-edit the fix", "New version → approval", "Push to Sarvam (UAT first)"].map((s, i) => `<span class="st"><i>${String(i + 1).padStart(2, "0")}</i>${s}</span>`).join('<span class="ar">→</span>');
  return `
  <div class="view-head"><div><h1>How the prompt system works</h1><p>Prompts are built from tested blocks or imported from the live Sarvam agents. Every change is traced to its block, versioned, approved, and confirmed against the Sarvam version Kollect calls.</p></div>
  <div class="row"><a class="btn primary" href="#agents">Agents</a><a class="btn" href="#create">Create a prompt</a></div></div>
  <div class="stack">
  <div class="kpis">${k((R.agents || []).length, "Sarvam agents", "#agents")}${k((R.prompts || []).length, "Prompts tracked", "#improve")}${k(live, "Prompts with a live version", "#improve")}${k(pending, "Versions waiting for approval", "#approvals")}${k((R.core || []).length, "Shared-core fixes logged", "#library")}</div>
  <div class="panel stack"><div><h2>Journey 1 · Improve a live agent</h2><p class="muted small">The everyday path once agents are in production.</p></div><div class="journey">${improve}</div></div>
  <div class="panel stack"><div><h2>Journey 2 · Create a prompt end to end</h2><p class="muted small">For a new client or bucket. Saved prompts follow the same approval path.</p></div><div class="journey">${create}</div></div>
  <div class="grid2">
    <div class="panel stack"><div><h2>Ten layers</h2><p class="muted small">Precedence when rules clash: ${PRECEDENCE.join(" › ")}.</p></div>
      <div class="layers">${LAYERS.map(l => `<div class="layer"><span class="id" style="color:${LAYER_COLOR(l.id)}">${l.id}</span><div style="min-width:0"><b>${l.name}</b><div class="d">${l.d}</div></div><span class="chip lvl">${l.edit}</span></div>`).join("")}</div></div>
    <div class="stack">
      <div class="panel stack"><h2>Connections</h2>${healthRows()}</div>
      <div class="panel stack"><h2>Known defects in the source prompts</h2>
        <div class="tbl-wrap"><table><thead><tr><th>Defect</th><th>In the builder</th><th>Status</th></tr></thead><tbody>
        ${DEFECTS.map(d => `<tr><td>${esc(d.d)}</td><td class="muted">${esc(d.fix)}</td><td><span class="chip ${d.st === "fixed" ? "ok" : "warn"}">${d.st === "fixed" ? "Fixed" : "Decision needed"}</span></td></tr>`).join("")}
        </tbody></table></div></div>
    </div>
  </div></div>`;
}
function healthRows() {
  const h = R.health || {};
  const row = (ok, t, d) => `<div class="vitem ${ok ? "ok" : "warn"}"><span class="ic">${ok ? "✓" : "!"}</span><div class="vt"><b>${t}</b><span>${d}</span></div></div>`;
  return `<div class="stack" style="gap:6px">
   ${row(h.db && h.db.ok && h.db.kind === "postgres", "Database", h.db ? (h.db.kind === "postgres" ? (h.db.ok ? "Render Postgres connected." : "Postgres error: " + esc(h.db.error)) : "Local file store. Set DATABASE_URL on Render or data is lost on each deploy.") : "Unknown")}

   ${row(h.llm && h.llm.length, "AI model", h.llm && h.llm.length ? esc(h.llm.join(" → ")) : "No GEMINI_API_KEY or GLM key: feedback is mapped with keyword rules and AI drafting is off.")}
   ${row(R.sarvam && R.sarvam.hasToken, "Sarvam", "Prompts are read from Sarvam automatically, and approved changes are pushed back with Push to Sarvam.")}
  </div>`;
}

// ---------- LIVE AGENTS ----------
function viewAgents() {
  const ag = R.agents || [], q = (R.agQ || "").trim().toLowerCase();
  const sOn = R.sarvam && R.sarvam.hasToken && !R.sarvam.expired;
  // One list: every agent, then prompts saved in the builder that aren't linked to an agent yet.
  const drafts = (R.prompts || []).filter(p => !p.agentId);
  const hit = (...t) => !q || t.join(" ").toLowerCase().includes(q);
  const rows = [...ag].filter(a => hit(a.name, a.client, a.sarvamName, a.agentType)).map(agentCard)
    .concat(drafts.filter(p => hit(p.name, p.agentType)).map(p => `<a class="arow" href="#improve" data-act="open-prompt" data-id="${p.id}"><div class="nm"><b>${esc(p.name)}</b><div class="small muted">${p.agentType ? `${esc(p.agentType === "sales" ? "Sales" : "Collections")} · ` : ""}not linked to a Sarvam agent yet${p.latest ? ` · v${esc(p.latest.v)}` : ""}</div></div><div>${p.latest ? statusPill(p.latest.status) : ""}</div><div></div></a>`));
  return `
  <div class="view-head"><div><h1>Agents</h1><p>${ag.length} agent${ag.length === 1 ? "" : "s"}${drafts.length ? ` · ${drafts.length} new prompt${drafts.length === 1 ? "" : "s"} not linked yet` : ""}</p></div>
  <div class="row" style="gap:8px"><input type="search" id="ag-q" data-ag-q placeholder="Search agents" value="${esc(R.agQ || "")}" style="width:240px">
   <details class="more"><summary class="btn" aria-label="More actions">⋯</summary><div class="more-pop">
     <a href="#" data-act="sync" title="Reads every agent and its newest committed version from Sarvam">Refresh from Sarvam</a>
     ${canDo("edit") && sOn ? `<a href="#" data-act="pull-all" title="Reads every agent's prompt and versions from Sarvam">Load all prompts</a>` : ""}
     <a href="#compare">Compare two agents</a></div></details>
   <a class="btn primary" href="#create">+ New agent</a></div></div>
  ${sarvamPanel()}
  ${pullBar()}
  ${R.syncNote ? `<div class="notice"><span>${R.syncNote}</span><a href="#" class="small" data-act="sync-note-x">dismiss</a></div>` : ""}
  ${rows.length ? `<div class="alist">${rows.join("")}</div>` : `<div class="empty">${q ? `Nothing matches “${esc(R.agQ)}”.` : sOn ? "No agents yet. Choose ⋯ → Refresh from Sarvam." : "No agents yet. Connect Sarvam first."}</div>`}`;
}
// "Load all prompts": progress while it runs in the background, and what happened when it's done.
function pullBar() {
  const j = R.pullJob; if (!j || j.state === "idle") return "";
  const pct = j.total ? Math.round(100 * j.done / j.total) : 0;
  if (j.state === "running") return `<div class="notice" style="flex-direction:column;align-items:stretch;gap:6px"><div class="row" style="justify-content:space-between"><b>Loading prompts from Sarvam · ${j.done} of ${j.total}</b><span class="small muted">${(j.current || []).map(esc).join(", ")}</span></div><div style="height:4px;border-radius:2px;background:var(--sunk)"><div style="height:4px;border-radius:2px;background:var(--accent);width:${pct}%"></div></div><div class="small muted">You can leave this page. It keeps going.</div></div>`;
  const bad = (j.errors || []).length;
  return `<div class="notice ${j.state === "done" && !j.failed ? "ok" : ""}" style="flex-direction:column;align-items:stretch;gap:4px"><div class="row" style="justify-content:space-between"><span><b>${j.state === "done" ? "Loaded all prompts" : "Stopped: " + esc(j.stopped || "")}</b> · ${j.imported} new or updated, ${j.unchanged} already current${j.failed ? `, ${j.failed} couldn't be loaded` : ""}</span><a href="#" class="small" data-act="pull-bar-x">dismiss</a></div>${bad ? `<details class="small"><summary>${bad} note${bad === 1 ? "" : "s"}</summary>${j.errors.map(e => `<div class="muted">${esc(e)}</div>`).join("")}</details>` : ""}</div>`;
}
async function pollPull() {
  if (R.pullPoll) return;
  R.pullPoll = setInterval(async () => {
    try {
      const j = await api("GET", "/agents/pull-all/status"); R.pullJob = j;
      if (j.state !== "running") { clearInterval(R.pullPoll); R.pullPoll = null; await Promise.all([loadAgents(true), loadPrompts(true)]); toast(j.state === "done" ? `Loaded all prompts: ${j.imported} new or updated, ${j.unchanged} already current${j.failed ? `, ${j.failed} couldn't be loaded` : ""}.` : `Stopped: ${j.stopped || "see the note on the Agents page"}`); }
      if (route() === "agents") render();
    } catch (e) { clearInterval(R.pullPoll); R.pullPoll = null; }
  }, 2000);
}
// Sarvam connection: one quiet line when fine, a yellow bar with one button when it needs action.
function sarvamPanel() {
  const s = R.sarvam || {};
  const exp = s.expiresAt ? new Date(s.expiresAt) : null;
  const urlErr = new URLSearchParams(location.hash.split("?")[1] || "").get("sarvamError");
  const ok = s.hasToken && !s.expired && !s.lastError && !urlErr;
  if (ok) return `<div class="notice ok">✓ Sarvam connected${exp ? ` until ${esc(exp.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }))}` : ""}${canDo("approve") ? ` · <a href="/api/sarvam/connect">Reconnect</a> · <a href="#" data-act="sarvam-clear">Disconnect</a>` : ""}</div>`;
  const msg = urlErr ? `Sarvam sign-in failed: ${esc(urlErr)}`
    : !s.hasToken ? "Connect Sarvam so prompts come in automatically."
    : s.expired ? "Your Sarvam sign-in expired."
    : esc(s.lastError);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  // Sarvam only allows the normal sign-in from localhost (or addresses it has allow-listed). On any other
  // site: sign in at Sarvam, and paste back the address your browser is sent to.
  const manual = canDo("approve") && !local ? `<div class="stack small" style="gap:6px;margin-top:8px">
    <div class="muted">Sarvam only lets this kind of sign-in return to <code>localhost</code>, so it takes three steps:</div>
    <ol style="margin:0 0 0 18px"><li><a href="/api/sarvam/connect?manual=1" target="_blank" rel="noopener"><b>Open Sarvam sign-in</b></a> (opens a new tab) and approve.</li>
     <li>The new tab then shows a page that <b>can't be reached</b> (<code>localhost:8976</code>). That's expected. Copy the <b>whole address</b> from its address bar.</li>
     <li>Paste it here and click <b>Connect</b>.</li></ol>
    <textarea id="sv-paste" rows="2" class="mono" placeholder="http://localhost:8976/callback?code=…&state=…" spellcheck="false"></textarea>
    <div class="row"><button class="btn sm primary" data-act="sarvam-finish">Connect</button><span class="muted">The address holds a one-time code. It stops working once used.</span></div></div>` : "";
  const alt = canDo("approve") ? `<details class="small" style="margin-top:8px"><summary>Or use a login made on your own computer</summary>
    <div class="stack" style="gap:6px;margin-top:6px"><ol style="margin:0 0 0 18px"><li>On your computer, open the builder at <code>localhost</code> and click <b>Connect Sarvam</b>.</li><li>In the builder folder, run <code>npm run export-sarvam</code> and copy the one long line it prints.</li><li>Paste it below and click <b>Use this login</b>.</li></ol>
     <textarea id="sv-line" rows="3" class="mono" placeholder="Paste the long line here" spellcheck="false"></textarea>
     <div class="row"><button class="btn sm" data-act="sarvam-import">Use this login</button><span class="muted">The line is a secret. Don't use the same login in both places at once.</span></div></div></details>` : "";
  const btn = !canDo("approve") ? `<span class="small muted">Ask an approver to connect Sarvam.</span>` : local ? `<a class="btn sm primary" href="/api/sarvam/connect">${s.hasToken ? "Reconnect Sarvam" : "Connect Sarvam"}</a>` : "";
  return `<div class="notice" style="flex-direction:column;align-items:stretch"><div class="row" style="justify-content:space-between;gap:8px"><b>${msg}</b>${btn}</div>${manual}${local || !canDo("approve") ? "" : alt}</div>`;
}
function agentCard(a) {
  const p = (R.prompts || []).find(x => x.id === a.promptId);
  const waiting = p && p.latest && p.latest.id !== (p.live || {}).id ? p.latest.status : null;
  const flag = a.sarvamPullError ? `<span class="chip warn">Couldn't load prompt</span>`
    : !p ? `<span class="chip">No prompt yet</span>`
    : waiting === "pending" ? `<span class="chip warn">Change waiting for approval</span>`
    : waiting === "approved" ? `<span class="chip acc">Approved, ready to push</span>`
    : waiting === "draft" ? `<span class="chip">Draft change</span>`
    : a.sarvamDraftAhead ? `<span class="chip warn">Unsaved edits in Sarvam</span>` : "";
  const uatOf = (R.agents || []).find(x => x.uatAgentId === a.id);
  const lv = p && p.live && p.live.sarvamVersion ? Number(p.live.sarvamVersion) : null;
  const newer = lv && a.sarvamNewest && a.sarvamNewest > lv ? `<span class="chip warn" title="Sarvam has a newer committed version than the one shown here. Open the agent and use ⋯ → Reload prompt from Sarvam.">Sarvam has v${esc(a.sarvamNewest)}</span>` : "";
  const notK = "";
  return `<a class="arow" href="#improve" data-act="open-agent" data-id="${esc(a.id)}">
   <div class="nm" style="min-width:0"><b>${esc(a.name)}</b><div class="small muted">${a.agentType === "sales" ? "Sales · " : ""}${esc(a.client || a.sarvamName || "")}${p && p.live && p.live.sarvamVersion ? ` · Sarvam v${esc(p.live.sarvamVersion)}` : a.sarvamNewest ? ` · Sarvam v${esc(a.sarvamNewest)} (prompt not loaded yet)` : ""}</div>${flag || uatOf || newer || notK ? `<div class="row" style="margin-top:6px;gap:4px">${flag}${newer}${notK}${uatOf ? `<span class="chip">UAT for ${esc(uatOf.name)}</span>` : ""}</div>` : ""}</div>


  </a>`;
}
async function reloadAgents() { if (route() === "improve") return go(); await Promise.all([loadAgents(true), loadPrompts(true), api("GET", "/sarvam/status").then(r => R.sarvam = r).catch(() => { })]); render(); }
const promptMsg = p => !p ? "" : p.skipped ? `Prompts not pulled: ${p.reason}.` : `Prompts: ${p.imported} imported, ${p.unchanged} unchanged${p.failed ? `, ${p.failed} failed (${p.error})` : ""}.`;
const fmtDur = s => { s = Math.round(Number(s) || 0); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m ${s % 60}s` : `${s}s`; };
async function callsModal(a) {
  $("#modal").innerHTML = `<div class="panel stack" role="dialog" aria-modal="true"><div class="small muted">Loading conversations…</div></div>`;
  $("#modal").hidden = false;
  let r;
  try { r = await api("GET", `/agents/${encodeURIComponent(a.id)}/calls`); }
  catch (e) { $("#modal").innerHTML = `<div class="panel stack"><div class="row" style="justify-content:space-between"><h2>Conversations · ${esc(a.name)}</h2><button class="btn sm ghost" data-act="close-modal">Close</button></div><div class="empty">${esc(e.message)}</div></div>`; return; }
  const u = r.usage || a, p = (R.prompts || []).find(x => x.id === a.promptId);
  const one = c => `<details class="panel"><summary><b>${esc(new Date(c.at).toLocaleString())}</b> · ${esc(c.customer || "Unknown")} ${esc(c.phone || "")} · ${c.answered ? fmtDur(c.durationSeconds) : "not answered"}${c.analysis && c.analysis.sentiment ? ` · ${esc(c.analysis.sentiment)}` : ""}${c.endReason && !c.answered ? ` · ${esc(c.endReason)}` : ""}</summary>
    ${c.analysis && c.analysis.summary ? `<p class="small"><b>Summary:</b> ${esc(c.analysis.summary)}</p>` : ""}${c.analysis && c.analysis.nextBestAction ? `<p class="small"><b>Next best action:</b> ${esc(c.analysis.nextBestAction)}</p>` : ""}
    ${(c.turns || []).length ? `<div class="stack" style="gap:4px">${c.turns.map(t => `<div class="small"><b>${t.role === "agent" ? "Agent" : "Customer"}:</b> ${esc(t.text)}</div>`).join("")}</div>` : `<div class="small muted">No transcript was captured for this call.</div>`}</details>`;
  $("#modal").innerHTML = `<div class="panel stack" role="dialog" aria-modal="true" style="max-height:88vh;overflow:auto">
   <div class="row" style="justify-content:space-between"><h2>Conversations · ${esc(a.name)}</h2><button class="btn sm ghost" data-act="close-modal">Close</button></div>
   <div class="small"><b>${fmtDur(u.talkSeconds)}</b> talk time · ${u.callsPlaced || 0} calls placed · ${u.callsAnswered || 0} answered</div>
   <div class="row" style="gap:6px">${p ? `<a class="btn sm primary" href="#improve" data-act="open-prompt" data-id="${p.id}">Edit this agent's prompt</a>` : `<span class="small muted">Import the live prompt to edit it from here.</span>`}</div>
   ${r.calls.length ? r.calls.map(one).join("") : `<div class="empty">No conversations recorded yet.</div>`}</div>`;
}
function importModal(a) {
  $("#modal").innerHTML = `<div class="panel stack" role="dialog" aria-modal="true" aria-labelledby="imH">
   <div class="row" style="justify-content:space-between"><h2 id="imH">Import live prompt · ${esc(a.name)}</h2><button class="btn sm ghost" data-act="close-modal">Close</button></div>
   <ol class="steps-live" style="margin:0;padding:0">
    <li><div>In Sarvam, open <b>Agents → ${esc(a.client || a.name)} → Canvas → Instructions</b> and copy the whole system prompt.</div></li>
    <li><div>Paste it below, or upload it as a .txt, .md or .docx file. The text is regrouped into the 13 standard sections without being reworded.</div></li>
   </ol>
   <textarea id="imText" rows="12" class="mono" placeholder="Paste the full Sarvam instructions here…"></textarea>
   <div class="row"><label class="btn sm">Upload file<input type="file" id="imFile" accept=".txt,.md,.docx" hidden></label>
    <label class="f" style="width:170px">Sarvam version <span class="hint">(blank = newest)</span><input type="number" id="imVer" min="1"></label></div>
   <div class="row"><button class="btn primary" data-act="do-import" data-id="${esc(a.id)}">Import</button><span class="small muted" id="imMsg"></span></div></div>`;
  $("#modal").hidden = false; $("#imText").focus();
}
const closeModal = () => { $("#modal").hidden = true; $("#modal").innerHTML = ""; };

// Every variable the prompt's blocks actually use is mapped automatically. The column name comes
// from, in order: the allocation file (if dropped), the name the existing agents already use for it,
// or the standard name. The user can drop a variable, add one, or add their own client fields.
// Standard variable a column/variable name stands for (exact or a known alias), or null.
// ---------- Knowledge base from documents ----------
// Files (or whole folders) are read in the browser. FAQ sheets (question + answer columns) and two-column
// fact sheets go straight in; everything else is read by the AI in batches. Nothing is added to the
// knowledge base until the user ticks what to keep.
const PDFJS_SRC = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const KB_EXT = /\.(xlsx|xls|csv|docx|pdf|txt|md|json|html?)$/i;
const KB_MAX_FILES = 60, KB_MAX_CHARS = 600000, KB_BATCH = 30000;
const kbImp = () => R.kbImp || (R.kbImp = { files: [], progress: null, draft: null, paste: "" });
const KB_KIND_T = { product: "Product", policy: "Policy", process: "Process", contact: "Contact", other: "Other" };
const kbNorm = t => String(t || "").toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, " ").trim();
async function kbReadFile(file, name) {
  const out = { name, size: file.size, text: "", facts: [], faqs: [] };
  if (/\.(xlsx|xls|csv)$/i.test(file.name)) {
    await loadScript(XLSX_SRC);
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const parts = [];
    wb.SheetNames.forEach(sn => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: "" }).filter(r => Object.values(r).some(v => String(v).trim()));
      if (!rows.length) return;
      const cols = Object.keys(rows[0]), f = re => cols.find(c => re.test(c));
      const q = f(/question|query|faq|customer (asks|says|question)/i), an = f(/answer|response|reply|agent (says|answer)|solution/i);
      const k = f(/topic|item|field|parameter|particular|feature|attribute|^name$|key|heading/i), v = f(/value|detail|description|information|^info|policy|rule|text|content/i);
      const src = wb.SheetNames.length > 1 ? `${name} › ${sn}` : name;
      if (q && an) rows.forEach(r => { if (String(r[q]).trim() && String(r[an]).trim()) out.faqs.push({ q: String(r[q]).trim(), a: String(r[an]).trim(), src }); });
      else if (k && v && cols.length <= 3) rows.forEach(r => { if (String(r[k]).trim() && String(r[v]).trim()) out.facts.push({ k: String(r[k]).trim(), v: String(r[v]).trim(), kind: "other", src }); });
      else parts.push(`Sheet: ${sn}\n` + rows.map(r => cols.filter(c => String(r[c]).trim()).map(c => `${c}: ${String(r[c]).trim()}`).join(" | ")).join("\n"));
    });
    out.text = parts.join("\n\n");
  } else if (/\.docx$/i.test(file.name)) out.text = await fileToText(file);
  else if (/\.pdf$/i.test(file.name)) {
    await loadScript(PDFJS_SRC); window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const doc = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(doc.numPages, 300); i++) { const c = await (await doc.getPage(i)).getTextContent(); pages.push(c.items.map(x => x.str + (x.hasEOL ? "\n" : " ")).join("")); }
    out.text = pages.join("\n\n");
    if (!out.text.trim()) throw new Error("No text found. It may be a scanned PDF; use a text PDF or a Word file.");
  } else if (/\.html?$/i.test(file.name)) out.text = new DOMParser().parseFromString(await file.text(), "text/html").body.textContent || "";
  else out.text = await file.text();
  out.text = out.text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}
// Files from a drop: whole folders are walked (hidden files skipped).
async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files].map(f => ({ file: f, path: f.name }));
  const out = [];
  const walk = async (e, pre) => {
    if (e.isFile) out.push({ file: await new Promise((res, rej) => e.file(res, rej)), path: pre + e.name });
    else if (e.isDirectory) { const rd = e.createReader(); let b; do { b = await new Promise((res, rej) => rd.readEntries(res, rej)); for (const x of b) await walk(x, pre + e.name + "/"); } while (b.length); }
  };
  for (const e of entries) await walk(e, "");
  return out;
}
async function kbAddFiles(list) {
  const I = kbImp(); let added = 0; const skipped = [];
  for (const { file, path } of list) {
    if (/(^|\/)[.~]/.test(path)) continue;
    if (!KB_EXT.test(file.name) || I.files.length >= KB_MAX_FILES) { skipped.push(path); continue; }
    if (I.files.some(x => x.name === path && x.size === file.size)) continue;
    const e = { name: path, size: file.size, status: "reading" }; I.files.push(e); render();
    try { Object.assign(e, await kbReadFile(file, path), { status: "ready" }); added++; if (!e.text && !e.facts.length && !e.faqs.length) { e.status = "error"; e.note = "Nothing readable in it."; } }
    catch (err) { e.status = "error"; e.note = err.message || "Couldn't read it."; }
  }
  render();
  toast(`${added} file${added === 1 ? "" : "s"} read${skipped.length ? ` · ${skipped.length} skipped (only Excel, CSV, Word, PDF, text and markdown, up to ${KB_MAX_FILES} files)` : ""}`);
}
const kbChars = I => I.files.filter(f => f.status === "ready").reduce((n, f) => n + (f.text || "").length, 0);
function kbBatches(I) {
  const pieces = [];
  I.files.filter(f => f.status === "ready" && f.text).forEach(f => {
    const t = f.text.slice(0, KB_MAX_CHARS);
    if (t.length <= KB_BATCH) return pieces.push({ name: f.name, text: t });
    const paras = t.split(/\n\s*\n/); let cur = "", n = 1;
    paras.forEach(p => { if (cur && cur.length + p.length > KB_BATCH) { pieces.push({ name: f.name, part: n++, text: cur }); cur = ""; } cur += (cur ? "\n\n" : "") + p.slice(0, KB_BATCH); });
    if (cur) pieces.push({ name: f.name, part: n, text: cur });
  });
  const batches = []; let b = [], size = 0, total = 0;
  for (const p of pieces) { if (total >= KB_MAX_CHARS) break; if (b.length && size + p.text.length > KB_BATCH) { batches.push(b); b = []; size = 0; } b.push(p); size += p.text.length; total += p.text.length; }
  if (b.length) batches.push(b);
  return batches;
}
async function kbBuild() {
  const I = kbImp(), kb = L.cfg.kb;
  const facts = [], faqs = []; let oos = "", errors = 0, provider = "";
  I.files.filter(f => f.status === "ready").forEach(f => { facts.push(...f.facts); faqs.push(...f.faqs); });
  const batches = kbBatches(I);
  if (batches.length && !aiOn()) throw new Error("No AI model is configured, so only FAQ and fact sheets can be imported.");
  I.progress = { done: 0, total: batches.length }; I.draft = null; render();
  const queue = [...batches];
  await Promise.all([0, 1].map(async () => { for (let b; (b = queue.shift());) {
    try { const r = await api("POST", "/ai/kb-docs", { docs: b.map(p => ({ name: p.name, text: p.text })), client: (L.np && L.np.info.client) || L.cfg.client.name, product: (L.np && L.np.info.product) || L.cfg.client.product, agentType: (L.np && L.np.info.type) || L.cfg.objective });
      facts.push(...r.facts); faqs.push(...r.faqs); if (r.oos && !oos) oos = r.oos; provider = r.provider || provider; }
    catch (e) { errors++; }
    I.progress.done++; render();
  } }));
  // Drop repeats, and anything the knowledge base already says.
  const have = new Set([...kb.facts.map(f => kbNorm(f.k + " " + f.v)), ...kb.faqs.map(f => kbNorm(f.q))]), seen = new Set();
  const uniq = (arr, key) => arr.filter(x => { const k = key(x); if (!k || have.has(k) || seen.has(k)) return false; seen.add(k); return true; });
  I.draft = { facts: uniq(facts, f => kbNorm(f.k + " " + f.v)).map(f => ({ ...f, on: true })), faqs: uniq(faqs, f => kbNorm(f.q)).map(f => ({ ...f, on: true })), oos, errors, provider, batches: batches.length };
  I.progress = null; render();
}
function kbImportPanel() {
  const I = kbImp(), ready = I.files.filter(f => f.status === "ready"), chars = kbChars(I), nb = kbBatches(I).length;
  const direct = ready.reduce((n, f) => n + f.facts.length + f.faqs.length, 0), D = I.draft;
  const tick = (kind, i, x) => `<input type="checkbox" data-act-check="kbd-on" data-kind="${kind}" data-i="${i}" ${x.on ? "checked" : ""}>`;
  return `<div class="panel stack" style="background:var(--sunk);box-shadow:none;border-style:dashed">
   <div><h3>Build it from the client's documents</h3><p class="small muted">Product sheets, policy PDFs, FAQ spreadsheets, whole folders. Excel FAQ sheets (question and answer columns) go straight in; the rest is read by the AI. You review everything before it's added.</p></div>
   <div class="dropzone" id="kbDrop">Drop files or folders here, or <label style="color:var(--accent);cursor:pointer;text-decoration:underline">choose files<input type="file" id="kbFiles" multiple accept=".xlsx,.xls,.csv,.docx,.pdf,.txt,.md,.json,.html,.htm" hidden></label> · <label style="color:var(--accent);cursor:pointer;text-decoration:underline">choose a folder<input type="file" id="kbFolder" webkitdirectory multiple hidden></label><div class="small" style="margin-top:4px">Excel, CSV, Word, PDF, text or markdown</div></div>
   <details><summary class="small muted">Or paste text (notes, an email, a policy extract)</summary><div class="stack" style="gap:8px;margin-top:8px"><textarea id="kb-paste" rows="4" data-act-input="kb-paste" placeholder="Paste here…">${esc(I.paste)}</textarea><div><button class="btn sm" data-act="kb-paste-add">Add as a source</button></div></div></details>
   ${I.files.length ? `<div class="tbl-wrap"><table><tbody>${I.files.map((f, i) => `<tr><td class="small" style="word-break:break-all">${esc(f.name)}</td>
     <td class="small muted nowrap">${f.status === "reading" ? "Reading…" : f.status === "error" ? `<span style="color:var(--err)">${esc(f.note || "Couldn't read")}</span>` : [f.faqs && f.faqs.length ? `${f.faqs.length} FAQs` : "", f.facts && f.facts.length ? `${f.facts.length} facts` : "", f.text ? `${fmtN(f.text.length)} characters` : ""].filter(Boolean).join(" · ")}</td>
     <td style="width:30px"><button class="btn sm ghost" data-act="kb-file-del" data-i="${i}" aria-label="Remove">✕</button></td></tr>`).join("")}</tbody></table></div>
    <div class="row" style="gap:10px"><button class="btn primary ${nb ? "ai" : ""}" data-act="kb-build" ${ready.length && !I.progress ? "" : "disabled"}>${I.progress ? `Reading ${I.progress.done} of ${I.progress.total}…` : "Build knowledge base"}</button>
     <span class="small muted">${ready.length} file${ready.length === 1 ? "" : "s"}${direct ? ` · ${direct} items read directly` : ""}${nb ? ` · ${nb} AI read${nb === 1 ? "" : "s"}${chars > KB_MAX_CHARS ? ` (only the first ${fmtN(KB_MAX_CHARS)} characters)` : ""}` : ""}</span>
     <a href="#" class="small" data-act="kb-files-clear">Clear</a></div>
    ${I.progress ? `<div class="bar" style="max-width:none;height:6px"><i style="width:${Math.round(100 * I.progress.done / Math.max(1, I.progress.total))}%"></i></div>` : ""}` : ""}
   ${D ? `<div class="stack" style="gap:10px;border-top:1px solid var(--line);padding-top:12px">
     <div class="row" style="justify-content:space-between"><b>Found ${D.facts.length} facts and ${D.faqs.length} FAQs</b><span class="small muted">${D.provider ? esc(D.provider) : ""}${D.errors ? ` · <span style="color:var(--warn)">${D.errors} batch${D.errors === 1 ? "" : "es"} failed</span>` : ""}</span></div>
     ${!D.facts.length && !D.faqs.length ? `<div class="small muted">Nothing new: everything found is already in the knowledge base.</div>` : ""}
     ${D.facts.some(f => f.kind === "policy") ? `<div class="vitem warn"><span class="ic">!</span><div class="vt"><b>Check the policy facts</b><span>They must match what you set on the Client policy step. The knowledge base never overrides a policy setting.</span></div></div>` : ""}
     ${Object.keys(KB_KIND_T).map(kind => { const xs = D.facts.map((f, i) => [f, i]).filter(([f]) => f.kind === kind); return xs.length ? `<div class="stack" style="gap:6px"><div class="eyebrow">${KB_KIND_T[kind]} facts · ${xs.length}</div>${xs.map(([f, i]) => `<label class="check small" style="align-items:flex-start">${tick("facts", i, f)}<span><b>${esc(f.k)}:</b> ${esc(f.v)} <span class="muted">· ${esc(f.src || "")}</span></span></label>`).join("")}</div>` : ""; }).join("")}
     ${D.faqs.length ? `<div class="stack" style="gap:6px"><div class="eyebrow">FAQs · ${D.faqs.length}</div>${D.faqs.map((f, i) => `<label class="check small" style="align-items:flex-start">${tick("faqs", i, f)}<span><b>${esc(f.q)}</b><br>${esc(f.a)} <span class="muted">· ${esc(f.src || "")}</span></span></label>`).join("")}</div>` : ""}
     ${D.oos ? `<label class="check small">${`<input type="checkbox" data-act-check="kbd-oos" ${D.useOos ? "checked" : ""}>`} Use this out-of-scope line: “${esc(D.oos)}”</label>` : ""}
     ${D.facts.length || D.faqs.length ? `<div class="row" style="gap:8px"><button class="btn primary" data-act="kb-accept">Add ${D.facts.filter(f => f.on).length + D.faqs.filter(f => f.on).length} to the knowledge base</button><a href="#" class="small" data-act="kbd-all" data-on="0">Untick all</a><a href="#" class="small" data-act="kbd-all" data-on="1">Tick all</a><a href="#" class="small" data-act="kb-discard">Discard</a></div>` : ""}
   </div>` : ""}
  </div>`;
}

// ---------- IMPROVE ----------
// Three tabs; Settings and History open from the ⋯ menu.
const TABS = [["calls", "Calls"], ["prompt", "Prompt"], ["changes", "Changes"]];
const MORE_TABS = { settings: "Settings", history: "History" };
function agentHead(agent, cur) {
  const live = cur && cur.versions.find(v => v.status === "live");
  const title = agent ? agent.name : cur.prompt.name;
  const uat = agent && agent.uatAgentId ? (R.agents || []).find(a => a.id === agent.uatAgentId) : null;
  const uatOf = agent ? (R.agents || []).find(a => a.uatAgentId === agent.id) : null;
  const sub = agent ? [agent.client, live && live.sarvamVersion ? `live in Sarvam v${live.sarvamVersion}` : null, uat ? `UAT agent: ${uat.name}` : null, uatOf ? `UAT agent for ${uatOf.name}` : null, agent.clonedFrom ? `copied from ${agent.clonedFrom.name}` : null, agent.sarvamName && agent.sarvamName !== agent.name ? `Sarvam name: ${agent.sarvamName}` : null].filter(Boolean).join(" · ") : "Not linked to a live agent";
  const agentItems = agent ? `<hr class="sep">
     ${canDo("approve") ? `<a href="#" data-act="uat-modal" data-id="${esc(agent.id)}">${uat ? "Change UAT agent…" : "Set a UAT agent…"}</a><a href="#" data-act="clone-modal" data-id="${esc(agent.id)}">New agent from this one…</a>` : ""}
     ${R.sarvam && R.sarvam.hasToken && canDo("edit") ? `<a href="#" data-act="pull" data-id="${esc(agent.id)}">Reload prompt from Sarvam</a>` : ""}
     ${canDo("edit") ? `<a href="#" data-act="import" data-id="${esc(agent.id)}">Paste prompt manually</a>` : ""}


    ` : "";
  const more = `<details class="more"><summary class="btn" aria-label="More">⋯</summary><div class="more-pop">${agent ? `<a href="#" data-act="tab" data-t="settings">Settings</a>` : ""}<a href="#" data-act="tab" data-t="history">History and rollback</a>${agentItems}</div></details>`;
  return `<a class="back" href="#agents">← All agents</a>
  <div class="view-head" style="margin-top:6px"><div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>
   <div class="row" style="gap:16px">${agent ? `<div class="stat" style="text-align:right"><b>${fmtDur(agent.talkSeconds)}</b><div class="small muted">talk time · ${agent.callsPlaced || 0} calls</div></div>` : ""}${more}</div></div>`;
}
// One line telling the user what to do next with this prompt.
// Regression tests: each fixed issue, replayed against a version so a new change can't quietly bring
// an old mistake back. Simulated with the AI model playing the agent with that version's prompt.
const testState = v => v && v.tests && (v.tests.rev || 0) === (v.rev || 0) ? v.tests : null;
function testsChip(v) {
  const t = testState(v);
  if (!t) return (R.tests || []).length ? `<span class="chip warn">tests not run on v${esc(v.v)}</span>` : "";
  return `<span class="chip ${t.failed ? "err" : "ok"}">Tests: ${t.passed}/${t.total} pass</span>`;
}
function testsPanel(cur) {
  const T = R.tests || [], latest = latestOf(cur);
  const run = (x, v) => x.runs && x.runs[v.id] && (x.runs[v.id].rev || 0) === (v.rev || 0) ? x.runs[v.id] : null;
  const fixedWithout = (R.feedback || []).filter(f => ["applied", "mapped"].includes(f.status) && !T.some(t => t.feedbackId === f.id)).length;
  return `<div class="panel stack" style="margin-top:16px" id="testsPanel">
   <div class="row" style="justify-content:space-between;gap:10px"><div><h2>Regression tests · ${T.length}</h2><p class="small muted">Every fixed issue becomes a test. Run them on a draft before pushing, so a new change can't bring an old mistake back. The AI plays the agent with that version's exact prompt (a simulation, not Sarvam's own model).</p></div>
    <div class="row" style="gap:6px">${canDo("edit") && fixedWithout ? `<button class="btn sm ai" data-act="tests-build">Make tests from ${fixedWithout} feedback item${fixedWithout === 1 ? "" : "s"}</button>` : ""}${T.length ? `<button class="btn sm primary ai" data-act="tests-run" data-vid="${latest.id}" ${aiOn() ? "" : "disabled"}>Run all on v${esc(latest.v)}</button>` : ""}</div></div>
   ${T.length ? `<div class="row" style="gap:6px">${testsChip(latest)}</div>
    ${T.map(x => { const r = run(x, latest); return `<div class="fb" style="gap:6px;border-left:4px solid ${r ? (r.pass ? "var(--ok)" : r.pass === false ? "var(--err)" : "var(--line)") : "var(--line)"}">
      <div class="row" style="justify-content:space-between;gap:8px"><b class="small">${r ? (r.pass ? "✓ " : r.pass === false ? "✗ " : "? ") : ""}${esc(x.title)}</b>${canDo("edit") ? `<a href="#" class="small" style="color:var(--err)" data-act="test-del" data-id="${x.id}">Delete</a>` : ""}</div>
      <div class="excerpt">${x.customer.map(l => `<div><b>Customer:</b> ${esc(l)}</div>`).join("")}</div>
      <div class="small"><b>Must:</b> ${esc(x.expect)}${x.avoid ? `<br><b>Must not:</b> ${esc(x.avoid)}` : ""}</div>
      ${r ? `<div class="small" style="color:${r.pass ? "var(--ok)" : "var(--err)"}">${esc(r.why)}</div>${(r.replies || []).length ? `<details><summary class="small">What the agent said</summary><div class="excerpt">${x.customer.map((l, i) => `<div><b>Customer:</b> ${esc(l)}</div><div class="${i === x.customer.length - 1 ? "hit" : ""}"><b>Agent:</b> ${esc(r.replies[i] || "")}</div>`).join("")}</div></details>` : ""}` : `<div class="small muted">Not run on v${esc(latest.v)} yet.</div>`}</div>`; }).join("")}` : `<div class="small muted">No tests yet.${fixedWithout ? " Make them from the fixed feedback above." : " Fix some feedback first; each fix becomes a test."}</div>`}
  </div>`;
}
// Fixes that went live once but are missing from the live prompt (e.g. undone by a later push).
async function loadLost() {
  const pid = R.curId; if (!pid) return;
  try { const r = await api("GET", `/prompts/${pid}/lost-fixes`); R.lost = { pid, items: r.items }; } catch (_) { R.lost = { pid, items: [] }; }
  if (route() === "improve" && R.curId === pid && !R.editText) render();
}
function lostNotice(cur) {
  const L = R.lost && R.lost.pid === cur.prompt.id ? R.lost.items.filter(x => !x.restoredInDraft) : [];
  if (!L.length) return "";
  return `<div class="nextstep" style="border-color:var(--err);flex-direction:column;align-items:stretch;gap:8px"><span><b>${L.length} fix${L.length > 1 ? "es that went" : " that went"} live ${L.length > 1 ? "are" : "is"} missing from the live prompt.</b> A later push was built on an older version and undid ${L.length > 1 ? "them" : "it"}. Restore puts just that fix's changes back, as a draft. Restore the oldest first.</span>
    ${L.map(x => `<div class="row" style="gap:8px;align-items:flex-start;border-top:1px dashed var(--line);padding-top:6px"><span style="flex:1;min-width:200px" class="small"><b>v${esc(x.v)} · Sarvam v${esc(x.sarvamVersion)}</b> · ${x.missing} of ${x.added} lines missing<div class="muted">${esc(x.note.slice(0, 200))}</div></span>${canDo("edit") ? `<button class="btn sm primary" data-act="restore-fix" data-vid="${x.versionId}">Restore</button>` : ""}</div>`).join("")}</div>`;
}
// Which Sarvam version a version's changes were made on (nearest ancestor that came from Sarvam).
function builtOnOf(cur, v) {
  const byId = id => cur.versions.find(x => x.id === id);
  let b = v.basedOn ? byId(v.basedOn) : null, g = 0;
  while (b && !b.sarvamVersion && g++ < 50) b = b.basedOn ? byId(b.basedOn) : null;
  return b && b.sarvamVersion ? Number(b.sarvamVersion) : null;
}
function nextStep(cur) {
  const latest = latestOf(cur), live = cur.versions.find(v => v.status === "live");
  if (live && latest.id === live.id) return "";
  const bo = builtOnOf(cur, latest);
  if (bo && live && live.sarvamVersion && bo < Number(live.sarvamVersion)) return `<div class="nextstep" style="border-color:var(--warn)"><span style="flex:1;min-width:200px"><b>v${esc(latest.v)} was made on Sarvam v${bo}, but Sarvam v${esc(live.sarvamVersion)} is live now.</b> Pushing it as it is would undo what changed since. Rebuild it on v${esc(live.sarvamVersion)}: only its own changes are moved over.</span><button class="btn sm" data-act="see-diff" data-pid="${cur.prompt.id}" data-vid="${latest.id}">See changes</button>${canDo("edit") ? `<button class="btn sm primary" data-act="rebase" data-vid="${latest.id}">Rebuild on v${esc(live.sarvamVersion)}</button>` : ""}</div>`;
  const v = `v${esc(latest.v)}`;
  const bar = (msg, btns) => `<div class="nextstep"><span style="flex:1;min-width:200px">${msg}</span>${btns}</div>`;
  const see = `<button class="btn sm" data-act="see-diff" data-pid="${cur.prompt.id}" data-vid="${latest.id}">See changes</button>`;
  const edit = canDo("edit") && !R.editText ? `<button class="btn sm" data-act="edit-text">✎ Edit</button>` : "";
  // UAT: try the version on the linked test agent first, then promote it to this agent.
  const uatAgent = cur.agent && cur.agent.uatAgentId ? (R.agents || []).find(a => a.id === cur.agent.uatAgentId) : null;
  const onUat = latest.uat ? ` <span class="chip ok">On UAT: ${esc(latest.uat.name)} · Sarvam v${esc(latest.uat.sarvamVersion)}</span>` : "";
  const uatBtn = uatAgent && canDo("edit") && R.sarvam && R.sarvam.hasToken ? `<button class="btn sm ${latest.status === "approved" && latest.uat ? "" : "primary"}" data-act="push-preview" data-vid="${latest.id}" data-target="uat">${latest.uat ? "Push to UAT again" : `Push to UAT (${esc(uatAgent.name)})`}</button>` : "";
  const lv = liveOf(cur);
  const settings = (latest.configSummary && latest.configSummary.length ? ` Settings: ${latest.configSummary.map(esc).join("; ")}.` : "")
    + (lv && latest.chars != null && lv.chars != null ? ` <span class="small">Length ${fmtN(lv.chars)} → <b>${fmtN(latest.chars)}</b> characters (${delta(latest.chars - lv.chars)}).</span>` : "")
    + (latest.fixes && latest.fixes.length > 1 || (latest.feedbackIds || []).length > 1 ? ` <span class="small muted">${(latest.feedbackIds || []).length} fixes in this draft.</span>` : "")
    + (testsChip(latest) ? ` ${testsChip(latest)}` : "");
  if (latest.status === "draft") return bar(`<b>${v} has your changes</b> and isn't live yet.${settings} ${uatAgent ? "Try it on UAT, then send it for approval." : "Send it for approval when it's ready."}${onUat}`, see + edit + uatBtn + (canDo("edit") ? `<button class="btn sm ${uatBtn && !latest.uat ? "" : "primary"}" data-act="submit" data-vid="${latest.id}">Send for approval</button>` : ""));
  if (latest.status === "rejected") { const n = ((latest.history || []).slice(-1)[0] || {}).note; return bar(`<b>${v} was sent back</b>${n ? `: “${esc(n)}”` : ""}. Edit it, or send it again.`, see + edit + (canDo("edit") ? `<button class="btn sm" data-act="submit" data-vid="${latest.id}">Send again</button>` : "")); }
  if (latest.status === "pending") return bar(`<b>${v} is waiting for approval.</b>${settings}${onUat}`, see + edit + uatBtn + (canDo("approve") ? `<a class="btn sm primary" href="#approvals">Review it</a>` : ""));
  if (latest.status === "approved") return bar(uatAgent ? `<b>${v} is approved.</b>${settings} ${latest.uat ? "Listen to a few UAT calls, then promote it to the live agent." : "Push it to UAT to test it, or promote it straight to the live agent."}${onUat}` : `<b>${v} is approved.</b>${settings} Push it to Sarvam to make it live.`,
    see + edit + uatBtn + (latest.uat && uatAgent ? `<button class="btn sm" data-act="open-agent-calls" data-id="${esc(uatAgent.id)}">UAT calls</button>` : "") + pushControl(cur, latest, !!uatAgent));
  return "";
}
// The push button, or — for a prompt made in the builder — a picker for the Sarvam agent it goes to.
function pushControl(cur, v, promote) {
  if (!canDo("golive")) return `<span class="small muted">An approver pushes it live.</span>`;
  if (!(R.sarvam && R.sarvam.hasToken && !R.sarvam.expired)) return `<a class="btn sm" href="#agents">Connect Sarvam to push</a>`;
  if (cur.agent && cur.agent.sarvamAppId) return `<button class="btn sm primary" data-act="push-preview" data-vid="${v.id}">${promote ? `Promote to live (${esc(cur.agent.name)})…` : "Push to Sarvam…"}</button>`;
  return `<select id="link-${v.id}" style="width:auto;max-width:260px"><option value="">Push to which Sarvam agent?</option>${(R.agents || []).map(a => `<option value="${esc(a.id)}">${esc(a.client)} · ${esc(a.name)}</option>`).join("")}</select><button class="btn sm primary" data-act="link-push" data-pid="${cur.prompt.id}" data-vid="${v.id}">Push…</button>`;
}
function viewImprove() {
  const agent = R.agentId ? (R.agents || []).find(a => a.id === R.agentId) : null;
  const cur = R.cur;
  if (!cur) {
    if (!agent) return `<a class="back" href="#agents">← All agents</a><div class="empty" style="margin-top:12px">Pick an agent on the <a href="#agents">Agents</a> page.</div>`;
    return agentHead(agent, null) + `<div class="empty stack" style="align-items:center">${agent.sarvamPullError ? `<div>Couldn't load this agent's prompt from Sarvam: ${esc(agent.sarvamPullError)}</div>` : `<div>This agent's prompt hasn't been brought in yet.</div>`}
      <div class="row">${R.sarvam && R.sarvam.hasToken ? `<button class="btn primary" data-act="pull" data-id="${esc(agent.id)}" ${canDo("edit") ? "" : "disabled"}>Load prompt from Sarvam</button>` : `<a class="btn primary" href="#agents">Connect Sarvam first</a>`}<button class="btn ghost" data-act="import" data-id="${esc(agent.id)}" ${canDo("edit") ? "" : "disabled"}>Paste it manually</button></div></div>`;
  }
  const tab = R.tab || "prompt";
  const nCalls = R.calls && R.calls.agentId === (agent || {}).id && R.calls.items ? callsShown(R.calls).length : null;
  const nFix = (R.feedback || []).filter(i => i.status === "mapped").length;
  const tabs = `<div class="subtabs" role="tablist">${TABS.filter(([k]) => k !== "calls" || agent).map(([k, l]) => `<button data-act="tab" data-t="${k}" aria-pressed="${tab === k}">${l}${k === "calls" && nCalls != null ? `<span class="n">${nCalls}</span>` : ""}${k === "changes" && nFix ? `<span class="n hot" title="${nFix} to fix">${nFix}</span>` : ""}</button>`).join("")}${MORE_TABS[tab] ? `<span class="subtab-more">${MORE_TABS[tab]} <a href="#" data-act="tab" data-t="prompt" aria-label="Close">✕</a></span>` : ""}</div>`;
  const ahead = agent && agent.sarvamDraftAhead ? `<div class="notice"><span><b>Sarvam has edits that aren't committed</b> (${agent.sarvamDraftAhead.chars >= 0 ? "+" : ""}${agent.sarvamDraftAhead.chars} characters). Calls don't use them, so they're not shown here. Commit them in Sarvam, then Refresh, to bring them in.</span></div>` : "";
  const body = tab === "calls" ? callsTab(agent) : tab === "changes" ? changesTab(cur) : tab === "history" ? historyTab(cur) : tab === "settings" ? settingsTab(cur, agent) : promptTab(cur);
  const lvv = liveOf(cur), shown = lvv && lvv.sarvamVersion ? Number(lvv.sarvamVersion) : null;
  const behind = agent && shown && agent.sarvamNewest && agent.sarvamNewest > shown
    ? `<div class="nextstep" style="border-color:var(--warn)"><span style="flex:1;min-width:200px"><b>Sarvam has a newer version (v${esc(agent.sarvamNewest)}) than the builder shows (v${shown}).</b> ${canDo("edit") ? "Reload it to bring in what's in Sarvam now." : ""}</span>${canDo("edit") && R.sarvam && R.sarvam.hasToken ? `<button class="btn sm primary" data-act="pull" data-id="${esc(agent.id)}">Reload from Sarvam</button>` : ""}</div>` : "";
  const kdown = "";
  return agentHead(agent, cur) + behind + kdown + lostNotice(cur) + nextStep(cur) + tabs + (tab === "prompt" ? ahead : "") + body;
}
// Light markdown, shown the way Sarvam's editor shows the instructions: headings, bullets,
// bold/italic, and {{variables}} as chips. Text is escaped first; nothing is executed.
function mdInline(s) {
  return esc(s)
    .replace(/\\([*_\[\]#`\-.])/g, "$1")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, `<span class="var">{ } $1</span>`)
    .replace(/(^|[^{])\{([a-z_][\w]*)\}(?!\})/gi, `$1<span class="var">{ } $2</span>`);
}
function mdRender(text) {
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    let m;
    if (!line.trim()) { close(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { close(); const n = Math.min(m[1].length + 1, 4); out.push(`<h${n}>${mdInline(m[2].replace(/^\*\*(.*)\*\*$/, "$1"))}</h${n}>`); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { close(); out.push("<hr>"); continue; }
    if ((m = line.match(/^(\s*)[-*•]\s+(.*)$/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li${m[1].length >= 2 ? ' class="sub"' : ""}>${mdInline(m[2])}</li>`); continue; }
    if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) { if (list !== "ol") { close(); out.push(`<ol start="${m[2]}">`); list = "ol"; } out.push(`<li${m[1].length >= 2 ? ' class="sub"' : ""}>${mdInline(m[3])}</li>`); continue; }
    if (list && /^\s{2,}\S/.test(line)) { out.push(`<div class="cont">${mdInline(line.trim())}</div>`); continue; }
    close(); out.push(`<p>${mdInline(line)}</p>`);
  }
  close();
  return out.join("");
}
// Give the prompt's headings ids and list them, for the outline beside the prompt.
function withToc(html) {
  const toc = []; let i = 0;
  const out = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (m, l, inner) => { const id = `toc-${i++}`; toc.push({ id, l, t: inner.replace(/<[^>]+>/g, "") }); return `<h${l} id="${id}">${inner}</h${l}>`; });
  return { html: out, toc: toc.filter(t => t.t.trim()).slice(0, 80) };
}
const greetingNow = () => (R.sv && (R.sv.greeting || (R.sv.meta && R.sv.meta.greeting))) || "";
function promptTab(cur) {
  const p = cur.prompt, latest = latestOf(cur);
  if (R.editText) return editPanel(cur);
  const text = R.sv && R.sv.text ? R.sv.text : mdOf(p.cfg, latest, false);
  const m = R.sv && R.sv.meta, greeting = greetingNow();
  const translations = m ? Object.entries(m.greetingByLanguage || {}).filter(([l, t]) => t && l !== "English") : [];
  const live = liveOf(cur);
  const len = ` · <b>${fmtN(latest.chars)}</b> characters${latest.greetingChars ? ` + ${fmtN(latest.greetingChars)} in the greeting` : ""}${live && live.id !== latest.id && live.chars != null ? ` (${delta(latest.chars - live.chars)} vs live v${esc(live.v)})` : ""}`;
  const note = (R.sv && R.sv.text ? (R.sv.exact ? `Exactly as in Sarvam v${esc(R.sv.liveSarvamVersion)}` : `v${esc(latest.v)} · how it will read in Sarvam once pushed`) : `v${esc(latest.v)}`) + len;
  const tocMd = R.viewSections || R.viewRaw ? { html: "", toc: [] } : withToc(mdRender(text));
  const body = R.viewSections ? `<pre class="prompt" style="max-height:none">${esc(mdOf(p.cfg, latest))}</pre>`
    : R.viewRaw ? `<pre class="prompt" style="max-height:none">${esc(text)}</pre>`
    : `<div class="md">${tocMd.html}</div>`;
  return `<div class="stack">
   <div class="row" style="justify-content:space-between"><span class="small muted">${note}</span>
    <div class="row" style="gap:8px">
     ${tocMd.toc.length > 2 ? `<select id="toc-jump" data-toc-jump aria-label="Jump to section" style="width:auto;max-width:240px"><option value="">Jump to section…</option>${tocMd.toc.filter((t, _, all) => t.l === (all.some(x => x.l === "2") ? "2" : "3")).map(t => `<option value="${t.id}">${t.t}</option>`).join("")}</select>` : ""}
     ${canDo("edit") ? `<button class="btn sm primary" data-act="edit-text">Edit</button>` : ""}
     <details class="more"><summary class="btn sm" aria-label="More">⋯</summary><div class="more-pop">
       <a href="#" data-act="view-mode" data-m="read">${!R.viewRaw && !R.viewSections ? "✓ " : ""}Formatted, as in Sarvam</a>
       <a href="#" data-act="view-mode" data-m="raw">${R.viewRaw && !R.viewSections ? "✓ " : ""}Plain text</a>
       <a href="#" data-act="view-mode" data-m="sections">${R.viewSections ? "✓ " : ""}By builder section</a>
       <hr class="sep">
       ${canDo("edit") && aiOn() && !(R.opt && R.opt.promptId === p.id) ? `<a href="#" data-act="opt-open" title="Find repeated rules, contradictions and wordy passages">Optimize…</a>` : ""}
       <a href="#" data-act="copy-prompt">Copy</a><a href="#" data-act="dl-prompt">Download</a>
     </div></details></div></div>
   ${R.opt && R.opt.promptId === p.id ? optPanel(cur) : ""}
   <div><div class="doc">
    ${cur.agent || greeting ? `<div class="doc-label">Greeting${R.sv && R.sv.greetingChanged ? ` <span class="chip warn">changed in this version</span>` : ""}</div>
    <div class="greet">${greeting ? mdInline(greeting) : `<span class="muted">No greeting set</span>`}</div>
    ${translations.length && !(R.sv && R.sv.greetingChanged) ? `<details class="trans"><summary class="btn sm">Translations (${translations.length})</summary><div class="stack" style="gap:6px;margin-top:8px">${translations.map(([l, t]) => `<div><span class="chip">${esc(l)}</span> ${mdInline(t)}</div>`).join("")}</div></details>` : R.sv && R.sv.greetingChanged ? `<div class="small muted">Sarvam regenerates the translations from this when it's pushed.</div>` : ""}` : ""}
    <div class="doc-label" style="margin-top:22px">Instructions</div>
    ${body}
   </div></div>
   ${sarvamAgentPanel(cur)}</div>`;
}
// Manual editing: the whole greeting and instructions, exactly as they will be in Sarvam.
function editPanel(cur) {
  const e = R.editText, latest = latestOf(cur), live = cur.versions.find(v => v.status === "live");
  return `<div class="stack">
   <div class="nextstep"><span style="flex:1;min-width:200px"><b>Editing v${esc(latest.v)}.</b> ${openDraft(latest) ? `Saving updates draft v${esc(latest.v)}.` : `Saving creates v${esc(bumpV(latest.v))} as a draft.`} Nothing changes in Sarvam until it's approved and pushed.${latest.status === "approved" || latest.status === "pending" ? ` v${esc(latest.v)} is ${latest.status === "pending" ? "waiting for approval" : "approved"}; your edit will need approval again.` : ""}</span></div>
   ${cur.agent ? `<label class="f">Greeting <span class="hint">(English. Sarvam regenerates the other languages from it. Keep variables as {{name}}.)</span><textarea id="ed-greeting" rows="3">${esc(e.greeting)}</textarea></label>` : ""}
   <label class="f">Instructions <span class="hint">(the full prompt, as it reads in Sarvam: markdown, Hindi and {{variables}} are kept exactly as you type them)</span>
    <textarea id="ed-text" class="mono" spellcheck="false" style="min-height:62vh;font-size:13px;line-height:1.55">${esc(e.text)}</textarea></label>
   <div class="small muted" id="ed-count">${edCount(e)}</div>
   <label class="f">What did you change? <span class="hint">(shown in History and on the approval)</span><input type="text" id="ed-note" placeholder="e.g. Softened the payment-link ask"></label>
   <div class="row"><button class="btn primary" data-act="save-text">Save as new draft</button><button class="btn" data-act="cancel-text">Cancel</button><span class="small muted" id="ed-msg"></span></div>
  </div>`;
}
// Live length while editing. Line breaks are counted as Sarvam stores them, so it matches the saved count.
const edCount = e => { const n = s => s.replace(/\r/g, "").length, crs = (e.orig.match(/\r/g) || []).length; const now = n(e.text) + crs, was = n(e.orig) + crs;
  return `${fmtN(now)} characters (was ${fmtN(was)}, ${delta(now - was)})`; };
function startEdit() {
  const cur = R.cur; if (!cur) return;
  const text = R.sv && R.sv.text ? R.sv.text : mdOf(cur.prompt.cfg, latestOf(cur), false);
  R.editText = { text, orig: text, greeting: greetingNow(), og: greetingNow() };
  R.tab = "prompt"; R.viewSections = false; render(); window.scrollTo(0, 0);
}
// "Added the fix to draft v3.1 · 117,221 → 117,913 characters (+692)". Toasts are plain text.
const savedMsg = (r, what = "the fix") => `${r.updated ? `Added ${what} to draft v${r.v}` : `Saved ${what} as new draft v${r.v}`}${r.charsBefore != null && r.charsAfter != null ? ` · ${fmtN(r.charsBefore)} → ${fmtN(r.charsAfter)} characters (${r.charsAfter - r.charsBefore >= 0 ? "+" : "−"}${fmtN(Math.abs(r.charsAfter - r.charsBefore))})` : ""}. Send it for approval when it's ready.`;
const fmtN = n => n == null ? "?" : Number(n).toLocaleString("en-IN");
const delta = n => n == null ? "" : `<span style="color:${n > 0 ? "var(--warn)" : n < 0 ? "var(--ok)" : "var(--muted)"}">${n > 0 ? "+" : n < 0 ? "−" : "±"}${fmtN(Math.abs(n))}</span>`;
// The version a draft's length is compared with: the live one.
const liveOf = cur => cur.versions.find(v => v.status === "live");
const openDraft = v => v && ["draft", "rejected"].includes(v.status);
const bumpV = v => { const [a, b] = String(v || "1.0").split("."); return `${a}.${(Number(b) || 0) + 1}`; };
// ---------- CALLS: every call Sarvam handled for this agent ----------
const dayStr = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const mmss = s => s == null ? "" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const callFlags = iid => (R.feedback || []).filter(f => f.call && f.call.iid === iid);
const ENDED = { USER_ENDS: "customer hung up", AGENT_ENDS: "agent ended", TIMEOUT: "timed out" };
function callsTab(agent) {
  const C = R.calls && R.calls.agentId === agent.id ? R.calls : null;
  if (R.call && R.call.agentId === agent.id) return callView(agent);
  const from = (C && C.from) || dayStr(Date.now() - 6 * 864e5), to = (C && C.to) || dayStr(Date.now());
  const bar = `<div class="panel stack" style="gap:10px">
   <div class="cfilter"><label class="f">From<input type="date" id="c-from" value="${esc(from)}" max="${esc(dayStr(Date.now()))}"></label><label class="f">To<input type="date" id="c-to" value="${esc(to)}" max="${esc(dayStr(Date.now()))}"></label>
    <button class="btn primary" data-act="calls-load">Show calls</button>
    <span class="small muted" style="align-self:center">${[["Today", 0], ["7 days", 6], ["30 days", 29]].map(([l, d]) => `<a href="#" data-act="calls-range" data-d="${d}">${l}</a>`).join(" · ")}</span></div>
   ${C && C.items ? (() => {
     const all = C.items, shown = callsShown(C);
     const byV = {}; all.filter(c => !C.hideTest || !c.test).forEach(c => { const k = c.version || "?"; (byV[k] = byV[k] || { n: 0, s: 0 }); byV[k].n++; byV[k].s += c.durationSeconds; });
     const vs = Object.keys(byV).sort((a, b) => b - a);
     return `<div class="row" style="justify-content:space-between;gap:10px"><div class="vchips"><span class="small muted">Version:</span><button data-act="calls-ver" data-v="" aria-pressed="${!C.ver}">All</button>${vs.map(v => `<button data-act="calls-ver" data-v="${esc(v)}" aria-pressed="${String(C.ver) === String(v)}" title="${byV[v].n} calls, average ${fmtDur(byV[v].s / byV[v].n)}">v${esc(v)} · ${byV[v].n}</button>`).join("")}</div>
      <label class="check small"><input type="checkbox" data-act-check="calls-hidetest" ${C.hideTest ? "checked" : ""}> Hide test calls</label></div>
      <div class="small muted">${shown.length} call${shown.length === 1 ? "" : "s"} · ${fmtDur(shown.reduce((n, c) => n + c.durationSeconds, 0))} talk time${C.total > all.length ? ` · showing the first ${all.length} of ${C.total}` : ""}</div>`;
   })() : ""}</div>`;
  if (!C || C.loading) return bar + `<div class="loading">Loading calls from Sarvam…</div>`;
  if (C.error) return bar + `<div class="empty">${esc(C.error)}</div>`;
  const shown = callsShown(C);
  const rows = shown.map(c => { const f = callFlags(c.id).length; return `<a class="crow" href="#" data-act="call-open" data-id="${esc(c.id)}">
    <span><b>${esc(new Date(c.at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}</b>${c.test ? ` <span class="chip">test</span>` : ""}</span>
    <span class="num">${fmtDur(c.durationSeconds)}</span><span><span class="chip acc">v${esc(c.version || "?")}</span></span>
    <span class="small">${esc(c.language || "—")}</span><span class="small muted">${esc(c.contact || (c.direction === "inbound" ? "inbound" : ""))}</span>
    <span class="small muted">${esc(c.failure ? c.failure.toLowerCase().replace(/_/g, " ") : ENDED[c.endedBy] || c.endedBy.toLowerCase().replace(/_/g, " "))}</span>
    <span>${f ? `<span class="chip err">⚑ ${f}</span>` : c.messages ? `<span class="small muted">${c.messages} lines</span>` : ""}</span></a>`; }).join("");
  return `<div class="stack">${bar}${shown.length ? `<div class="clist"><div class="crow head"><span>When</span><span>Length</span><span>Ver.</span><span>Language</span><span>Contact</span><span>Ended</span><span>Flags</span></div>${rows}</div>
   ${C.more ? `<div class="row"><button class="btn" data-act="calls-more">Load more</button></div>` : ""}` : `<div class="empty">No calls in these dates${C.ver ? ` for v${esc(C.ver)}` : ""}.</div>`}</div>`;
}
const callsShown = C => (C.items || []).filter(c => (!C.hideTest || !c.test) && (!C.ver || String(c.version) === String(C.ver)));
async function loadCalls(agent, opts = {}) {
  const prev = R.calls && R.calls.agentId === agent.id ? R.calls : {};
  const from = opts.from || prev.from || dayStr(Date.now() - 6 * 864e5), to = opts.to || prev.to || dayStr(Date.now());
  const offset = opts.more ? (prev.items || []).length : 0;
  R.calls = { ...prev, agentId: agent.id, from, to, loading: !opts.more, error: null, ...(opts.more ? {} : { items: null, ver: prev.ver && opts.keepVer ? prev.ver : "" }) };
  if (route() === "improve") render();
  try {
    const r = await api("GET", `/agents/${encodeURIComponent(agent.id)}/interactions?from=${from}&to=${to}&offset=${offset}`);
    R.calls = { ...R.calls, loading: false, items: opts.more ? [...(R.calls.items || []), ...r.items] : r.items, total: r.total, more: r.more };
  } catch (e) { R.calls = { ...R.calls, loading: false, error: e.message }; }
  if (route() === "improve") render();
}
// One call: the recording on top, the transcript below. Click a time to jump there; flag any line.
function callView(agent) {
  const K = R.call, c = K.row || {};
  const head = `<div class="row" style="justify-content:space-between;gap:10px"><a class="back" href="#" data-act="call-close">← All calls</a>
    <span class="small muted">${c.at ? esc(new Date(c.at).toLocaleString()) + " · " : ""}${c.durationSeconds ? fmtDur(c.durationSeconds) + " · " : ""}<span class="chip acc">Sarvam v${esc(c.version || "?")}</span> · ${esc(c.language || "")}${c.contact ? " · " + esc(c.contact) : ""}${c.test ? ` · <span class="chip">test call</span>` : ""}</span></div>`;
  const src = `/api/agents/${encodeURIComponent(agent.id)}/interactions/audio?iid=${encodeURIComponent(K.id)}`;
  const player = `<div class="player">${c.hasAudio !== false ? `<audio id="callAudio" controls preload="metadata" data-src="${esc(src)}" src="${esc(src)}"></audio>` : `<div class="small muted">No recording for this call.</div>`}
    <div class="small muted" style="margin-top:4px">${K.t && K.t.timed ? "Click a time to jump there. " : ""}Click <b>⚑ Mistake here</b> on every line where the agent went wrong (as many as you like) and say what happened and what should have happened. The AI then reads them together against the exact prompt the agent had on this call.</div></div>`;
  if (K.loading) return `<div class="stack">${head}${player}<div class="loading">Loading transcript…</div></div>`;
  if (K.error) return `<div class="stack">${head}${player}<div class="empty">${esc(K.error)}</div></div>`;
  const flags = callFlags(K.id), sel = K.sel || {};
  const nSel = Object.keys(sel).length;
  const turnsOf = f => f.call.issues ? f.call.issues.map(x => x.turn) : [f.call.turn];
  const turns = (K.t.turns || []).map((t, i) => {
    const fl = flags.filter(f => turnsOf(f).includes(i));
    const shown = flags.filter(f => turnsOf(f)[turnsOf(f).length - 1] === i); // a grouped diagnosis shows once, under its last line
    const s = sel[i];
    return `<div class="turn ${t.role === "agent" ? "agent" : "user"} ${fl.length || s ? "flagged" : ""}" id="turn-${i}" data-start="${t.start ?? ""}" data-end="${t.end ?? ""}">
      <div><div class="who">${t.role === "agent" ? "Agent" : t.role === "user" ? "Customer" : esc(t.role)}</div>${t.start != null ? `<button class="ts" data-act="seek" data-t="${t.start}">${mmss(t.start)}</button>` : ""}</div>
      <div class="tx">${esc(t.text)}</div>
      ${canDo("edit") ? `<button class="flagbtn" data-act="flag-toggle" data-i="${i}" ${s ? 'style="opacity:1;color:var(--err);border-color:var(--err)"' : ""}>${s ? "✕ Unflag" : "⚑ Mistake here"}</button>` : "<span></span>"}</div>
     ${s ? `<div class="flagbox"><div class="fgrid">
       <label class="f">What happened <span class="hint">(optional)</span><textarea id="g-${i}-h" rows="2" data-gt="${i}" data-gf="happened" placeholder="e.g. It went back to the 30th that it had suggested">${esc(s.happened || "")}</textarea></label>
       <label class="f">What should have happened <span class="hint">(optional)</span><textarea id="g-${i}-s" rows="2" data-gt="${i}" data-gf="should" placeholder="e.g. Keep the customer's 17th and suggest the 12th once">${esc(s.should || "")}</textarea></label></div></div>` : ""}
     ${shown.map(diagCard).join("")}`;
  }).join("");
  const tray = nSel && canDo("edit") ? `<div class="batchbar"><b>${nSel} line${nSel === 1 ? "" : "s"} flagged</b><input type="text" id="g-note" data-gnote="1" placeholder="Anything about the call as a whole? (optional)" value="${esc(K.gnote || "")}" style="flex:1;min-width:200px">
    <button class="btn sm ghost" data-act="flag-clear">Clear</button><button class="btn primary ai" data-act="flag-group" ${aiOn() ? "" : "disabled"}>${nSel === 1 ? "Find why" : `Find why (${nSel} together)`}</button></div>` : "";
  return `<div class="stack" style="gap:10px">${head}${player}
    ${flags.length ? `<div class="notice ok"><span>${flags.length} diagnosis${flags.length === 1 ? "" : "es"} on this call. They're in <a href="#" data-act="tab" data-t="changes">Make a change</a>, where you fix several together in one new version.</span></div>` : ""}
    <div class="transcript">${turns || `<div class="empty">No transcript for this call.</div>`}</div>${tray}</div>`;
}
const CAUSE = { missing: "Prompt doesn't cover it", unclear: "Rule is unclear", conflict: "Rules conflict", ignored: "Rule exists, agent ignored it", data: "Wrong call data" };
function diagCard(f) {
  const m = f.map || {};
  return `<div class="diag"><div class="row" style="gap:6px;justify-content:space-between"><b>${esc(m.what || f.text)}</b><span class="row" style="gap:4px"><span class="chip err">${esc(CAUSE[m.cause] || m.cause || "")}</span><span class="chip ${m.severity === "high" ? "err" : m.severity === "medium" ? "warn" : ""}">${esc(m.severity || "")}</span></span></div>
   ${f.text && f.text !== m.what ? `<div class="small muted">Your note: ${esc(f.text)}</div>` : ""}
   ${(m.quotes || []).length ? `<div class="small muted">From the prompt${m.diagnosedOn ? ` (${esc(m.diagnosedOn)})` : ""}:</div>${m.quotes.map(q => `<div class="quote ${q.found ? "" : "nf"}" title="${q.found ? "Found word for word in the prompt" : "Not found word for word: the AI paraphrased"}">${mdInline(q.text)}</div>`).join("")}` : ""}
   ${m.diagnosis ? `<div><b>Why:</b> ${esc(m.diagnosis)}</div>` : ""}${m.fix ? `<div><b>Fix:</b> ${esc(m.fix)}</div>` : ""}
   <div class="small muted">${f.status === "applied" ? `<span style="color:var(--ok)">Fixed in v${esc(f.appliedIn)}</span>` : f.status === "dismissed" ? "Dismissed" : `Waiting in <a href="#" data-act="tab" data-t="changes">Make a change</a> · goes in ${esc(secTitle(m.section))}`}</div></div>`;
}
const curAgent = () => R.agentId && (R.agents || []).find(a => a.id === R.agentId);
async function openCall(agent, id, seekTo) {
  const fb = (R.feedback || []).find(f => f.call && f.call.iid === id);
  const row = ((R.calls && R.calls.items) || []).find(c => c.id === id) || { id, version: fb && fb.call.sarvamVersion, at: fb && fb.call.at };
  R.call = { agentId: agent.id, id, row, loading: true, flagTurn: null, flagNote: "", seekTo: seekTo ?? null };
  render(); window.scrollTo(0, 0);
  try { R.call.t = await api("GET", `/agents/${encodeURIComponent(agent.id)}/interactions/transcript?iid=${encodeURIComponent(id)}`); R.call.loading = false; }
  catch (e) { R.call.loading = false; R.call.error = e.message; }
  if (R.call && R.call.id === id) { render(); if (R.call.seekTo != null) seekCall(R.call.seekTo); }
}
function seekCall(t) { const a = $("#callAudio"); if (!a) return; a.currentTime = Number(t) || 0; a.play().catch(() => { }); }
// The player survives re-renders (flagging, diagnosis results) so playback isn't interrupted.
function wireAudio(prev) {
  const slot = $("#callAudio");
  if (!slot) return;
  if (prev && prev.dataset.src === slot.dataset.src) { slot.replaceWith(prev); return; }
  slot.addEventListener("timeupdate", () => {
    const t = slot.currentTime;
    $$(".turn").forEach(el => { const s = parseFloat(el.dataset.start), e = parseFloat(el.dataset.end); el.classList.toggle("playing", !isNaN(s) && t >= s && t < (isNaN(e) ? s + 4 : e)); });
  });
}
// ---------- SETTINGS: languages, voice, variables ----------
function cfgEditFrom(d) {
  return { initial: d.languages.initial, supported: [...d.languages.supported], voiceId: d.voice.id, pace: d.voice.pace, pitch: d.voice.pitch,
    vars: d.variables.map(v => ({ ...v, orig: { ...v } })), note: "" };
}
async function loadCfg(agent) {
  R.acfg = { agentId: agent.id, loading: true };
  try { const d = await api("GET", `/agents/${encodeURIComponent(agent.id)}/config`); R.acfg = { agentId: agent.id, data: d, edit: cfgEditFrom(d) }; }
  catch (e) { R.acfg = { agentId: agent.id, error: e.message }; }
  if (route() === "improve" && R.tab === "settings") render();
}
function settingsTab(cur, agent) {
  const S = R.acfg && R.acfg.agentId === agent.id ? R.acfg : null;
  if (!S || S.loading) return `<div class="loading">Reading the agent's settings from Sarvam…</div>`;
  if (S.error) return `<div class="empty">${esc(S.error)}</div>`;
  const d = S.data, e = S.edit, latest = latestOf(cur), ro = !canDo("edit") ? "disabled" : "";
  const pending = latest.configSummary && latest.status !== "live" ? latest.configSummary : null;
  const voice = d.voices.find(v => v.id === e.voiceId);
  const varRow = (v, i) => { const ch = !v.isNew && !v.remove && (v.description !== v.orig.description || v.value !== v.orig.value || v.afterCall !== v.orig.afterCall || v.postPrompt !== v.orig.postPrompt);
    return `<tr class="${v.remove ? "removed" : ch || v.isNew ? "changed" : ""}">
    <td>${v.isNew ? `<input type="text" data-cfg="vars.${i}.name" value="${esc(v.name)}" placeholder="variable_name" ${ro}>` : `<code>{{${esc(v.name)}}}</code>`}<div class="small muted">${esc(v.type)}</div></td>
    <td><input type="text" data-cfg="vars.${i}.description" value="${esc(v.description)}" ${ro}></td>
    <td>${v.afterCall ? `<textarea rows="2" data-cfg="vars.${i}.postPrompt" placeholder="How to fill it from the call" ${ro}>${esc(v.postPrompt)}</textarea>` : `<input type="text" data-cfg="vars.${i}.value" value="${esc(v.value)}" placeholder="test value" ${ro}>`}</td>
    <td><label class="check small"><input type="checkbox" data-cfg="vars.${i}.afterCall" ${v.afterCall ? "checked" : ""} ${ro}> after call</label></td>
    <td>${v.isNew ? `<button class="btn sm ghost" data-act="cfg-var-del" data-i="${i}">✕</button>` : `<label class="check small"><input type="checkbox" data-cfg="vars.${i}.remove" ${v.remove ? "checked" : ""} ${ro}> remove</label>`}</td></tr>`; };
  return `<div class="stack">
   <div class="small muted">What the agent uses now, in Sarvam v${esc(d.sarvamVersion)}. Saving creates a new draft version; nothing changes in Sarvam until it's approved and pushed.${!canDo("edit") ? " Your role can only view these." : ""}</div>
   ${pending ? `<div class="notice"><span><b>v${esc(latest.v)} already has settings changes that aren't live:</b> ${pending.map(esc).join("; ")}. New changes are added on top.</span></div>` : ""}
   <div class="panel stack"><h2>Languages</h2>
    <label class="f" style="max-width:260px">Starts the call in<select data-cfg="initial" ${ro}>${e.supported.map(l => `<option ${l === e.initial ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
    <div><div class="small muted" style="margin-bottom:6px">Can speak</div><div class="langs">${d.allLanguages.map(l => `<label class="check small"><input type="checkbox" data-cfg-lang="${esc(l)}" ${e.supported.includes(l) ? "checked" : ""} ${ro}> ${esc(l)}</label>`).join("")}</div></div></div>
   <div class="panel stack"><h2>Voice</h2>
    <div class="fgrid"><label class="f">Voice<select data-cfg="voiceId" ${ro}>${d.voices.map(v => `<option value="${esc(v.id)}" ${v.id === e.voiceId ? "selected" : ""}>${esc(v.name)} · ${esc(v.gender)}${v.languages.length ? " · " + esc(v.languages.join(", ")) : ""}</option>`).join("")}${!voice ? `<option value="${esc(e.voiceId)}" selected>Current voice (not in the list)</option>` : ""}</select></label>
     <label class="f">Pace <span class="hint">0.9 – 1.4</span><input type="number" min="0.9" max="1.4" step="0.05" data-cfg="pace" value="${esc(e.pace)}" ${ro}></label>
     <label class="f">Pitch <span class="hint">-0.2 – 0.2</span><input type="number" min="-0.2" max="0.2" step="0.01" data-cfg="pitch" value="${esc(e.pitch)}" ${ro}></label></div>
    ${voice && voice.description ? `<div class="small muted">${esc(voice.description)}</div>` : ""}</div>
   <div class="panel stack"><div class="row" style="justify-content:space-between"><h2>Variables · ${e.vars.filter(v => !v.remove).length}</h2>${canDo("edit") ? `<button class="btn sm" data-act="cfg-var-add">+ Add variable</button>` : ""}</div>
    <div class="small muted">Call inputs are filled by the dialer when it places a call. "After call" variables are filled by Sarvam from the conversation. A variable the greeting or prompt still uses can't be removed.</div>
    <div class="tbl-wrap"><table class="vartbl"><thead><tr><th>Name</th><th>Description</th><th>Test value / how it's filled</th><th></th><th></th></tr></thead><tbody>${e.vars.map(varRow).join("")}</tbody></table></div></div>
   ${canDo("edit") ? `<div class="row"><input type="text" id="cfg-note" placeholder="What changed and why (optional)" style="flex:1;min-width:220px" value="${esc(e.note)}" data-cfg="note"><button class="btn primary" data-act="cfg-save">Check with Sarvam and save as draft</button><button class="btn ghost" data-act="cfg-reset">Undo changes</button></div>` : ""}
  </div>`;
}
function cfgChanges() {
  const d = R.acfg.data, e = R.acfg.edit, body = {};
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  if (e.initial !== d.languages.initial || !sameSet(e.supported, d.languages.supported)) body.languages = { initial: e.initial, supported: e.supported };
  if (e.voiceId !== d.voice.id || Number(e.pace) !== Number(d.voice.pace) || Number(e.pitch) !== Number(d.voice.pitch)) {
    const v = d.voices.find(x => x.id === e.voiceId);
    body.voice = { ...(e.voiceId !== d.voice.id ? { id: e.voiceId, name: v ? v.name : "" } : {}), ...(Number(e.pace) !== Number(d.voice.pace) ? { pace: Number(e.pace) } : {}), ...(Number(e.pitch) !== Number(d.voice.pitch) ? { pitch: Number(e.pitch) } : {}) };
  }
  const vars = e.vars.filter(v => v.isNew ? v.name.trim() : v.remove || v.description !== v.orig.description || v.value !== v.orig.value || v.afterCall !== v.orig.afterCall || v.postPrompt !== v.orig.postPrompt)
    .map(v => ({ name: v.name.trim(), description: v.description, type: v.type, value: v.value, afterCall: v.afterCall, postPrompt: v.postPrompt, remove: !!v.remove, isNew: !!v.isNew }));
  if (vars.length) body.variables = vars;
  return body;
}

function historyTab(cur) {
  return `<div class="tbl-wrap"><table><thead><tr><th>Version</th><th>Status</th><th>When</th><th>By</th><th>Length</th><th>Change</th><th></th></tr></thead><tbody>
   ${[...cur.versions].reverse().map(v => { const i = cur.versions.indexOf(v), prev = cur.versions[i - 1]; return `<tr><td class="num"><b>v${esc(v.v)}</b>${v.sarvamVersion ? `<div class="small muted">Sarvam v${esc(v.sarvamVersion)}</div>` : ""}</td><td>${statusPill(v.status)}</td><td class="num muted">${fmtDate(v.updatedAt && v.rev ? v.updatedAt : v.createdAt)}</td><td class="muted small">${esc(v.by)}</td>
     <td class="num small">${fmtN(v.chars)}${prev && prev.chars != null && v.chars != null ? `<div>${delta(v.chars - prev.chars)}</div>` : ""}</td><td>${esc(v.note)}${(v.feedbackIds || []).length > 1 ? `<div class="small muted">${v.feedbackIds.length} fixes</div>` : ""}</td>
     <td><div class="row" style="gap:4px;flex-wrap:nowrap">${i > 0 ? `<button class="btn sm" data-act="cmp" data-i="${i}">${R.cmpOpen === i ? "Hide" : "Compare"}</button>` : ""}${["superseded", "rolled_back"].includes(v.status) && v.sarvamVersion && canDo("rollback") ? `<button class="btn sm" data-act="rollback" data-vid="${v.id}">Roll back to this</button>` : ""}</div></td></tr>${R.cmpOpen === i ? `<tr><td colspan="7">${versionDiff(cur.versions[i - 1], v)}</td></tr>` : ""}`; }).join("")}
   </tbody></table></div>`;
}
const FB_ORDER = { mapped: 0, new: 1, applied: 2, dismissed: 3 };
function changesTab(cur) {
  const latest = latestOf(cur);
  const items = R.feedback || [];
  const counts = { new: 0, mapped: 0, applied: 0, dismissed: 0 }; items.forEach(i => counts[i.status] = (counts[i.status] || 0) + 1);
  const mode = R.inMode || "paste";
  return `
  <div class="changes">
   <details class="in-box" data-in-box ${R.inOpen != null ? (R.inOpen ? "open" : "") : (items.some(i => i.status === "mapped" || i.status === "new") ? "" : "open")}><summary class="btn">+ Add feedback or a call</summary><div class="stack" style="margin-top:16px">
    <div class="seg" role="tablist" style="align-self:flex-start"><button type="button" data-act="in-mode" data-m="paste" aria-pressed="${mode === "paste"}">Paste feedback</button><button type="button" data-act="in-mode" data-m="call" aria-pressed="${mode === "call"}">Analyse a call</button></div>
    ${mode === "call" ? transcriptPanel(cur, true) : `<p class="small muted">From UAT, a call review or the client. Each line becomes one item.</p>
    <label class="f">From<select id="f-src">${["Client UAT", "Founders", "Internal QA", "Call review", "Client stakeholder"].map(s => `<option ${s === (L.fbSource || "Client UAT") ? "selected" : ""}>${s}</option>`).join("")}</select></label>
    <label class="f">Paste text <span class="hint">(numbered or bulleted lists split into items)</span><textarea id="f-raw" rows="8" data-act-input="raw">${esc(L.fbRaw || "")}</textarea></label>
    <div class="dropzone" id="fbDrop">Drop an Excel, CSV, Word or text file, or <label style="color:var(--accent);cursor:pointer;text-decoration:underline">choose a file<input type="file" id="fbFile" accept=".xlsx,.xls,.csv,.docx,.txt,.md" hidden></label><div class="small" id="fbFileMsg"></div></div>
    <div class="row"><button class="btn primary" data-act="split" ${canDo("edit") ? "" : "disabled"}>Add items</button><button class="btn ghost sm" data-act="sample-fb">Try sample feedback</button></div>`}
   </div></details>
   <div class="stack">
    <div class="row" style="justify-content:space-between"><h2>Items to fix</h2>${items.length ? `<span class="small muted">${counts.new || 0} new · ${counts.mapped || 0} to fix · ${counts.applied || 0} done</span>` : ""}</div>
    ${items.some(i => i.status === "new") ? `<div class="row"><button class="btn primary ai" data-act="map-all">Find where each item goes in the prompt</button></div>` : ""}
    ${counts.mapped > 1 && canDo("edit") ? `<div class="small muted">Tick the items to fix together. One new version is made with all of them, so it's approved and pushed once. <a href="#" data-act="fb-selall">Select all ${counts.mapped}</a></div>` : ""}
    <div class="stack" style="gap:10px">${items.length ? [...items].reverse().sort((x, y) => (FB_ORDER[x.status] ?? 9) - (FB_ORDER[y.status] ?? 9)).map(it => fbCard(it, latest)).join("") : `<div class="empty">Nothing yet. Add feedback here, or flag mistakes on the <a href="#" data-act="tab" data-t="calls">Calls</a> tab.</div>`}</div>
   </div>
  </div>
  ${testsPanel(cur)}
  ${fbHistory(items)}
  ${(() => { const sel = [...(R.fbSel || [])].filter(id => items.some(i => i.id === id && i.status === "mapped")); return sel.length ? `<div class="batchbar"><b>${sel.length} selected</b><span class="small muted" style="flex:1;min-width:200px">The AI drafts each fix on top of the previous one, then ${openDraft(latest) ? `adds them to draft v${esc(latest.v)}` : `saves v${esc(bumpV(latest.v))} as a draft`} for you to review.</span><button class="btn sm ghost" data-act="fb-selnone">Clear</button><button class="btn primary ai" data-act="fb-batch" ${aiOn() ? "" : "disabled"}>Fix ${sel.length} in one new version</button></div>` : ""; })()}`;
}
// Optimize: the AI proposes exact edits that remove repeated rules, settle contradictions and cut
// wordiness. Pure shortening is ticked by default; anything that changes behaviour is left to you.
const OPT_TYPES = [["contradiction", "Contradictions", "err"], ["duplicate", "Said more than once", "warn"], ["outdated", "Outdated or broken references", "warn"], ["unclear", "Unclear wording", ""], ["verbose", "Wordy", ""]];
function optPanel(cur) {
  const O = R.opt, latest = latestOf(cur);
  const head = `<div class="row" style="justify-content:space-between"><h2>Optimize this prompt</h2><a href="#" class="small" data-act="opt-close">Close</a></div>`;
  if (!O.result) return `<div class="panel stack" id="optPanel">${head}
    <p class="small muted">The AI reads all ${fmtN(latest.chars)} characters of v${esc(latest.v)} and finds rules said more than once, rules that contradict each other, wordy passages and references to things that no longer exist. You see every change before anything is saved, and the result is a draft that goes through approval like any change.</p>
    <label class="f">Focus on <span class="hint">(optional)</span><input type="text" data-opt="focus" value="${esc(O.focus || "")}" placeholder="e.g. the dates and promise-to-pay rules"></label>
    <div class="row"><button class="btn primary ai" data-act="opt-run" ${O.loading ? "disabled" : ""}>${O.loading ? "Reading the whole prompt…" : "Find clutter"}</button><span class="small muted">Takes 1 to 3 minutes for a long prompt.</span></div>
    ${O.error ? `<div class="notice"><span>${esc(O.error)}</span></div>` : ""}</div>`;
  const r = O.result, sel = O.sel;
  const repeatOn = r.edits.some(e => e.repeat && sel.has(e.id));
  if (!repeatOn) r.edits.filter(e => e.afterRepeat).forEach(e => sel.delete(e.id)); // they only work with the repeat removed
  const picked = r.edits.filter(e => sel.has(e.id)), saved = picked.reduce((n, e) => n + e.saved, 0);
  const stale = r.versionId !== latest.id || (O.rev || 0) !== (latest.rev || 0);
  const groups = OPT_TYPES.map(([t, label, chip]) => { const list = r.edits.filter(e => e.type === t); return list.length ? `<div class="stack" style="gap:6px"><b class="small">${label} · ${list.length}</b>
    ${list.map(e => `<div class="fb" style="gap:6px"><label class="fbsel" style="align-items:flex-start"><input type="checkbox" data-act-check="opt-sel" data-i="${e.id}" ${sel.has(e.id) ? "checked" : ""} ${e.afterRepeat && !repeatOn ? "disabled title='Tick the repeated block first'" : ""}><span><b>${esc(e.title || label)}</b>${e.afterRepeat ? ` <span class="chip" title="This passage is also inside the repeated block, so it's applied after the repeat is removed">needs the repeat removed</span>` : ""} <span class="chip ${chip}">${esc(t)}</span>${e.changesBehaviour ? ` <span class="chip warn">changes behaviour: check it</span>` : ""} <span class="small muted">${e.saved >= 0 ? `saves ${fmtN(e.saved)}` : `adds ${fmtN(-e.saved)}`} characters</span></span></label>
      <div class="small">${esc(e.reason)}</div>
      <details><summary class="small">See the exact change</summary>${e.new_text ? diffHtml(e.old_text.replace(/\r/g, ""), e.new_text) : (() => { const L = e.old_text.replace(/\r/g, "").split("\n"); return `<div class="diff">${L.slice(0, 30).map(l => `<span class="d">− ${esc(l) || " "}</span>`).join("")}${L.length > 30 ? `<span class="c">… and ${fmtN(L.length - 30)} more lines deleted</span>` : ""}</div>`; })()}</details></div>`).join("")}</div>` : ""; }).join("");
  return `<div class="panel stack" id="optPanel">${head}
   ${stale ? `<div class="notice"><span>The prompt changed after this was run. <a href="#" data-act="opt-run">Run it again</a> before saving.</span></div>` : ""}
   <div class="small">${esc(r.summary)}</div>
   <div class="row" style="gap:16px"><div class="stat"><b>${fmtN(r.chars)}</b><span class="small muted">characters now</span></div><div class="stat"><b>${fmtN(r.chars - saved)}</b><span class="small muted">after the ticked changes (${delta(-saved)})</span></div><div class="stat"><b>${r.edits.length}</b><span class="small muted">changes found</span></div></div>
   ${r.dropped ? `<div class="small muted">${r.dropped} suggested change${r.dropped > 1 ? "s" : ""} didn't match the prompt text exactly and ${r.dropped > 1 ? "were" : "was"} left out.</div>` : ""}
   ${r.edits.length ? groups : `<div class="empty">No clutter found worth changing.</div>`}
   ${r.edits.length ? `<div class="row"><button class="btn primary" data-act="opt-apply" ${picked.length && !stale ? "" : "disabled"}>${openDraft(latest) ? `Add ${picked.length} change${picked.length === 1 ? "" : "s"} to draft v${esc(latest.v)}` : `Save ${picked.length} change${picked.length === 1 ? "" : "s"} as a new draft`}</button><a href="#" class="small" data-act="opt-run">Run again</a><span class="small muted">Nothing changes in Sarvam until it's approved and pushed.</span></div>` : ""}
  </div>`;
}

// A whole UAT call transcript, uploaded or pasted: the AI lists what went wrong, the reviewer ticks
// the mistakes to keep, and they become feedback items that are already diagnosed.
function transcriptPanel(cur, embedded) {
  const T = R.tx && R.tx.promptId === cur.prompt.id ? R.tx : (R.tx = { promptId: cur.prompt.id, text: "", label: "", note: "", versionId: "" });
  const live = cur.versions.find(v => v.status === "live"), latest = latestOf(cur);
  const opts = [...cur.versions].reverse().slice(0, 8).map(v => `<option value="${v.id}" ${(T.versionId || (live || latest).id) === v.id ? "selected" : ""}>v${esc(v.v)} · ${esc(v.status)}${v.sarvamVersion ? ` · Sarvam v${esc(v.sarvamVersion)}` : ""}${v.uat ? " · on UAT" : ""}</option>`).join("");
  const res = T.result;
  return `<div class="${embedded ? "" : "panel "}stack" id="txPanel">
   ${embedded ? `<p class="small muted">Upload or paste a UAT call transcript. The AI lists what went wrong, the cause in the prompt, and a fix.</p>` : `<div><h2>Analyse a whole call</h2><p class="small muted">Upload or paste the transcript of a UAT call. The AI reads it against the prompt the agent had and lists everything that went wrong, with the cause in the prompt and a fix.</p></div>`}
   <div class="fgrid"><label class="f">Call name <span class="hint">(optional)</span><input type="text" data-tx="label" value="${esc(T.label)}" placeholder="e.g. UAT call 3, 31 Nov date"></label>
    <label class="f">Prompt the agent had<select data-tx="versionId">${opts}</select></label></div>
   <div class="dropzone" id="txDrop">Drop a .txt, .docx or .md transcript, or <label style="color:var(--accent);cursor:pointer;text-decoration:underline">choose a file<input type="file" id="txFile" accept=".txt,.md,.docx,.csv,.json,.srt,.vtt" hidden></label><div class="small" id="txFileMsg">${T.file ? `Loaded ${esc(T.file)}` : ""}</div></div>
   <label class="f">…or paste it <span class="hint">(any format: "Agent: … / Customer: …" works best)</span><textarea rows="6" data-tx="text" placeholder="Agent: Namaste, main Priya bol rahi hoon…&#10;Customer: Haan, boliye…">${esc(T.text)}</textarea></label>
   <label class="f">Anything to look at in particular? <span class="hint">(optional)</span><input type="text" data-tx="note" value="${esc(T.note)}" placeholder="e.g. the date handling near the end"></label>
   <div class="row"><button class="btn primary ai" data-act="tx-analyze" ${aiOn() && canDo("edit") ? "" : "disabled"}>Find what went wrong</button>${T.text ? `<span class="small muted">${fmtN(T.text.length)} characters</span>` : ""}</div>
   ${res ? `<div class="stack" style="gap:8px;border-top:1px solid var(--line);padding-top:10px">
     <div class="row" style="justify-content:space-between"><b>${res.mistakes.length} mistake${res.mistakes.length === 1 ? "" : "s"} found</b><span class="small muted">against v${esc(res.versionV)}${res.sarvamVersion ? ` (Sarvam v${esc(res.sarvamVersion)})` : ""} · ${esc(res.provider || "")}</span></div>
     ${res.summary ? `<div class="small">${esc(res.summary)}</div>` : ""}
     ${res.mistakes.map((m, i) => `<div class="fb" style="gap:6px"><label class="fbsel" style="align-items:flex-start"><input type="checkbox" data-act-check="tx-sel" data-i="${i}" ${T.sel.has(i) ? "checked" : ""}><span><b>${esc(m.what)}</b></span></label>
       <div class="excerpt">${m.customer ? `<div><b>Customer:</b> ${esc(m.customer)}</div>` : ""}<div class="hit"><b>Agent:</b> ${esc(m.moment)}</div></div>
       <div class="meta"><span class="chip err">${esc(CAUSE[m.cause] || m.cause)}</span><span class="chip ${m.severity === "high" ? "err" : m.severity === "medium" ? "warn" : ""}">${esc(m.severity)}</span><span class="chip acc">${esc(secTitle(m.section))}</span><span class="chip">${esc(m.type)}</span></div>
       ${m.quotes.map(q => `<div class="small" style="border-left:3px solid ${q.found ? "var(--amber)" : "var(--line)"};background:${q.found ? "var(--amber-soft)" : "var(--sunk)"};padding:6px 10px;border-radius:4px;white-space:pre-wrap" title="${q.found ? "Found word for word in the prompt" : "Not found word for word"}">${mdInline(q.text)}</div>`).join("")}
       ${m.why ? `<div class="small"><b>Why:</b> ${esc(m.why)}</div>` : ""}${m.fix ? `<div class="small"><b>Fix:</b> ${esc(m.fix)}</div>` : ""}</div>`).join("")}
     ${res.mistakes.length ? `<div class="row"><button class="btn primary" data-act="tx-add" ${T.sel.size ? "" : "disabled"}>Add ${T.sel.size} to feedback</button><a href="#" class="small" data-act="tx-clear">Clear</a><span class="small muted">They appear under "Fix each item", already diagnosed: draft, check and fix them like any other.</span></div>` : `<div class="row"><span class="small muted">Nothing went wrong on this call.</span><a href="#" class="small" data-act="tx-clear">Clear</a></div>`}
   </div>` : ""}
  </div>`;
}

// "Check this fix": the AI's second, critical read of its own draft. Customer cases walked through the
// changed prompt, then problems as suggestions; ticked ones (plus the reviewer's notes) feed the redraft.
function checkPanel(it) {
  const c = it.check;
  if (!c) return `<div class="row" style="gap:6px"><button class="btn sm ai" data-act="fix-check" data-id="${it.id}" ${aiOn() ? "" : "disabled"}>Check this fix</button><span class="small muted">A second AI read: tries customer cases against the change and points out what it misses.</span></div>`;
  const sel = chkSel(it);
  const bad = c.cases.filter(x => !x.ok).length;
  return `<div class="stack" style="gap:8px;border:1px solid var(--line);border-radius:var(--r);padding:10px 12px">
   <div class="row" style="justify-content:space-between;gap:8px"><b>Check of this fix</b><span class="row" style="gap:6px"><span class="chip ${c.verdict === "ready" ? "ok" : "warn"}">${c.verdict === "ready" ? "Looks ready" : "Needs work"}</span><a href="#" class="small" data-act="fix-check" data-id="${it.id}">check again</a></span></div>
   ${c.headline ? `<div class="small">${esc(c.headline)}</div>` : ""}
   ${c.cases.length ? `<details ${bad ? "open" : ""}><summary class="small">${c.cases.length} customer cases tried · ${bad ? `<b style="color:var(--err)">${bad} handled wrongly</b>` : "all handled correctly"}</summary>
     <div class="tbl-wrap" style="margin-top:6px"><table><tbody>${c.cases.map(x => `<tr><td style="width:22px">${x.ok ? `<span style="color:var(--ok)">✓</span>` : `<span style="color:var(--err)">✗</span>`}</td><td class="small"><b>${esc(x.case)}</b><div class="muted">${esc(x.agent)}</div>${!x.ok && x.why ? `<div style="color:var(--err)">${esc(x.why)}</div>` : ""}</td></tr>`).join("")}</tbody></table></div></details>` : ""}
   ${c.suggestions.length ? `<div class="small"><b>Suggested changes to the fix</b> <span class="muted">(tick the ones to use; they're added to your notes when you redraft)</span></div>
     ${c.suggestions.map((s, i) => `<label class="check small" style="align-items:flex-start"><input type="checkbox" data-act-check="chk" data-id="${it.id}" data-i="${i}" ${sel.has(i) ? "checked" : ""}><span><span class="chip ${s.severity === "high" ? "err" : s.severity === "medium" ? "warn" : ""}">${esc(s.severity)}</span> ${esc(s.issue)}<div class="muted">→ ${esc(s.note)}</div></span></label>`).join("")}` : `<div class="small muted">No changes suggested.</div>`}
  </div>`;
}
const chkSel = it => { R.chkSel = R.chkSel || {}; const k = it.id + "|" + (it.check && it.check.at); if (!R.chkSel[k]) R.chkSel[k] = new Set((it.check ? it.check.suggestions : []).map((s, i) => s.severity === "low" ? -1 : i).filter(i => i >= 0)); return R.chkSel[k]; };

// Every piece of feedback ever given on this prompt, grouped by where it lands (section) or by kind
// (compliance, tone, policy…), with what happened to it. Shows which areas keep needing fixes.
const FB_STATUS = { new: ["Not mapped", ""], mapped: ["Waiting", "warn"], applied: ["Fixed", "ok"], dismissed: ["Dismissed", ""] };
function fbHistory(items) {
  if (!items.length) return "";
  const by = R.fbGroup || "section";
  const key = it => by === "type" ? ((it.map && it.map.type) || "not mapped") : by === "source" ? (it.source || "Other") : (it.map ? secTitle(it.map.section) : "Not mapped");
  const groups = {};
  items.forEach(it => (groups[key(it)] = groups[key(it)] || []).push(it));
  const names = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  const cnt = (list, s) => list.filter(i => i.status === s).length;
  return `<div class="panel stack" style="margin-top:16px">
   <div class="row" style="justify-content:space-between;gap:10px"><div><h2>Feedback history · ${items.length}</h2><p class="small muted">Everything said about this agent, and what happened to it. Areas with the most feedback are at the top.</p></div>
    <div class="vchips"><span class="small muted">Group by:</span>${[["section", "Prompt section"], ["type", "Kind"], ["source", "From"]].map(([k, l]) => `<button data-act="fb-group" data-g="${k}" aria-pressed="${by === k}">${l}</button>`).join("")}</div></div>
   ${names.map(n => { const list = groups[n].slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
     return `<details ${R.fbOpen === n ? "open" : ""} data-g="${esc(n)}"><summary class="row" style="gap:8px;cursor:pointer;padding:6px 0"><b style="text-transform:capitalize">${esc(n)}</b><span class="chip">${list.length}</span>${cnt(list, "mapped") ? `<span class="chip warn">${cnt(list, "mapped")} waiting</span>` : ""}${cnt(list, "applied") ? `<span class="chip ok">${cnt(list, "applied")} fixed</span>` : ""}${cnt(list, "dismissed") ? `<span class="chip">${cnt(list, "dismissed")} dismissed</span>` : ""}</summary>
      <div class="tbl-wrap"><table><thead><tr><th>When</th><th>Feedback</th><th>From</th><th>Status</th></tr></thead><tbody>
      ${list.map(it => { const [l, c] = FB_STATUS[it.status] || [it.status, ""]; return `<tr><td class="num muted small">${fmtDate(it.createdAt)}</td><td class="small">${esc(it.text)}${it.map && it.map.fix ? `<div class="muted">Fix: ${esc(it.map.fix)}</div>` : ""}${it.call ? `<div><a href="#" data-act="call-goto" data-iid="${esc(it.call.iid)}" data-t="${it.call.start ?? ""}">▶ listen to the call</a></div>` : ""}</td><td class="small muted">${esc(it.source)}<div>${esc(it.by || "")}</div></td><td><span class="chip ${c}">${l}${it.status === "applied" && it.appliedIn ? ` in v${esc(it.appliedIn)}` : ""}</span>${canDo("edit") ? `<div><a href="#" class="small" style="color:var(--err)" data-act="fb-del" data-id="${it.id}">Delete</a></div>` : ""}</td></tr>`; }).join("")}
      </tbody></table></div></details>`; }).join("")}
  </div>`;
}
function sarvamAgentPanel(cur) {
  const m = R.sv && R.sv.meta, agent = cur.agent;
  if (!agent || !agent.sarvamAppId) return "";
  if (!m) return "";
  const greet = Object.entries(m.greetingByLanguage || {}).filter(([l, t]) => t && l !== "English");
  return `<details class="panel"><summary><b>Variables and languages</b> <span class="small muted">· ${m.variables.length} variables, ${m.languages ? m.languages.supported.length : 0} languages · click to open</span></summary>
   <div class="stack" style="margin-top:10px">
    ${m.languages ? `<div class="small"><b>Starts in</b> ${esc(m.languages.initial)} · <b>also speaks</b> ${esc(m.languages.supported.filter(x => x !== m.languages.initial).join(", "))}</div>` : ""}
    <div class="tbl-wrap"><table><thead><tr><th>Variable</th><th>Type</th><th>Description</th><th>Test value</th></tr></thead><tbody>
     ${m.variables.map(v => `<tr><td><code>{{${esc(v.name)}}}</code>${v.afterCall ? ` <span class="chip">filled after call</span>` : ""}</td><td class="muted small">${esc(v.type)}</td><td class="small">${esc(v.description) || "<span class='muted'>—</span>"}</td><td class="small muted">${esc(v.example)}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="small muted">Variables and languages are changed in Sarvam. The greeting and instructions can be edited here with ✎ Edit.</div>
   </div></details>`;
}
// Review view: first a list of every change (section, lines, type, a short preview), then each change
// in full with the exact words highlighted. Reviewers read the changes, not the whole long prompt.
function versionDiff(a, b) {
  const order = [...new Set([...(b.order || []), ...(a.order || []), ...Object.keys(a.sections), ...Object.keys(b.sections)])];
  const changed = order.filter(k => (a.sections[k] || "") !== (b.sections[k] || ""));
  if (!changed.length) return `<span class="muted">No section changes.</span>`;
  const uid = "cv" + Math.random().toString(36).slice(2, 8);
  const peek = t => { const x = t.filter(l => l.trim() && !/^<!--.*-->$/.test(l.trim())).join(" ").replace(/\s+/g, " ").trim(); return x.length > 110 ? x.slice(0, 110) + "…" : x; };
  // A block of changed lines with as many lines before as after is listed line by line, each with its own type.
  const perLine = h => h.kind !== "changed" || h.del.length !== h.add.length || h.del.length < 2 ? [h]
    : h.del.map((d, i) => { const x = { ...h, del: [d], add: [h.add[i]], aLine: h.aLine + i, bLine: h.bLine + i }; return d.trim() === h.add[i].trim() ? null : { ...x, label: cvSimilar(d, h.add[i]) >= 0.5 ? "Modified" : "Replaced" }; }).filter(Boolean);
  const rows = changed.flatMap(k => cvHunks(a.sections[k] || "", b.sections[k] || "").hunks.flatMap((h0, hi) => perLine(h0).map(h => ({ k, h, hi }))));
  const list = `<div class="tbl-wrap cv-list"><table><thead><tr><th>Section</th><th>Where</th><th>Change</th><th>What</th></tr></thead><tbody>${rows.map(({ k, h, hi }) =>
    `<tr><td><a href="#" data-act="cv-jump" data-to="${uid}-${esc(k)}-${hi}">${esc(secTitle(k))}</a></td><td class="mono small nowrap">${cvLines(h)}</td><td><span class="cv-k ${CV_KLASS[h.label]}">${h.label}</span></td><td class="small">${h.kind === "removed" ? `<del>${esc(peek(h.del))}</del>` : esc(peek(h.add))}</td></tr>`).join("")}</tbody></table></div>`;
  return `<div class="small muted" style="margin-bottom:6px">${rows.length} change${rows.length === 1 ? "" : "s"} in ${changed.length} section${changed.length === 1 ? "" : "s"}. Line numbers count from the top of each section.</div>${list}` +
    changed.map(k => `<div style="margin:12px 0 8px"><b>${secTitle(k)}</b>${diffHtml(a.sections[k] || "", b.sections[k] || "", { anchor: `${uid}-${k}`, section: secTitle(k) })}</div>`).join("");
}
// One feedback item. Up front: the issue, where it lands, the diagnosis and the one next action.
// Everything else (section, scope, notes for the AI, the matched prompt lines, dismiss, delete) sits
// under "More options", which stays open across redraws once opened.
function fbCard(it, latest) {
  const m = it.map;
  const ed = R.editing[it.id];
  const secOpts = latest.order.map(s => `<option value="${s}" ${m && m.section === s ? "selected" : ""}>${secTitle(s)}</option>`).join("");
  const stale = it.draft && (it.draft.before ? Object.entries(it.draft.before).some(([s, t]) => (latest.sections[s] || "") !== t) : it.draft.baseVersionId !== latest.id);
  const c = it.call, sel = R.fbSel && R.fbSel.has(it.id);
  const mapped = it.status === "mapped", edit = canDo("edit");
  const when = c && c.at ? esc(new Date(c.at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })) : "";
  const origin = `${esc(it.source)} · ${fmtDate(it.createdAt)}${c && c.upload ? ` · uploaded transcript${c.label ? `: ${esc(c.label)}` : ""}` : c ? ` · call ${when}${c.sarvamVersion ? ` on Sarvam v${esc(c.sarvamVersion)}` : ""} · <a href="#" data-act="call-goto" data-iid="${esc(c.iid)}" data-t="${c.start ?? ""}">▶ Listen</a>` : ""}`;
  const where = m ? `<span class="chip acc">${esc(secTitle(m.section))}</span><span class="sev ${esc(m.severity)}">${esc(m.severity)}</span>${m.cause ? `<span>· ${esc(CAUSE[m.cause] || m.cause)}</span>` : ""}<span>· ${m.scope === "shared" ? "every agent" : "this agent only"}</span>` : "";
  const nNotes = (it.guidance || []).length;
  const open = (R.fbMore && R.fbMore.has(it.id)) || nNotes > 0;
  const more = mapped && edit && !ed ? `<details class="fb-more" data-fbm="${it.id}" ${open ? "open" : ""}><summary>${it.draft && !stale ? "Not quite right? Add notes for the AI, or change options" : "More options"}${nNotes ? ` · ${nNotes} note${nNotes === 1 ? "" : "s"}` : ""}</summary><div class="stack" style="gap:12px">
     <div class="fgrid"><label class="f">Section<select id="sec-${it.id}" data-act-change="resec" data-id="${it.id}">${secOpts}</select></label>
      <label class="f">Who it's for<select data-act-change="scope" data-id="${it.id}"><option value="client" ${m.scope !== "shared" ? "selected" : ""}>This agent only</option><option value="shared" ${m.scope === "shared" ? "selected" : ""}>Every agent</option></select></label></div>
     ${(m.quotes || []).length ? `<div class="stack" style="gap:6px"><div class="small muted">Prompt lines the AI found responsible</div>${m.quotes.map(q => `<div class="small" style="border-left:3px solid var(--amber);background:var(--amber-soft);padding:6px 10px;border-radius:4px;white-space:pre-wrap">${mdInline(q.text)}</div>`).join("")}</div>` : ""}
     ${nNotes ? `<div class="small"><b>Your notes</b> <span class="muted">(used in every draft)</span>${it.guidance.map((g, i) => `<div class="row" style="gap:6px;align-items:flex-start;margin-top:4px"><span style="flex:1">${i + 1}. ${g.from === "check" ? `<span class="chip">from check</span> ` : ""}${esc(g.text)} <span class="muted">· ${esc((g.by || "").split("@")[0])}, ${fmtDate(g.at)}</span></span><a href="#" data-act="gd-del" data-id="${it.id}" data-i="${i}" class="muted" title="Remove this note">✕</a></div>`).join("")}</div>` : ""}
     <label class="f">${it.draft ? "Tell the AI what to change" : "Details for the fix"} <span class="hint">(exact wording, dates, what not to do; your notes override the diagnosis)</span>
      <textarea id="gd-${it.id}" rows="3" data-gd="${it.id}" placeholder="e.g. Don't ask 'this date or earlier'. Suggest a date 5–6 days before theirs.">${esc((R.gd || {})[it.id] || "")}</textarea></label>
     <div class="row" style="gap:8px"><button class="btn sm ai" data-act="draft-notes" data-id="${it.id}" ${aiOn() ? "" : "disabled"}>${(() => { const n = it.check && it.draft && it.check.draftAt === it.draft.at ? chkSel(it).size : 0; return it.draft ? (n ? `Redraft with ${n} ticked suggestion${n === 1 ? "" : "s"} + my notes` : "Redraft with my notes") : "Draft with my notes"; })()}</button></div>
     ${m.scope === "shared" ? `<label class="check small"><input type="checkbox" id="pr-${it.id}" data-act-check="promote" data-id="${it.id}" ${it.promote !== false ? "checked" : ""}> Also log as a shared-core fix for every client</label>` : ""}
     <div class="row small muted" style="gap:6px">${layerChip(m.layer || "L6")}${m.block ? `<code class="chip">${esc(m.block)}</code>` : ""}<span class="chip">${esc(m.type)}</span><span>mapped by ${m.via === "ai" ? esc(m.provider || "AI") : "keyword rules"}</span></div>
     <div class="row" style="gap:12px"><a href="#" class="small" data-act="dismiss" data-id="${it.id}">Dismiss</a><a href="#" class="small" data-act="fb-del" data-id="${it.id}" style="color:var(--err)">Delete for good</a></div>
    </div></details>` : "";
  return `<div class="fb ${it.status}">
   ${mapped && edit ? `<label class="fbsel"><input type="checkbox" data-act-check="fbsel" data-id="${it.id}" ${sel ? "checked" : ""} title="Select to fix several together"><span class="q">${esc(it.text)}</span></label>` : `<div class="q">${esc(it.text)}</div>`}
   <div class="where">${where}${where ? "<span>·</span>" : ""}<span>${origin}</span></div>
   ${c && c.excerpt ? `<div class="excerpt">${c.excerpt.map(x => `<div class="${(c.issues ? c.issues.some(z => z.turn === x.i) : x.i === c.turn) ? "hit" : ""}"><b>${x.role === "agent" ? "Agent" : "Customer"}:</b> ${esc(x.text.slice(0, 260))}</div>`).join("")}</div>` : ""}
   ${m && (m.diagnosis || m.fix) && it.status !== "applied" ? `<div class="why">${m.diagnosis ? `<span><b>Why:</b> ${esc(m.diagnosis)}</span>` : ""}${m.fix ? `<span><b>Fix:</b> ${esc(m.fix)}</span>` : ""}</div>` : ""}
   ${it.status === "applied" ? `<div class="small" style="color:var(--ok)"><b>✓ Fixed in v${esc(it.appliedIn)}</b>${it.promoted ? " · logged as a shared-core fix" : ""}</div>` : ""}
   ${mapped ? `
     ${it.draft ? `<div class="small"><b>Proposed change</b>${it.draft.how ? ` <span class="chip ${it.draft.how === "added" ? "warn" : "ok"}">${{ added: "Adds a new line", replaced: "Replaces a rule", modified: "Edits existing rules" }[it.draft.how] || "Edits existing rules"}</span>` : ""} ${esc(it.draft.summary)}${it.draft && !stale && it.draft.charsBefore != null && it.draft.charsAfter != null ? ` <span class="muted">(${delta(it.draft.charsAfter - it.draft.charsBefore)} characters)</span>` : ""}${it.draft.lostTags ? ` <span style="color:var(--warn)">(${it.draft.lostTags} block tag${it.draft.lostTags > 1 ? "s" : ""} dropped: check before applying)</span>` : ""}${stale ? ` <span style="color:var(--warn)">(drafted on v${esc(it.draft.baseV)}; the prompt has changed since)</span>` : ""}</div>
       ${Object.entries(it.draft.sections || { [m.section]: it.draft.revised }).map(([s, t]) => `${it.draft.sections && Object.keys(it.draft.sections).length > 1 || s !== m.section ? `<div class="small muted" style="margin-top:4px">In <b>${esc(secTitle(s))}</b>:</div>` : ""}${diffHtml(latest.sections[s] || "", t, !stale && !ed && edit ? { edit: { id: it.id, section: s } } : {})}`).join("")}${it.draft.editedByHand ? `<div class="small muted">You edited parts of this fix by hand.</div>` : ""}` : ""}
     ${it.draft && it.draft.understood ? `<div class="small" style="border-left:3px solid var(--accent);padding:4px 10px"><b>How the AI read your notes:</b> ${esc(it.draft.understood)}</div>` : ""}
     ${it.draft && !stale && !ed ? checkPanel(it) : ""}
     ${ed ? `<textarea id="ed-${it.id}" rows="10" class="mono">${esc(it.draft && !stale ? it.draft.revised : (latest.sections[m.section] || ""))}</textarea>` : ""}
     <div class="acts">
       ${(!it.draft || stale) && !ed ? `<button class="btn sm primary ai" data-act="draft" data-id="${it.id}" ${aiOn() ? "" : "disabled title='No AI model configured'"}>${stale ? "Draft again" : "Draft fix"}</button>` : ""}
       ${it.draft && !stale && !ed ? `<button class="btn sm primary" data-act="apply" data-id="${it.id}" ${edit ? "" : "disabled"}>${openDraft(latest) ? `Add to draft v${esc(latest.v)}` : "Apply as new draft"}</button>` : ""}
       ${ed ? `<button class="btn sm primary" data-act="apply-edit" data-id="${it.id}">${openDraft(latest) ? `Add edit to draft v${esc(latest.v)}` : "Apply edit as new draft"}</button><button class="btn sm" data-act="cancel-edit" data-id="${it.id}">Cancel</button>` : `<button class="btn sm" data-act="edit" data-id="${it.id}">Edit by hand</button>`}
     </div>
     ${more}` : ""}
   ${it.status === "new" ? `<div class="small muted">Not placed in the prompt yet.</div>` : ""}
   ${it.status === "dismissed" ? `<div class="row"><span class="small muted">Dismissed.</span><button class="btn sm ghost" data-act="undismiss" data-id="${it.id}">Restore</button></div>` : ""}
  </div>`;
}

// ---------- COMPARE TWO AGENTS ----------
// Each area: a checklist of things a prompt does or doesn't say (found by keywords in the live
// prompt, with the line that matched as evidence), plus the matching builder sections side by side.
const CMP_AREAS = [
  { id: "compliance", t: "Compliance", secs: ["rules", "identity"], facts: [
    ["Recording disclosure", /recorded|recording/i],
    ["Says it's AI when asked", /\bAI\b.*(asked|honest|confirm)|virtual assistant|are you a (bot|robot)/i],
    ["Identity check before details (RPC)", /\bRPC\b|right party|confirm(s|ed)? (the )?(identity|name)|speaking with|identity (check|gate)/i],
    ["No details to third parties", /third.?party|family member|someone else|wrong (person|number)|not disclose|never (share|disclose)/i],
    ["No threats / harassment", /never threaten|no threat|threat|harass|police|arrest|jail/i],
    ["Calling-hours window", /\b(8|08)(:00)?\s*(am|a\.m\.)?\s*(to|–|-)\s*(7|19|8|20)(:00)?\s*(pm|p\.m\.)?|calling (hours|window)/i],
    ["Stops on death / self-harm / distress", /deceased|died|death|self.?harm|distress|sensitive stop/i],
    ["Respects stop / DND requests", /do not call|DND|stop calling|don'?t call/i],
    ["No promises of outcomes", /never promise|no promise|guarantee/i]] },
  { id: "policy", t: "Policies", secs: ["flows", "dates"], facts: [
    ["Partial payment", /partial|part (payment|today)|some amount/i],
    ["Asks \"how much can you pay\"", /how much (can|could) you|kitna (de|pay)/i],
    ["Promise-to-pay with a date", /promise|PTP|fixed date|commit(ment)? date/i],
    ["Waiver / discount / settlement", /waiver|waive|discount|settle(ment)?/i],
    ["Payment link", /payment link|link (on|via) (sms|whatsapp)|send (the|a) link/i],
    ["UPI / app / net banking", /\bUPI\b|net ?banking|\bapp\b|NEFT|IMPS/i],
    ["Escalation / consequences line", /escalat|next stage|legal (action|notice)|credit (score|bureau)|CIBIL/i],
    ["Transfer to a human", /transfer|human agent|manager|supervisor/i],
    ["Field visit", /field (visit|agent)|home visit|visit (you|your)/i],
    ["Broken-promise handling", /broken promise|missed (the )?(promise|date)|didn'?t pay (as|on)/i]] },
  { id: "tone", t: "Collection tone", secs: ["persona", "speech"], line: /tone\s*[:*]/i, facts: [
    ["Warm / empathetic", /\bwarm|empath|polite|gentle|friendly|soft/i],
    ["Firm / direct", /\bfirm\b|direct|assertive|confident/i],
    ["Urgency / pressure", /urgen|pressure|today itself|immediately|aaj hi/i],
    ["Strict / aggressive", /strict|aggressive|stern/i],
    ["Short spoken lines", /short (lines|sentences)|one (sentence|line) at a time|brief/i],
    ["Hinglish / code-mixing", /hinglish|code.?mix|mix (of )?hindi/i]] },
  { id: "brand", t: "Branding", secs: ["opening"], brand: true, facts: [
    ["Agent has a name", /agent is \w+|named \w+|this is \w+|main \w+ bol/i],
    ["How the company is referred to", /referred to as|on behalf of|calling from/i],
    ["Legal name only if asked", /legal name|full (legal )?name.*only if/i],
    ["Agency calling for the lender", /agency|on behalf of/i]] },
  { id: "product", t: "Product", secs: ["kb", "inputs"], facts: [
    ["Personal loan", /personal loan/i], ["BNPL / pay later", /BNPL|pay ?later/i], ["Credit card", /credit card/i],
    ["EMI", /\bEMI\b/i], ["Foreclosure / full payoff", /foreclos|pay ?off|full (outstanding|closure)/i],
    ["Late fees / charges", /late fee|penalt|charges|bounce/i], ["Out-of-scope answer", /out.?of.?scope|don'?t know|not sure|I'll (note|check)/i]] },
  { id: "lang", t: "Languages & variables", secs: ["language"], meta: true, facts: [] },
  { id: "objections", t: "Objections", secs: ["objections"], facts: [
    ["Already paid", /already paid/i], ["No money / lost job", /no money|lost (my )?job|salary|paise nahi/i],
    ["Disputes the loan / fraud", /dispute|fraud|not my loan|never took/i], ["Abusive customer", /abus|rude|shout/i],
    ["Wants to talk to a human", /human|manager|supervisor/i], ["Busy / call back later", /busy|call (me )?back|later/i]] },
  { id: "closing", t: "Closing & dispositions", secs: ["closing", "hygiene"], facts: [
    ["Recaps what was agreed", /recap|summar|repeat (the )?(amount|date)/i], ["Dispositions / end reasons", /disposition|end_call|end reason|outcome code|rpc_failed/i],
    ["Voicemail handling", /voicemail/i], ["Silence handling", /silence|no response|dead air/i]] }
];
const linesOf = t => String(t || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
function cmpFacts(text, re) { const l = linesOf(text).find(x => re.test(x)); return l ? l.replace(/[*_#>]+/g, "").replace(/^[-•\s]+/, "").slice(0, 220) : null; }
async function loadCmpAgent(id) {
  R.cmpData = R.cmpData || {};
  if (R.cmpData[id]) return R.cmpData[id];
  const a = (R.agents || []).find(x => x.id === id);
  if (!a || !a.promptId) return (R.cmpData[id] = { agent: a, missing: true });
  const cur = await api("GET", "/prompts/" + a.promptId);
  const v = cur.versions.find(x => x.status === "live") || latestOf(cur);
  const sv = await api("GET", `/versions/${v.id}/sarvam-text`).catch(() => null);
  return (R.cmpData[id] = { agent: a, v, text: (sv && sv.text) || mdOf(cur.prompt.cfg, v, false), meta: sv && sv.meta, greeting: (sv && sv.greeting) || "" });
}
function viewCompare() {
  const ag = (R.agents || []).filter(a => a.promptId);
  const [ia, ib] = R.cmpPick || [];
  const opts = sel => `<option value="">Choose an agent…</option>` + ag.map(a => `<option value="${esc(a.id)}" ${a.id === sel ? "selected" : ""}>${esc(a.name)} · ${esc(a.client)}</option>`).join("");
  const areas = R.cmpAreas || CMP_AREAS.map(x => x.id);
  const A = ia && R.cmpData && R.cmpData[ia], B = ib && R.cmpData && R.cmpData[ib];
  return `<a class="back" href="#agents">← All agents</a>
  <div class="view-head" style="margin-top:6px"><div><h1>Compare agents</h1><p>Pick two agents and the areas you care about. Each area shows what each prompt says, side by side.</p></div></div>
  <div class="panel stack" style="margin-bottom:16px">
   <div class="fgrid"><label class="f">Agent A<select id="cmp-a" data-act-change="cmp-pick">${opts(ia)}</select></label><label class="f">Agent B<select id="cmp-b" data-act-change="cmp-pick">${opts(ib)}</select></label></div>
   <div class="row" style="gap:6px">${CMP_AREAS.map(x => `<button class="btn sm pill" data-act="cmp-area" data-id="${x.id}" aria-pressed="${areas.includes(x.id)}">${x.t}</button>`).join("")}
    <span class="small muted" style="margin-left:6px"><a href="#" data-act="cmp-all">All</a> · <a href="#" data-act="cmp-none">None</a></span></div>
   <label class="check small"><input type="checkbox" id="cmp-diff" data-act-check="cmp-diff" ${R.cmpOnlyDiff ? "checked" : ""}> Only show where they differ</label>
  </div>
  ${!ia || !ib ? `<div class="empty">Choose two agents above.</div>` : ia === ib ? `<div class="empty">Pick two different agents.</div>` : !A || !B ? `<div class="loading">Loading both prompts…</div>` : cmpSummary(A, B) + cmpBody(A, B, areas)}`;
}
function cmpSummary(A, B) {
  if (A.missing || B.missing) return "";
  const s = R.cmpSum && R.cmpSum.key === `${A.agent.id}|${B.agent.id}` ? R.cmpSum : null;
  if (!s) return `<div class="panel row" style="justify-content:space-between;margin-bottom:16px"><span class="small muted">Get a plain-language summary of how these two agents will behave differently on calls.</span><button class="btn sm primary ai" data-act="cmp-sum" ${aiOn() ? "" : "disabled title='No AI model configured'"}>Summarize the differences</button></div>`;
  if (s.loading) return `<div class="panel" style="margin-bottom:16px"><span class="small muted">Reading both prompts…</span></div>`;
  if (s.error) return `<div class="notice" style="margin-bottom:16px"><span>${esc(s.error)}</span><button class="btn sm" data-act="cmp-sum">Try again</button></div>`;
  return `<div class="panel stack" style="margin-bottom:16px"><div class="row" style="justify-content:space-between"><h2>Summary</h2><span class="small muted">by ${esc(s.provider || "AI")} · <a href="#" data-act="cmp-sum">redo</a></span></div>
   <p><b>${esc(s.headline)}</b></p>
   <div class="stack" style="gap:6px">${s.differences.map(d => `<div class="cmp-grid risk-${d.risk}" style="padding-left:8px"><div class="lbl">${esc(d.area)}${d.risk === "high" ? ` <span class="chip err">risk</span>` : ""}</div><div class="small">${esc(d.a)}</div><div class="small">${esc(d.b)}</div></div>`).join("")}</div>
   ${s.same ? `<p class="small muted">Same in both: ${esc(s.same)}</p>` : ""}</div>`;
}
function cmpBody(A, B, areas) {
  if (A.missing || B.missing) return `<div class="empty">${esc((A.missing ? A : B).agent.name)} has no prompt in the builder yet. Open it and load its prompt from Sarvam first.</div>`;
  const head = `<div class="cmp-grid cmp-head"><div></div><div><b>${esc(A.agent.name)}</b><div class="small muted">${esc(A.agent.client)}${A.v.sarvamVersion ? ` · Sarvam v${esc(A.v.sarvamVersion)}` : ""}</div></div><div><b>${esc(B.agent.name)}</b><div class="small muted">${esc(B.agent.client)}${B.v.sarvamVersion ? ` · Sarvam v${esc(B.v.sarvamVersion)}` : ""}</div></div></div>`;
  const cell = ev => ev ? `<div class="yes">✓ <span>${mdInline(ev)}</span></div>` : `<div class="no">— not mentioned</div>`;
  const row = (label, a, b, differs) => R.cmpOnlyDiff && !differs ? "" : `<div class="cmp-grid ${differs ? "diff" : ""}"><div class="lbl">${label}</div><div>${a}</div><div>${b}</div></div>`;
  const plain = s => s ? mdInline(s) : `<span class="muted">—</span>`;
  const out = areas.map(id => {
    const area = CMP_AREAS.find(x => x.id === id);
    const rows = [];
    if (area.brand) {
      rows.push(row("Greeting", plain(A.greeting), plain(B.greeting), A.greeting !== B.greeting));
      rows.push(row("Client", esc(A.agent.client), esc(B.agent.client), A.agent.client !== B.agent.client));
      const who = t => cmpFacts(t, /agent is|named|calling on behalf|referred to as/i);
      rows.push(row("Who the agent is", plain(who(A.text)), plain(who(B.text)), who(A.text) !== who(B.text)));
    }
    if (area.line) { const a = cmpFacts(A.text, area.line), b = cmpFacts(B.text, area.line); rows.push(row("Tone line", plain(a), plain(b), a !== b)); }
    if (area.id === "product") rows.push(row("Product (catalog)", esc(A.agent.product || "—"), esc(B.agent.product || "—"), A.agent.product !== B.agent.product));
    if (area.meta) {
      const la = A.meta && A.meta.languages, lb = B.meta && B.meta.languages;
      rows.push(row("Starts in", esc(la ? la.initial : "—"), esc(lb ? lb.initial : "—"), (la && la.initial) !== (lb && lb.initial)));
      const ls = l => l ? l.supported.join(", ") : "—";
      rows.push(row("Speaks", esc(ls(la)), esc(ls(lb)), ls(la) !== ls(lb)));
      const va = new Set(((A.meta || {}).variables || []).map(v => v.name)), vb = new Set(((B.meta || {}).variables || []).map(v => v.name));
      const onlyA = [...va].filter(x => !vb.has(x)), onlyB = [...vb].filter(x => !va.has(x)), both = [...va].filter(x => vb.has(x));
      rows.push(row("Variables in both", `${both.length}`, `${both.length}`, false));
      rows.push(row("Variables only here", onlyA.map(x => `<span class="var">${esc(x)}</span>`).join(" ") || "—", onlyB.map(x => `<span class="var">${esc(x)}</span>`).join(" ") || "—", !!(onlyA.length || onlyB.length)));
    }
    for (const [label, re] of area.facts) { const a = cmpFacts(A.text, re), b = cmpFacts(B.text, re); rows.push(row(esc(label), cell(a), cell(b), !!a !== !!b)); }
    const body = rows.join("");
    const secs = area.secs.filter(s => (A.v.sections[s] || B.v.sections[s]));
    const sectionText = secs.length ? `<details class="cmp-text"><summary class="small">Read the full ${secs.map(secTitle).join(" and ").toLowerCase()} text side by side</summary>
      <div class="cmp-grid"><div></div><div class="md small-md">${mdRender(secs.map(s => stripTagsC(A.v.sections[s])).filter(Boolean).join("\n\n")) || "<span class='muted'>Nothing here.</span>"}</div><div class="md small-md">${mdRender(secs.map(s => stripTagsC(B.v.sections[s])).filter(Boolean).join("\n\n")) || "<span class='muted'>Nothing here.</span>"}</div></div></details>` : "";
    if (R.cmpOnlyDiff && !body) return `<div class="panel"><h2>${area.t}</h2><div class="small muted" style="margin-top:6px">No differences found.</div></div>`;
    return `<div class="panel stack" style="gap:0"><h2 style="margin-bottom:8px">${area.t}</h2>${body}${sectionText}</div>`;
  }).join("");
  return `<div class="stack">${head}${out || `<div class="empty">Pick at least one area.</div>`}
   <p class="small muted">The checklist looks for keywords in each live prompt and shows the line it found. "Not mentioned" means no line matched, so open the full text to be sure.</p></div>`;
}
const stripTagsC = s => String(s || "").replace(/^<!--.*-->[ \t]*\n?/gm, "").trim();
async function cmpLoad() {
  const [a, b] = R.cmpPick || [];
  await Promise.all([a, b].filter(Boolean).map(id => loadCmpAgent(id).catch(e => { R.cmpData[id] = { agent: (R.agents || []).find(x => x.id === id), missing: true, error: e.message }; })));
  if (route() === "compare") render();
}

// ---------- APPROVALS ----------
function viewApprovals() {
  const items = R.approvals || [];
  const pending = items.filter(v => v.status === "pending"), approved = items.filter(v => v.status === "approved");
  const card = v => {
    const p = (R.prompts || []).find(x => x.id === v.promptId) || {};
    const agent = p.agent;
    const last = (v.history || []).slice(-1)[0] || {};
    return `<div class="panel stack">
    <div class="row" style="justify-content:space-between"><div><h3>${esc(v.promptName)} · v${esc(v.v)}</h3><div class="small muted">${esc(v.note)} · by ${esc(v.by)} · ${fmtDate(v.createdAt)}</div></div>${statusPill(v.status)}</div>
    <div class="row" style="gap:6px"><button class="btn sm" data-act="see-diff" data-pid="${v.promptId}" data-vid="${v.id}">See changes</button><a class="btn sm ghost" href="#improve" data-act="open-prompt" data-id="${v.promptId}">Open prompt</a>${canDo("edit") ? `<a class="btn sm ghost" href="#improve" data-act="open-edit" data-id="${v.promptId}" title="Edits are saved as a new draft that needs approval again">✎ Edit text</a>` : ""}</div>
    ${v.status === "pending" ? (canDo("approve") ? `<div class="row" style="gap:6px"><input type="text" id="note-${v.id}" placeholder="Note (required to reject)" style="flex:1;min-width:180px"><button class="btn sm primary" data-act="approve" data-vid="${v.id}" ${!R.selfApprove && [v.by, ...(v.editedBy || [])].includes(R.me.email) && R.me.role !== "admin" ? "disabled title='Someone who did not write or edit this version must approve it'" : ""}>Approve</button><button class="btn sm" data-act="reject" data-vid="${v.id}">Reject</button></div>` : `<div class="small muted">Waiting for an approver.</div>`) : ""}
    ${v.status === "approved" ? `<div class="small muted">Approved by ${esc(v.approvedBy)} · ${fmtDate(v.approvedAt)}${last.note ? " · " + esc(last.note) : ""}</div>
     <div class="row" style="gap:6px">${pushControl({ prompt: { id: v.promptId }, agent }, v)}<span class="small muted">${agent ? `Writes the changes into ${esc(agent.name)} in Sarvam and commits a new version. You see them before anything is written.` : "Pick the Sarvam agent this prompt is for. Its prompt will be replaced by this one; you see it before anything is written."}</span></div>
     <details><summary class="small">Do it by hand instead</summary>
     <ol class="steps-live" style="margin:0;padding:0">
      <li><div><b>Copy the approved prompt</b> <button class="btn sm" data-act="copy-ver" data-pid="${v.promptId}" data-vid="${v.id}">Copy prompt</button><div class="small muted">Block tags are removed from the copy.</div></div></li>
      <li><div><b>Paste it into Sarvam and commit</b><div class="small muted">${agent ? `Agents → ${esc(agent.client)} → Canvas → Instructions. Save as a new version.` : "This prompt isn't linked to a live agent. Paste it into the agent in Sarvam and commit."}</div></div></li>
      <li><div><b>Confirm here</b>${canDo("golive") ? `<div class="row" style="margin-top:6px"><label class="f" style="width:150px">Sarvam version <span class="hint">${agent ? "(blank = newest)" : ""}</span><input type="number" min="1" id="sv-${v.id}"></label>${agent ? `` : ""}<button class="btn sm primary" style="align-self:flex-end" data-act="go-live" data-vid="${v.id}">Confirm live</button></div><div class="small muted">${agent ? "The builder checks Sarvam that the version exists and is newer than the live one." : ""}</div>` : `<div class="small muted">An approver confirms this step.</div>`}</div></li>
     </ol></details>` : ""}
   </div>`; };
  return `
  <div class="view-head"><div><h1>Approvals</h1><p>${R.selfApprove ? "Review each change, approve it, then push it live." : "Changes waiting for a second person to approve, then ready to push live."}</p></div></div>
  <div class="grid2">
   <div class="stack"><h2>Waiting for approval · ${pending.length}</h2>${pending.length ? pending.map(card).join("") : `<div class="empty">Nothing waiting.</div>`}</div>
   <div class="stack"><h2>Approved, not live yet · ${approved.length}</h2>${approved.length ? approved.map(card).join("") : `<div class="empty">Nothing approved and waiting to go live.</div>`}</div>
  </div>`;
}
// Push: Sarvam dry-runs the edits first; nothing is written until "Push and go live".
async function pushModal(vid, allowDraftChanges, target) {
  const uat = target === "uat";
  $("#modal").innerHTML = `<div class="panel stack" role="dialog" aria-modal="true"><div class="small muted">Checking with Sarvam (dry run, nothing is written)…</div></div>`;
  $("#modal").hidden = false;
  const head = t => `<div class="row" style="justify-content:space-between"><h2>${t}</h2><button class="btn sm ghost" data-act="close-modal">Close</button></div>`;
  let r;
  try { r = await api("POST", `/versions/${vid}/push`, { dryRun: true, allowDraftChanges: !!allowDraftChanges, target: uat ? "uat" : undefined }); }
  catch (e) {
    if (e.code === "stale_base") {
      const d = e.data || {};
      $("#modal").innerHTML = `<div class="panel stack" role="dialog" aria-modal="true" style="max-height:88vh;overflow:auto">${head(uat ? "Push to UAT" : "Promote to live")}
        <div class="vitem warn"><span class="ic">!</span><div class="vt"><b>Stopped: this would undo newer fixes</b><span>${esc(e.message)}</span></div></div>
        ${(d.lost || []).length ? `<details open><summary class="small">Lines in Sarvam v${esc(d.newest)} that this push would erase (${fmtN(d.lostCount)})</summary><div class="cv"><div class="cv-card removed"><div class="cv-one"><div class="cv-txt">${d.lost.map(l => `<del>${esc(l)}</del>`).join("\n")}</div></div></div></div></details>` : ""}
        <p class="small">Rebuild takes only this version's own changes and applies them on top of Sarvam v${esc(d.newest)}, so the newer fixes stay. If it was approved, it needs approval again.</p>
        <div class="row"><button class="btn primary" data-act="rebase" data-vid="${vid}">Rebuild on Sarvam v${esc(d.newest)}</button></div></div>`;
      return;
    }
    const dirty = e.code === "draft_dirty";
    $("#modal").innerHTML = `<div class="panel stack" role="dialog" aria-modal="true">${head(uat ? "Push to UAT" : "Push to Sarvam")}
      <div class="vitem warn"><span class="ic">!</span><div class="vt"><b>${dirty ? "Sarvam has uncommitted edits" : e.code === "same_as_uat" ? "Nothing to push" : "Can't push yet"}</b><span>${esc(e.message)}</span></div></div>
      ${dirty ? `<p class="small">Someone edited this agent in Sarvam without committing. Either commit or discard those edits in Sarvam first, or include them in this push. Including them means they ${uat ? "are overwritten by this version" : "go live too, unreviewed"}.</p>
      <div class="row"><button class="btn sm" data-act="push-preview" data-vid="${vid}" data-allow="1" data-target="${uat ? "uat" : ""}">${uat ? "Overwrite them and continue" : "Include them and continue"}</button></div>` : ""}</div>`;
    return;
  }

  $("#modal").innerHTML = `<div class="panel stack" role="dialog" aria-modal="true" style="max-height:88vh;overflow:auto">${head(uat ? `Push to UAT · ${esc(r.uatName)}` : "Promote to live")}
    <div class="vitem ok"><span class="ic">✓</span><div class="vt"><b>Sarvam accepted the dry run</b><span>${r.whole ? `${uat ? esc(r.uatName) + "'s" : "The agent's"} whole prompt will be replaced by this version (${r.chars >= 0 ? "+" : ""}${r.chars} characters)` : r.edits ? `${r.edits} passage${r.edits === 1 ? "" : "s"} will change (${r.chars >= 0 ? "+" : ""}${r.chars} characters); everything else stays exactly as it is` : "The instructions don't change"}${r.baseVersion ? `, based on Sarvam v${r.baseVersion}` : ""}.${r.greeting ? " The greeting is set too, and Sarvam regenerates its translations." : ""}${r.draftDirty ? " Uncommitted Sarvam draft edits are included." : ""}</span></div></div>
    ${r.settings && r.settings.length ? `<div><div class="small muted">Settings changes</div><ul class="small" style="margin:4px 0 0 18px">${r.settings.map(s => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
    ${r.greeting ? `<div><div class="small muted">${uat ? "Greeting" : "New greeting"}</div><div class="greet" style="font-size:15px">${mdInline(r.greeting)}</div></div>` : ""}
    ${r.preview.map((x, i) => `<details ${i < 3 && !(uat && r.whole) ? "open" : ""}><summary class="small">${r.whole ? "New prompt (start)" : `Passage ${i + 1}`}</summary><div class="diff">${r.whole ? esc(x.after) : diffHtml(x.before, x.after)}</div></details>`).join("")}
    ${uat ? `<div class="small muted">The UAT agent becomes an exact copy of this version so you can test it on real calls. The live agent doesn't change.</div>
      <div class="row"><button class="btn primary" data-act="push-do" data-vid="${vid}" data-allow="${allowDraftChanges ? 1 : ""}" data-target="uat">Push to UAT</button></div>`
    : `${(() => { const vv = R.cur && R.cur.versions.find(x => x.id === vid), ts = vv && testState(vv); if (!vv || !(R.tests || []).length) return ""; return ts ? (ts.failed ? `<div class="vitem warn"><span class="ic">!</span><div class="vt"><b>${ts.failed} of ${ts.total} regression tests failed on v${esc(vv.v)}</b><span>An old mistake may come back with this version. Check the tests on Make a change before pushing.</span></div></div>` : `<div class="small" style="color:var(--ok)">✓ All ${ts.total} regression tests passed on v${esc(vv.v)}.</div>`) : `<div class="vitem warn"><span class="ic">!</span><div class="vt"><b>Regression tests weren't run on v${esc(vv.v)}</b><span>Run them on Make a change first to check no fixed mistake comes back.</span></div></div>`; })()}

    <div class="row"><button class="btn primary" data-act="push-do" data-vid="${vid}" data-allow="${allowDraftChanges ? 1 : ""}">Push and go live</button><span class="small muted">Commits a new version in Sarvam. Roll back from the version table if needed.</span></div>`}</div>`;
}
// New agent: Sarvam copies an existing agent (prompt, greeting, variables, voice) under a new name.
function cloneModal(fromId, opts = {}) {
  const ag = (R.agents || []).filter(a => a.sarvamAppId);
  const src = ag.find(a => a.id === fromId) || ag[0];
  const p = src && (R.prompts || []).find(x => x.id === src.promptId);
  const sv = p && p.live && p.live.sarvamVersion;
  $("#modal").innerHTML = `<div class="panel stack" role="dialog" aria-modal="true" style="max-width:560px">
   <div class="row" style="justify-content:space-between"><h2>${opts.uatFor ? "Create a UAT copy" : "New agent"}</h2><button class="btn sm ghost" data-act="close-modal">Close</button></div>
   <p class="small muted">Sarvam makes a full copy: prompt, greeting, variables, languages, voice and tools. Then change what's different for the new client on the Prompt and Settings tabs, and push it like any change.</p>
   <label class="f">Copy from<select id="cl-from">${ag.map(a => `<option value="${esc(a.id)}" ${a.id === (src && src.id) ? "selected" : ""}>${esc(a.name)} · ${esc(a.client)}</option>`).join("")}</select></label>
   <label class="f">Version to copy <span class="hint">(blank = the newest committed${sv ? `; live is v${esc(sv)}` : ""})</span><input type="number" min="1" id="cl-ver" value="${esc(sv || "")}"></label>
   <label class="f">New agent's name<input type="text" id="cl-name" value="${esc(opts.uatFor && src ? src.name + " UAT" : "")}" placeholder="e.g. Fatak Pay Strict – Bucket 2"></label>
   <label class="f">Client <span class="hint">(as shown in the builder)</span><input type="text" id="cl-client" value="${esc(src ? src.client : "")}"></label>
   ${opts.uatFor ? "" : `<label class="f">New greeting <span class="hint">(optional, English; blank keeps the copied greeting)</span><textarea id="cl-greet" rows="2"></textarea></label>`}
   <div class="row"><button class="btn primary" data-act="clone-do" data-uat="${esc(opts.uatFor || "")}">Create in Sarvam</button><span class="small muted" id="cl-msg">Creates a new agent in your Sarvam workspace. It can't be deleted from here.</span></div></div>`;
  $("#modal").hidden = false;
}
function uatModal(agentId) {
  const a = (R.agents || []).find(x => x.id === agentId);
  const others = (R.agents || []).filter(x => x.id !== agentId && x.sarvamAppId);
  $("#modal").innerHTML = `<div class="panel stack" role="dialog" aria-modal="true" style="max-width:560px">
   <div class="row" style="justify-content:space-between"><h2>UAT agent for ${esc(a.name)}</h2><button class="btn sm ghost" data-act="close-modal">Close</button></div>
   <p class="small muted">Changes are pushed to the UAT agent first so you can hear them on real test calls. When they're good, one click promotes the same version to ${esc(a.name)}.</p>
   <label class="f">UAT agent<select id="uat-pick"><option value="">None</option>${others.map(x => `<option value="${esc(x.id)}" ${x.id === a.uatAgentId ? "selected" : ""}>${esc(x.name)} · ${esc(x.client)}</option>`).join("")}</select></label>
   <div class="row"><button class="btn primary" data-act="uat-save" data-id="${esc(a.id)}">Save</button><span class="small muted">or</span><button class="btn" data-act="uat-create" data-id="${esc(a.id)}">Create a UAT copy of ${esc(a.name)}…</button></div></div>`;
  $("#modal").hidden = false;
}
async function showDiffModal(pid, vid) {
  const cur = await api("GET", "/prompts/" + pid);
  const i = cur.versions.findIndex(v => v.id === vid);
  const v = cur.versions[i], base = cur.versions.find(x => x.id === v.basedOn) || cur.versions.find(x => x.status === "live") || cur.versions[i - 1];
  $("#modal").innerHTML = `<div class="panel stack" role="dialog" aria-modal="true"><div class="row" style="justify-content:space-between"><h2>v${esc(v.v)} compared with ${base ? "v" + esc(base.v) : "nothing"}</h2><button class="btn sm ghost" data-act="close-modal">Close</button></div>
   ${base ? versionDiff(base, v) : `<pre class="prompt">${esc(mdOf(cur.prompt.cfg, v))}</pre>`}</div>`;
  $("#modal").hidden = false;
}

// ---------- MODULE LIBRARY ----------
// A module is a reusable set of rules for one behaviour (e.g. payment dates). Creating, editing or
// approving a module never changes an agent. An agent changes only when you use the module for THAT
// agent: you see the exact changes first, they're saved as a draft, then approved and pushed as usual.
async function loadMod(id) { const r = await api("GET", `/modules/${id}`); R.modDoc = r; R.modId = id; if (!R.modUse || R.modUse.docId !== id) R.modUse = { docId: id, agentId: "", options: null, params: {}, preview: null }; }
const modSt = s => `<span class="chip ${s === "approved" ? "ok" : "warn"}">${s === "approved" ? "Approved" : "Draft"}</span>`;
// Where the module library is saved (the git repo), and the last save error if any.
function libLine() {
  const l = R.lib; if (!l) return "";
  const where = l.kind === "github" ? `Saved in git: <span class="mono">${esc(l.repo)}</span>, branch <span class="mono">${esc(l.branch)}</span>, folder <span class="mono">${esc(l.path)}</span>. Every save is a commit.` : `Saved as files in <span class="mono">${esc(l.path)}</span> of this folder. Commit them to git (set GITHUB_TOKEN on Render to commit automatically).`;
  return `<p class="small muted">${where}</p>${l.lastError ? `<div class="vitem warn"><span class="ic">!</span><div class="vt"><b>Module library problem</b><span>${esc(l.lastError)}</span></div></div>` : ""}`;
}
function viewModules() {
  if (R.modId && R.modDoc) return viewModule();
  const L = R.mods || [], ag = (R.agents || []).filter(a => a.promptId);
  const X = R.modNew || (R.modNew = { agentId: "", topic: "", moduleId: "", title: "", open: false });
  return `<div class="view-head"><div><h1>Module library</h1><p>Reusable rules for one behaviour, like payment dates. <b>Making or changing a module never changes an agent.</b> An agent changes only when you use a module for it and approve that change.</p>${libLine()}</div>
   <div class="row">${canDo("edit") ? `<button class="btn primary" data-act="mod-new-toggle">+ Extract a module from an agent</button>` : ""}</div></div>
  ${X.open ? `<div class="panel stack" style="margin-bottom:16px"><h2>Extract a module</h2>
    <p class="small muted">The AI finds every rule about this behaviour in the agent's prompt, wherever it sits, and turns it into a client-neutral module with settings and tests. The agent is only read.</p>
    <div class="fgrid"><label class="f">From agent<select data-modnew="agentId"><option value="">Choose…</option>${ag.map(a => `<option value="${esc(a.id)}" ${a.id === X.agentId ? "selected" : ""}>${esc(a.name)}${a.client ? " · " + esc(a.client) : ""}</option>`).join("")}</select></label>
     <label class="f">Module ID <span class="hint">(letters, numbers, dashes)</span><input type="text" data-modnew="moduleId" value="${esc(X.moduleId)}" placeholder="PTP-DATES"></label>
     <label class="f">Title<input type="text" data-modnew="title" value="${esc(X.title)}" placeholder="Payment dates (promise to pay)"></label></div>
    <label class="f">What behaviour is this? <span class="hint">(a sentence or two)</span><textarea rows="3" data-modnew="topic" placeholder="How the agent handles the date a customer gives to pay: checking it is a real date, keeping the customer's earliest date, suggesting one exact earlier date, and what to say when a date is invalid.">${esc(X.topic)}</textarea></label>
    <div class="row"><button class="btn primary ai" data-act="mod-extract" ${aiOn() ? "" : "disabled"}>Extract (1 to 3 minutes)</button><button class="btn" data-act="mod-new-toggle">Cancel</button></div></div>` : ""}
  ${L.length ? `<div class="alist">${L.map(m => `<a class="arow" href="#modules" data-act="mod-open" data-id="${m.id}"><div class="nm"><b>${esc(m.title)}</b><div class="small muted"><code>${esc(m.moduleId)}</code> v${esc(m.v)} · ${m.rules} rules · ${m.tests} tests</div><div class="small muted">${esc(m.purpose || "")}</div><div class="row" style="margin-top:6px;gap:4px">${modSt(m.status)}<span class="chip">${m.usedBy.length ? "Used by " + [...new Set(m.usedBy.map(u => u.agent))].map(esc).join(", ") : "Not used by any agent yet"}</span></div></div><div></div><div></div></a>`).join("")}</div>` : `<div class="empty">No modules yet. Extract the first one from an agent that does this behaviour well.</div>`}`;
}
function viewModule() {
  const { module: m, versions, usedBy } = R.modDoc, U = R.modUse;
  const opts = U.options || (U.options = Object.fromEntries((m.options || []).map(o => [o.id, o.default])));
  const ag = (R.agents || []).filter(a => a.promptId);
  const rev = canDo("edit") && m.status === "draft";
  const ruleCard = x => { const ed = R.modEdit === x.id;
    return `<div class="fb" style="gap:6px"><div class="row" style="justify-content:space-between;gap:8px"><b>${esc(x.title)}</b><span class="row" style="gap:4px"><span class="chip acc">${esc(secTitle(x.slot))}</span>${x.sourceFound ? `<span class="chip ok" title="The source passage was found word for word in the agent's prompt">from source</span>` : `<span class="chip warn" title="The source passage wasn't found word for word">source paraphrased</span>`}</span></div>
     ${ed ? `<textarea id="mod-rule-text" rows="8" class="mono">${esc(x.text)}</textarea><div class="row" style="gap:6px"><button class="btn sm primary" data-act="mod-rule-save" data-rid="${esc(x.id)}">Save</button><button class="btn sm" data-act="mod-rule-edit" data-rid="">Cancel</button></div>`
        : `<div class="md small-md">${mdRender(x.text.replace(/<<if (\w+)>>/g, "⟦if $1: ").replace(/<<end>>/g, "⟧").replace(/\[\[(\w+)\]\]/g, "⟨$1⟩"))}</div>${canDo("edit") ? `<div class="row" style="gap:6px"><button class="btn sm" data-act="mod-rule-edit" data-rid="${esc(x.id)}">✎ Edit</button></div>` : ""}`}
     ${x.source ? `<details><summary class="small">What was changed from the agent's own wording (${esc(m.source.agent)} v${esc(m.source.version)})</summary>${diffHtml(x.source, x.text)}</details>` : ""}</div>`; };
  const P = U.preview;
  const preview = P ? `<div class="stack" style="gap:8px;border-top:1px solid var(--line);padding-top:10px">
    <div class="row" style="justify-content:space-between"><b>What would change in ${esc(P.agent)}</b><span class="small muted">${P.edits.filter(e => e.action !== "skip").length} change${P.edits.filter(e => e.action !== "skip").length === 1 ? "" : "s"} · nothing is saved yet · ${esc(P.provider || "")}</span></div>
    ${P.unfilled.length ? `<div class="notice"><span>Fill in these settings first: ${P.unfilled.map(esc).join(", ")}.</span></div>` : ""}
    ${P.edits.map(e => `<div class="fb" style="gap:6px"><label class="fbsel" style="align-items:flex-start"><input type="checkbox" data-act-check="mod-sel" data-i="${e.id}" ${e.action !== "skip" && e.ok && U.sel.has(e.id) ? "checked" : ""} ${e.action === "skip" || !e.ok ? "disabled" : ""}><span><b>${esc(e.title)}</b> <span class="chip ${e.action === "replace" ? "warn" : e.action === "insert" ? "ok" : ""}">${{ replace: "Replaces the agent's own rule", insert: "Adds a rule", skip: "Already there" }[e.action]}</span>${e.ok ? "" : ` <span class="chip err">couldn't be placed exactly</span>`}</span></label>
      ${e.reason ? `<div class="small muted">${esc(e.reason)}</div>` : ""}${e.action === "skip" ? "" : diffHtml(e.old_text, e.new_text)}</div>`).join("")}
    <div class="row"><button class="btn primary" data-act="mod-apply" ${m.status === "approved" && U.sel.size && !P.unfilled.length ? "" : "disabled"}>Save ${U.sel.size} change${U.sel.size === 1 ? "" : "s"} as a draft on ${esc(P.agent)}</button><span class="small muted">${m.status === "approved" ? `Only ${esc(P.agent)}'s draft changes. Every other agent stays as it is. It then goes through approval like any change.` : "Approve the module first. A draft module can be previewed but not used."}</span></div></div>` : "";
  const runs = m.runs && U.agentId && m.runs[U.agentId];
  return `<a class="back" href="#modules" data-act="mod-close">← Module library</a>
  <div class="view-head" style="margin-top:6px"><div><h1>${esc(m.title)}</h1><p><code>${esc(m.moduleId)}</code> v${esc(m.v)} · ${modSt(m.status)}${versions.length > 1 ? ` · versions: ${versions.map(v => `<a href="#modules" data-act="mod-open" data-id="${v.id}">v${esc(v.v)}</a>`).join(", ")}` : ""} · extracted from ${esc(m.source.agent)} v${esc(m.source.version)}${m.source.versionStatus !== "live" ? ` (${esc(m.source.versionStatus)})` : ""}</p></div>
   <div class="row">${m.status === "draft" && canDo("edit") && !usedBy.length ? `<button class="btn" data-act="mod-delete" style="color:var(--err)">Delete draft</button>` : ""}${m.status === "draft" && canDo("approve") ? `<button class="btn primary" data-act="mod-approve">Approve module</button>` : ""}</div></div>
  <div class="notice ${usedBy.length ? "" : "ok"}"><span>${usedBy.length ? `Used by ${usedBy.map(u => `<b>${esc(u.agent)}</b> (v${esc(u.moduleVersion)}, ${esc(u.status)})`).join(", ")}.` : "<b>No agent uses this module yet</b>, so no agent's prompt is affected."}</span></div>
  <div class="stack">
   <div class="panel stack"><h2>About this module</h2>
    <div class="fgrid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))">
     <div><div class="small muted">Purpose</div><div>${esc(m.purpose)}</div></div><div><div class="small muted">Applies when</div><div>${esc(m.trigger)}</div></div>
     <div><div class="small muted">Needs these call values</div><div>${(m.requires || []).map(v => `<span class="var">{ } ${esc(v)}</span>`).join(" ") || "—"}</div></div>
     <div><div class="small muted">Can end in</div><div>${(m.exits || []).map(esc).join(" · ") || "—"}</div></div>
     <div style="grid-column:1/-1"><div class="small muted">Depends on these policy decisions</div><div>${(m.policyDeps || []).map(esc).join(" · ") || "—"}</div></div></div></div>
   <div class="panel stack"><h2>Rules · ${m.rules.length}</h2><p class="small muted">Text in ⟦if option: …⟧ is kept only when that setting is on. ⟨name⟩ is filled in for each agent. {{call values}} are left as they are.</p>${m.rules.map(ruleCard).join("")}</div>
   <div class="panel stack"><h2>Settings</h2><div class="small muted">How a client can differ. Defaults are how ${esc(m.source.agent)} behaves.</div>
    ${(m.options || []).map(o => `<div class="small"><b>${esc(o.label)}</b> <span class="chip">${o.default ? "on by default" : "off by default"}</span><div class="muted">${esc(o.desc)}</div></div>`).join("") || "<div class='small muted'>No settings.</div>"}
    ${(m.params || []).length ? `<div class="small"><b>Filled in per agent:</b> ${m.params.map(p => `${esc(p.label)} (e.g. ${esc(p.example)})`).join("; ")}</div>` : ""}</div>
   <div class="panel stack"><h2>Tests · ${(m.tests || []).length}</h2><p class="small muted">These travel with the module. Run them on any agent to check it handles this behaviour.</p>
    ${(m.tests || []).map(t => `<div class="fb" style="gap:4px"><b class="small">${esc(t.title)}</b><div class="excerpt">${t.customer.map(l => `<div><b>Customer:</b> ${esc(l)}</div>`).join("")}</div><div class="small"><b>Must:</b> ${esc(t.expect)}${t.avoid ? `<br><b>Must not:</b> ${esc(t.avoid)}` : ""}</div></div>`).join("") || "<div class='small muted'>No tests.</div>"}</div>
   <div class="panel stack" id="useMod"><h2>Use this module for an agent</h2>
    <p class="small muted">Pick one agent and set how it should differ. You see the exact changes first. Nothing is saved until you click the save button, and only that agent's draft changes.</p>
    <div class="fgrid"><label class="f">Agent<select data-moduse="agentId"><option value="">Choose…</option>${ag.map(a => `<option value="${esc(a.id)}" ${a.id === U.agentId ? "selected" : ""}>${esc(a.name)}${a.client ? " · " + esc(a.client) : ""}</option>`).join("")}</select></label>
     ${(m.params || []).map(p => `<label class="f">${esc(p.label)} <span class="hint">(e.g. ${esc(p.example)})</span><input type="text" data-modparam="${esc(p.name)}" value="${esc(U.params[p.name] || "")}"></label>`).join("")}</div>
    ${(m.options || []).map(o => `<label class="check small" style="align-items:flex-start"><input type="checkbox" data-act-check="mod-opt" data-id="${esc(o.id)}" ${opts[o.id] ? "checked" : ""}><span><b>${esc(o.label)}</b><div class="muted">${esc(o.desc)}</div></span></label>`).join("")}
    <div class="row" style="gap:6px"><button class="btn primary ai" data-act="mod-preview" ${U.agentId && aiOn() ? "" : "disabled"}>Preview the changes (1 to 3 minutes)</button><button class="btn ai" data-act="mod-tests" ${U.agentId && (m.tests || []).length && aiOn() ? "" : "disabled"}>Run the module's tests on this agent</button></div>
    ${runs ? `<div class="small"><b>Last test run on ${esc(runs.agent)} v${esc(runs.v)}:</b> <span class="chip ${runs.failed ? "err" : "ok"}">${runs.passed}/${runs.total} pass</span>${runs.results.map(x => `<div style="color:${x.pass ? "var(--ok)" : "var(--err)"}">${x.pass ? "✓" : x.pass === false ? "✗" : "?"} ${esc(x.title)}${x.pass ? "" : ` <span class="muted">${esc((x.why || "").slice(0, 200))}</span>`}</div>`).join("")}</div>` : ""}
    ${preview}</div>
  </div>`;
}

function viewLibrary() {
  const f = L.libFilter || "all";
  const list = BLOCKS.filter(b => f === "all" || b.layer === f);
  const core = R.core || [];
  return `
  <div class="view-head"><div><h1>Block library</h1><p>${BLOCKS.length} blocks. Each records its layer, where it came from, and how it can be changed.</p></div></div>
  <div class="stack">
  <div class="row" style="gap:6px">${["all", ...LAYERS.map(l => l.id)].map(id => `<button class="btn sm" data-act="libf" data-f="${id}" style="${f === id ? "background:var(--accent-soft);border-color:var(--accent);color:var(--accent)" : ""}">${id === "all" ? "All layers" : id + " " + LAYERS.find(l => l.id === id).name}</button>`).join("")}</div>
  <div class="tbl-wrap"><table><thead><tr><th>Block</th><th>Section</th><th>Layer</th><th>Source</th><th>Change by</th></tr></thead><tbody>
  ${list.map(b => `<tr><td><b>${esc(b.t)}</b><br><code class="muted">${b.id}</code></td><td>${secTitle(b.sec)}</td><td>${layerChip(b.layer)}</td><td>${esc(b.src)}</td><td class="muted">${b.edit}</td></tr>`).join("")}
  </tbody></table></div>
  <div class="panel stack"><h2>Shared-core fixes to merge</h2><p class="muted small">Fixes marked as affecting every client. A developer merges each into shared/blocks.js so new prompts inherit it.</p>
   ${core.length ? `<div class="tbl-wrap"><table><thead><tr><th>When</th><th>Block</th><th>Fix</th><th>From</th></tr></thead><tbody>${core.map(x => `<tr><td class="num muted">${fmtDate(x.createdAt)}</td><td><code>${esc(x.block || x.sec)}</code></td><td>${esc(x.note)}<div class="small muted">${esc(x.feedback || "")}</div></td><td class="muted">${esc(x.from)} v${esc(x.v)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty small">None yet.</div>`}</div>
  </div>`;
}

// ---------- Actions ----------
const item = id => (R.feedback || []).find(i => i.id === id);
async function reloadCur() { await Promise.all([loadCur(R.curId), loadPrompts(true), api("GET", "/approvals").then(r => R.approvals = r.items).catch(() => { })]); render(); }
const ACT = {
  "copy-md": () => copyText($("#mdOut").textContent),
  "dl-md": () => downloadText(fileName(L.cfg, L.genVersion || "1.0"), $("#mdOut").textContent),
  sync: el => run(el, async () => {
    const r = await api("POST", "/agents/sync");
    const bits = [];

    if (r.sarvam && !r.sarvam.ok) bits.push(`<b>Sarvam wasn't read:</b> ${esc(r.sarvam.error)}`);
    R.syncNote = bits.join(" ");
    await reloadAgents();
    toast(`${r.synced} agents${r.added ? ` (${r.added} new from Sarvam)` : ""}. ${promptMsg(r.prompts)}`);
  }, "Refreshing…"),
  "sync-note-x": () => { R.syncNote = ""; render(); },
  "pull-all": el => run(el, async () => { R.pullJob = await api("POST", "/agents/pull-all/start"); render(); pollPull(); }, "Starting…"),
  "pull-bar-x": () => { R.pullJob = null; render(); },
  "pull-all": el => run(el, async () => { const r = await api("POST", "/agents/pull-prompts"); await reloadAgents(); toast(promptMsg(r)); }, "Pulling…"),
  pull: el => run(el, async () => { const r = await api("POST", `/agents/${encodeURIComponent(el.dataset.id)}/pull`); await reloadAgents(); toast(r.changed ? `Imported as v${r.v}` : "Already up to date with Sarvam"); }, "Pulling…"),
  "sarvam-finish": el => run(el, async () => {
    const pasted = ($("#sv-paste") || {}).value || "";
    if (pasted.trim().length < 10) throw new Error("Paste the address from the page that couldn't be reached.");
    await api("POST", "/sarvam/finish-manual", { pasted });
    location.hash = "#agents"; await reloadAgents(); toast("Sarvam is connected. Click Refresh to load the agents.");
  }, "Connecting…"),
  "sarvam-import": el => run(el, async () => {
    const line = ($("#sv-line") || {}).value || "";
    if (line.trim().length < 40) throw new Error("Paste the whole line that npm run export-sarvam printed.");
    await api("POST", "/sarvam/import-token", { line });
    location.hash = "#agents"; await reloadAgents(); toast("Sarvam is connected with the login from your computer. Click Refresh to load the agents.");
  }, "Checking with Sarvam…"),
  "sarvam-clear": el => run(el, async () => { await api("DELETE", "/sarvam/token"); await reloadAgents(); toast("Sarvam disconnected"); }),


  calls: el => callsModal(R.agents.find(a => a.id === el.dataset.id)),
  import: el => importModal(R.agents.find(a => a.id === el.dataset.id)),
  "close-modal": closeModal,
  "do-import": el => run(el, async () => {
    $("#imMsg").textContent = "Regrouping the prompt into sections…";
    const r = await api("POST", `/agents/${encodeURIComponent(el.dataset.id)}/import`, { text: $("#imText").value, sarvamVersion: $("#imVer").value || null });
    closeModal(); R.curId = r.promptId; R.tab = "prompt"; toast(`Imported as v${r.v}`); if (route() === "improve") go(); else location.hash = "#improve";
  }, "Importing…"),
  "open-prompt": el => { R.curId = el.dataset.id; R.agentId = null; R.tab = "prompt"; R.editText = null; closeModal(); },
  "open-agent": el => { R.agentId = el.dataset.id; R.tab = "prompt"; R.viewSections = false; R.viewRaw = false; R.cmpOpen = null; R.editText = null; R.call = null; R.fbSel = new Set(); },
  tab: el => { R.tab = el.dataset.t; const agent = curAgent(); if (R.tab === "calls" && agent && (!R.calls || R.calls.agentId !== agent.id)) loadCalls(agent); if (R.tab === "settings" && agent && (!R.acfg || R.acfg.agentId !== agent.id)) loadCfg(agent); render(); window.scrollTo(0, 0); },
  // Calls
  "calls-load": () => { const a = curAgent(); const from = $("#c-from").value, to = $("#c-to").value; if (!from || !to || from > to) { toast("Pick a start date on or before the end date."); return; } loadCalls(a, { from, to }); },
  "calls-range": el => loadCalls(curAgent(), { from: dayStr(Date.now() - Number(el.dataset.d) * 864e5), to: dayStr(Date.now()) }),
  "calls-ver": el => { R.calls.ver = el.dataset.v; render(); },
  "calls-more": el => run(el, () => loadCalls(curAgent(), { more: true }), "Loading…"),
  "call-open": el => openCall(curAgent(), el.dataset.id),
  "call-close": () => { R.call = null; render(); },
  "call-goto": el => { R.tab = "calls"; const a = curAgent(); if (!R.calls || R.calls.agentId !== a.id) loadCalls(a); openCall(a, el.dataset.iid, el.dataset.t === "" ? null : Number(el.dataset.t)); },
  seek: el => seekCall(el.dataset.t),
  "flag-toggle": el => {
    const i = Number(el.dataset.i), K = R.call; K.sel = K.sel || {};
    if (K.sel[i]) delete K.sel[i]; else K.sel[i] = { happened: "", should: "" };
    render(); const t = document.querySelector(`[data-gt="${i}"][data-gf="happened"]`); if (t) t.focus({ preventScroll: true });
  },
  "flag-clear": () => { if (Object.values(R.call.sel || {}).some(x => x.happened || x.should) && !confirm("Clear all flagged lines and what you wrote?")) return; R.call.sel = {}; R.call.gnote = ""; render(); },
  "flag-group": el => run(el, async () => {
    const K = R.call, issues = Object.entries(K.sel || {}).map(([turn, x]) => ({ turn: Number(turn), happened: x.happened, should: x.should }));
    const r = await api("POST", `/agents/${encodeURIComponent(K.agentId)}/interactions/flag-group`, { iid: K.id, issues, note: K.gnote || "", callVersion: K.row.version, at: K.row.at });
    R.feedback = (await api("GET", `/prompts/${R.curId}/feedback`)).items;
    if (R.call && R.call.id === K.id) { K.sel = {}; K.gnote = ""; }
    render();
    toast(`${issues.length} line${issues.length === 1 ? "" : "s"} → ${r.items.length} cause${r.items.length === 1 ? "" : "s"}. ${r.summary || ""} Added to Make a change.`);
  }, "Finding why…"),
  "flag-open": el => { R.call.flagTurn = Number(el.dataset.i); R.call.flagNote = ""; render(); const t = $("#flag-note"); if (t) t.focus(); },
  "flag-cancel": () => { R.call.flagTurn = null; render(); },
  "flag-find": el => run(el, async () => {
    const K = R.call, msg = $("#flag-msg"); if (msg) msg.textContent = "Reading the prompt the agent had on this call…";
    const it = await api("POST", `/agents/${encodeURIComponent(K.agentId)}/interactions/flag`, { iid: K.id, turn: Number(el.dataset.i), note: ($("#flag-note") || {}).value || "", callVersion: K.row.version, at: K.row.at });
    R.feedback = (await api("GET", `/prompts/${R.curId}/feedback`)).items;
    if (R.call && R.call.id === K.id) R.call.flagTurn = null;
    render(); const d = document.getElementById("turn-" + el.dataset.i); if (d) d.scrollIntoView({ block: "center", behavior: "smooth" });
    toast(`Found: ${(CAUSE[it.map.cause] || "").toLowerCase()}. Added to Make a change.`);
  }, "Finding why…"),
  "open-agent-calls": el => { R.agentId = el.dataset.id; R.tab = "calls"; R.call = null; R.editText = null; go(); },
  // Fix several feedback items in one version
  "fb-selall": () => { R.fbSel = new Set((R.feedback || []).filter(i => i.status === "mapped").map(i => i.id)); render(); },
  "draft-notes": el => run(el, async () => {
    const id = el.dataset.id, own = (($("#gd-" + id) || {}).value || "").trim();
    const it = item(id);
    const ticked = it.check && !(it.draft && it.check.draftAt !== it.draft.at) ? [...chkSel(it)].map(i => it.check.suggestions[i]).filter(Boolean).map(s => ({ text: s.note, from: "check" })) : [];
    const guidance = [...ticked, ...(own ? [{ text: own }] : [])];
    if (!guidance.length && !(it.guidance || []).length) throw new Error("Write what the fix should include, tick a suggestion from the check, or use Draft fix.");
    await api("POST", `/feedback/${id}/draft`, { guidance });
    if (R.gd) delete R.gd[id];
    await reloadCur(); toast("Redrafted with your notes. Check the change below.");
  }, "Rethinking the fix…"),
  "mod-new-toggle": () => { R.modNew.open = !R.modNew.open; render(); },
  "mod-open": async el => { try { await loadMod(el.dataset.id); R.modEdit = ""; render(); window.scrollTo(0, 0); } catch (e) { toast(e.message); } },
  "mod-close": () => { R.modId = null; R.modDoc = null; R.modEdit = ""; api("GET", "/modules").then(r => { R.mods = r.items; render(); }).catch(() => render()); },
  "mod-extract": el => run(el, async () => {
    const X = R.modNew;
    if (!X.agentId || !X.moduleId.trim() || X.topic.trim().length < 15) throw new Error("Pick the agent, give an ID and describe the behaviour.");
    const m = await api("POST", "/modules/extract", { agentId: X.agentId, moduleId: X.moduleId, title: X.title, topic: X.topic });
    R.modNew = { agentId: "", topic: "", moduleId: "", title: "", open: false };
    R.mods = (await api("GET", "/modules")).items; await loadMod(m.id); render(); window.scrollTo(0, 0);
    toast(`Extracted ${m.rules.length} rules and ${m.tests.length} tests as a draft module. Nothing in any agent changed.`);
  }, "Reading the prompt (1 to 3 minutes)…"),
  "mod-delete": el => { if (!confirm("Delete this draft module? No agent uses it. This can't be undone.")) return; run(el, async () => { await api("DELETE", `/modules/${R.modId}`); R.modId = null; R.modDoc = null; R.mods = (await api("GET", "/modules")).items; render(); toast("Draft deleted"); }); },
  "mod-rule-edit": el => { R.modEdit = el.dataset.rid; render(); },
  "mod-rule-save": el => run(el, async () => {
    const r = await api("PATCH", `/modules/${R.modId}`, { rules: [{ id: el.dataset.rid, text: $("#mod-rule-text").value }] });
    R.modEdit = ""; R.mods = (await api("GET", "/modules")).items; await loadMod(r.module.id); render(); toast(r.forked ? `Saved as a new draft, v${r.module.v}. Agents using the approved version are unaffected.` : "Saved");
  }),
  "mod-approve": el => run(el, async () => { await api("POST", `/modules/${R.modId}/approve`); R.mods = (await api("GET", "/modules")).items; await loadMod(R.modId); render(); toast("Module approved. It's in the library; no agent was changed."); }),
  "mod-preview": el => run(el, async () => {
    const U = R.modUse; U.preview = null;
    const r = await api("POST", `/modules/${R.modId}/preview`, { agentId: U.agentId, options: U.options, params: U.params });
    U.preview = r; U.sel = new Set(r.edits.filter(e => e.action !== "skip" && e.ok).map(e => e.id)); render(); const p = $("#useMod"); if (p) p.scrollIntoView({ block: "end" });
  }, "Reading the agent's prompt (1 to 3 minutes)…"),
  "mod-apply": el => run(el, async () => {
    const U = R.modUse, P = U.preview, picked = P.edits.filter(e => U.sel.has(e.id));
    const r = await api("POST", `/modules/${R.modId}/apply`, { agentId: U.agentId, edits: picked, options: U.options, params: U.params });
    U.preview = null; await loadPrompts(true); render();
    toast(`${r.updated ? "Added to" : "Saved as"} draft v${r.v} on ${r.agent} (${fmtN(r.charsBefore)} → ${fmtN(r.charsAfter)} characters). Open the agent to review and send it for approval. No other agent changed.`);
  }, "Saving the draft…"),
  "mod-tests": el => run(el, async () => { const U = R.modUse; await api("POST", `/modules/${R.modId}/tests/run`, { agentId: U.agentId }); await loadMod(R.modId); render(); }, "Running tests (about a minute)…"),
  "tests-build": el => run(el, async () => { const r = await api("POST", `/prompts/${R.curId}/tests/build`); await reloadCur(); toast(`${r.added} test${r.added === 1 ? "" : "s"} made. Run them on the draft before pushing.`); }, "Writing tests…"),
  "tests-run": el => run(el, async () => { const r = await api("POST", `/prompts/${R.curId}/tests/run`, { versionId: el.dataset.vid }); await reloadCur(); toast(`v${r.v}: ${r.passed} passed, ${r.failed} failed${r.errors ? `, ${r.errors} couldn't run` : ""}.`); }, "Running tests (about a minute)…"),
  "test-del": el => { if (!confirm("Delete this test?")) return; run(el, async () => { await api("DELETE", `/tests/${el.dataset.id}`); await reloadCur(); }); },
  "restore-fix": el => run(el, async () => {
    const r = await api("POST", `/prompts/${R.curId}/restore-fix`, { versionId: el.dataset.vid });
    await reloadCur(); await loadLost(); window.scrollTo(0, 0);
    toast(savedMsg(r, `the restored fix (${r.moved} change${r.moved === 1 ? "" : "s"})`));
  }, "Restoring…"),
  rebase: el => run(el, async () => {
    const r = await api("POST", `/versions/${el.dataset.vid}/rebase`);
    closeModal(); await go();
    toast(`Rebuilt v${r.v} on Sarvam v${r.newest}: ${r.moved} change${r.moved === 1 ? "" : "s"} moved over, newer fixes kept.${r.reapprove ? " It needs approval again." : ""}`);
  }, "Rebuilding…"),
  "kb-build": el => run(el, kbBuild, "Reading…"),
  "kb-file-del": el => { kbImp().files.splice(+el.dataset.i, 1); render(); },
  "kb-files-clear": () => { R.kbImp = null; render(); },
  "kb-discard": () => { kbImp().draft = null; render(); },
  "kbd-all": el => { const D = kbImp().draft; if (!D) return; [...D.facts, ...D.faqs].forEach(x => x.on = el.dataset.on === "1"); render(); },
  "kb-paste-add": () => { const I = kbImp(), t = (I.paste || "").trim(); if (t.length < 20) return toast("Paste some text first."); I.files.push({ name: `Pasted text ${I.files.filter(f => /^Pasted text/.test(f.name)).length + 1}`, size: t.length, text: t, facts: [], faqs: [], status: "ready" }); I.paste = ""; render(); },
  "kb-accept": () => { const I = kbImp(), D = I.draft, kb = L.cfg.kb; if (!D) return;
    // Inside New prompt: the ticked facts and FAQs become rules of the prompt's facts section.
    if (R.kbTarget && L.np && route() === "create") { const np = L.np, sec = R.kbTarget.sec; let n = 0;
      D.facts.filter(x => x.on).forEach(f => { if (npAdd(np, sec, { text: `${f.k}: ${f.v}`, from: { agent: f.src || "documents" } })) n++; });
      D.faqs.filter(x => x.on).forEach(f => { if (npAdd(np, sec, { text: `Q: ${f.q}\nA: ${f.a}`, from: { agent: f.src || "documents" } })) n++; });
      I.draft = null; R.npKb = null; R.kbTarget = null; commit(); toast(`Added ${n} facts and FAQs to the prompt.`); return; }
    const f = D.facts.filter(x => x.on).map(({ k, v, src, kind }) => ({ k, v, src, kind })), q = D.faqs.filter(x => x.on).map(({ q, a, src }) => ({ q, a, src }));
    kb.facts.push(...f); kb.faqs.push(...q); if (D.useOos && D.oos) kb.oos = D.oos;
    I.draft = null; commit(); toast(`Added ${f.length} facts and ${q.length} FAQs to the knowledge base.`); },
  "in-mode": el => { R.inMode = el.dataset.m; render(); },
  jump: el => { const t = document.getElementById(el.dataset.to); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); },
  "cv-jump": el => { const t = document.getElementById(el.dataset.to); if (t) { t.scrollIntoView({ behavior: "smooth", block: "center" }); t.parentElement.classList.add("cv-flash"); setTimeout(() => t.parentElement.classList.remove("cv-flash"), 1600); } },
  "diff-mode": el => { R.diffMode = el.dataset.m; try { localStorage.setItem("pb-diff-mode", R.diffMode); } catch (_) { } render(); },
  "hunk-edit": el => { R.hunkEdit = el.dataset.k; render(); const t = $("#hunk-text"); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } },
  "hunk-cancel": () => { R.hunkEdit = null; render(); },
  "hunk-undo": el => hunkChange(el, false),
  "hunk-save": el => hunkChange(el, true),
  "opt-open": () => { R.opt = { promptId: R.cur.prompt.id, focus: "" }; render(); const p = $("#optPanel"); if (p) p.scrollIntoView({ block: "start" }); },
  "opt-close": () => { R.opt = null; render(); },
  "opt-run": async () => {
    const O = R.opt, latest = latestOf(R.cur);
    Object.assign(O, { loading: true, error: null, result: null }); render();
    try { const r = await api("POST", `/prompts/${R.curId}/optimize`, { focus: O.focus }); O.result = r; O.rev = latest.rev || 0; O.sel = new Set(r.edits.filter(e => !e.changesBehaviour).map(e => e.id)); }
    catch (e) { O.error = e.message; }
    O.loading = false; if (R.opt === O) render();
  },
  "opt-apply": el => run(el, async () => {
    const O = R.opt, picked = O.result.edits.filter(e => O.sel.has(e.id));
    const r = await api("POST", `/prompts/${R.curId}/optimize/apply`, { versionId: O.result.versionId, rev: O.rev, edits: picked });
    R.opt = null; await reloadCur(); window.scrollTo(0, 0); toast(savedMsg(r, `${picked.length} optimization${picked.length === 1 ? "" : "s"}`));
  }, "Saving…"),
  "tx-analyze": el => run(el, async () => {
    const T = R.tx;
    if ((T.text || "").trim().length < 80) throw new Error("Paste or upload the whole call transcript first.");
    const r = await api("POST", `/prompts/${R.curId}/transcript/analyze`, { transcript: T.text, note: T.note, versionId: T.versionId || undefined });
    T.result = r; T.sel = new Set(r.mistakes.map((_, i) => i));
    render(); const p = $("#txPanel"); if (p) p.scrollIntoView({ block: "start", behavior: "smooth" });
  }, "Reading the call (about a minute)…"),
  "tx-add": el => run(el, async () => {
    const T = R.tx, picked = [...T.sel].sort((a, b) => a - b).map(i => T.result.mistakes[i]);
    const r = await api("POST", `/prompts/${R.curId}/transcript/add`, { mistakes: picked, label: T.label, versionV: T.result.versionV, provider: T.result.provider });
    R.tx = { promptId: T.promptId, text: "", label: "", note: "", versionId: T.versionId };
    await reloadCur(); toast(`${r.added} mistake${r.added === 1 ? "" : "s"} added to feedback. Draft and check them under Fix each item.`);
  }, "Adding…"),
  "tx-clear": () => { R.tx.result = null; render(); },
  "fb-del": el => {
    const it = item(el.dataset.id); if (!it) return;
    const extra = it.status === "applied" ? `\n\nIts fix stays in v${it.appliedIn}; only this feedback record and its notes are removed.` : "";
    if (!confirm(`Delete this feedback for good? This can't be undone.\n\n“${it.text.slice(0, 160)}${it.text.length > 160 ? "…" : ""}”${extra}`)) return;
    run(el, async () => { await api("DELETE", `/feedback/${it.id}`); if (R.fbSel) R.fbSel.delete(it.id); await reloadCur(); toast("Feedback deleted"); });
  },
  "fix-check": el => run(el, async () => { await api("POST", `/feedback/${el.dataset.id}/check`); await reloadCur(); const c = item(el.dataset.id).check; toast(c.verdict === "ready" ? "The check found no real problems." : `The check found ${c.suggestions.length} thing${c.suggestions.length === 1 ? "" : "s"} to improve. Tick what you agree with, add notes, then redraft.`); }, "Checking the fix…"),
  "gd-del": el => run(el, async () => { await api("PATCH", `/feedback/${el.dataset.id}`, { removeGuidance: Number(el.dataset.i) }); await reloadCur(); }),
  "fb-group": el => { R.fbGroup = el.dataset.g; R.fbOpen = null; render(); },
  "fb-selnone": () => { R.fbSel = new Set(); render(); },
  "fb-batch": el => run(el, async () => {
    const ids = [...R.fbSel];
    const r = await api("POST", `/prompts/${R.curId}/feedback/apply-batch`, { ids });
    R.fbSel = new Set(); await reloadCur(); window.scrollTo(0, 0);
    toast(`${savedMsg(r, `${r.applied} fix${r.applied === 1 ? "" : "es"}`)}${r.failed.length ? ` ${r.failed.length} couldn't be drafted: ${r.failed[0].error}` : ""}`);
  }, "Drafting fixes…"),
  // Settings
  "cfg-var-add": () => { R.acfg.edit.vars.push({ name: "", description: "", type: "string", value: "", afterCall: false, postPrompt: "", isNew: true, orig: {} }); render(); },
  "cfg-var-del": el => { R.acfg.edit.vars.splice(Number(el.dataset.i), 1); render(); },
  "cfg-reset": () => { R.acfg.edit = cfgEditFrom(R.acfg.data); render(); },
  "cfg-save": el => run(el, async () => {
    const body = cfgChanges();
    if (!Object.keys(body).length) { toast("Nothing changed."); return; }
    body.note = R.acfg.edit.note;
    const r = await api("POST", `/prompts/${R.curId}/settings`, body);
    R.acfg.edit = cfgEditFrom(R.acfg.data); await reloadCur(); window.scrollTo(0, 0);
    toast(`Sarvam accepted it. Saved as draft v${r.v}: ${r.summary.join("; ")}`);
  }, "Checking with Sarvam…"),
  // New agent, UAT agent
  "clone-modal": el => cloneModal(el.dataset.id),
  "clone-do": el => run(el, async () => {
    const name = $("#cl-name").value.trim();
    if (name.length < 3) throw new Error("Give the new agent a name.");
    const from = $("#cl-from").value, uatFor = el.dataset.uat;
    if (!confirm(`Create "${name}" in Sarvam as a copy of ${((R.agents || []).find(a => a.id === from) || {}).name}?`)) return;
    $("#cl-msg").textContent = "Sarvam is copying the agent and bringing in its prompt…";
    const r = await api("POST", "/agents/clone", { from, name, version: $("#cl-ver").value || null, client: $("#cl-client").value, greeting: ($("#cl-greet") || {}).value || "" });
    if (uatFor) await api("PATCH", `/agents/${encodeURIComponent(uatFor)}`, { uatAgentId: r.agentId });
    closeModal(); await loadAgents(true); await loadPrompts(true);
    R.agentId = uatFor || r.agentId; R.tab = "prompt"; R.call = null;
    if (route() === "improve") go(); else location.hash = "#improve";
    toast(uatFor ? `Created ${r.name} and set it as the UAT agent.` : `Created ${r.name} in Sarvam.${r.pulled ? "" : " Its prompt couldn't be loaded yet: use Reload prompt from Sarvam."}`);
  }, "Creating…"),
  "uat-modal": el => uatModal(el.dataset.id),
  "uat-create": el => cloneModal(el.dataset.id, { uatFor: el.dataset.id }),
  "uat-save": el => run(el, async () => { await api("PATCH", `/agents/${encodeURIComponent(el.dataset.id)}`, { uatAgentId: $("#uat-pick").value || null }); closeModal(); await loadAgents(true); render(); toast("Saved"); }),
  // Compare summary
  "cmp-sum": el => {
    const [ia, ib] = R.cmpPick || [], A = R.cmpData[ia], B = R.cmpData[ib];
    const side = x => ({ name: x.agent.name, client: x.agent.client, greeting: x.greeting, text: x.text, languages: x.meta && x.meta.languages ? `starts in ${x.meta.languages.initial}; speaks ${x.meta.languages.supported.join(", ")}` : "" });
    R.cmpSum = { key: `${ia}|${ib}`, loading: true }; render();
    api("POST", "/ai/compare", { a: side(A), b: side(B) }).then(r => { R.cmpSum = { key: `${ia}|${ib}`, ...r }; }).catch(e => { R.cmpSum = { key: `${ia}|${ib}`, error: e.message }; }).then(() => { if (route() === "compare") render(); });
  },
  "view-mode": el => { R.viewRaw = el.dataset.m === "raw"; R.viewSections = el.dataset.m === "sections"; render(); },
  "edit-text": () => startEdit(),
  "open-edit": el => { R.curId = el.dataset.id; R.agentId = null; R.tab = "prompt"; R.pendingEdit = true; },
  "cancel-text": () => { const e = R.editText; if (e && (e.text !== e.orig || e.greeting !== e.og) && !confirm("Discard your edits?")) return; R.editText = null; render(); },
  "save-text": el => run(el, async () => {
    const body = { text: $("#ed-text").value, note: $("#ed-note").value };
    if ($("#ed-greeting")) body.greeting = $("#ed-greeting").value;
    const r = await api("POST", `/prompts/${R.curId}/edit`, body);
    R.editText = null; await reloadCur(); window.scrollTo(0, 0); toast(savedMsg(r, "your edit"));
  }, "Saving…"),
  "link-push": el => {
    const agentId = ($("#link-" + el.dataset.vid) || {}).value;
    if (!agentId) { toast("Pick the Sarvam agent first."); return; }
    const a = (R.agents || []).find(x => x.id === agentId);
    if (!confirm(`Link this prompt to ${a ? a.name : "that agent"}? Pushing replaces that agent's prompt in Sarvam (you see a preview first).`)) return;
    run(el, async () => { await api("PATCH", `/prompts/${el.dataset.pid}`, { agentId }); await loadPrompts(true); if (route() === "improve") await loadCur(R.curId); render(); pushModal(el.dataset.vid); });
  },
  "copy-prompt": () => copyText(R.sv && R.sv.text ? R.sv.text : mdOf(R.cur.prompt.cfg, latestOf(R.cur), false)),
  "dl-prompt": () => { const v = latestOf(R.cur); downloadText(fileName(R.cur.prompt.cfg, v.v), R.sv && R.sv.text ? R.sv.text : mdOf(R.cur.prompt.cfg, v, false)); },
  "sample-fb": () => { L.fbRaw = SAMPLE_FEEDBACK; saveLocal(); render(); toast("Sample loaded. Now add it as items."); },
  split: el => run(el, async () => {
    const raw = ($("#f-raw") || {}).value || ""; const items = splitFeedback(raw);
    if (!items.length) throw new Error("No feedback found. Paste some text first.");
    await api("POST", `/prompts/${R.curId}/feedback`, { items, source: $("#f-src").value });
    L.fbRaw = ""; saveLocal(); await reloadCur(); toast(`${items.length} feedback items added`);
  }),
  "map-all": el => run(el, async () => {
    const r = await api("POST", `/prompts/${R.curId}/feedback/map`);
    await reloadCur(); toast(r.via === "ai" ? `Mapped ${r.mapped} items with ${r.provider}` : `Mapped ${r.mapped} items with keyword rules${r.fallbackReason && r.fallbackReason !== "no_llm" ? " (the AI request failed)" : ""}`);
  }, "Mapping…"),
  draft: el => run(el, async () => { await api("POST", `/feedback/${el.dataset.id}/draft`); await reloadCur(); }, "Drafting…"),
  edit: el => { R.editing[el.dataset.id] = true; render(); },
  "cancel-edit": el => { delete R.editing[el.dataset.id]; render(); },
  apply: el => run(el, async () => { const r = await api("POST", `/feedback/${el.dataset.id}/apply`, {}); await reloadCur(); toast(savedMsg(r)); }, "Applying…"),
  "apply-edit": el => run(el, async () => { const id = el.dataset.id; const r = await api("POST", `/feedback/${id}/apply`, { text: $("#ed-" + id).value }); delete R.editing[id]; await reloadCur(); toast(savedMsg(r)); }, "Applying…"),
  dismiss: el => run(el, async () => { await api("PATCH", `/feedback/${el.dataset.id}`, { status: "dismissed" }); await reloadCur(); }),
  undismiss: el => run(el, async () => { const it = item(el.dataset.id); await api("PATCH", `/feedback/${el.dataset.id}`, { status: it.map ? "mapped" : "new" }); await reloadCur(); }),
  cmp: el => { const i = +el.dataset.i; R.cmpOpen = R.cmpOpen === i ? null : i; render(); },
  submit: el => run(el, async () => { await api("POST", `/versions/${el.dataset.vid}/submit`); await reloadCur(); toast("Sent for approval"); }),
  rollback: el => run(el, async () => { const r = await api("POST", `/versions/${el.dataset.vid}/rollback`); await reloadCur(); toast(r.recommitted ? `Rolled back. The prompt of Sarvam v${r.from} is committed again as Sarvam v${r.sarvamVersion}.` : "Rolled back."); }, "Rolling back…"),
  approve: el => run(el, async () => { await api("POST", `/versions/${el.dataset.vid}/approve`, { note: ($("#note-" + el.dataset.vid) || {}).value }); await go(); toast("Approved"); }),
  reject: el => run(el, async () => { await api("POST", `/versions/${el.dataset.vid}/reject`, { note: ($("#note-" + el.dataset.vid) || {}).value }); await go(); toast("Rejected and sent back to the author"); }),
  "see-diff": el => run(el, () => showDiffModal(el.dataset.pid, el.dataset.vid)),
  "copy-ver": el => run(el, async () => { const cur = await api("GET", "/prompts/" + el.dataset.pid); const v = cur.versions.find(x => x.id === el.dataset.vid); await copyText(mdOf(cur.prompt.cfg, v, false)); }),
  "push-preview": el => pushModal(el.dataset.vid, el.dataset.allow === "1", el.dataset.target),
  "push-do": el => run(el, async () => {
    if (el.dataset.target === "uat") {
      const u = await api("POST", `/versions/${el.dataset.vid}/push`, { allowDraftChanges: el.dataset.allow === "1", target: "uat" });
      closeModal(); await go(); toast(`${u.uatName} now runs this version (Sarvam v${u.sarvamVersion}). Test it, then promote it.`); return;
    }
    const r = await api("POST", `/versions/${el.dataset.vid}/push`, { allowDraftChanges: el.dataset.allow === "1" });
    closeModal(); await go();
    toast(`Live as Sarvam v${r.sarvamVersion} (${r.edits} passage${r.edits === 1 ? "" : "s"} changed)`);
  }, "Pushing…"),
  "go-live": el => run(el, async () => {
    const vid = el.dataset.vid;
    let r;
    try { r = await api("POST", `/versions/${vid}/go-live`, { sarvamVersion: $("#sv-" + vid).value || null }); }
    catch (e) { if (e.code === "same_version") { toast(e.message); return; } throw e; }
    await go(); toast(`Live as Sarvam v${r.sarvamVersion}`);
  }, "Checking Sarvam…"),
  "cmp-area": el => { const s = new Set(R.cmpAreas || CMP_AREAS.map(x => x.id)); s.has(el.dataset.id) ? s.delete(el.dataset.id) : s.add(el.dataset.id); R.cmpAreas = CMP_AREAS.map(x => x.id).filter(x => s.has(x)); render(); },
  "cmp-all": () => { R.cmpAreas = CMP_AREAS.map(x => x.id); render(); },
  "cmp-none": () => { R.cmpAreas = []; render(); },
  libf: el => { L.libFilter = el.dataset.f; saveLocal(); render(); }
};
document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]"); if (!el || el.disabled) return;
  const f = ACT[el.dataset.act]; if (!f) return;
  if (el.tagName !== "A" || el.getAttribute("href") === "#") e.preventDefault();
  const menu = el.closest("details.more"); if (menu) menu.open = false;
  f(el);
});
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
// Remember which feedback-history group is open, so it stays open when the page redraws.
document.addEventListener("toggle", e => { const d = e.target; if (d.matches && d.matches("details[data-in-box]")) { R.inOpen = d.open; return; } if (d.matches && d.matches("details[data-fbm]")) { R.fbMore = R.fbMore || new Set(); d.open ? R.fbMore.add(d.dataset.fbm) : R.fbMore.delete(d.dataset.fbm); return; } if (d.matches && d.matches("details[data-g]")) { if (d.open) R.fbOpen = d.dataset.g; else if (R.fbOpen === d.dataset.g) R.fbOpen = null; } }, true);
document.addEventListener("click", e => $$("details.more[open]").forEach(d => { if (!d.contains(e.target)) d.open = false; }));
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });

document.addEventListener("input", e => {
  const el = e.target;
  if (el.dataset.bind && el.type !== "checkbox" && el.tagName !== "SELECT") { let v = el.value; if (el.type === "number") v = Number(v) || 0; setPath(L.cfg, el.dataset.bind, v); R.aiReview = null; commit(false); return; }
  if (el.dataset.kb) { setPath(L.cfg.kb, el.dataset.kb, el.value); saveLocal(); refreshInsights(); return; }
  if (el.dataset.tocJump != null) { const t = document.getElementById(el.value); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); el.value = ""; return; }
  if (el.dataset.agQ != null) { R.agQ = el.value; render(); const q = $("#ag-q"); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } return; }
  const a = el.dataset.actInput;
  if (a === "channels") { L.cfg.policy.channels = el.value.split(",").map(s => s.trim()).filter(Boolean); commit(false); }
  if (a === "ver") { L.genVersion = el.value.trim() || "1.0"; saveLocal(); const o = $("#mdOut"); if (o) o.textContent = toMarkdown(header(L.cfg, L.genVersion), L.cfg.order, sectionsFrom(L.cfg), L.genTags !== false); }
  if (a === "raw") { L.fbRaw = el.value; saveLocal(); }
  if (a === "kb-paste") { kbImp().paste = el.value; return; }
  if (el.id === "flag-note" && R.call) R.call.flagNote = el.value;
  if (el.dataset.gt != null && R.call && R.call.sel && R.call.sel[el.dataset.gt]) R.call.sel[el.dataset.gt][el.dataset.gf] = el.value;
  if (el.dataset.gnote && R.call) R.call.gnote = el.value;
  if (el.dataset.tx && R.tx && el.tagName !== "SELECT") R.tx[el.dataset.tx] = el.value;
  if (el.dataset.opt && R.opt) R.opt[el.dataset.opt] = el.value;
  if (el.dataset.modnew && R.modNew) R.modNew[el.dataset.modnew] = el.value;
  if (el.dataset.modparam && R.modUse) { R.modUse.params[el.dataset.modparam] = el.value; R.modUse.preview = null; }
  if (el.dataset.gd) { R.gd = R.gd || {}; R.gd[el.dataset.gd] = el.value; } // notes survive a redraw while typing
  if (el.dataset.cfg && R.acfg && R.acfg.edit && el.type !== "checkbox" && el.tagName !== "SELECT") setPath(R.acfg.edit, el.dataset.cfg, el.value);
  if (R.editText && el.id === "ed-text") { R.editText.text = el.value; const c = $("#ed-count"); if (c) c.innerHTML = edCount(R.editText); }
  if (R.editText && el.id === "ed-greeting") R.editText.greeting = el.value;
});
document.addEventListener("change", e => {
  const el = e.target;
  if (el.dataset.bind && (el.type === "checkbox" || el.tagName === "SELECT")) { setPath(L.cfg, el.dataset.bind, el.type === "checkbox" ? el.checked : el.value); R.aiReview = null; commit(); return; }
  if (el.dataset.bind) return;
  const c = el.dataset.actCheck;
  if (c === "kbd-on") { const D = kbImp().draft; if (D) { D[el.dataset.kind][+el.dataset.i].on = el.checked; render(); } return; }
  if (c === "kbd-oos") { const D = kbImp().draft; if (D) D.useOos = el.checked; return; }
  if (c === "tags") { L.showTags = el.checked; commit(); }
  if (c === "gtags") { L.genTags = el.checked; commit(); }
  if (c === "blk") { const id = el.dataset.id, o = L.cfg.off; el.checked ? o.splice(o.indexOf(id), 1) : o.push(id); commit(); }
  if (c === "cmp-diff") { R.cmpOnlyDiff = el.checked; render(); }
  if (c === "calls-hidetest") { R.calls.hideTest = el.checked; render(); }
  if (c === "cv-full") { R.cvFull = el.checked; render(); }
  if (c === "mod-opt") { R.modUse.options[el.dataset.id] = el.checked; R.modUse.preview = null; render(); }
  if (c === "mod-sel") { const i = Number(el.dataset.i); el.checked ? R.modUse.sel.add(i) : R.modUse.sel.delete(i); render(); }
  if (el.dataset.moduse === "agentId" && R.modUse) { R.modUse.agentId = el.value; R.modUse.preview = null; const a = (R.agents || []).find(x => x.id === el.value); const m = R.modDoc && R.modDoc.module; if (a && m) (m.params || []).forEach(p => { if (!R.modUse.params[p.name] && /client/.test(p.name)) R.modUse.params[p.name] = a.client || a.name; }); render(); }
  if (el.dataset.modnew && el.tagName === "SELECT" && R.modNew) R.modNew[el.dataset.modnew] = el.value;
  if (c === "opt-sel") { const i = Number(el.dataset.i); el.checked ? R.opt.sel.add(i) : R.opt.sel.delete(i); render(); }
  if (c === "tx-sel") { const i = Number(el.dataset.i); el.checked ? R.tx.sel.add(i) : R.tx.sel.delete(i); render(); }
  if (el.dataset.tx === "versionId" && R.tx) R.tx.versionId = el.value;
  if (el.id === "txFile" && el.files[0]) readTranscript(el.files[0]);
  if (c === "chk") { const it = item(el.dataset.id), s = chkSel(it), i = Number(el.dataset.i); el.checked ? s.add(i) : s.delete(i); render(); }
  if (el.dataset.actChange === "scope") { api("PATCH", `/feedback/${el.dataset.id}`, { scope: el.value }).then(reloadCur).then(() => toast(el.value === "shared" ? "This fix is now for every agent: it's logged as a shared fix when applied." : "This fix is for this agent only.")).catch(err => toast(err.message)); }
  if (c === "fbsel") { R.fbSel = R.fbSel || new Set(); el.checked ? R.fbSel.add(el.dataset.id) : R.fbSel.delete(el.dataset.id); render(); }
  if (el.dataset.cfg && R.acfg && R.acfg.edit && (el.type === "checkbox" || el.tagName === "SELECT")) { setPath(R.acfg.edit, el.dataset.cfg, el.type === "checkbox" ? el.checked : el.value); render(); }
  if (el.dataset.cfgLang && R.acfg && R.acfg.edit) {
    const e = R.acfg.edit, l = el.dataset.cfgLang;
    e.supported = el.checked ? [...e.supported, l] : e.supported.filter(x => x !== l);
    if (!e.supported.includes(e.initial)) e.initial = e.supported[0] || "";
    render();
  }
  if (c === "promote") api("PATCH", `/feedback/${el.dataset.id}`, { promote: el.checked }).catch(err => toast(err.message));
  const a = el.dataset.actChange;
  if (a === "prompt") { R.cmpOpen = null; R.viewPrompt = false; loadCur(el.value).then(render).catch(err => toast(err.message)); }
  if (a === "link") { L.linkAgent = el.value; saveLocal(); }
  if (a === "cmp-pick") { R.cmpPick = [$("#cmp-a").value, $("#cmp-b").value]; render(); cmpLoad(); }
  if (a === "resec") api("PATCH", `/feedback/${el.dataset.id}`, { section: el.value }).then(reloadCur).catch(err => toast(err.message));
  if (el.id === "f-src") { L.fbSource = el.value; saveLocal(); }
  if ((el.id === "kbFiles" || el.id === "kbFolder") && el.files.length) { const list = [...el.files].map(f => ({ file: f, path: f.webkitRelativePath || f.name })); el.value = ""; kbAddFiles(list); }
  if (el.id === "fbFile" && el.files[0]) readFb(el.files[0]);
  if (el.id === "imFile" && el.files[0]) fileToText(el.files[0]).then(t => { $("#imText").value = t; }).catch(err => toast(err.message));
});
async function readFb(file) {
  const msg = $("#fbFileMsg"); if (msg) msg.textContent = "Reading " + file.name + "…";
  try {
    const items = await readFeedbackFile(file);
    if (!items.length) { msg.textContent = "No feedback rows found in " + file.name; return; }
    await api("POST", `/prompts/${R.curId}/feedback`, { items, source: ($("#f-src") || {}).value || "Client UAT" });
    await reloadCur(); toast(`${items.length} feedback items added from ${file.name}`);
  } catch (e) { if (msg) msg.textContent = e.message; }
}
document.addEventListener("dragover", e => { const z = e.target.closest && e.target.closest(".dropzone"); if (z) { e.preventDefault(); z.classList.add("over"); } });
document.addEventListener("dragleave", e => { const z = e.target.closest && e.target.closest(".dropzone"); if (z) z.classList.remove("over"); });
document.addEventListener("drop", e => { const z = e.target.closest && e.target.closest(".dropzone"); if (!z) return; e.preventDefault(); z.classList.remove("over"); if (z.id === "kbDrop") { filesFromDrop(e.dataTransfer).then(kbAddFiles); return; } const f = e.dataTransfer.files[0]; if (!f) return; z.id === "txDrop" ? readTranscript(f) : readFb(f); });
async function readTranscript(file) {
  const msg = $("#txFileMsg"); if (msg) msg.textContent = "Reading " + file.name + "…";
  try {
    if (!/\.(txt|md|docx|csv|json|srt|vtt)$/i.test(file.name)) throw new Error("Use a .txt, .docx or .md file.");
    const t = (await fileToText(file)).trim();
    if (t.length < 80) throw new Error(`${file.name} looks empty.`);
    Object.assign(R.tx, { text: t, file: file.name, label: R.tx.label || file.name.replace(/\.[^.]+$/, ""), result: null });
    render();
  } catch (e) { if (msg) msg.textContent = e.message; }
}
let dragSec = null;
document.addEventListener("dragstart", e => { const s = e.target.closest && e.target.closest(".sec"); if (!s) return; dragSec = s.dataset.sec; s.classList.add("drag"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", dragSec); } catch (_) { } });
document.addEventListener("dragend", () => { $$(".sec").forEach(x => x.classList.remove("drag", "over")); dragSec = null; });
document.addEventListener("dragover", e => { const s = e.target.closest && e.target.closest(".sec"); if (!s || !dragSec) return; e.preventDefault(); $$(".sec").forEach(x => x.classList.toggle("over", x === s)); });
document.addEventListener("drop", e => { const s = e.target.closest && e.target.closest(".sec"); if (!s || !dragSec) return; e.preventDefault(); const o = L.cfg.order; const from = o.indexOf(dragSec), to = o.indexOf(s.dataset.sec); o.splice(from, 1); o.splice(to, 0, dragSec); dragSec = null; commit(); });

// ---------- Boot ----------
async function boot() {
  $("#login").hidden = true; $("#shell").hidden = false;
  $("#who").innerHTML = `<b>${esc(R.me.name)}</b><small>${esc(R.me.role)}</small>`;
  try { R.health = await api("GET", "/health"); } catch (e) { R.health = null; }
  const on = aiOn();
  $("#aiState").innerHTML = `<span class="dot ${on ? "on" : "off"}"></span><span>${on ? "AI ready" : "AI off"}</span>`;
  $("#aiState").title = on ? `AI model: ${R.health.llm.join(" → ")}` : "No AI model configured: feedback is mapped by keyword rules and drafting is off.";
  api("GET", "/approvals").then(r => { R.approvals = r.items; updateBadge(); }).catch(() => { });
  go();
}
loadLocal();
api("GET", "/me").then(r => { R.me = r.user; R.selfApprove = r.selfApprove !== false; boot(); }).catch(() => showLogin());
