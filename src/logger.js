import { EventEmitter } from 'node:events';
import winston from 'winston';
import { config } from './config.js';

/**
 * Structured JSON logging built on Winston.
 *
 * In addition to writing to stdout (so DigitalOcean App Platform / Docker can
 * capture it), we keep an in-memory ring buffer of recent entries and emit a
 * "log" event for every entry. The dashboard WebSocket and the /api/logs
 * endpoint both consume these so the UI can tail logs live.
 */

export const logEvents = new EventEmitter();
// Avoid MaxListeners warnings when several WebSocket clients attach.
logEvents.setMaxListeners(0);

const ringBuffer = [];

function pushToBuffer(entry) {
  ringBuffer.push(entry);
  if (ringBuffer.length > config.logBufferSize) {
    ringBuffer.shift();
  }
  logEvents.emit('log', entry);
}

/**
 * Custom Winston transport that mirrors every log entry into the ring buffer
 * and event emitter. The shape matches the logging strategy in the spec:
 * { timestamp, level, service, message, metadata }.
 */
class BufferTransport extends winston.Transport {
  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    const { level, message, timestamp, service, ...rest } = info;
    const entry = {
      timestamp: timestamp || new Date().toISOString(),
      level: level.toUpperCase(),
      service: service || 'app',
      message,
      metadata: rest.metadata || stripWinstonInternals(rest),
    };
    pushToBuffer(entry);
    callback();
  }
}

// Winston injects Symbol-keyed internals; keep only plain own enumerable keys.
function stripWinstonInternals(rest) {
  const out = {};
  for (const key of Object.keys(rest)) {
    out[key] = rest[key];
  }
  return Object.keys(out).length ? out : undefined;
}

const baseLogger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console(),
    new BufferTransport(),
  ],
});

/**
 * Create a child logger bound to a service name. Usage:
 *   const log = createLogger('drive-upload');
 *   log.info('Attachment uploaded successfully', { recipient, filename });
 */
export function createLogger(service) {
  // Call sites pass a `{ metadata: {...} }` object as the second argument; we
  // spread it so the resulting log entry has a single, un-nested `metadata`
  // field (see the logging strategy in the spec / README).
  return {
    info: (message, extra = {}) => baseLogger.info({ message, service, ...extra }),
    warn: (message, extra = {}) => baseLogger.warn({ message, service, ...extra }),
    error: (message, extra = {}) => baseLogger.error({ message, service, ...extra }),
    debug: (message, extra = {}) => baseLogger.debug({ message, service, ...extra }),
  };
}

/** Return a snapshot of recent log entries, optionally filtered. */
export function getRecentLogs({ level, search, limit = 200 } = {}) {
  let entries = ringBuffer;
  if (level) {
    const wanted = level.toUpperCase();
    entries = entries.filter((e) => e.level === wanted);
  }
  if (search) {
    const needle = search.toLowerCase();
    entries = entries.filter((e) => JSON.stringify(e).toLowerCase().includes(needle));
  }
  return entries.slice(-limit);
}
