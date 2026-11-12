# Kollect integration notes

The builder uses three endpoints that **already exist** in Kollect-StateMachine (`server/routes/agentCatalog.js`), so Kollect needs no changes for it to work.

| Builder action | Kollect call |
|---|---|
| Sync from Kollect | `GET /api/agent-catalog`. Keeps agents with an `appId` (Sarvam). |
| Check Sarvam version / Confirm live | `GET /api/agent-versions?appId=…&refresh=1` |
| Confirm live with "Pin it in Kollect", Roll back | `POST /api/agent-versions { appId, version }` |
| Unpin | `POST /api/agent-versions { appId, version: null }` |

Notes:
- `variables` in `agentCatalog.json` is sometimes a real array and sometimes a Python-style string (`"['user_name', …]"`). The builder reads both. It's still worth normalising the file to real arrays.
- Pins are stored in `server/data/agentVersions.json`. On Render's free tier that file is wiped on every deploy, which means Kollect falls back to "latest". If you rely on pins for rollback, give Kollect a persistent disk or move pins into a database.
- Kollect's free-tier service sleeps. The first call after idle can take 30–50 seconds, and the builder waits up to 30 seconds. If a sync times out, click again.

## Recommended: protect the pin endpoint

`POST /api/agent-versions` changes which Sarvam version real calls use, and today it has no authentication. This patch to Kollect's `server/routes/agentCatalog.js` requires a shared key, except for requests coming from Kollect's own Agent Library page. That stops casual misuse; the full fix is login on Kollect.

```js
// at the top of the POST /agent-versions handler
const key = process.env.BUILDER_KEY;
const sameSite = (req.get('origin') || '').includes(req.get('host'));
if (key && !sameSite && req.get('x-builder-key') !== key) {
  return res.status(401).json({ error: 'Missing or wrong builder key.' });
}
```

Then set `BUILDER_KEY` on Kollect and the same value as `KOLLECT_API_KEY` on the builder.
