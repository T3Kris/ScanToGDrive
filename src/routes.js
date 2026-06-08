import express from 'express';
import { config, validateConfig } from './config.js';
import { getRecentLogs } from './logger.js';
import { getStatus, getStats, setPaused } from './state.js';
import { isRunning } from './processor.js';
import { requireApiKey } from './middleware.js';

/**
 * REST API consumed by the dashboard.
 *   GET  /api/status  - running/paused state + config summary
 *   GET  /api/stats   - counters
 *   GET  /api/logs    - recent logs (filter by level / search)
 *   POST /api/pause   - pause processing
 *   POST /api/resume  - resume processing
 */
export function createApiRouter() {
  const router = express.Router();
  router.use(requireApiKey);

  router.get('/status', (req, res) => {
    const problems = validateConfig();
    res.json({
      ...getStatus(),
      running: isRunning(),
      configured: problems.length === 0,
      configProblems: problems,
      config: {
        sender: config.monitorSenderEmail || null,
        group: config.monitorGroupEmail || null,
        driveFolderName: config.driveFolderName,
        pollingIntervalSeconds: config.pollingIntervalSeconds,
        maxFileSizeBytes: config.driveMaxFileSizeBytes,
      },
    });
  });

  router.get('/stats', (req, res) => {
    res.json(getStats());
  });

  router.get('/logs', (req, res) => {
    const { level, search, limit } = req.query;
    res.json({
      logs: getRecentLogs({
        level,
        search,
        limit: limit ? Math.min(Number(limit), 1000) : 200,
      }),
    });
  });

  router.post('/pause', (req, res) => {
    res.json({ paused: setPaused(true) });
  });

  router.post('/resume', (req, res) => {
    res.json({ paused: setPaused(false) });
  });

  return router;
}
