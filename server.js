const express = require('express');
const path = require('path');
const fs = require('fs');
const { buildSnapshot } = require('./sync');
const { resolveSlackAvatars } = require('./slack');

const PORT = process.env.PORT || 8080;
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 15 * 60 * 1000); // default 15 min
const SLACK_AVATAR_REFRESH_MS = Number(process.env.SLACK_AVATAR_REFRESH_MS || 7 * 24 * 60 * 60 * 1000); // default 7 days
const SNAPSHOT_FILE = process.env.SNAPSHOT_FILE; // e.g. ./snapshot.json — offline preview, skips Notion AND Slack entirely

// Two independently-refreshed caches, merged into one served response.
// Notion data changes often (people get added/reassigned) — check every 15 min.
// Slack profile photos barely ever change — checking weekly is plenty, and
// keeps us well clear of Slack's rate limits since it's one call per person.
let notionCache = { generatedAt: null, people: {}, rows: [] };
let slackAvatars = {}; // email -> avatarUrl
let slackAvatarsUpdatedAt = null;
let served = { generatedAt: null, people: {}, rows: [] }; // what /api/stakeholders actually returns
let lastNotionError = null;
let lastSlackError = null;

function composeServedCache() {
  const people = {};
  for (const [id, p] of Object.entries(notionCache.people)) {
    const slackUrl = p.email ? slackAvatars[p.email] : null;
    people[id] = { name: p.name, avatarUrl: slackUrl || p.notionAvatarUrl || null };
  }
  served = { generatedAt: notionCache.generatedAt, people, rows: notionCache.rows };
}

async function refreshNotion() {
  try {
    notionCache = await buildSnapshot();
    lastNotionError = null;
    composeServedCache();
    console.log(`[notion] ok — ${notionCache.rows.length} rows, ${Object.keys(notionCache.people).length} people, at ${notionCache.generatedAt}`);
  } catch (err) {
    lastNotionError = err.message;
    console.error('[notion] sync failed:', err.message);
    // keep serving the last good cache rather than wiping it out
  }
}

async function refreshSlackAvatarsCache() {
  try {
    const emails = Object.values(notionCache.people).map(p => p.email).filter(Boolean);
    if (emails.length === 0) return; // nothing to look up yet (e.g. before first Notion sync)
    slackAvatars = await resolveSlackAvatars(emails);
    slackAvatarsUpdatedAt = new Date().toISOString();
    lastSlackError = null;
    composeServedCache();
    console.log(`[slack] ok — resolved ${Object.values(slackAvatars).filter(Boolean).length}/${emails.length} avatars at ${slackAvatarsUpdatedAt}`);
  } catch (err) {
    lastSlackError = err.message;
    console.error('[slack] avatar refresh failed:', err.message);
    // keep serving whatever avatars we already had
  }
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stakeholders', (req, res) => {
  res.json(served);
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: !lastNotionError,
    lastNotionError,
    lastSlackError,
    generatedAt: served.generatedAt,
    rowCount: served.rows.length,
    slackAvatarsUpdatedAt,
  });
});

app.post('/api/refresh', async (req, res) => {
  await refreshNotion();
  res.json({ ok: !lastNotionError, lastNotionError, generatedAt: served.generatedAt });
});

app.post('/api/refresh-avatars', async (req, res) => {
  await refreshSlackAvatarsCache();
  res.json({ ok: !lastSlackError, lastSlackError, slackAvatarsUpdatedAt });
});

app.listen(PORT, async () => {
  console.log(`Stakeholder webapp listening on :${PORT}`);

  if (SNAPSHOT_FILE) {
    // Offline preview: load a static file once, never call Notion or Slack.
    const raw = fs.readFileSync(path.resolve(SNAPSHOT_FILE), 'utf8');
    served = JSON.parse(raw);
    console.log(`[snapshot] loaded ${served.rows.length} rows from ${SNAPSHOT_FILE} (offline preview, not calling Notion or Slack)`);
    return;
  }

  await refreshNotion();
  await refreshSlackAvatarsCache();
  setInterval(refreshNotion, SYNC_INTERVAL_MS);
  setInterval(refreshSlackAvatarsCache, SLACK_AVATAR_REFRESH_MS);
});
