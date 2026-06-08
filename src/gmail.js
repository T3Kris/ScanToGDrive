import { gmailClientFor } from './auth.js';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { withRetry } from './retry.js';

const log = createLogger('email-monitor');

/**
 * Gmail read helpers. Each call impersonates a specific mailbox owner so we
 * read messages from within that user's inbox.
 */

/**
 * Search a mailbox for new messages from the monitored sender after the given
 * epoch-seconds watermark. Returns an array of { id, threadId }.
 */
export async function searchNewMessages(userEmail, afterEpochSeconds) {
  const gmail = gmailClientFor(userEmail);
  // Gmail's `after:` operator takes epoch seconds. Combined with our in-memory
  // dedupe set this gives forward-looking, non-duplicated processing.
  const query = `from:${config.monitorSenderEmail} after:${afterEpochSeconds} has:attachment`;

  const res = await withRetry(
    () => gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: config.batchSize,
    }),
    { onRetry: ({ attempt, delay, error }) => log.warn('Retrying message list', { metadata: { userEmail, attempt, delay, error: error.message } }) },
  );

  return res.data.messages || [];
}

/** Fetch the full message payload for a given message id. */
export async function getMessage(userEmail, messageId) {
  const gmail = gmailClientFor(userEmail);
  const res = await withRetry(
    () => gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' }),
    { onRetry: ({ attempt, delay }) => log.warn('Retrying message get', { metadata: { userEmail, messageId, attempt, delay } }) },
  );
  return res.data;
}

/** Download and decode an attachment's bytes. */
export async function getAttachmentData(userEmail, messageId, attachmentId) {
  const gmail = gmailClientFor(userEmail);
  const res = await withRetry(
    () => gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId }),
    { onRetry: ({ attempt, delay }) => log.warn('Retrying attachment download', { metadata: { userEmail, messageId, attempt, delay } }) },
  );
  // Gmail returns URL-safe base64.
  return Buffer.from(res.data.data, 'base64url');
}

const HEADER_FROM = 'from';
const HEADER_SUBJECT = 'subject';

/** Extract a header value (case-insensitive) from a message payload. */
function header(payload, name) {
  const headers = payload?.headers || [];
  const found = headers.find((h) => h.name.toLowerCase() === name);
  return found?.value;
}

/** Pull the bare email address out of a "Name <addr@x>" header value. */
export function parseAddress(value) {
  if (!value) return '';
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim().toLowerCase();
}

/**
 * Walk the MIME tree and collect attachment parts. Returns an array of
 * { attachmentId, filename, mimeType, size }.
 */
export function collectAttachments(message) {
  const out = [];
  const visit = (part) => {
    if (!part) return;
    const isAttachment = part.filename && part.body?.attachmentId;
    if (isAttachment) {
      out.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: part.body.size || 0,
      });
    }
    for (const child of part.parts || []) visit(child);
  };
  visit(message.payload);
  return out;
}

export function getSubject(message) {
  return header(message.payload, HEADER_SUBJECT) || '(no subject)';
}

export function getSender(message) {
  return parseAddress(header(message.payload, HEADER_FROM));
}
