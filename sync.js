// sync.js — pulls the "All Product Delivery Teams" data source from Notion,
// resolves every referenced person to {name, avatarUrl}, and produces a
// normalized JSON shape the frontend can render directly.

const NOTION_VERSION = '2025-09-03';
const NOTION_API = 'https://api.notion.com/v1';

const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID; // e.g. a814a013-b5ca-4dd9-a1aa-a43ed96b5f57
const NOTION_TOKEN = process.env.NOTION_TOKEN;

// Only these domains are in scope for this webapp (Design & Programs excluded on purpose).
const INCLUDED_DOMAINS = new Set(['Developer Services', 'Platform', 'Data Services']);

function notionHeaders() {
  if (!NOTION_TOKEN) throw new Error('NOTION_TOKEN env var is not set');
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function queryAllRows() {
  if (!DATA_SOURCE_ID) throw new Error('NOTION_DATA_SOURCE_ID env var is not set');
  const rows = [];
  let cursor = undefined;
  do {
    const res = await fetch(`${NOTION_API}/data_sources/${DATA_SOURCE_ID}/query`, {
      method: 'POST',
      headers: notionHeaders(),
      body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
    });
    if (!res.ok) {
      throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    rows.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return rows;
}

// simple in-process cache so repeat syncs don't re-fetch the same user repeatedly
const userCache = new Map();

async function resolveUser(userId) {
  if (userCache.has(userId)) return userCache.get(userId);
  const res = await fetch(`${NOTION_API}/users/${userId}`, { headers: notionHeaders() });
  if (!res.ok) {
    // Deactivated/removed users, or permission issues — fail soft.
    const fallback = { id: userId, name: null, email: null, notionAvatarUrl: null };
    userCache.set(userId, fallback);
    return fallback;
  }
  const data = await res.json();
  const resolved = {
    id: userId,
    name: data.name || null,
    email: data.person?.email || null,
    notionAvatarUrl: data.avatar_url || null,
  };
  userCache.set(userId, resolved);
  return resolved;
}

function firstPersonId(prop) {
  const people = prop?.people;
  if (Array.isArray(people) && people.length > 0) return people[0].id;
  return null;
}

function allPersonIds(prop) {
  const people = prop?.people;
  return Array.isArray(people) ? people.map(p => p.id) : [];
}

function titleText(prop) {
  return prop?.title?.[0]?.plain_text || '';
}

function selectName(prop) {
  return prop?.select?.name || '';
}

function urlProp(prop) {
  return prop?.url || null;
}

async function buildSnapshot() {
  const pages = await queryAllRows();

  // collect every unique person id referenced across the relevant rows first
  const relevantPages = pages.filter(p => INCLUDED_DOMAINS.has(selectName(p.properties['Domain'])));
  const personIds = new Set();
  const roleProps = ['Domain Lead', 'Director', 'Product Manager', 'Engineering Manager', 'Product Designer', 'Tech Writer'];

  relevantPages.forEach(page => {
    roleProps.forEach(propName => {
      const id = firstPersonId(page.properties[propName]);
      if (id) personIds.add(id);
    });
    allPersonIds(page.properties['Members']).forEach(id => personIds.add(id));
  });

  // resolve people with modest concurrency (Notion allows ~3 req/s)
  const people = {};
  const idList = [...personIds];
  const CONCURRENCY = 3;
  for (let i = 0; i < idList.length; i += CONCURRENCY) {
    const batch = idList.slice(i, i + CONCURRENCY);
    const resolved = await Promise.all(batch.map(resolveUser));
    resolved.forEach(u => { people[u.id] = { name: u.name, email: u.email, notionAvatarUrl: u.notionAvatarUrl }; });
  }

  const rows = relevantPages.map(page => ({
    domain: selectName(page.properties['Domain']),
    domainLeader: firstPersonId(page.properties['Domain Lead']),
    area: selectName(page.properties['Product Area']),
    director: firstPersonId(page.properties['Director']),
    team: titleText(page.properties['Team']),
    pm: firstPersonId(page.properties['Product Manager']),
    em: firstPersonId(page.properties['Engineering Manager']),
    design: firstPersonId(page.properties['Product Designer']),
    tw: firstPersonId(page.properties['Tech Writer']),
    members: allPersonIds(page.properties['Members']),
    jiraUrl: urlProp(page.properties['Jira Project']),
    notionUrl: page.url,
  }));

  return { generatedAt: new Date().toISOString(), people, rows };
}

module.exports = { buildSnapshot };
