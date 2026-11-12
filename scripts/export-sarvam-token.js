// Prints the Sarvam login this computer's builder holds, as one line you can paste into the deployed
// builder (Agents page > "Use a login from your computer"). Run it on the machine where "Connect Sarvam"
// works (localhost), after connecting:   npm run export-sarvam
//
// The line is a secret: anyone who has it can use your Sarvam login. Paste it, then clear your clipboard.
// Reads data/store.json (the local file store). It never changes anything.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'data', 'store.json');
let st;
try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('Could not read data/store.json. Run this in the folder where the builder runs locally.'); process.exit(1); }
const t = (st.settings || {})['sarvam-token'], c = (st.settings || {})['sarvam-oauth-client'];
if (!t || !t.token || !c || !c.clientId) { console.error('No Sarvam login here yet. Start the builder, open the Agents page and click Connect Sarvam first.'); process.exit(1); }
console.error('Note: a Sarvam login lasts about 24 hours and cannot be renewed. After that, sign in again and export a fresh line.');
const line = Buffer.from(JSON.stringify({ v: 1, clientId: c.clientId, redirectUri: c.redirectUri, token: t.token, refreshToken: t.refreshToken || null, expiresAt: t.expiresAt })).toString('base64');
console.error('Copy the next line (all of it) and paste it into the deployed builder:\n');
console.log(line);
