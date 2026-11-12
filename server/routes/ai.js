const express = require('express');
const ai = require('../lib/aiTasks');
const { h, fail } = require('../lib/util');
const r = express.Router();
r.post('/ai/review', h(async (req, res) => {
  const md = String((req.body || {}).markdown || '');
  if (md.length < 100) throw fail(400, 'Nothing to review.');
  res.json(await ai.review(md));
}));
r.post('/ai/kb', h(async (req, res) => {
  const { notes, client, product } = req.body || {};
  if (String(notes || '').trim().length < 20) throw fail(400, 'Paste some product notes first.');
  res.json(await ai.kbDraft({ notes, client, product }));
}));
// Compare page: a plain-language summary of how two agents' prompts differ.
r.post('/ai/compare', h(async (req, res) => {
  const { a, b } = req.body || {};
  if (!a || !b || String(a.text || '').length < 100 || String(b.text || '').length < 100) throw fail(400, 'Both agents need a prompt.');
  res.json(await ai.compareSummary(a, b));
}));
module.exports = r;
