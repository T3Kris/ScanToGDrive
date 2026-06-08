import { config, validateConfig } from './config.js';
import { createLogger } from './logger.js';
import { getGroupMembers } from './group.js';
import {
  searchNewMessages,
  getMessage,
  getAttachmentData,
  collectAttachments,
  getSubject,
  getSender,
} from './gmail.js';
import { uploadAttachment } from './drive.js';
import {
  isPaused,
  hasProcessed,
  markProcessed,
  recordPoll,
  incrementStat,
  getWatermarkEpochSeconds,
} from './state.js';
import { sleep, isQuotaExceeded } from './retry.js';

const log = createLogger('email-monitor');

/**
 * The polling monitor. On an interval it:
 *   1. Lists members of the monitored group.
 *   2. For each member, searches their inbox for new mail from the sender.
 *   3. Extracts attachments and uploads them to that member's Drive.
 *
 * Forward-looking only: the Gmail query is bounded by a boot-time watermark and
 * a per-message dedupe set, so historical mail is never processed.
 */

let running = false;
let stopRequested = false;
// When Gmail quota is exhausted we back off until this time before polling.
let quotaPausedUntil = 0;

export function startMonitor() {
  if (running) return;
  const problems = validateConfig();
  if (problems.length) {
    log.error('Monitor not started due to configuration problems', { metadata: { problems } });
    return;
  }
  running = true;
  stopRequested = false;
  log.info('Email monitor started', {
    metadata: {
      sender: config.monitorSenderEmail,
      group: config.monitorGroupEmail,
      intervalSeconds: config.pollingIntervalSeconds,
    },
  });
  loop();
}

export async function stopMonitor() {
  stopRequested = true;
}

async function loop() {
  while (!stopRequested) {
    try {
      if (isPaused()) {
        log.debug('Skipping poll cycle: paused');
      } else if (Date.now() < quotaPausedUntil) {
        log.warn('Skipping poll cycle: waiting for Gmail quota reset', {
          metadata: { resumesAt: new Date(quotaPausedUntil).toISOString() },
        });
      } else {
        await pollOnce();
      }
    } catch (err) {
      incrementStat('errors');
      if (isQuotaExceeded(err)) {
        // Back off for 24h on quota exhaustion per the spec.
        quotaPausedUntil = Date.now() + 24 * 60 * 60 * 1000;
        log.error('Gmail API quota exceeded; pausing polling for 24h', {
          metadata: { error: err.message, resumesAt: new Date(quotaPausedUntil).toISOString() },
        });
      } else {
        log.error('Poll cycle failed', { metadata: { error: err.message } });
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(config.pollingIntervalSeconds * 1000);
  }
  running = false;
  log.info('Email monitor stopped');
}

async function pollOnce() {
  const watermark = getWatermarkEpochSeconds();
  const members = await getGroupMembers();
  log.debug('Polling group members', { metadata: { memberCount: members.length } });

  for (const member of members) {
    if (stopRequested || isPaused()) break;
    // eslint-disable-next-line no-await-in-loop
    await pollMailbox(member, watermark);
  }
  recordPoll();
}

async function pollMailbox(member, watermark) {
  let messages;
  try {
    messages = await searchNewMessages(member, watermark);
  } catch (err) {
    if (isQuotaExceeded(err)) throw err; // let the loop handle quota globally
    incrementStat('errors');
    log.error('Failed to search mailbox', { metadata: { recipient: member, error: err.message } });
    return;
  }

  for (const { id } of messages) {
    if (stopRequested || isPaused()) break;
    if (hasProcessed(id)) continue;
    // eslint-disable-next-line no-await-in-loop
    await processMessage(member, id);
  }
}

async function processMessage(recipient, messageId) {
  const startedAt = Date.now();
  let message;
  try {
    message = await getMessage(recipient, messageId);
  } catch (err) {
    incrementStat('errors');
    log.error('Failed to fetch message', { metadata: { recipient, emailId: messageId, error: err.message } });
    return;
  }

  const sender = getSender(message);
  const subject = getSubject(message);

  // Defensive re-check: the search query already filters by sender, but never
  // trust a single filter for an action that writes to a user's Drive.
  if (sender !== config.monitorSenderEmail) {
    log.warn('Skipping message: sender mismatch', { metadata: { recipient, emailId: messageId, sender } });
    markProcessed(messageId);
    return;
  }

  const attachments = collectAttachments(message);
  if (!attachments.length) {
    log.info('Message has no attachments; nothing to do', { metadata: { recipient, emailId: messageId, subject } });
    markProcessed(messageId);
    return;
  }

  const receivedAt = message.internalDate
    ? new Date(Number(message.internalDate)).toISOString()
    : undefined;

  let saved = 0;
  for (const att of attachments) {
    if (stopRequested) break;
    // eslint-disable-next-line no-await-in-loop
    const ok = await handleAttachment({ recipient, messageId, sender, subject, att, receivedAt });
    if (ok) saved += 1;
  }

  // Mark processed even if some attachments were skipped, so we don't reprocess
  // the whole message. Per-attachment failures are logged for troubleshooting.
  markProcessed(messageId);
  incrementStat('emailsProcessed');
  log.info('Finished processing email', {
    metadata: {
      recipient,
      sender,
      emailId: messageId,
      subject,
      attachmentsTotal: attachments.length,
      attachmentsSaved: saved,
      duration_ms: Date.now() - startedAt,
    },
  });
}

async function handleAttachment({ recipient, messageId, sender, subject, att, receivedAt }) {
  const startedAt = Date.now();

  if (att.size > config.driveMaxFileSizeBytes) {
    incrementStat('attachmentsSkipped');
    log.error('Attachment too large; skipping', {
      metadata: { recipient, emailId: messageId, filename: att.filename, fileSize: att.size, limit: config.driveMaxFileSizeBytes },
    });
    return false;
  }

  try {
    const buffer = await getAttachmentData(recipient, messageId, att.attachmentId);
    const { fileId, name } = await uploadAttachment({
      userEmail: recipient,
      filename: att.filename,
      mimeType: att.mimeType,
      buffer,
      receivedAt,
    });
    incrementStat('attachmentsSaved');
    log.info('Attachment uploaded successfully', {
      metadata: {
        emailId: messageId,
        sender,
        recipient,
        subject,
        filename: name,
        fileSize: buffer.length,
        driveFileId: fileId,
        duration_ms: Date.now() - startedAt,
      },
    });
    return true;
  } catch (err) {
    incrementStat('errors');
    incrementStat('attachmentsSkipped');
    log.error('Failed to upload attachment', {
      metadata: { recipient, emailId: messageId, filename: att.filename, error: err.message, duration_ms: Date.now() - startedAt },
    });
    return false;
  }
}

export function isRunning() {
  return running;
}
