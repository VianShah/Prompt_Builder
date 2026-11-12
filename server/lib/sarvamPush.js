// Push an approved version to Sarvam as exact passage edits, then commit it.
//
// The builder regroups a Sarvam prompt into sections on import, so its section order is not the
// prompt's order. Sending the regrouped text back would reshuffle the whole prompt. Instead:
//   1. Map the live version back to the passages ("chunks") of the Sarvam text it came from, in
//      Sarvam's own order (chunkMap).
//   2. Line-diff each section of the approved version against the live one and work out which
//      passages changed (planEdits).
//   3. Send each changed passage as { old_text: passage as it is in Sarvam, new_text } through
//      configure_agent's prompt_edits: dry run first, then for real, then commit.
// Everything that wasn't edited stays byte-for-byte as it is in Sarvam.
const crypto = require('crypto');
const core = require('../../shared/promptcore');
const sarvam = require('./sarvam');

const stripTags = s => String(s || '').replace(/^<!--.*-->[ \t]*\n?/gm, '').trim();
const err = (msg, code, status, extra) => Object.assign(new Error(msg), { code, status, publicMessage: msg }, extra || {});
const hash = t => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

// Which Sarvam passage sits in which section, in Sarvam's order. Import puts each section's
// passages in source order joined by a blank line, so each section body is walked against the
// passages in order. Returns null if the version doesn't line up with this text.
function chunkMap(sections, order, baseText) {
  const chunks = core.chunkPrompt(baseText);
  const owner = new Array(chunks.length).fill(null);
  for (const sec of order) {
    const body = stripTags(sections[sec]);
    if (!body) continue;
    let pos = 0;
    for (let i = 0; i < chunks.length && pos < body.length; i++) {
      if (owner[i] !== null) continue;
      if (body.startsWith(chunks[i], pos)) {
        owner[i] = sec; pos += chunks[i].length;
        while (pos < body.length && /\s/.test(body[pos])) pos++;
      }
    }
    if (pos < body.length) return null;
  }
  if (owner.some(o => o === null)) return null;
  return chunks.map((text, i) => ({ sec: owner[i], text }));
}

// Turn the section changes into passage edits on the original text.
function planEdits(baseChunks, oldSections, newSections, order) {
  const out = baseChunks.map(c => ({ ...c, newText: c.text }));
  const lastIdx = out.length - 1;
  for (const sec of order) {
    const idx = out.map((c, i) => c.sec === sec ? i : -1).filter(i => i >= 0);
    const newBody = stripTags(newSections[sec]);
    if (!idx.length) {
      // A section that had no Sarvam text before: add its text after the prompt's last passage.
      if (newBody) out[lastIdx].newText = out[lastIdx].newText + '\n\n' + newBody;
      continue;
    }
    // Old body as lines, remembering which passage each line came from (-1 = the blank separator).
    const oldLines = [], owner = [];
    idx.forEach((ci, k) => {
      if (k) { oldLines.push(''); owner.push(-1); }
      out[ci].text.split('\n').forEach(l => { oldLines.push(l); owner.push(ci); });
    });
    if (oldLines.join('\n') === newBody) continue;
    const ops = core.lineDiff(oldLines.join('\n'), newBody);
    const lines = new Map(idx.map(ci => [ci, []]));
    let oi = 0, last = null, afterSep = false;
    for (const [op, line] of ops) {
      if (op === 'c' || op === 'd') {
        const ci = owner[oi++];
        if (ci === -1) { afterSep = true; continue; }
        last = ci; afterSep = false;
        if (op === 'c') lines.get(ci).push(line);
      } else {
        // Added line: goes with the passage before it; at the very start, with the first passage.
        const ci = last === null ? idx[0] : last;
        if (afterSep && last !== null) { lines.get(ci).push(''); afterSep = false; }
        lines.get(ci).push(line);
      }
    }
    idx.forEach(ci => { out[ci].newText = lines.get(ci).join('\n').trim(); });
  }
  const edits = out.filter(c => c.newText !== c.text).map(c => ({ old_text: c.text, new_text: c.newText }));
  return { edits, newChunks: out.map(c => ({ sec: c.sec, text: c.newText })).filter(c => c.text) };
}


// Sarvam's merge rules: objects merge key by key, lists and other values replace, null deletes.
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

const count = (hay, needle) => { let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; } return n; };

// Passage edits that turn base into target. Line diff; each changed run is widened with whole
// unchanged lines on both sides until its old text is unique in base, so Sarvam can find it.
// Falls back to one whole-prompt replace when most of the text changed (e.g. a prompt written in
// the builder for an existing agent) or if the edits don't reproduce the target exactly.
function textEdits(base, target) {
  if (base === target || !base.trim()) return [];
  const whole = [{ old_text: base, new_text: target }];
  const A = base.split('\n'), B = target.split('\n');
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const midA = A.slice(pre, A.length - suf), midB = B.slice(pre, B.length - suf);
  if (midA.length * midB.length > 9e6) return whole;
  // lineDiff splits "" into one empty line, so pure inserts/deletes are built directly.
  const ops = !midA.length ? midB.map(l => ['a', l]) : !midB.length ? midA.map(l => ['d', l]) : core.lineDiff(midA.join('\n'), midB.join('\n'));
  // Hunks as line ranges in both texts: old [s,e), new [ts,te).
  const hunks = []; let oi = pre, ti = pre, cur = null;
  for (const [op] of ops) {
    if (op === 'c') { if (cur) { hunks.push(cur); cur = null; } oi++; ti++; continue; }
    if (!cur) cur = { s: oi, e: oi, ts: ti, te: ti };
    if (op === 'd') cur.e = ++oi; else cur.te = ++ti;
  }
  if (cur) hunks.push(cur);
  if (!hunks.length) return whole; // only whitespace-joined differences
  if (hunks.reduce((n, h) => n + A.slice(h.s, h.e).join('\n').length, 0) > base.length * 0.6) return whole;
  // Widen: unchanged lines are identical on both sides, so both ranges move together.
  const oldOf = h => A.slice(h.s, h.e).join('\n');
  for (const h of hunks) {
    for (let k = 0; k < 400; k++) {
      const t = oldOf(h);
      // Both sides need at least one line, or the line break around a pure insert/delete is lost.
      if (h.e > h.s && h.te > h.ts && t.replace(/\s/g, '').length >= 24 && count(base, t) === 1) break;
      const up = h.s > 0, down = h.e < A.length;
      if (!up && !down) break;
      if (up && (k % 2 === 0 || !down)) { h.s--; h.ts--; } else { h.e++; h.te++; }
    }
  }
  const merged = [];
  for (const h of hunks) {
    const last = merged[merged.length - 1];
    if (last && h.s <= last.e) { last.e = Math.max(last.e, h.e); last.te = Math.max(last.te, h.te); }
    else merged.push({ ...h });
  }
  const edits = merged.map(h => ({ old_text: oldOf(h), new_text: B.slice(h.ts, h.te).join('\n') }));
  // Self-check: applying the edits to base must give target exactly.
  let t = base;
  for (const e of edits) { if (count(t, e.old_text) !== 1) return whole; t = t.replace(e.old_text, () => e.new_text); }
  return t === target ? edits : whole;
}

// The full Sarvam text a version stands for (null when it can't be worked out).
function targetText(live, next, cfg) {
  if (next.sarvamText) return next.sarvamText;
  const t = live ? sarvamTextFor(live, next) : null;
  if (t) return t.text;
  if (!live && cfg) return core.toMarkdown(core.header(cfg, next.v), next.order, next.sections, false).trim();
  return null;
}

// Plan (and, unless dryRun, apply and commit) the push. Throws coded errors the UI explains.
// Works for an imported agent prompt (only the changed passages are sent) and for a prompt written
// in the builder and linked to an existing Sarvam agent (its text replaces the agent's prompt).
async function push({ agent, live, next, cfg, user, dryRun, allowDraftChanges, builtOn }) {
  const appId = agent.sarvamAppId;
  const empty = { text: '', hash: hash('') };
  const read = async v => { try { return await sarvam.promptText(appId, v); } catch (e) { if (e.code === 'sarvam_shape') return empty; throw e; } };
  const committed = await sarvam.committedVersions(appId);
  const newest = committed[committed.length - 1] || null;
  const baseVersion = live && live.sarvamVersion ? live.sarvamVersion : newest;

  // The change must have been built on what Sarvam has now. Pushing a change built on an older version
  // makes Sarvam's prompt exactly that older text plus the change, which silently erases every newer fix.
  if (builtOn && newest && Number(builtOn) !== Number(newest)) {
    const [old, top] = await Promise.all([read(builtOn), read(newest)]);
    if (old.hash !== top.hash) {
      const target0 = targetText(live, next, cfg) || '';
      const lines = s => new Set(s.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(l => l.length > 3));
      const want = lines(target0), had = lines(old.text);
      const lost = [...lines(top.text)].filter(l => !want.has(l) && !had.has(l));
      if (lost.length) throw err(`This change was built on Sarvam v${builtOn}, but Sarvam now has v${newest}. Pushing it would erase ${lost.length} line${lost.length === 1 ? '' : 's'} added since v${builtOn}. Rebuild it on v${newest} first.`, 'stale_base', 409, { payload: { builtOn, newest, lost: lost.slice(0, 40), lostCount: lost.length } });
    }
  }

  // Sarvam must still hold what the builder thinks is live, or the edits would land on unknown text.
  const base = baseVersion ? await read(baseVersion) : empty;
  if (live && live.sarvamVersion && newest && newest !== live.sarvamVersion) {
    const top = await read(newest);
    if (top.hash !== base.hash) throw err(`Someone committed v${newest} in Sarvam after the builder's live version (v${live.sarvamVersion}). Open the agent and choose ⋯ → Reload prompt from Sarvam, then re-apply this change.`, 'sarvam_base', 409);
  }
  const draft = await read(null);
  const draftDirty = draft.hash !== base.hash;
  if (draftDirty && !allowDraftChanges) {
    throw err(`Sarvam's draft for this agent has edits nobody committed (${Math.abs(draft.text.length - base.text.length)} characters different). Pushing would commit them along with this change.`, 'draft_dirty', 409, { draftDiff: draft.text.length - base.text.length });
  }

  const target = targetText(live, next, cfg);
  if (target == null) throw err('Couldn\'t work out this version\'s full text. Reload the prompt from Sarvam and re-apply the change.', 'sarvam_base', 409);
  // Edits are planned on the text Sarvam's draft holds now (the same as base unless draft edits are included).
  const from = draft.text;
  const edits = textEdits(from, target);
  const append = !from.trim() && target.trim() ? target : null;
  const baseGreeting = ((live && live.sarvamMeta && live.sarvamMeta.greeting) || '').trim();
  const greeting = next.greeting && next.greeting.trim() && next.greeting.trim() !== baseGreeting ? next.greeting.trim() : null;
  // Settings changed in the builder (variables, languages, voice) ride along as a config patch.
  const config = deepMerge(greeting ? { intro_message_config: { audio: greeting } } : {}, next.configPatch || {});
  const extra = { prompt_append: append, config: Object.keys(config).length ? config : null };
  if (!edits.length && !append && !greeting && !next.configPatch) throw err('This version has no changes compared with what is in Sarvam.', 'sarvam_edit', 409);

  // Sarvam runs every check without writing anything.
  await sarvam.editDraft(appId, edits, true, extra);
  const whole = !!append || (edits.length === 1 && edits[0].old_text === from);
  const summary = { edits: edits.length + (append ? 1 : 0), whole, greeting, settings: next.configSummary || null, chars: target.length - from.length, draftDirty, baseVersion, newestCommitted: newest };
  const cut = s => whole ? s.slice(0, 1500) + (s.length > 1500 ? '\n…' : '') : s;
  if (dryRun) return { dryRun: true, ...summary, preview: (append ? [{ old_text: '', new_text: append }] : edits).map(e => ({ before: cut(e.old_text), after: cut(e.new_text) })) };

  await sarvam.editDraft(appId, edits, false, extra);
  const version = await sarvam.commit(appId, `Prompt Builder v${next.v}: ${next.note || 'approved change'} (approved by ${next.approvedBy || user.email})`);
  // Read the committed text back and check it is the approved text.
  const after = await read(version);
  const norm = s => s.replace(/\s+/g, ' ').trim();
  if (norm(after.text) !== norm(target)) throw err(`Committed as Sarvam v${version}, but its text differs from the approved version. Check the agent in Sarvam before pinning.`, 'sarvam_edit', 502, { committedVersion: version });
  return { ...summary, version, newHash: after.hash, text: after.text };
}

// A version's prompt as it reads (or will read) in Sarvam: Sarvam's own text, in its own order.
// New versions carry their full text; older ones get it by swapping their edited passages into the live text.
function sarvamTextFor(live, version) {
  if (version.sarvamText) return { text: version.sarvamText, exact: !!version.sarvamVersion };
  if (!live || !live.sarvamText) return null;
  const baseChunks = live.sourceChunks || chunkMap(live.sections, live.order, live.sarvamText);
  if (!baseChunks) return null;
  const { edits } = planEdits(baseChunks, live.sections, version.sections, version.order || live.order);
  let text = live.sarvamText;
  for (const e of edits) {
    const i = text.indexOf(e.old_text);
    if (i < 0) return null;
    text = text.slice(0, i) + e.new_text + text.slice(i + e.old_text.length);
  }
  return { text, exact: false, edits: edits.length };
}

// Full text + passage map for a new version whose sections were changed on top of ref.
function deriveText(ref, sections, order) {
  if (!ref || !ref.sarvamText) return null;
  const chunks = ref.sourceChunks || chunkMap(ref.sections, ref.order, ref.sarvamText);
  if (chunks) {
    const pl = planEdits(chunks, ref.sections, sections, order || ref.order);
    let text = ref.sarvamText, ok = true;
    for (const e of pl.edits) { const i = text.indexOf(e.old_text); if (i < 0) { ok = false; break; } text = text.slice(0, i) + e.new_text + text.slice(i + e.old_text.length); }
    if (ok) return { text, sourceChunks: pl.newChunks };
  }
  // Passage map unavailable: apply each changed section's own line edits straight to the text.
  let text = ref.sarvamText;
  for (const sec of new Set([...Object.keys(ref.sections), ...Object.keys(sections)])) {
    const a = stripTags(ref.sections[sec]), b = stripTags(sections[sec]);
    if (a === b) continue;
    if (!a) { text = text + '\n\n' + b; continue; }
    for (const e of textEdits(a, b)) { if (count(text, e.old_text) !== 1) return null; text = text.replace(e.old_text, () => e.new_text); }
  }
  return { text, sourceChunks: null };
}

module.exports = { push, deepMerge, chunkMap, planEdits, stripTags, hash, sarvamTextFor, textEdits, targetText, deriveText };
