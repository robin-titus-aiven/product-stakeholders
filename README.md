# Stakeholder map webapp

Internal "who owns what" view for Developer Services, Platform, and Data Services.
Reads from the **All Product Delivery Teams** Notion database — Notion is the
source of truth; this app is a read-only visual layer on top of it (Cards / Tree /
Canvas views, same as the earlier static prototype).

Scope: only rows where `Domain` is Developer Services, Platform, or Data Services.
Design and Programs & Product Delivery Ops are intentionally excluded.

## How it works

- `sync.js` queries the Notion data source and resolves every referenced
  person (Domain Lead, Director, Product Manager, Engineering Manager,
  Product Designer, Tech Writer) to a name + email via the Notion Users API.
- `slack.js` looks each of those people up in Slack by email
  (`users.lookupByEmail`) and grabs their Slack profile photo. This runs on
  its own, much longer schedule (default weekly) since profile photos
  barely change and it's a per-person API call.
- `server.js` runs the Notion sync every `SYNC_INTERVAL_MS` (default 15 min)
  and the Slack avatar refresh every `SLACK_AVATAR_REFRESH_MS` (default 7
  days), merges the two into one cache, and serves it at
  `GET /api/stakeholders`. **Slack photo wins when both exist** — since
  almost nobody has a Notion profile picture, this is what actually shows
  up. If someone has no Slack photo either, it falls back to Notion's, then
  to nothing (the frontend shows the dashed placeholder). It also serves the
  frontend from `public/`.
- `public/index.html` is the frontend — it fetches `/api/stakeholders` on
  load (and every 5 minutes) and renders it as Cards, a Tree, or a
  pan/zoomable Canvas org chart. No credentials of any kind ever reach the
  browser.

Endpoints:
- `GET /api/stakeholders` — the current merged snapshot
- `GET /api/health` — `{ ok, lastNotionError, lastSlackError, generatedAt, rowCount, slackAvatarsUpdatedAt }`
- `POST /api/refresh` — force an immediate Notion re-sync
- `POST /api/refresh-avatars` — force an immediate Slack avatar refresh


## Preview without any Notion setup at all

There's a `snapshot.json` in this folder — a real one-time capture of the
current Notion data — so you can see the whole app before creating any
integration or token:

```
npm install
SNAPSHOT_FILE=./snapshot.json node server.js
```

Open http://localhost:8080. This never calls Notion; it just serves that
static file through the same API shape the real sync produces, so the
frontend behaves identically. It's a point-in-time snapshot, not live —
switch to the real `NOTION_TOKEN` setup below whenever you're ready.

## Local setup (live from Notion + Slack)

1. Create a Notion integration at https://www.notion.so/my-integrations
   (internal integration, no special capabilities needed beyond read content).
2. Share the **All Product Delivery Teams** database with that integration
   (••• menu on the database → Connections → add it).
3. Create a Slack app at https://api.slack.com/apps (or reuse one you have
   permission to add scopes to). Under **OAuth & Permissions**, add the bot
   scopes `users:read` and `users:read.email`, then install it to the Aiven
   workspace and copy the **Bot User OAuth Token** (starts with `xoxb-`).
4. Copy `.env.example` to `.env` and fill in `NOTION_TOKEN` and
   `SLACK_BOT_TOKEN`. The data source id is already filled in but double-check
   it if the database gets restructured.
5. Install and run:
   ```
   npm install
   node --env-file=.env server.js
   ```
6. Open http://localhost:8080

## Deploying to Aiven Runtime

Runtime builds from a GitHub repo and does **not** auto-deploy on push —
redeploy manually (see below).

1. Push this folder to a **private** GitHub repo (`.gitignore` already keeps
   `.env` and `snapshot.json` out).
2. In the Aiven Console, open your project → **Runtime** → **Deploy
   application**. Select the GitHub account, repository and branch, click
   **Next**, pick the `Containerfile` as the manifest and click **Scan**.
   Port 8080 (HTTP) is what the app listens on. Click **Deploy**.
3. **Add authentication before adding any secrets.** App → **Authentication**
   → **Add authentication method** (Aiven Identity, or an OIDC provider).
   Apps are public by default, and until the tokens are set the app serves no
   data, so this order keeps it from ever being public *with* data.
4. App → **Overview** → **Environment variables** → **Edit**: add
   `NOTION_TOKEN` and `SLACK_BOT_TOKEN` (mark both **Secret**) and
   `NOTION_DATA_SOURCE_ID` (plain variable). Saving redeploys the app.
5. Open `<app url>/api/health` — expect `ok: true`, `rowCount: 28`, and no
   `lastNotionError` / `lastSlackError`. Runtime logs should show
   `[notion] ok` and `[slack] ok`.
6. To ship later changes: push to the branch, then App → **Overview** →
   **Actions** → **Deploy latest commit**.

## Known data-scope decisions (as of this build)

- Console = renamed DevEx team, already reflected in Notion.
- IaC and Fleet are included even though they weren't in the original
  spreadsheet.
- Team/Product Area naming follows whatever's currently in Notion (e.g.
  "Identity and Access", "OEM Platform Delivery", "SRE (NA)") rather than
  the older spreadsheet names — Notion is treated as canonical.
- Profile photos come from Slack, not Notion, since almost nobody has a
  Notion profile picture. See "How it works" above for the fallback order.

