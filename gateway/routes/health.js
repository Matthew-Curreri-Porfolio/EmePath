// Tiny health route module for future express/fastify wiring.
export function healthHandler(req, res) {
  const ok = { status: 'ok' };
  if (res && typeof res.json === 'function') return res.json(ok);
  // fallback to Node http
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(ok));
}

export default { healthHandler };
