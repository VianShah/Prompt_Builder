# Prompt Builder for Sarvam voice agents

A web app, run as its own Render service, for improving the collections voice agents that run on Sarvam. It talks to Sarvam directly. Nothing else has to be running. With it you can:

- **Refresh** the agent list from your Sarvam workspace and **load** each agent's committed prompt (regrouped into 13 standard sections, never reworded).
- **Review calls**: every call per agent by date, with transcript and synced audio. Flag what went wrong and what should have happened.
- **Improve** a prompt from those flags or from UAT, founder or client feedback (text, Excel, CSV or Word). Each item is mapped to the section and block that causes it, then fixed with an AI draft or by hand.
- **Review and approve** versions. The review lists every change by section and line, marked Added, Removed, Modified or Replaced. The engineer who built the agent approves it (`SELF_APPROVE=true`, the default); set it to `false` to require a second person.
- **Take it live.** **Push and go live** writes only the changed passages into the agent through Sarvam's MCP server (dry run first) and commits a new Sarvam version. Push to the UAT agent first if one is linked. **Roll back** commits an older version's prompt again as a new Sarvam version.
- **Create** agents by cloning, or from the block and module library.

## How it connects

```
Prompt Builder (this service)
   ├── Sarvam Voice Agents MCP   read/write prompts, clone, commit (sign-in lasts ~24 hours)
   ├── Sarvam analytics REST     calls, transcripts, recordings (SARVAM_API_KEY, doesn't expire daily)
   ├── Render Postgres           prompts, versions, feedback, tests, modules, audit
   └── Claude (Bedrock) → GLM → Gemini   mapping, fix drafts, reviews
```

There is no Kollect connection. Going live commits a new Sarvam version, and the agent runs its newest committed version. Roll back commits an older version's prompt again as a new version.

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

### Library and New prompt

Each agent type (**Collections**, **Sales**) has its own library, on the **Library** page:

1. **Structure:** the Greeting plus the sections every prompt of that type has, marked required or optional. *Derive from agents* reads the live agents' prompts and proposes it; *Draft from documents* does the same from client documents (for a type with no live agents yet). An approver confirms it. It's saved as `library/skeletons/<type>.json`.
2. **Rules:** *Build from agents* reads every live agent of the type, splits each prompt into rules by section, merges near-duplicates across agents (keeping the other wordings), and saves them as draft entries that record which agents use them. *Add from documents* drafts rules from client documents. Engineers approve entries on their module page. Collections also lists the builder's built-in blocks in each section.

Set each agent's type under **Agents and their type** on the Library page.

**New prompt** has three steps:
1. **Client:** type, client, agent name, product, objective.
2. **Source:** a live agent (its greeting and rules fill the sections) or a clean slate (the structure, empty).
3. **Review:** the Greeting and every section. Add rules from the library, or **Use the best modules** (the AI picks the best-fitting rule per section and says why). **Refine** tailors a rule to this client and saves it to the library as a variant. Checks block saving while a required section is empty, a `[[placeholder]]` or `[CONFIRM: …]` is left, or a rule names another client. Save creates a draft; approve and push it as usual.

### Module library (in git)

Library entries are JSON files in `library/modules/<MODULE-ID>/<version>.json` and structures in `library/skeletons/<type>.json`, not in the database.

- **On Render:** set `GITHUB_TOKEN` (fine-grained token, *Contents: read and write* on this repo only) and `GITHUB_REPO`. The builder reads the library from the `module-library` branch at start, and every module save, approval or delete is a commit there. It's a separate branch so a module save doesn't redeploy the service. Merge `module-library` into `main` whenever you want the library in `main`.
- **On your computer:** leave `GITHUB_TOKEN` empty. Modules are written to `library/modules/` in this folder; commit them like any other change.
- Modules saved in the database before this change are copied into the library once, the first time it starts empty.
- If GitHub can't be reached at start, the builder still runs, but the Modules page shows the error and saving modules is refused until a restart.

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
3. **Approvals**: open **See changes**, read the change list, approve, then **Push and go live** (UAT first if linked).
4. If something goes wrong, click **Roll back to this** on the previous live version. It commits that version's prompt again in Sarvam.

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
  lib/llm.js          Claude (Bedrock) → GLM 5 → Gemini JSON completions with fallback (LLM_ORDER)
  lib/libraryStore.js Module library as JSON files in git (GitHub API on Render, local files otherwise)
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
