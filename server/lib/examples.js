// "How other agents handle this": passages from other agents of the same type (collections with
// collections, sales with sales) that cover what a feedback item is about.
// - match(): free. Words shared with the item, weighted so rare words count more, with a bonus for
//   the same section. No AI call.
// - aiPick(): optional. Sends only short snippets of the best word-matched candidates (about 3,000
//   characters in all) and asks for the ids of the closest ones, with a tiny reply budget.
// Passages from another lender are anonymised: that lender's names, the agent's persona name,
// web links and long numbers are replaced, so one lender's material never lands in another's prompt.
const db = require('../db');
const llm = require('./llm');
const PB = require('../../shared/blocks');

const STOP = new Set(('the and for with that this from have has had not are was were but you your our they them their its into then than when what which who will would should could can may must also only just very more most such any all each other there here about over under after before because while where how why does did done been being make made like even both either neither same some many much few one two three agent agents customer customers call calls line lines rule rules prompt section user users payment payments pay paid kya hai hain aur nahi aap main bhi').split(' '));
const words = s => String(s || '').toLowerCase().replace(/\{\{\s*\w+\s*\}\}/g, ' ').match(/[a-zऀ-ॿ][a-z0-9ऀ-ॿ'-]{2,}/g) || [];
const keyWords = s => [...new Set(words(s).filter(w => !STOP.has(w)))];
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const secTitle = (v, s) => (v && v.titles && v.titles[s]) || PB.secTitle(s) || s;
const sortV = vs => vs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What the item is about: the reviewer's words, the diagnosis and the proposed fix.
const itemQuery = it => [it.text, it.map && it.map.what, it.map && it.map.diagnosis, it.map && it.map.fix].filter(Boolean).join(' ');

// Names to hide in another lender's text. Imported agents often have no client name stored, so the
// lender is also read from the agent's own name ("Test_Mpokket-Kollect" -> Mpokket, Kollect), and a
// trailing "- Priya v3" / "- Anita v1" part is the persona.
const GENERIC = new Set('test testing tests collections collection agent agents dev main book demo migrated loan loans offer outreach card credit advisor company tractor rotavator pl bnpl emi uat prod live draft new old copy final version the and for with ai'.split(' '));
function namesOf(p, agent, promptText) {
  const c = (p.cfg && p.cfg.client) || {}, i = p.info || {};
  const label = String((agent && agent.name) || p.name || '');
  const parts = label.split(/\s+[-–·]\s+/);
  const persona = [c.agentName, i.agentName], lender = [c.name, c.legal, i.client, i.legal, agent && agent.client];
  parts.forEach((part, k) => {
    const m = part.trim().match(/^([A-Z][a-z]{2,})(\s+v\d+(\.\d+)?)?$/);
    if (k > 0 && m && !GENERIC.has(m[1].toLowerCase())) { persona.push(m[1]); return; }
    part.split(/[\s_\-()]+/).forEach(w => { const t = w.replace(/[^A-Za-z0-9]/g, ''); if (t.length >= 3 && /[A-Z]/.test(t[0]) && !/^v\d+$/i.test(t) && !GENERIC.has(t.toLowerCase())) lender.push(t); });
  });
  // "Mpokket" is also said "M ... Pokket": hide the name without its first letter too.
  lender.slice().forEach(n => { const t = String(n || '').trim(); if (t.length >= 6) lender.push(t[1].toUpperCase() + t.slice(2)); });
  // The persona as the prompt itself names it: "You are Priya", "Priya is a female ...".
  const body = String(promptText || '').slice(0, 60000);
  for (const m of body.matchAll(/\bYou are ([A-Z][a-z]{2,})\b|\b([A-Z][a-z]{2,}) is a (?:female|male|friendly|polite|calm)\b|\bmain ([A-Z][a-z]{2,}) bol (?:rahi|raha)\b|\b(?:named|called|name is|naam) ([A-Z][a-z]{2,})\b|\bthis is ([A-Z][a-z]{2,}) (?:calling|from)\b/gi)) { const nm = m[1] || m[2] || m[3] || m[4] || m[5]; if (nm && /^[A-Z]/.test(nm)) persona.push(nm); }
  const clean = a => [...new Set(a.filter(x => x && String(x).trim().length >= 3 && !GENERIC.has(String(x).trim().toLowerCase())).map(x => String(x).trim()))].sort((a, b) => b.length - a.length);
  return { lender: clean(lender), persona: clean(persona) };
}
// A name also matches when its letters are spaced or split: "Mpokket" finds "M Pokket", "SMFG" finds "S M F G".
const loose = n => n.length >= 4 ? [...n].map(escRe).join('[\\s.-]?') : escRe(n);
function anonymise(text, names) {
  let t = String(text);
  for (const n of names.lender) t = t.replace(new RegExp(`\\b${loose(n)}\\b`, 'gi'), '[client]');
  for (const n of names.persona) t = t.replace(new RegExp(`\\b${escRe(n)}\\b`, 'g'), '[agent name]');
  return t.replace(/https?:\/\/\S+/g, '[link]').replace(/\b\d{6,}\b/g, '[number]').replace(/(\[client\][\s.-]*){2,}/g, '[client] ');
}

// Every passage of every other agent of this type: a paragraph, or a few lines of a long one.
async function candidates(prompt) {
  const type = prompt.agentType || 'collections';
  const [prompts, agents] = await Promise.all([db.list('prompts'), db.list('agents')]);
  const mine = norm(((prompt.cfg && prompt.cfg.client) || {}).name || (prompt.info || {}).client);
  const out = [];
  for (const p of prompts) {
    if (p.id === prompt.id) continue;
    const agent = p.agentId ? agents.find(a => a.id === p.agentId) : null;
    if ((p.agentType || (agent && agent.agentType) || 'collections') !== type) continue;
    const vs = sortV(await db.list('versions', v => v.promptId === p.id));
    const v = vs.find(x => x.status === 'live') || vs[vs.length - 1];
    if (!v || !v.sections) continue;
    const names = namesOf(p, agent, (v.order || Object.keys(v.sections)).map(s => v.sections[s] || '').join('\n'));
    // The same lender ("BoB Card" and "BOB-creditcard-testing"): nothing to hide.
    const sq = x => norm(x).replace(/ /g, ''), same = mine && names.lender.some(n => { const a = sq(n), b = sq(mine); return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a)); });
    for (const s of v.order || Object.keys(v.sections)) {
      const paras = String(v.sections[s] || '').replace(/\r/g, '').split(/\n\s*\n/).map(x => x.trim()).filter(x => x.length >= 40);
      for (const para of paras) {
        const chunks = para.length <= 1200 ? [para] : para.split('\n').reduce((acc, line) => { const last = acc[acc.length - 1]; if (last && last.length + line.length < 900) acc[acc.length - 1] = last + '\n' + line; else acc.push(line); return acc; }, []);
        for (const ch of chunks) if (ch.trim().length >= 40) out.push({ promptId: p.id, agent: (agent && agent.name) || p.name, v: v.v, live: v.status === 'live', section: s, sectionTitle: secTitle(v, s), text: same ? ch.trim() : anonymise(ch.trim(), names) });
      }
    }
  }
  return out;
}

// Free: score by shared words (rarer words count more), small bonus for the same section.
function score(list, query, section, sectionTitle) {
  const q = keyWords(query);
  const df = new Map();
  const toks = list.map(c => { const set = new Set(words(c.text)); set.forEach(w => df.set(w, (df.get(w) || 0) + 1)); return set; });
  const n = list.length || 1, sec = norm(sectionTitle || section);
  return list.map((c, i) => {
    let s = 0; const hits = [];
    for (const w of q) if (toks[i].has(w)) { s += Math.log(1 + n / (df.get(w) || 1)); hits.push(w); }
    if (s && (c.section === section || norm(c.sectionTitle) === sec)) s *= 1.3;
    return { ...c, score: Math.round(s * 10) / 10, hits: hits.slice(0, 8) };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score);
}
// At most two passages per agent, so the list shows different agents.
function spread(list, k) {
  const per = new Map(), out = [];
  for (const c of list) { const m = per.get(c.promptId) || 0; if (m >= 2) continue; per.set(c.promptId, m + 1); out.push(c); if (out.length >= k) break; }
  return out;
}

async function match(prompt, version, it, k = 4) {
  const section = it.map && it.map.section;
  const list = await candidates(prompt);
  const ranked = score(list, itemQuery(it), section, secTitle(version, section));
  return { agentType: prompt.agentType || 'collections', searched: new Set(list.map(c => c.promptId)).size, passages: list.length, examples: spread(ranked, k) };
}

// Optional AI pick, kept small: 25 candidates x 120 characters, the item in 300, a reply of a few ids.
async function aiPick(prompt, version, it, k = 3) {
  const section = it.map && it.map.section;
  const list = await candidates(prompt);
  if (!list.length) return { examples: [], searched: 0, provider: null };
  const ranked = score(list, itemQuery(it), section, secTitle(version, section));
  // Word matches first, then the same section, so the AI also sees passages that say it in other words.
  const seen = new Set(), pool = [];
  const add = c => { const key = c.promptId + '|' + c.text.slice(0, 60); if (!seen.has(key) && pool.length < 25) { seen.add(key); pool.push(c); } };
  ranked.slice(0, 15).forEach(add);
  list.filter(c => c.section === section || norm(c.sectionTitle) === norm(secTitle(version, section))).forEach(add);
  list.forEach(add);
  const snip = t => t.replace(/\s+/g, ' ').slice(0, 120);
  const ask = [it.map && it.map.what, it.text].filter(Boolean).join(' / ').replace(/\s+/g, ' ').slice(0, 300);
  const req = `Pick up to ${k} passages that best show how to handle this issue in a voice-agent prompt. Reply only JSON {"ids":[numbers]}, best first; [] if none fit.
ISSUE: ${ask}
${pool.map((c, i) => `${i}: ${snip(c.text)}`).join('\n')}`;
  const r = await llm.json(req, { maxTokens: 60 });
  const ids = ((r.data && r.data.ids) || []).map(Number).filter(i => Number.isInteger(i) && pool[i]);
  return { examples: [...new Set(ids)].slice(0, k).map(i => ({ ...pool[i], score: null, hits: [], viaAi: true })), searched: new Set(list.map(c => c.promptId)).size, provider: r.provider, promptChars: req.length };
}

module.exports = { match, aiPick, anonymise, namesOf, keyWords, score, candidates };
