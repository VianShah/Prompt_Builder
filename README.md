# Prompt Builder for Kollect

A web app, run as its own Render service, for the collections voice agents that the Kollect dashboard calls through Sarvam. With it you can:

- **Sync** the live Sarvam agents from Kollect's agent library.
- **Import** each agent's live prompt once. The text is regrouped into 13 standard sections without being reworded.
- **Improve** a prompt from UAT, founder or client feedback. Feedback can be pasted text, Excel, CSV or Word. Each item is mapped to the section and block that causes it, then fixed with an AI draft or by hand. Each fix is saved as a new draft version.
- **Review and approve** versions. The review lists every change by section and line, marked Added, Removed, Modified or Replaced, so nobody has to read the whole prompt. The FDE or GTM engineer who built the agent approves it (`SELF_APPROVE=true`, the default). Set `SELF_APPROVE=false` to require a second person.
- **Take it live.** **Push and go live** writes only the changed passages into the agent through Sarvam's MCP server (dry run first), commits a new Sarvam version and checks the committed text. If Kollect is connected it also pins that version. **Roll back** re-pins the old version in Kollect when it can; otherwise it commits the old version's prompt again as a new Sarvam version (prompt text only; the greeting and settings stay as they are).
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

**Sarvam is the source of truth; Kollect is optional.** Reading prompts, pushing, committing, cloning agents and rollback all go through Sarvam's MCP server. Sarvam's API key can't edit prompts and Sarvam won't give that access, so the MCP sign-in is the only way in, and it lasts about 24 hours: sign in again each day (see below). Calls, transcripts and recordings use `SARVAM_API_KEY` and need no daily sign-in. Kollect, when `KOLLECT_BASE_URL` is set and its endpoints answer, only adds catalog details (client, stage, call counts) and version pins.

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

Sarvam's sign-in only returns to `localhost` unless Sarvam has allow-listed the address, so the normal **Connect Sarvam** button fails on a Render URL. On any address that isn't localhost, the Agents page shows a three-step sign-in that needs no allow-listing:

1. Click **Open Sarvam sign-in** (new tab) and approve.
2. The tab then lands on a page that can't be reached (`localhost:8976`). That's expected. Copy the whole address from its address bar.
3. Paste it into the box on the Agents page and click **Connect**. The address holds a one-time code that stops working once used.

Alternatives: ask Sarvam to allow-list `https://<your-service>.onrender.com/api/sarvam/callback` (then the normal button works), or sign in on your own computer, run `npm run export-sarvam`, and paste the line it prints under "Or use a login made on your own computer". Don't use the same login in both places at once.

The Sarvam login lasts about 24 hours and can't be renewed, so repeat the sign-in daily. Only two things need it: reading and pushing agent prompts, and the audio-synced transcript.

### Calls without the daily login

Set `SARVAM_API_KEY` (Sarvam > Voice Agents > Settings > API key) on Render. The Calls tab then lists calls, shows transcripts and plays recordings through that key, with no daily sign-in and without Kollect. It can't read prompts.

### Load all prompts

After signing in, **Load all prompts** on the Agents page copies every agent's committed prompt in the background, with a progress bar. It stops cleanly if the login lapses.

### Copy your local data to Render

Render's database starts empty. To bring over your local prompts, versions, feedback, tests and modules (never the Sarvam login):

```bash
DATABASE_URL="<External Database URL from Render>" npm run import-local            # dry run
DATABASE_URL="<External Database URL from Render>" npm run import-local -- --apply  # do it
```

Nothing deployed is overwritten unless you add `--replace` (see the top of `scripts/import-local-data.js`).

## First week of use

1. **Live agents → Import live prompt** for each agent. In Sarvam, copy everything from Canvas → Instructions and paste it in. The import is marked live at the Sarvam version Kollect calls.
2. **Improve from feedback**: drop the UAT sheet in, then click **Map new items to sections**. For each item, **Draft fix** or **Edit by hand**, then **Apply as new draft version**, then **Send for approval**.
3. **Approvals**: open **See changes**, read the change list (section, line, type), approve, then **Push and go live**. Push to the UAT agent first if one is linked.
4. If something goes wrong, open the version table and click **Roll back to this** on the previous live version. Without Kollect this commits that version's prompt again in Sarvam.

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
  lib/llm.js          Claude (Bedrock) → GLM 5 → Gemini JSON completions with fallback (LLM_ORDER)
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
