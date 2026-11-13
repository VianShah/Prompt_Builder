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
  users: parseUsers(process.env.BUILDER_USERS),
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
  llmOrder: list(process.env.LLM_ORDER, 'claude,glm,gemini'),
  // How an approved prompt reaches Sarvam. "manual" = copy into Sarvam Canvas, commit, then confirm here.
  sarvamPush: process.env.SARVAM_PROMPT_PUSH || 'manual',
  // Reading live instructions from Sarvam (org and workspace ids from the Sarvam URL). The login token is pasted in the UI.
  // apiKey: the Voice Agents API key. Used for calls, transcripts and recordings (see lib/sarvamRest.js); it can't read prompts.
  sarvam: { orgId: process.env.SARVAM_ORG_ID || '', workspaceId: process.env.SARVAM_WORKSPACE_ID || '', apiKey: process.env.SARVAM_API_KEY || '' },
};
