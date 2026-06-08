import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, validateConfig } from './config.js';
import { createLogger, logEvents, getRecentLogs } from './logger.js';
import { initState } from './state.js';
import { createApiRouter } from './routes.js';
import { isAuthorized } from './middleware.js';
import { startMonitor, stopMonitor } from './processor.js';

const log = createLogger('api-handler');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function main() {
  initState();

  const problems = validateConfig();
  if (problems.length) {
    log.warn('Service starting with configuration problems; monitor will not run until resolved', {
      metadata: { problems },
    });
  }
  if (!config.dashboardApiKey) {
    log.warn('DASHBOARD_API_KEY is not set — dashboard and API are unauthenticated. Set it for production.');
  }

  const app = express();
  app.use(express.json());

  // Health check for App Platform / load balancers (unauthenticated).
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use('/api', createApiRouter());

  // Serve the static dashboard.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const server = http.createServer(app);

  // WebSocket for live log streaming at /ws/logs.
  const wss = new WebSocketServer({ server, path: '/ws/logs' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    if (!isAuthorized(url.searchParams.get('apiKey'))) {
      ws.close(1008, 'Unauthorized');
      return;
    }
    // Send a backlog of recent entries on connect.
    ws.send(JSON.stringify({ type: 'backlog', logs: getRecentLogs({ limit: 200 }) }));
    const onLog = (entry) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'log', log: entry }));
      }
    };
    logEvents.on('log', onLog);
    ws.on('close', () => logEvents.off('log', onLog));
  });

  server.listen(config.port, () => {
    log.info('Server listening', { metadata: { port: config.port, env: config.nodeEnv } });
    startMonitor();
  });

  const shutdown = async (signal) => {
    log.info('Shutting down', { metadata: { signal } });
    await stopMonitor();
    server.close(() => process.exit(0));
    // Force-exit if connections linger.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
