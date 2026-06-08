import fs from 'node:fs';
import { google } from 'googleapis';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('auth');

let cachedCredentials = null;

/**
 * Resolve the service account credentials from the GOOGLE_SERVICE_ACCOUNT_JSON
 * environment variable. Supports three forms:
 *   1. A path to a JSON file on disk.
 *   2. A base64-encoded JSON string.
 *   3. A raw JSON string.
 */
export function loadServiceAccount() {
  if (cachedCredentials) return cachedCredentials;

  const raw = config.googleServiceAccountJson;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not configured.');
  }

  let jsonText;
  if (raw.trim().startsWith('{')) {
    // Raw JSON.
    jsonText = raw;
  } else if (fs.existsSync(raw)) {
    // Path to a file.
    jsonText = fs.readFileSync(raw, 'utf8');
  } else {
    // Assume base64.
    try {
      jsonText = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON, a file path, or base64.');
    }
  }

  try {
    cachedCredentials = JSON.parse(jsonText);
  } catch {
    throw new Error('Failed to parse service account JSON.');
  }

  if (!cachedCredentials.client_email || !cachedCredentials.private_key) {
    throw new Error('Service account JSON is missing client_email or private_key.');
  }

  log.debug('Service account credentials loaded', {
    metadata: { clientEmail: cachedCredentials.client_email },
  });
  return cachedCredentials;
}

/**
 * Build a JWT auth client that impersonates `subject` (a user in the Workspace
 * domain) with the requested OAuth scopes. This is the mechanism behind
 * domain-wide delegation: the service account acts on behalf of the user.
 */
export function getImpersonatedAuth(subject, scopes) {
  const creds = loadServiceAccount();
  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes,
    subject,
  });
}

/** Gmail client impersonating the given mailbox owner. */
export function gmailClientFor(userEmail) {
  const auth = getImpersonatedAuth(userEmail, config.scopes.gmail);
  return google.gmail({ version: 'v1', auth });
}

/** Drive client impersonating the given mailbox owner. */
export function driveClientFor(userEmail) {
  const auth = getImpersonatedAuth(userEmail, config.scopes.drive);
  return google.drive({ version: 'v3', auth });
}

/** Admin SDK Directory client impersonating the configured admin. */
export function directoryClient() {
  const auth = getImpersonatedAuth(config.googleAdminEmail, config.scopes.directory);
  return google.admin({ version: 'directory_v1', auth });
}
