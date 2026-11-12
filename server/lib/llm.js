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

async function withTimeout(fn, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || TIMEOUT_MS);
  try { return await fn(ctl.signal); } finally { clearTimeout(timer); }
}

// Bedrock Converse with a Bedrock API key (Authorization: Bearer). Model must be the inference
// profile id (global.anthropic.claude-sonnet-5-5); the plain id is refused for on-demand use.
// Throttling is retried with backoff.
async function callClaude(prompt, { maxTokens, timeoutMs }) {
  const url = `https://bedrock-runtime.${config.claude.region}.amazonaws.com/model/${encodeURIComponent(config.claude.model)}/converse`;
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
    }, timeoutMs);
    if (!out.throttled) return out.text;
    if (attempt >= 4) throw Object.assign(new Error('claude bedrock throttled'), { code: 'provider_error', detail: 'ThrottlingException after retries' });
    await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
  }
}

async function callGlm(prompt, { maxTokens }) {
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
  });
}

async function callGemini(prompt, { maxTokens }) {
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
  });
}

const PROVIDERS = {
  claude: { ok: () => !!config.claude.apiKey, call: callClaude, label: () => 'Claude Sonnet 5.5 (Bedrock)' },
  glm: { ok: () => !!config.glm.apiKey, call: callGlm, label: () => `GLM (${config.glm.model})` },
  gemini: { ok: () => !!config.gemini.apiKey, call: callGemini, label: () => `Gemini (${config.gemini.model})` },
};

function available() { return config.llmOrder.filter(p => PROVIDERS[p] && PROVIDERS[p].ok()); }

async function json(prompt, { maxTokens = 8000, timeoutMs } = {}) {
  const order = available();
  if (!order.length) throw Object.assign(new Error('No LLM configured. Set AWS_BEARER_TOKEN_BEDROCK (Claude on Bedrock), GLM_BEDROCK_API_KEY or GEMINI_API_KEY.'), { code: 'no_llm' });
  let lastErr;
  for (const p of order) {
    try {
      const text = await PROVIDERS[p].call(prompt, { maxTokens, timeoutMs });
      return { data: parseJSON(text), provider: PROVIDERS[p].label() };
    } catch (e) {
      lastErr = e;
      console.warn(`[llm] ${p} failed: ${e.code || ''} ${e.message} ${e.detail || ''}`);
    }
  }
  throw lastErr;
}

module.exports = { json, available, labels: () => available().map(p => PROVIDERS[p].label()) };
