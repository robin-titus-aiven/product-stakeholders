// slack.js — resolves Slack profile photos by email. Kept separate from the
// Notion sync because it changes far less often (people rarely update their
// photo) and Slack's users.lookupByEmail is a per-person call, so we run it
// on its own, much longer interval (default: weekly) rather than every
// Notion sync cycle.

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const CALL_DELAY_MS = 350; // stay well under Slack's rate limit for this method

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function lookupByEmail(email) {
  const url = `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } });
  const data = await res.json();
  if (!data.ok) {
    // user_not_found is expected for some people (e.g. contractors not in Slack) — not a hard error
    return null;
  }
  const profile = data.user?.profile || {};
  return profile.image_512 || profile.image_192 || profile.image_original || null;
}

/**
 * Resolves Slack avatars for a list of emails.
 * Returns { [email]: avatarUrl | null }
 */
async function resolveSlackAvatars(emails) {
  if (!SLACK_TOKEN) throw new Error('SLACK_BOT_TOKEN env var is not set');
  const uniqueEmails = [...new Set(emails.filter(Boolean))];
  const result = {};
  for (const email of uniqueEmails) {
    try {
      result[email] = await lookupByEmail(email);
    } catch (err) {
      console.warn(`[slack] lookup failed for ${email}: ${err.message}`);
      result[email] = null;
    }
    await sleep(CALL_DELAY_MS);
  }
  return result;
}

module.exports = { resolveSlackAvatars };
