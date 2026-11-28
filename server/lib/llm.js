// JSON completions. Claude Sonnet 5.5 on the team's AWS Bedrock (Converse API, Bedrock API key),
// then GLM 5 (Bedrock, OpenAI-compatible) and Gemini as fallbacks.
// Order comes from LLM_ORDER. A provider with no key is skipped; a failing one falls through to the next.
const config = require('../config');

const TIMEOUT_MS = 90000;

function parseJSON(text) {
  const t = String(text || '').trim();
  const tries = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1]);
  const s = t.search(/[[{]/), e = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (s >= 0 && e > s) tries.push(t.slice(s, e + 1));
  for (const x of tries) { try { return JSON.parse(x); } catch (_) { /* next */ } }
  const err = new Error('The AI\'s reply was cut off or wasn\'t in the expected format. Try again.'); err.code = 'invalid_json'; err.publicMessage = err.message; err.raw = t.slice(0, 500); throw err;
}

// A caller can pass its own AbortSignal (a Stop button): the request is cut off at once, and the error
// says so (code "cancelled"), so nothing retries and no fallback provider is tried.
const cancelled = () => Object.assign(new Error('Stopped.'), { code: 'cancelled', publicMessage: 'Stopped.' });
async function withTimeout(fn, ms, outer) {
  if (outer && outer.aborted) throw cancelled();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (outer) outer.addEventListener('abort', onAbort, { once: true });
  try { return await fn(ctl.signal); }
  catch (e) { if (outer && outer.aborted) throw cancelled(); throw e; }
  finally { clearTimeout(timer); if (outer) outer.removeEventListener('abort', onAbort); }
}

// Bedrock Converse with a Bedrock API key (Authorization: Bearer). Model must be the inference
// profile id (global.anthropic.claude-sonnet-5-5); the plain id is refused for on-demand use.
// Throttling is retried with backoff.
async function callClaude(prompt, { maxTokens, timeoutMs, signal: outer }) {
  const url = `${process.env.BEDROCK_ENDPOINT || `https://bedrock-runtime.${config.claude.region}.amazonaws.com`}/model/${encodeURIComponent(config.claude.model)}/converse`;
  for (let attempt = 0; ; attempt++) {
    const out = await withTimeout(async signal => {
      const res = await fetch(url, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.claude.apiKey}` },
        body: JSON.stringify({
          system: [{ text: 'You reply with valid JSON only. No prose, no markdown fences.' }],
          messages: [{ role: 'user', content: [{ text: prompt }] }],
          inferenceConfig: { maxTokens: Math.min(maxTokens, 32000) }, // Sonnet 5.5 refuses `temperature`
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 429 || res.status >= 500 || /Throttling|ServiceUnavailable|InternalServer/i.test(body.__type || body.message || '')) return { throttled: true }; // rate limit or a temporary server error: retry
      if (!res.ok) throw Object.assign(new Error(`claude bedrock http ${res.status}`), { code: 'provider_error', detail: String(body.message || JSON.stringify(body)).slice(0, 300) });
      const parts = body.output && body.output.message && body.output.message.content;
      return { text: (parts || []).map(p => p.text || '').join('') };
    }, timeoutMs, outer);
    if (!out.throttled) return out.text;
    if (attempt >= 4) throw Object.assign(new Error('claude bedrock throttled'), { code: 'provider_error', detail: 'ThrottlingException after retries' });
    if (outer && outer.aborted) throw cancelled();
    await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
  }
}

// Read images with Claude on Bedrock (the Converse API takes image blocks; the GLM and Gemini fallbacks
// here are text only). images: [{ data: base64, format: 'jpeg'|'png'|'gif'|'webp' }]. Returns plain text.
async function readImages(prompt, images, { maxTokens = 6000, timeoutMs } = {}) {
  if (!config.claude.apiKey || !config.bedrockFallback) throw Object.assign(new Error('Reading pictures and scans needs the Bedrock fallback switched on (LLM_BEDROCK_FALLBACK=on, with AWS_BEARER_TOKEN_BEDROCK).'), { code: 'no_llm', publicMessage: 'Reading pictures and scanned pages needs the Bedrock fallback switched on. Use text, Word, Excel or text-based PDFs, or ask an admin to switch the fallback on.' });
  const url = `${process.env.BEDROCK_ENDPOINT || `https://bedrock-runtime.${config.claude.region}.amazonaws.com`}/model/${encodeURIComponent(config.claude.model)}/converse`;
  // Bedrock takes the image bytes base64-encoded inside the JSON.
  const content = [...images.map(i => ({ image: { format: i.format, source: { bytes: Buffer.isBuffer(i.data) ? i.data.toString('base64') : String(i.data) } } })), { text: prompt }];
  for (let attempt = 0; ; attempt++) {
    const out = await withTimeout(async signal => {
      const res = await fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.claude.apiKey}` },
        body: JSON.stringify({ messages: [{ role: 'user', content }], inferenceConfig: { maxTokens: Math.min(maxTokens, 16000) } }) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 429 || res.status >= 500 || /Throttling|ServiceUnavailable|InternalServer/i.test(body.__type || body.message || '')) return { throttled: true };
      if (!res.ok) throw Object.assign(new Error(`claude bedrock http ${res.status}`), { code: 'provider_error', detail: String(body.message || JSON.stringify(body)).slice(0, 300) });
      return { text: ((body.output && body.output.message && body.output.message.content) || []).map(p => p.text || '').join('') };
    }, timeoutMs || 180000);
    if (!out.throttled) return out.text;
    if (attempt >= 3) throw Object.assign(new Error('claude bedrock throttled'), { code: 'provider_error', detail: 'ThrottlingException after retries' });
    await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
  }
}

// Sarvam 105B. JSON mode (response_format) is NOT used: in testing it silently cut long replies short.
// The reply is plain text that the parser below reads as JSON; reasoning comes back in its own field.
// Reasoning "auto" (the default): light reasoning for small jobs, none for big inputs or long replies,
// where in testing even light reasoning used up the whole output budget before writing anything.
async function callSarvam(prompt, { maxTokens, timeoutMs, signal: outer }) {
  const S = config.sarvamLlm;
  let mode = S.reasoning === 'auto' || !S.reasoning ? (String(prompt).length < 20000 && (maxTokens || 8000) <= 8000 ? 'low' : 'none') : S.reasoning;
  for (let attempt = 0; ; attempt++) {
    const reasoning = mode === 'none' ? null : mode;
    const headroom = reasoning ? ({ low: 8000, medium: 12000, high: 16000 }[reasoning] || 8000) : 0;
    const budget = Math.min((maxTokens || 8000) + headroom, S.maxTokens);
    const out = await withTimeout(async signal => {
      const res = await fetch(S.url, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'api-subscription-key': S.apiKey },
        body: JSON.stringify({ model: S.model, max_tokens: budget, reasoning_effort: reasoning, messages: [
          { role: 'system', content: 'You reply with valid JSON only. No prose, no markdown fences.' },
          { role: 'user', content: prompt }] }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 429 || res.status === 503 || res.status >= 500) return { throttled: true }; // rate limit or overload: retry with backoff
      if (!res.ok) throw Object.assign(new Error(`sarvam llm http ${res.status}`), { code: 'provider_error', detail: String((body.error && body.error.message) || JSON.stringify(body)).slice(0, 300) });
      const c = body.choices && body.choices[0];
      const text = (c && c.message && c.message.content) || '';
      if (c && c.finish_reason === 'length') {
        if (!text && reasoning) return { reasoningOnly: true }; // spent it all on reasoning: try once without
        throw Object.assign(new Error('sarvam llm reply cut off'), { code: 'provider_error', detail: `The reply hit the ${budget}-token limit before it finished.` });
      }
      return { text };
    }, timeoutMs, outer);
    if (out.reasoningOnly) { mode = 'none'; console.warn('[llm] sarvam used the whole budget on reasoning; asking again without reasoning'); continue; }
    if (!out.throttled) return out.text;
    if (attempt >= 4) throw Object.assign(new Error('sarvam llm busy'), { code: 'provider_error', detail: 'Rate-limited or overloaded after retries' });
    if (outer && outer.aborted) throw cancelled();
    await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
  }
}

async function callGlm(prompt, { maxTokens, signal: outer }) {
  return withTimeout(async signal => {
    const res = await fetch(`${config.glm.baseUrl}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.glm.apiKey}` },
      body: JSON.stringify({ model: config.glm.model, temperature: 0.2, max_tokens: maxTokens, messages: [
        { role: 'system', content: 'You reply with valid JSON only. No prose, no markdown fences.' },
        { role: 'user', content: prompt }] }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`glm http ${res.status}`), { code: 'provider_error', detail: JSON.stringify(body).slice(0, 300) });
    return body.choices && body.choices[0] && body.choices[0].message ? body.choices[0].message.content : '';
  }, undefined, outer);
}

async function callGemini(prompt, { maxTokens, signal: outer }) {
  return withTimeout(async signal => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
    const res = await fetch(url, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, responseMimeType: 'application/json' } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`gemini http ${res.status}`), { code: 'provider_error', detail: JSON.stringify(body).slice(0, 300) });
    const parts = body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts;
    return (parts || []).map(p => p.text || '').join('');
  }, undefined, outer);
}

const PROVIDERS = {
  sarvam: { ok: () => !!config.sarvamLlm.apiKey, call: callSarvam, label: () => `Sarvam ${config.sarvamLlm.model.replace(/^sarvam-/, '').toUpperCase()}` },
  claude: { ok: () => !!config.claude.apiKey, call: callClaude, label: () => 'Claude Sonnet 5.5 (Bedrock)' },
  glm: { ok: () => !!config.glm.apiKey, call: callGlm, label: () => `GLM (${config.glm.model})` },
  gemini: { ok: () => !!config.gemini.apiKey, call: callGemini, label: () => `Gemini (${config.gemini.model})` },
};

// The order from LLM_ORDER. Bedrock (claude) is used only when LLM_BEDROCK_FALLBACK is on, and then last.
function available() {
  const order = config.llmOrder.filter(p => p !== 'claude');
  if (config.bedrockFallback) order.push('claude');
  return order.filter(p => PROVIDERS[p] && PROVIDERS[p].ok());
}

async function json(prompt, { maxTokens = 8000, timeoutMs, signal } = {}) {
  if (signal && signal.aborted) throw cancelled();
  const order = available();
  if (!order.length) throw Object.assign(new Error('No LLM configured. Set SARVAM_LLM_API_KEY (Sarvam 105B), or switch on the Bedrock fallback (LLM_BEDROCK_FALLBACK=on with AWS_BEARER_TOKEN_BEDROCK).'), { code: 'no_llm' });
  let lastErr;
  for (const p of order) {
    try {
      // A long reply now and then comes back as broken JSON: ask the same model once more before moving on.
      for (let attempt = 0; ; attempt++) {
        const text = await PROVIDERS[p].call(prompt, { maxTokens, timeoutMs, signal });
        try { return { data: parseJSON(text), provider: PROVIDERS[p].label() }; }
        catch (pe) { if (attempt >= 1 || pe.code !== 'invalid_json') throw pe; console.warn(`[llm] ${p} reply wasn't valid JSON; asking again`); }
      }
    } catch (e) {
      if (e.code === 'cancelled') throw e; // stopped by the caller: no fallback provider
      lastErr = e;
      console.warn(`[llm] ${p} failed: ${e.code || ''} ${e.message} ${e.detail || ''}`);
    }
  }
  throw lastErr;
}

module.exports = { readImages, vision: () => !!config.claude.apiKey && config.bedrockFallback, json, available, labels: () => available().map(p => PROVIDERS[p].label()) };
