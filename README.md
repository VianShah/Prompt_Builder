# Prompt Builder for Kollect

A web app, run as its own Render service, for the collections voice agents that the Kollect dashboard calls through Sarvam. With it you can:

- **Sync** the live Sarvam agents from Kollect's agent library.
- **Import** each agent's live prompt once. The text is regrouped into 13 standard sections without being reworded.
- **Improve** a prompt from UAT, founder or client feedback. Feedback can be pasted text, Excel, CSV or Word. Each item is mapped to the section and block that causes it, then fixed with an AI draft or by hand. Each fix is saved as a new draft version.
- **Approve** versions. The author can't approve their own version.
- **Take it live.** Paste the approved text into Sarvam and commit it. The builder then checks through Kollect that the new Sarvam version exists and pins it, so Kollect calls exactly that version. Rollback re-pins the previous version.
- **Create** new prompts from the block library using a 10-step wizard: client, bucket, policy, compliance, persona, data mapping, knowledge base, assembly, validation and save.

The stack matches Kollect-StateMachine: Node and Express, a plain HTML/JS front end with no build step, and the same LLMs (GLM 5 on Bedrock, with Gemini as fallback). Data is stored in Render Postgres.

## How it connects

```
Prompt Builder (this service) ──server-side──► Kollect dashboard (existing Render service)
   │                                              GET  /api/agent-catalog      (agents, Sarvam appId/version, variables)
   │                                              GET  /api/agent-versions     (latest / pinned Sarvam version)
   │                                              POST /api/agent-versions     (pin a version = go live / roll back)
   ├── Render Postgres (prompts, versions, feedback, approvals, audit)
   └── GLM 5 (Bedrock) → Gemini   (feedback mapping, fix drafts, prompt review, KB drafts, import grouping)
```

**What isn't automatic, and why.** Sarvam's API key can't read or write an agent's instructions. Kollect's own `agentVersions.js` notes that the key can't even list versions. Sarvam only exposes agent editing through its MCP server, which needs a browser login every 24 hours. So prompt text moves between Sarvam and the builder by copy and paste: once at import, and once per approved version. The version check, pin and rollback after that are automatic. Everything that touches Sarvam sits behind `SARVAM_PROMPT_PUSH`. If Sarvam gives you API access to app instructions, a `sarvam` mode can be added in `server/routes/prompts.js` (`go-live`) without changing the UI.

## Deploy on Render

1. Push this folder to a GitHub repo, either a new one or a `prompt-builder/` folder in Kollect-StateMachine. If it's a folder, set **Root Directory** to it.
2. In Render, choose **New → Blueprint** and pick the repo. `render.yaml` creates:
   - `prompt-builder`, a Node web service on the Starter plan, with the health check at `/healthz`.
   - `prompt-builder-db`, a Postgres database on the Basic plan. Render deletes free Postgres databases after 30 days.
3. When Render asks, fill in:
   - `BUILDER_USERS`: `email|Name|role|password`, comma-separated. Roles are `editor`, `approver` and `admin`.
   - `KOLLECT_BASE_URL`: the Kollect service URL, for example `https://kollect-xxxx.onrender.com`.
   - `GEMINI_API_KEY`: reuse Kollect's key. Add `GLM_BEDROCK_API_KEY` too if you've renewed it; the key noted in Kollect's config expired on 7 Oct 2026.
4. Open the service URL, sign in, go to **Live agents**, and click **Sync from Kollect**.

The database table is created on first start. There are no migrations to run.

## Connecting Sarvam on Render

Sarvam's sign-in only accepts callback addresses on `localhost` or addresses Sarvam has allow-listed, so **Connect Sarvam** fails on a Render URL ("Sarvam doesn't allow signing in from this address"). Two ways around it:

1. Ask Sarvam to allow-list `https://<your-service>.onrender.com/api/sarvam/callback`, then use **Connect Sarvam** as normal.
2. Use a login made on your own computer: run the builder locally, click **Connect Sarvam**, then run `npm run export-sarvam` and copy the one line it prints. On the Render site, open **Agents**, paste it into **Use the login from your computer** and click **Use this login**. The refresh token in the line keeps it signed in. Don't keep using the same login from both places at once: if a refresh on one side replaces the token, export again.

## First week of use

1. **Live agents → Import live prompt** for each agent. In Sarvam, copy everything from Canvas → Instructions and paste it in. The import is marked live at the Sarvam version Kollect calls.
2. **Improve from feedback**: drop the UAT sheet in, then click **Map new items to sections**. For each item, **Draft fix** or **Edit by hand**, then **Apply as new draft version**, then **Send for approval**.
3. **Approvals**: an approver reviews the diff and approves. Then **Copy prompt**, paste it into Sarvam, commit it, and click **Confirm live**. Leave **Pin it in Kollect** ticked.
4. If something goes wrong, open the version table in **Improve from feedback** and click **Roll back to this** on the previous live version.

## Local development

```bash
npm install
cp .env.example .env          # leave DATABASE_URL empty to use data/store.json
npm run mock-kollect          # stand-in Kollect on :3009 (CATALOG=…/agentCatalog.json uses the real catalog)
npm run dev                   # http://localhost:3002
```

`npm run smoke` runs a 30-step end-to-end test against a running server and the mock. It covers sync, import, feedback, mapping, approval rules, go-live, pin and rollback. To exercise the AI paths without real keys, set `GLM_BEDROCK_BASE_URL=http://localhost:3009/openai/v1` and `GLM_BEDROCK_API_KEY=test`. The mock answers like an OpenAI-compatible model.

## Layout

```
server/
  index.js            Express app, auth gate, static files
  config.js           Env (users, Kollect, LLMs)
  db.js               Document store: Postgres (docs table, jsonb) or a JSON file locally
  auth.js             Signed-cookie sessions; roles editor/approver/admin
  lib/kollect.js      Kollect adapter (catalog, versions, pin)
  lib/llm.js          GLM 5 → Gemini JSON completions with fallback
  lib/aiTasks.js      Prompts for mapping, drafting, review, KB, import grouping (+ rule fallbacks)
  routes/agents.js    Sync, Sarvam version check, unpin, import
  routes/prompts.js   Prompts, versions, approvals, go-live, rollback, audit
  routes/feedback.js  Feedback items, mapping, drafts, apply
  routes/ai.js        Review and KB drafting
shared/
  blocks.js           Block library, presets, layers (used by server and browser)
  promptcore.js       Assembly, markdown, validation, diff, feedback and import heuristics
public/               index.html, css/app.css, js/app.js
scripts/              mockKollect.js, smoke.js
```

## Security notes

- Every `/api` route needs a signed-in user. Passwords live only in `BUILDER_USERS` on Render, never in the database.
- **Kollect's `/api/agent-versions` POST has no authentication today.** Anyone who knows the URL can change which Sarvam version Kollect calls. `docs/kollect-integration.md` has a short patch that requires a shared key. Set the same value as `KOLLECT_API_KEY` here.
- Prompts can contain client names and policy details. Share the service URL only with the team.
