// Backups that don't need a database.
// 1. Browser copy: every prompt opened or saved is kept in this browser (latest version, greeting, text).
//    If the server loses it (a Render restart or deploy wipes its file store), the Agents page offers it back.
// 2. A .md file: every "Save as draft" downloads the prompt as "<name> v<version>.md". Restore takes that file back.
// 3. Unsaved Edit text is kept in this browser while typing, and comes back after a refresh.
const BK_KEY = "pb.backup.v1", BK_EDIT = "pb.edit.";
const bkRead = () => { try { const d = JSON.parse(localStorage.getItem(BK_KEY)); return d && d.prompts ? d : { prompts: {} }; } catch (_) { return { prompts: {} }; } };
function bkWrite(d) {
  // Full storage: drop the oldest copies until it fits.
  for (let i = 0; i < 50; i++) {
    try { localStorage.setItem(BK_KEY, JSON.stringify(d)); return true; }
    catch (_) { const ids = Object.keys(d.prompts).sort((a, b) => String(d.prompts[a].savedAt).localeCompare(String(d.prompts[b].savedAt))); if (ids.length <= 1) return false; delete d.prompts[ids[0]]; }
  }
  return false;
}
// The prompt as it reads now: the same text the editor shows.
function bkEntry(cur, sv) {
  const p = cur.prompt, v = latestOf(cur);
  return { id: p.id, name: p.name || "Untitled", agentType: p.agentType || "collections", agentId: p.agentId || null, info: p.info || null,
    v: v.v, status: v.status, greeting: (sv && (sv.greeting || (sv.meta && sv.meta.greeting))) || v.greeting || "",
    text: sv && sv.text ? sv.text : mdOf(p.cfg, v, false), savedAt: new Date().toISOString() };
}
function bkSnapshot(cur, sv) { try { if (!cur || !cur.prompt || !cur.versions || !cur.versions.length) return null; const e = bkEntry(cur, sv), d = bkRead(); d.prompts[e.id] = e; bkWrite(d); return e; } catch (_) { return null; } }

// ---------- the .md file ----------
const bkFile = e => `${String(e.name).replace(/[\\/:*?"<>|]+/g, "-").trim() || "prompt"} v${e.v}.md`;
function bkMarkdown(e) {
  const meta = { "prompt-builder": 1, id: e.id, name: e.name, agentType: e.agentType, agentId: e.agentId || "", version: e.v, status: e.status, savedAt: e.savedAt, info: JSON.stringify(e.info || {}) };
  return `---\n${Object.entries(meta).map(([k, v]) => `${k}: ${String(v).replace(/\n/g, " ")}`).join("\n")}\n---\n\n# Greeting\n\n${e.greeting || ""}\n\n# Instructions\n\n${e.text}\n`;
}
function bkDownload(e) {
  const url = URL.createObjectURL(new Blob([bkMarkdown(e)], { type: "text/markdown" }));
  const a = document.createElement("a"); a.href = url; a.download = bkFile(e); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function bkParse(md) {
  const m = String(md).replace(/\r/g, "").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("This file isn't a Prompt Builder backup (no header). Use a .md file the builder downloaded.");
  const meta = Object.fromEntries(m[1].split("\n").map(l => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  if (!meta["prompt-builder"]) throw new Error("This file isn't a Prompt Builder backup.");
  const body = m[2], gi = body.indexOf("# Greeting\n"), ii = body.indexOf("\n# Instructions\n");
  if (ii < 0) throw new Error("The backup has no Instructions part.");
  let info = null; try { info = JSON.parse(meta.info || "null"); } catch (_) { }
  return { id: meta.id || null, name: meta.name || "Restored prompt", agentType: meta.agentType || "collections", agentId: meta.agentId || null, info, v: meta.version || "1.0",
    status: meta.status || "draft", savedAt: meta.savedAt || "", greeting: gi >= 0 ? body.slice(gi + 11, ii).trim() : "", text: body.slice(ii + 16).trim() };
}

// After a save: read back what the server stored, keep it in the browser, and download it as .md.
async function bkAfterSave(promptId) {
  try {
    const p = await api("GET", "/prompts/" + promptId), v = latestOf(p);
    const sv = await api("GET", `/versions/${v.id}/sarvam-text`).catch(() => null);
    const e = bkSnapshot(p, sv); if (e) bkDownload(e);
  } catch (err) { toast(`Saved, but the .md backup couldn't be made: ${err.message}`); }
}

// ---------- restore ----------
const bkMissing = () => { const have = new Set((R.prompts || []).map(p => p.id)); return Object.values(bkRead().prompts).filter(e => !have.has(e.id)); };
async function bkRestore(e) { const r = await api("POST", "/prompts/restore", e); const d = bkRead(); if (e.id && e.id !== r.promptId) delete d.prompts[e.id]; d.prompts[r.promptId] = { ...e, id: r.promptId, status: "draft" }; bkWrite(d); return r; }
function bkBanner() {
  if (!canDo("edit")) return "";
  const miss = bkMissing();
  const pick = `<label class="small" style="color:var(--accent);cursor:pointer;text-decoration:underline">Restore from a .md backup<input type="file" id="bk-file" accept=".md,text/markdown" hidden></label>`;
  if (!miss.length) return `<div class="row" style="justify-content:flex-end;margin:-6px 0 6px">${pick}</div>`;
  return `<div class="notice" style="flex-wrap:wrap;gap:8px"><span style="flex:1;min-width:240px"><b>${miss.length} prompt${miss.length === 1 ? " is" : "s are"} saved in this browser but missing on the server</b> (the server may have restarted): ${miss.map(e => `${esc(e.name)} v${esc(e.v)}`).join(", ")}. Restoring brings ${miss.length === 1 ? "it" : "them"} back as a draft to send for approval again.</span>
   <button class="btn sm primary" data-act="bk-restore-all">Restore ${miss.length === 1 ? "it" : "all"}</button><a href="#" class="small" data-act="bk-forget">Forget ${miss.length === 1 ? "it" : "them"}</a>${pick}</div>`;
}
Object.assign(ACT, {
  "bk-restore-all": el => run(el, async () => { let n = 0; for (const e of bkMissing()) { await bkRestore(e); n++; } await loadPrompts(true); render(); toast(`Restored ${n} prompt${n === 1 ? "" : "s"} as draft${n === 1 ? "" : "s"}.`); }, "Restoring…"),
  "bk-forget": () => { if (!confirm("Remove these copies from this browser? They can't be restored from here afterwards.")) return; const d = bkRead(); bkMissing().forEach(e => delete d.prompts[e.id]); bkWrite(d); render(); },
  "bk-download": () => { const cur = R.cur; if (!cur) return; const e = bkSnapshot(cur, R.sv); if (e) bkDownload(e); },
});
document.addEventListener("change", async ev => {
  const el = ev.target; if (el.id !== "bk-file" || !el.files.length) return;
  const f = el.files[0]; el.value = "";
  try {
    const e = bkParse(await f.text());
    const exists = e.id && (R.prompts || []).some(p => p.id === e.id);
    if (exists && !confirm(`${e.name} is already on the server. Restore this file as a separate copy?`)) return;
    const r = await bkRestore(exists ? { ...e, id: null } : e);
    await loadPrompts(true); render(); toast(`Restored ${e.name} v${e.v} as draft v${r.v}.`);
  } catch (err) { toast(err.message); }
});

// ---------- unsaved Edit text ----------
const bkEditKey = id => BK_EDIT + id;
function bkEditSave(id, e) { try { localStorage.setItem(bkEditKey(id), JSON.stringify({ text: e.text, greeting: e.greeting, orig: e.orig, og: e.og, at: new Date().toISOString() })); } catch (_) { } }
function bkEditLoad(id) { try { return JSON.parse(localStorage.getItem(bkEditKey(id))); } catch (_) { return null; } }
function bkEditClear(id) { try { localStorage.removeItem(bkEditKey(id)); } catch (_) { } }
