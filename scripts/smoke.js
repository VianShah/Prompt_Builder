// End-to-end check against a running builder + mock Kollect. Usage: node scripts/smoke.js
const BASE = process.env.BASE || 'http://localhost:3002';
const MOCK = process.env.MOCK || 'http://localhost:3009';
const PB = require('../shared/blocks'); const core = require('../shared/promptcore');
let ok = 0; const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } ok++; console.log('ok -', m); };
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(BASE + '/api' + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
  };
}
(async () => {
  const ed = client(), ap = client();
  assert((await ed('GET', '/prompts')).status === 401, 'API requires sign-in');
  assert((await ed('POST', '/login', { email: 'editor@test.in', password: 'wrong' })).status === 401, 'wrong password rejected');
  assert((await ed('POST', '/login', { email: 'editor@test.in', password: 'ed-pass' })).status === 200, 'editor signs in');
  assert((await ap('POST', '/login', { email: 'approver@test.in', password: 'ap-pass' })).status === 200, 'approver signs in');
  const health = (await ed('GET', '/health')).body; console.log('   health', JSON.stringify(health));
  const sync = await ed('POST', '/agents/sync'); assert(sync.status === 200 && sync.body.synced >= 2, `synced ${sync.body.synced} Sarvam agents from Kollect`);
  const agents = (await ed('GET', '/agents')).body.agents; const sm = agents.find(a => a.client === 'SnapMint');
  assert(sm && sm.sarvamAppId && sm.bucket === 'b1', 'agent mapped (Bucket 1 → b1)');
  const fat = agents.find(a => a.client === 'Fatak Pay'); assert(fat && fat.variables.includes('emi_due_date'), 'string-encoded variables parsed');
  // import: simulate the live Sarvam prompt with the SnapMint preset text, tags removed
  const c = PB.baseCfg(); PB.PRESETS.snapmint.apply(c); c.preset = 'snapmint';
  const raw = core.toMarkdown(core.header(c, 'x'), c.order, core.sectionsFrom(c), false);
  const imp = await ed('POST', `/agents/${encodeURIComponent(sm.id)}/import`, { text: raw });
  assert(imp.status === 200 && imp.body.v === '1.0', `imported live prompt as v1.0 (${imp.body.import && imp.body.import.chunks} chunks via ${imp.body.import && imp.body.import.via})`);
  const pid = imp.body.promptId;
  let cur = (await ed('GET', '/prompts/' + pid)).body;
  assert(cur.versions[0].status === 'live' && cur.versions[0].sarvamVersion === 3, 'import is live at Sarvam v3 (from Kollect)');
  const words = s => s.split(/\s+/).filter(Boolean).sort().join(' ');
  const rebuilt = Object.values(cur.versions[0].sections).join('\n').replace(/<!--.*-->/g, '');
  assert(words(rebuilt) === words(raw), 'import keeps every word of the original prompt');
  assert((await ed('POST', '/prompts/' + pid + '/feedback', { raw: PB.SAMPLE_FEEDBACK, source: 'Client UAT' })).body.added === 8, '8 feedback items split from the sample');
  const map = await ed('POST', `/prompts/${pid}/feedback/map`); assert(map.status === 200 && map.body.mapped === 8, `mapped via ${map.body.via} ${map.body.provider || ''}`);
  let fb = (await ed('GET', `/prompts/${pid}/feedback`)).body.items; assert(fb.every(f => f.status === 'mapped' && f.map.section), 'every item has a section');
  const it = fb[0];
  const dr = await ed('POST', `/feedback/${it.id}/draft`);
  if (dr.status === 200) {
    assert(dr.body.draft.revised.includes('<!--'), 'AI draft keeps block tags');
    const apA = await ed('POST', `/feedback/${it.id}/apply`, {}); assert(apA.status === 200 && apA.body.v === '1.1', 'AI draft applied as v1.1 draft');
  } else {
    console.log('   draft unavailable:', dr.status, dr.body.error);
    const sec = it.map.section; cur = (await ed('GET', '/prompts/' + pid)).body;
    const ap1 = await ed('POST', `/feedback/${it.id}/apply`, { text: cur.versions[0].sections[sec] + '\n- Never ask how much the customer can pay.' });
    assert(ap1.status === 200 && ap1.body.v === '1.1', 'hand edit applied as v1.1 draft');
  }
  cur = (await ed('GET', '/prompts/' + pid)).body; const v11 = cur.versions[1];
  assert(v11.status === 'draft' && v11.basedOn === cur.versions[0].id, 'v1.1 is a draft based on v1.0');
  assert((await ap('POST', `/versions/${v11.id}/approve`)).status === 409, 'cannot approve a draft before it is submitted');
  assert((await ed('POST', `/versions/${v11.id}/submit`)).status === 200, 'editor submits v1.1');
  assert((await ed('POST', `/versions/${v11.id}/approve`)).status === 403, 'editor cannot approve');
  assert((await ap('POST', `/versions/${v11.id}/reject`, {})).status === 400, 'reject needs a reason');
  assert((await ap('POST', `/versions/${v11.id}/approve`, { note: 'ok' })).status === 200, 'approver approves');
  const same = await ap('POST', `/versions/${v11.id}/go-live`, { pin: true });
  assert(same.status === 409 && same.body.code === 'same_version', 'go-live refused while Sarvam still shows the live version');
  await fetch(MOCK + '/mock/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: sm.sarvamAppId }) });
  const gl = await ap('POST', `/versions/${v11.id}/go-live`, { pin: true });
  assert(gl.status === 200 && gl.body.sarvamVersion === 4 && gl.body.pinned, 'go-live confirms Sarvam v4 and pins it in Kollect');
  let kv = await (await fetch(`${MOCK}/api/agent-versions?appId=${sm.sarvamAppId}`)).json(); assert(kv.active === 4 && kv.mode === 'pinned', 'Kollect now calls v4');
  cur = (await ed('GET', '/prompts/' + pid)).body;
  assert(cur.versions[0].status === 'superseded' && cur.versions[1].status === 'live', 'v1.0 superseded, v1.1 live');
  assert((await ed('POST', `/versions/${cur.versions[0].id}/rollback`)).status === 403, 'editor cannot roll back');
  const rb = await ap('POST', `/versions/${cur.versions[0].id}/rollback`); assert(rb.status === 200 && rb.body.sarvamVersion === 3, 'approver rolls back to v1.0');
  kv = await (await fetch(`${MOCK}/api/agent-versions?appId=${sm.sarvamAppId}`)).json(); assert(kv.active === 3, 'Kollect pinned back to Sarvam v3');
  const md = await ed('GET', `/versions/${cur.versions[1].id}/markdown?tags=0`); assert(md.status === 200 && md.body.includes('## 1.'), 'markdown export');
  const shared = (await ed('GET', '/core-changes')).body.items; console.log('   shared-core fixes:', shared.length);
  const created = await ed('POST', '/prompts', { name: 'SMFG test', cfg: c, sections: core.sectionsFrom(c), order: c.order, version: '1.0' });
  assert(created.status === 200, 'wizard prompt saved as draft');
  assert((await ed('GET', '/audit')).body.items.length > 5, 'audit log written');
  console.log(`\n${ok} checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
