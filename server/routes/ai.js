const express = require('express');
const ai = require('../lib/aiTasks');
const { h, fail } = require('../lib/util');
const r = express.Router();
r.post('/ai/review', h(async (req, res) => {
  const { blocks, steps } = req.body || {};
  // The wizard sends its blocks, so each issue can come back with a fix to apply in place.
  if (Array.isArray(blocks) && blocks.length) return res.json(await ai.reviewWithFixes({ blocks, steps }));
  const md = String((req.body || {}).markdown || '');
  if (md.length < 100) throw fail(400, 'Nothing to review.');
  res.json(await ai.review(md));
}));
r.post('/ai/kb', h(async (req, res) => {
  const { notes, client, product } = req.body || {};
  if (String(notes || '').trim().length < 20) throw fail(400, 'Paste some product notes first.');
  res.json(await ai.kbDraft({ notes, client, product }));
}));
// Pictures and scanned pages: Claude reads them and returns the text they carry (up to 8 images per call).
r.post('/ai/read-images', h(async (req, res) => {
  const { images, label } = req.body || {};
  if (!Array.isArray(images) || !images.length) throw fail(400, 'No images to read.');
  const ok = images.filter(i => i && /^(jpeg|png|gif|webp)$/.test(i.format) && typeof i.data === 'string' && i.data.length > 100);
  if (!ok.length) throw fail(400, 'These images are not in a format Claude can read (JPEG, PNG, GIF or WebP).');
  if (ok.reduce((n, i) => n + i.data.length, 0) > 3.2e6) throw fail(413, 'These images are too large together. Send fewer or smaller ones.');
  res.json(await ai.readImagesToText({ images: ok.map(i => ({ format: i.format, data: Buffer.from(i.data, 'base64') })), label }));
}));
// Knowledge base from documents: one batch of extracted text per call (the browser sends the batches).
r.post('/ai/kb-docs', h(async (req, res) => {
  const { docs, client, product, agentType } = req.body || {};
  if (!Array.isArray(docs) || !docs.some(d => d && String(d.text || '').trim().length > 20)) throw fail(400, 'Nothing readable in these documents.');
  const total = docs.reduce((n, d) => n + String((d && d.text) || '').length, 0);
  if (total > 200000) throw fail(413, 'This batch is too large. Send at most 200,000 characters at a time.');
  res.json(await ai.kbFromDocs({ docs, client, product, agentType }));
}));
// Compare page: a plain-language summary of how two agents' prompts differ.
r.post('/ai/compare', h(async (req, res) => {
  const { a, b } = req.body || {};
  if (!a || !b || String(a.text || '').length < 100 || String(b.text || '').length < 100) throw fail(400, 'Both agents need a prompt.');
  res.json(await ai.compareSummary(a, b));
}));
module.exports = r;
