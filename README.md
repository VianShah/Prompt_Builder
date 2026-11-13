# Prompt Builder for Sarvam voice agents

A web app, run as its own Render service, for improving the collections voice agents that run on Sarvam. It talks to Sarvam directly. Nothing else has to be running. With it you can:

- **Refresh** the agent list from your Sarvam workspace and **load** each agent's committed prompt (regrouped into 13 standard sections, never reworded).
- **Review calls**: every call per agent by date, with transcript and synced audio. Flag what went wrong and what should have happened.
- **Improve** a prompt from those flags or from UAT/client feedback. The AI finds the cause and drafts the fix; many fixes go into one draft.
- **Approve** versions (the author can't approve their own), push to a UAT agent first, then promote to the live agent.
- **Create** agents by cloning, or from the block and module library.

## How it connects

```
Prompt Builder (this service)
   ├── Sarvam Voice Agents MCP   read/write prompts, clone, commit (sign-in lasts ~24 hours)
   ├── Sarvam analytics REST     calls, transcripts, recordings (SARVAM_API_KEY, doesn't expire daily)
   ├── Render Postgres           prompts, versions, feedback, tests, modules, audit
   └── Claude (Bedrock) → GLM → Gemini   mapping, fix drafts, reviews
```

There is no Kollect connection. Going live means the builder writes the changed passages into the Sarvam agent and commits a new version; the agent runs its newest committed version. To go back to an older version, push its text again as a new version.

## Deploy on Render

1. Push this folder to GitHub. In Render choose **New → Blueprint**; `render.yaml` creates the web service and a Postgres database.
2. Add the environment variables listed in `.env.example`: `BUILDER_USERS`, `SARVAM_ORG_ID`, `SARVAM_WORKSPACE_ID`, `SARVAM_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK` (and optionally `GEMINI_API_KEY`, `GLM_BEDROCK_API_KEY`). `DATABASE_URL` and `SESSION_SECRET` are wired automatically.
3. Open the service URL, sign in, then sign in to Sarvam (below) and click **Refresh** on the Agents page.

The database starts empty and its table is created on first start. To bring over local work, see "Copy your local data to Render".

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

1. Sign in to Sarvam, click **Refresh**, then **Load all prompts**.
2. **Calls**: pick an agent and dates, flag mistakes, then use the fix flow to draft one combined fix.
3. **Approvals**: an approver reviews the change and approves. Push to UAT, test, then push to live.

## Local development

```bash
npm install
cp .env.example .env          # leave DATABASE_URL empty to use data/store.json
npm run dev                   # http://localhost:3002
```

## Layout

```
server/
  index.js            Express app, auth gate, static files
  config.js           Env (users, Sarvam, LLMs)
  db.js               Document store: Postgres (docs table, jsonb) or a JSON file locally
  auth.js             Signed-cookie sessions; roles editor/approver/admin
  lib/sarvam.js       Sarvam MCP client (prompts, clone, commit)
  lib/sarvamRest.js   Sarvam analytics REST (calls, transcripts, recordings)
  lib/llm.js          GLM 5 → Gemini JSON completions with fallback
  lib/aiTasks.js      Prompts for mapping, drafting, review, KB, import grouping (+ rule fallbacks)
  routes/agents.js    Refresh, load prompts, calls, import
  routes/prompts.js   Prompts, versions, approvals, go-live, push, audit
  routes/feedback.js  Feedback items, mapping, drafts, apply
  routes/ai.js        Review and KB drafting
shared/
  blocks.js           Block library, presets, layers (used by server and browser)
  promptcore.js       Assembly, markdown, validation, diff, feedback and import heuristics
public/               index.html, css/app.css, js/app.js
scripts/              import-local-data.js, export-sarvam-token.js
```

## Security notes

- Every `/api` route needs a signed-in user. Passwords live only in `BUILDER_USERS` on Render, never in the database.
- Prompts can contain client names and policy details. Share the service URL only with the team.
