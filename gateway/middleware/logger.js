// gateway/middleware/logger.js
// Custom JSON‑formatted request/response logger.
// It respects LOG_SILENT and LOG_BODY environment variables.

import { log } from '../utils.js';

export function requestLogger(req, res, next) {
  const silent =
    process.env.LOG_SILENT === '1' || process.env.LOG_SILENT === 'true';
  if (silent) return next();

  const start = Date.now();
  const { method, url, headers } = req;
  const body =
    process.env.LOG_BODY === '1' || process.env.LOG_BODY === 'true'
      ? req.body
      : undefined;

  res.on('finish', () => {
    const duration = Date.now() - start;
    log({
      event: 'http_request',
      method,
      url,
      status: res.statusCode,
      duration,
      headers,
      body,
      ts: new Date().toISOString(),
    });
  });

  next();
}
