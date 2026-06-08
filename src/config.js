import dotenv from 'dotenv';

dotenv.config();

/**
 * Centralised, validated configuration loaded from environment variables.
 *
 * The service account credentials may be supplied either as a path to a JSON
 * file (GOOGLE_SERVICE_ACCOUNT_JSON pointing at a file) or as a raw / base64
 * encoded JSON string. We resolve both forms into a parsed object lazily via
 * loadServiceAccount() so that the rest of the app never has to care.
 */

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function asInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return n;
}

export const config = {
  // Google Cloud & service account
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  googleAdminEmail: process.env.GOOGLE_ADMIN_EMAIL,

  // Monitoring configuration
  monitorSenderEmail: optional('MONITOR_SENDER_EMAIL', '').toLowerCase(),
  monitorGroupEmail: optional('MONITOR_GROUP_EMAIL', '').toLowerCase(),

  // Gmail API
  pollingIntervalSeconds: asInt('GMAIL_POLLING_INTERVAL_SECONDS', 60),
  batchSize: asInt('GMAIL_BATCH_SIZE', 10),

  // Google Drive
  driveFolderName: optional('DRIVE_FOLDER_NAME', 'Email Attachments'),
  driveMaxFileSizeBytes: asInt('DRIVE_MAX_FILE_SIZE_BYTES', 104857600), // 100 MB

  // Group membership cache lifetime
  groupCacheTtlSeconds: asInt('GROUP_CACHE_TTL_SECONDS', 300),

  // Application
  nodeEnv: optional('NODE_ENV', 'development'),
  port: asInt('PORT', 8080),
  logLevel: optional('LOG_LEVEL', 'info').toLowerCase(),
  logBufferSize: asInt('LOG_BUFFER_SIZE', 1000),

  // Persistence
  stateFilePath: optional('STATE_FILE_PATH', './data/state.json'),

  // Dashboard authentication. If unset, the dashboard/API is open (only do
  // this behind a trusted network). Recommended: set DASHBOARD_API_KEY.
  dashboardApiKey: process.env.DASHBOARD_API_KEY,

  // OAuth scopes used for domain-wide delegated impersonation.
  scopes: {
    gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
    drive: ['https://www.googleapis.com/auth/drive'],
    // Needed to enumerate / verify Google Group membership via Admin SDK.
    directory: ['https://www.googleapis.com/auth/admin.directory.group.member.readonly'],
  },
};

/**
 * Validate that the configuration required to actually run the monitor is
 * present. Returns an array of human-readable problems (empty === valid).
 * We keep this non-throwing so the dashboard can still boot and display the
 * misconfiguration rather than crash-looping.
 */
export function validateConfig() {
  const problems = [];
  if (!config.googleServiceAccountJson) {
    problems.push('GOOGLE_SERVICE_ACCOUNT_JSON is not set (service account credentials).');
  }
  if (!config.googleAdminEmail) {
    problems.push('GOOGLE_ADMIN_EMAIL is not set (admin to impersonate for Admin SDK).');
  }
  if (!config.monitorSenderEmail) {
    problems.push('MONITOR_SENDER_EMAIL is not set (sender to filter on).');
  }
  if (!config.monitorGroupEmail) {
    problems.push('MONITOR_GROUP_EMAIL is not set (group to monitor).');
  }
  if (config.pollingIntervalSeconds < 10) {
    problems.push('GMAIL_POLLING_INTERVAL_SECONDS should be >= 10 to respect API quota.');
  }
  return problems;
}
