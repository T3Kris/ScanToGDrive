import { config } from './config.js';

/**
 * Simple shared-secret auth for the dashboard and API. The key may be supplied
 * via the `x-api-key` header or `?apiKey=` query string (the latter so the
 * WebSocket, which cannot set headers easily from the browser, can authenticate).
 *
 * If DASHBOARD_API_KEY is not configured, access is open — intended only for
 * trusted-network deployments. A warning is logged at startup in that case.
 */
export function requireApiKey(req, res, next) {
  if (!config.dashboardApiKey) return next();
  const provided = req.get('x-api-key') || req.query.apiKey;
  if (provided && timingSafeEqual(provided, config.dashboardApiKey)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

export function isAuthorized(apiKey) {
  if (!config.dashboardApiKey) return true;
  return Boolean(apiKey) && timingSafeEqual(apiKey, config.dashboardApiKey);
}

// Constant-time-ish comparison to avoid leaking key length/contents via timing.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
