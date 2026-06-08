import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('state');

/**
 * Lightweight persistent state.
 *
 * The spec calls for in-memory state with optional persistence for restart
 * recovery. Rather than pull in a native SQLite dependency (which complicates
 * builds on App Platform), we persist a small JSON document to disk. It tracks:
 *   - paused:            whether processing is suspended
 *   - startedAt:         service boot time; messages before this are ignored
 *                        (forward-looking only — no retroactive processing)
 *   - processedIds:      set of Gmail message IDs already handled (dedupe)
 *   - lastPollAt:        timestamp of the last completed poll cycle
 *   - lastActivityAt:    last time real work happened (email processed)
 *   - stats:             counters surfaced on the dashboard
 */

const DEFAULT_STATE = {
  paused: false,
  startedAt: null,
  lastPollAt: null,
  lastActivityAt: null,
  // Stored as an array on disk, hydrated into a Set in memory.
  processedIds: [],
  stats: {
    emailsProcessed: 0,
    attachmentsSaved: 0,
    attachmentsSkipped: 0,
    errors: 0,
  },
};

// Cap the processed-id history so the file does not grow unbounded.
const MAX_PROCESSED_IDS = 5000;

let state;
let processedSet;
let writeTimer = null;

function ensureDir() {
  const dir = path.dirname(config.stateFilePath);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function initState() {
  ensureDir();
  if (fs.existsSync(config.stateFilePath)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(config.stateFilePath, 'utf8'));
      state = { ...DEFAULT_STATE, ...loaded, stats: { ...DEFAULT_STATE.stats, ...loaded.stats } };
      log.info('Loaded persisted state', {
        metadata: { paused: state.paused, processedCount: state.processedIds.length },
      });
    } catch (err) {
      log.error('Failed to read state file; starting fresh', { metadata: { error: err.message } });
      state = structuredClone(DEFAULT_STATE);
    }
  } else {
    state = structuredClone(DEFAULT_STATE);
  }

  processedSet = new Set(state.processedIds);

  // Forward-looking only: record boot time the first time we ever start so we
  // can ignore any email that predates the service's existence.
  if (!state.startedAt) {
    state.startedAt = new Date().toISOString();
  }
  // Each process start advances the "watermark" used for Gmail queries so we
  // never reach back before this run began.
  state.bootAt = new Date().toISOString();
  persist();
  return getStatus();
}

function persist() {
  // Debounce writes; many small updates collapse into one disk write.
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      state.processedIds = [...processedSet].slice(-MAX_PROCESSED_IDS);
      fs.writeFileSync(config.stateFilePath, JSON.stringify(state, null, 2));
    } catch (err) {
      log.error('Failed to persist state', { metadata: { error: err.message } });
    }
  }, 250);
}

export function isPaused() {
  return state.paused;
}

export function setPaused(paused) {
  state.paused = paused;
  persist();
  log.info(paused ? 'Processing paused' : 'Processing resumed');
  return state.paused;
}

export function hasProcessed(messageId) {
  return processedSet.has(messageId);
}

export function markProcessed(messageId) {
  processedSet.add(messageId);
  state.lastActivityAt = new Date().toISOString();
  persist();
}

export function recordPoll() {
  state.lastPollAt = new Date().toISOString();
  persist();
}

export function incrementStat(name, by = 1) {
  if (state.stats[name] === undefined) state.stats[name] = 0;
  state.stats[name] += by;
  persist();
}

/**
 * The lower bound (epoch seconds) used in Gmail search queries. We never look
 * before the current process boot, guaranteeing forward-looking behaviour.
 */
export function getWatermarkEpochSeconds() {
  return Math.floor(new Date(state.bootAt).getTime() / 1000);
}

export function getStatus() {
  return {
    paused: state.paused,
    startedAt: state.startedAt,
    bootAt: state.bootAt,
    lastPollAt: state.lastPollAt,
    lastActivityAt: state.lastActivityAt,
    stats: { ...state.stats },
  };
}

export function getStats() {
  return { ...state.stats };
}
