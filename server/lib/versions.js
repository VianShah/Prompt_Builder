// Saving a change (a feedback fix, a hand edit, a settings change) on top of the latest version.
//
// If the latest version is still an open draft (not yet sent for approval, or sent back), the change
// is ADDED TO THAT DRAFT: one draft collects every fix until someone sends it for approval, instead of
// v3.1, v3.2, v3.3… for each fix. Once a version is waiting for approval, approved or live it is never
// changed underneath the approver: the change starts a new draft on top of it.
// In Sarvam, every push is still a new committed version: committed versions can't be edited, and
// that is what makes rollback and per-version call history work.
const db = require('../db');
const { uid, now, bump } = require('./util');

const isOpenDraft = v => !!v && ['draft', 'rejected'].includes(v.status);

// fields: the new content (sections, order, sarvamText, sourceChunks, greeting, configPatch…) plus
// note, src, feedbackIds, fixes. what: one line for the history.
async function saveOnTop(prompt, base, fields, user, what) {
  if (isOpenDraft(base)) {
    const v = { ...base, ...fields,
      status: 'draft',
      rev: (base.rev || 0) + 1,
      note: [base.note, fields.note].filter(Boolean).join(' · ').slice(0, 1200),
      feedbackIds: [...(base.feedbackIds || []), ...(fields.feedbackIds || [])],
      fixes: [...(base.fixes || []), ...(fields.fixes || [])],
      editedBy: [...new Set([...(base.editedBy || []), user.email])],
      uat: null,
      history: [...(base.history || []), { at: now(), by: user.email, action: 'updated', note: what }] };
    if (base.status === 'rejected') v.history.push({ at: now(), by: user.email, action: 'reopened', note: 'Changed after it was sent back' });
    if (base.uat) v.history.push({ at: now(), by: user.email, action: 'uat_outdated', note: `${base.uat.name} still runs the earlier text. Push to UAT again to test this.` });
    await db.put('versions', v);
    return { ver: v, updated: true };
  }
  const ver = await db.put('versions', { id: uid(), promptId: prompt.id, v: bump(base.v), status: 'draft', basedOn: base.id, by: user.email, rev: 0,
    ...fields, history: [{ at: now(), by: user.email, action: 'created', note: what }] });
  await db.put('prompts', { ...prompt, latestVersionId: ver.id });
  return { ver, updated: false };
}

module.exports = { saveOnTop, isOpenDraft };
