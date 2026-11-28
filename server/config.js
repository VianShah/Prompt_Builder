require('dotenv').config();

const list = (v, d = '') => (v || d).split(',').map(s => s.trim()).filter(Boolean);

// Users: BUILDER_USERS="email|Name|role|password,email2|Name2|role|password2"
// role is editor | approver | admin. Approvers can approve versions; admins can also roll back.
function parseUsers(raw) {
  return list(raw).map(entry => {
    const [email, name, role, ...pw] = entry.split('|');
    return { email: (email || '').toLowerCase(), name: name || email, role: ['editor', 'approver', 'admin'].includes(role) ? role : 'editor', password: pw.join('|') };
  }).filter(u => u.email && u.password);
}

module.exports = {
  port: Number(process.env.PORT || 3002),
  databaseUrl: process.env.DATABASE_URL || '',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  // The FDE / GTM engineer who builds an agent also reviews and approves it. Set SELF_APPROVE=false to
  // require a second person (the author then can't approve their own version or module).
  selfApprove: process.env.SELF_APPROVE !== 'false',
  users: parseUsers(process.env.BUILDER_USERS),
  // Main model: Sarvam 105B (128K context) through Sarvam's chat completions API.
  // reasoning: none | low | medium | high. Reasoning tokens count toward max_tokens, so each call gets
  // headroom on top of the output it needs, capped at maxTokens.
  sarvamLlm: {
    apiKey: process.env.SARVAM_LLM_API_KEY || '',
    model: process.env.SARVAM_LLM_MODEL || 'sarvam-105b',
    url: process.env.SARVAM_LLM_URL || 'https://api.sarvam.ai/v1/chat/completions',
    reasoning: process.env.SARVAM_LLM_REASONING || 'auto', // auto | none | low | medium | high
    maxTokens: Number(process.env.SARVAM_LLM_MAX_TOKENS) || 32000,
  },
  // Bedrock (Claude) is a fallback only when switched on: LLM_BEDROCK_FALLBACK=on. Off by default.
  bedrockFallback: /^(on|true|1|yes)$/i.test(process.env.LLM_BEDROCK_FALLBACK || ''),
  // Claude Sonnet 5.5 on the team's AWS Bedrock (ap-south-1), via a Bedrock API key. Requests are
  // served from AWS regions worldwide (global profile): don't send data that must stay in India.
  claude: {
    apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK || '',
    region: process.env.BEDROCK_REGION || 'ap-south-1',
    model: process.env.CLAUDE_MODEL || 'global.anthropic.claude-sonnet-5-5',
  },
  // Fallbacks, with the GLM 5 on Bedrock, then Gemini.
  glm: {
    apiKey: process.env.GLM_BEDROCK_API_KEY || '',
    baseUrl: process.env.GLM_BEDROCK_BASE_URL || 'https://bedrock-runtime.ap-south-1.amazonaws.com/openai/v1',
    model: process.env.GLM_MODEL || 'zai.glm-5',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  llmOrder: list(process.env.LLM_ORDER, 'sarvam'),
  // How an approved prompt reaches Sarvam. "manual" = copy into Sarvam Canvas, commit, then confirm here.
  sarvamPush: process.env.SARVAM_PROMPT_PUSH || 'manual',
  // Reading live instructions from Sarvam (org and workspace ids from the Sarvam URL). The login token is pasted in the UI.
  // apiKey: the Voice Agents API key. Used for calls, transcripts and recordings (see lib/sarvamRest.js); it can't read prompts.
  // Module library in the GitHub repo. A fine-grained token with Contents: read and write on this repo.
  github: {
    token: process.env.GITHUB_TOKEN || '',
    repo: process.env.GITHUB_REPO || '',              // owner/name, e.g. VianShah/Prompt_Builder
    branch: process.env.GITHUB_LIBRARY_BRANCH || 'module-library',
  },
  sarvam: { orgId: process.env.SARVAM_ORG_ID || '', workspaceId: process.env.SARVAM_WORKSPACE_ID || '', apiKey: process.env.SARVAM_API_KEY || '' },
};
