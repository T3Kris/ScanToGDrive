import { directoryClient } from './auth.js';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { withRetry } from './retry.js';

const log = createLogger('group');

/**
 * Resolves and caches the membership of the monitored Google Group via the
 * Admin SDK Directory API. Membership is used both to know which mailboxes to
 * poll and to verify that a recipient genuinely belongs to the group.
 */

let cache = { members: [], fetchedAt: 0 };

async function fetchMembers() {
  const directory = directoryClient();
  const members = [];
  let pageToken;
  do {
    // eslint-disable-next-line no-await-in-loop
    const res = await withRetry(
      () => directory.members.list({
        groupKey: config.monitorGroupEmail,
        maxResults: 200,
        pageToken,
        includeDerivedMembership: true,
      }),
      { onRetry: ({ attempt, delay }) => log.warn('Retrying group member fetch', { metadata: { attempt, delay } }) },
    );
    for (const m of res.data.members || []) {
      // Only mailboxes (users) can receive mail / own a Drive. Skip nested
      // groups' own entries but keep derived user members.
      if (m.email && (m.type === 'USER' || m.type === undefined)) {
        members.push(m.email.toLowerCase());
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return [...new Set(members)];
}

/** Return the group members, using a TTL cache to limit Admin SDK calls. */
export async function getGroupMembers({ force = false } = {}) {
  const ageMs = Date.now() - cache.fetchedAt;
  if (!force && cache.members.length && ageMs < config.groupCacheTtlSeconds * 1000) {
    return cache.members;
  }
  const members = await fetchMembers();
  cache = { members, fetchedAt: Date.now() };
  log.info('Refreshed group membership', {
    metadata: { group: config.monitorGroupEmail, memberCount: members.length },
  });
  return members;
}

/** Verify a single address is a member of the monitored group. */
export async function isGroupMember(email) {
  const members = await getGroupMembers();
  return members.includes(email.toLowerCase());
}
