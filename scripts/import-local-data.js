// Copy this computer's builder data (data/store.json) into the database a deployed builder uses
// (Render Postgres): prompts, every version, feedback, regression tests, modules, shared-fix log.
//
//   DATABASE_URL="<External Database URL from Render>" npm run import-local            dry run: shows what would happen
//   DATABASE_URL="<External Database URL from Render>" npm run import-local -- --apply  does it
//
// Never copied: the saved Sarvam login and sign-in client ("settings"): the deployed builder has its own.
// Nothing on the deployed side is overwritten unless you ask:
//   --replace        where the deployed builder already loaded its OWN copy of an agent's prompt (for example
//                    after Refresh / Load all prompts), delete that copy and use yours, with all its history
//   --include-audit  also copy the audit log
//   --from <file>    read a different store file (default data/store.json)
// Agents: the deployed list wins (Refresh rebuilds it from Sarvam). Only the UAT link and template flags
// you set locally are carried over, and only where the deployed agent doesn't have them.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = n => argv.includes('--' + n);
const arg = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const APPLY = flag('apply'), REPLACE = flag('replace');
const toLocalFile = flag('to-local-file'); // for testing: write to this folder's own file store instead of a database
const fromFile = arg('from') || path.join(__dirname, '..', 'data', 'store.json');

if (!process.env.DATABASE_URL && !toLocalFile) {
  console.error('Set DATABASE_URL to the deployed database (Render > your Postgres > External Database URL), then run this again.');
  process.exit(1);
}
if (toLocalFile) delete process.env.DATABASE_URL;

let src;
try { src = JSON.parse(fs.readFileSync(fromFile, 'utf8')); } catch (e) { console.error(`Could not read ${fromFile}: ${e.message}`); process.exit(1); }
const db = require('../server/db');

const COPY = ['prompts', 'versions', 'feedback', 'tests', 'modules', 'coreChanges', ...(flag('include-audit') ? ['audit'] : [])];
const docs = col => Object.values(src[col] || {});
const N = n => String(n).padStart(4);

(async () => {
  await db.init();
  const host = (process.env.DATABASE_URL || '').replace(/^.*@/, '').replace(/\/.*$/, '') || 'this folder\'s own file store';
  console.log(`${APPLY ? 'APPLYING to' : 'DRY RUN against'}: ${host}`);
  console.log(`Reading: ${fromFile}\n`);

  // --- prompts: one per agent. If the target already has its own for the same agent, that's a conflict.
  const tPrompts = await db.list('prompts');
  const tByAgent = new Map(tPrompts.filter(p => p.agentId).map(p => [p.agentId, p]));
  const skipPrompt = new Set(), deleteTargetPrompt = new Set(), conflicts = [];
  for (const p of docs('prompts')) {
    const t = p.agentId && tByAgent.get(p.agentId);
    if (t && t.id !== p.id) { if (REPLACE) deleteTargetPrompt.add(t.id); else { skipPrompt.add(p.id); conflicts.push({ agent: p.agentId, name: p.name }); } }
  }
  const tIds = {};
  for (const col of [...COPY, 'agents']) tIds[col] = new Set((await db.list(col)).map(d => d.id));

  const plan = {};
  const belongs = (col, d) => !(d.promptId && skipPrompt.has(d.promptId)) && !(col === 'modules' && d.source && d.source.promptId && skipPrompt.has(d.source.promptId));
  for (const col of COPY) {
    const all = docs(col);
    const usable = all.filter(d => belongs(col, d));
    const fresh = usable.filter(d => !tIds[col].has(d.id) || (REPLACE && col === 'prompts'));
    plan[col] = { local: all.length, blockedByConflict: all.length - usable.length, alreadyThere: usable.length - fresh.length, toWrite: fresh };
  }
  // agents: keep the target's, carry over a few local flags.
  const carry = ['uatAgentId', 'template', 'templateNote', 'templateBy', 'templateAt'];
  const tAgents = new Map((await db.list('agents')).map(a => [a.id, a]));
  const agentPlan = { insert: [], patch: [] };
  for (const a of docs('agents')) {
    const t = tAgents.get(a.id);
    if (!t) { const { sarvamPullError, ...rest } = a; agentPlan.insert.push(rest); continue; }
    const add = {}; for (const k of carry) if (a[k] && !t[k]) add[k] = a[k];
    if (Object.keys(add).length) agentPlan.patch.push({ id: a.id, add });
  }

  console.log('collection      here  deployed-already  blocked  to write');
  for (const col of COPY) { const x = plan[col]; console.log(`${col.padEnd(14)} ${N(x.local)}  ${N(x.alreadyThere).padEnd(16)}  ${N(x.blockedByConflict).padEnd(7)}  ${N(x.toWrite.length)}`); }
  console.log(`agents         ${N(docs('agents').length)}  ${N(tAgents.size).padEnd(16)}  ${N(0).padEnd(7)}  ${N(agentPlan.insert.length)} new, ${agentPlan.patch.length} flags carried over`);
  console.log('settings (Sarvam login): never copied');
  if (REPLACE && deleteTargetPrompt.size) console.log(`\n--replace: the deployed copy of ${deleteTargetPrompt.size} prompt(s) and their versions, feedback and tests will be deleted first.`);
  if (conflicts.length) {
    console.log(`\nCONFLICT: the deployed builder already has its own prompt for ${conflicts.length} agent(s), so yours were skipped (with their versions, feedback and tests):`);
    conflicts.forEach(c => console.log(`  - ${c.name || c.agent}`));
    console.log('Run again with --replace to use your copies instead (the deployed copies and their history are deleted).');
  }
  if (!APPLY) { console.log('\nDry run only. Nothing was written. Add --apply to do it.'); return; }

  // --- apply
  let wrote = 0;
  for (const id of deleteTargetPrompt) {
    for (const col of ['versions', 'feedback', 'tests']) for (const d of await db.list(col, x => x.promptId === id)) await db.del(col, d.id);
    await db.del('prompts', id);
  }
  for (const col of COPY) for (const d of plan[col].toWrite) { await db.put(col, d); wrote++; }
  for (const a of agentPlan.insert) { await db.put('agents', a); wrote++; }
  for (const p of agentPlan.patch) { await db.put('agents', { ...tAgents.get(p.id), ...p.add }); wrote++; }
  console.log(`\nDone: ${wrote} records written. Open the deployed builder and click Refresh.`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
