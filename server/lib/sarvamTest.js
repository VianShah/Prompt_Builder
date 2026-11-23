// Test a prompt version on Sarvam's own runtime, over text (send_chat), before anything is committed.
// 1. The version is written into the chosen agent's Sarvam DRAFT. Nothing is committed, so calls keep
//    running the committed version.
// 2. Each conversation runs turn by turn against that draft.
// 3. The draft is put back exactly as it was (prompt, greeting, and any variables Sarvam declared for
//    the test are deleted), and read back to check.
// If the draft already holds edits nobody committed, the test stops instead of touching them.
// The chat runtime can't inject call variables: each chat uses the agent's declared defaults.
const sarvam = require('./sarvam');
const pushLib = require('./sarvamPush');

const err = (msg, code, status) => Object.assign(new Error(msg), { code, status, publicMessage: msg });
const flat = s => String(s || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();

async function draftInfo(appId) {
  const app = await sarvam.callTool('agents', { operation: 'get', id: appId, params: { include: ['versions', 'intro', 'variables'] } });
  const draft = (app.versions || []).find(x => x.status === 'draft');
  const vars = (app.variables && (app.variables.agent_variables || app.variables)) || {};
  return { draftVersion: draft ? Number(draft.app_version) : null, greeting: (app.intro && app.intro.audio) || '', variables: Object.keys(vars) };
}

// Write to the draft and judge success by reading the draft back: Sarvam can report platform-managed
// fields as "not applied" even when the prompt itself was written.
async function writeDraft(appId, edits, extra) {
  const args = { agent_id: appId, dry_run: false };
  if (edits && edits.length) args.prompt_edits = edits;
  if (extra.prompt_append) args.prompt_append = extra.prompt_append;
  if (extra.config) args.config = extra.config;
  const r = await sarvam.callTool('configure_agent', args);
  if (r && r.ok === false) throw err(`Sarvam refused the draft edit: ${(r.error && (r.error.detail || r.error.message)) || 'unknown error'}`, 'sarvam_edit', 409);
}

// One conversation: the customer's lines in order; the agent's reply to each.
async function chat(appId, appVersion, lines) {
  const turns = []; let id = null;
  for (let i = 0; i < lines.length; i++) {
    const last = i === lines.length - 1;
    const args = { app_id: appId, text: String(lines[i]).slice(0, 1000), save_logs: false, ...(appVersion ? { app_version: appVersion } : {}) };
    if (!id) args.start_interaction = true; else args.interaction_id = id;
    if (last && id) args.end_interaction = true;
    const t0 = Date.now();
    const r = await sarvam.callTool('send_chat', args);
    if (r && r.ok === false) throw err(`Sarvam's chat refused a turn: ${(r.error && (r.error.detail || r.error.message)) || 'unknown error'}`, 'sarvam_chat', 502);
    id = (r && (r.id || r.interaction_id)) || id;
    turns.push({ role: 'customer', text: String(lines[i]) }, { role: 'agent', text: String((r && r.text) || ''), ms: Date.now() - t0 });
  }
  return turns;
}

// Write the version into the agent's draft, run fn(draftVersion), then put the draft back.
async function onDraft({ appId, text, greeting }, fn) {
  const committed = await sarvam.committedVersions(appId);
  const newest = committed[committed.length - 1] || null;
  const [before, top, info] = await Promise.all([sarvam.promptText(appId, null), newest ? sarvam.promptText(appId, newest) : Promise.resolve({ text: '', hash: '' }), draftInfo(appId)]);
  if (newest && flat(before.text) !== flat(top.text)) throw err(`This agent's Sarvam draft has edits nobody committed (${Math.abs(before.text.length - top.text.length)} characters different from v${newest}). The test would overwrite them, so it stopped. Commit or discard that draft in Sarvam, or test on another agent.`, 'draft_dirty', 409);
  const wantGreeting = greeting && greeting.trim() && greeting.trim() !== info.greeting.trim() ? greeting.trim() : null;
  const same = flat(before.text) === flat(text) && !wantGreeting;
  let wrote = false, out = null, restore = { ok: true, note: 'Nothing was written: Sarvam already had this text.' };
  try {
    if (!same) {
      const edits = pushLib.textEdits(before.text, text);
      const append = !before.text.trim() && text.trim() ? text : null;
      wrote = true; // set first: whatever happens from here, the draft is put back
      await writeDraft(appId, append ? [] : edits, { prompt_append: append, config: wantGreeting ? { intro_message_config: { audio: wantGreeting } } : null });
      const got = await sarvam.promptText(appId, null);
      if (flat(got.text) !== flat(text)) throw err('Sarvam did not take the whole prompt into the draft, so the test did not run.', 'sarvam_edit', 409);
    }
    const dv = (await draftInfo(appId)).draftVersion;
    out = { ...(await fn(dv || null)), draftVersion: dv, missingVariables: [...new Set((`${text} ${greeting || ''}`.match(/\{\{\s*(\w+)\s*\}\}/g) || []).map(x => x.replace(/[{}\s]/g, '')))].filter(v => !info.variables.includes(v)) };
    return out;
  } finally {
    if (wrote) {
      try {
        const now = await sarvam.promptText(appId, null);
        const back = flat(now.text) === flat(before.text) ? [] : pushLib.textEdits(now.text, before.text);
        if (back.length || wantGreeting) await writeDraft(appId, back, { config: wantGreeting ? { intro_message_config: { audio: info.greeting } } : null });
        // Sarvam declares every {{variable}} the prompt names: delete the ones it added (null deletes a key).
        let after = await draftInfo(appId);
        const added = after.variables.filter(x => !info.variables.includes(x));
        if (added.length) { await writeDraft(appId, [], { config: { llm_config: { agent_config: { agent_variables: Object.fromEntries(added.map(n => [n, null])) } } } }); after = await draftInfo(appId); }
        const check = await sarvam.promptText(appId, null);
        const sameVars = after.variables.length === info.variables.length && after.variables.every(x => info.variables.includes(x));
        const ok = flat(check.text) === flat(before.text) && after.greeting.trim() === info.greeting.trim() && sameVars;
        restore = ok ? { ok: true, note: 'The Sarvam draft was put back as it was (prompt, greeting and variables checked).' } : { ok: false, note: 'The Sarvam draft could not be put back exactly. Check it in Sarvam before anyone commits it.' };
      } catch (e) { restore = { ok: false, note: `Putting the Sarvam draft back failed: ${e.publicMessage || e.message}. Check it in Sarvam before anyone commits it.` }; }
    }
    if (out) out.restore = restore;
    else if (!restore.ok) console.warn('[sarvam-test]', restore.note);
  }
}

module.exports = { chat, onDraft, draftInfo };
