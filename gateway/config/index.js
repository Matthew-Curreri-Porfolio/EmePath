// Minimal config normalization for early wiring
export const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || '3333', 10);
export const NODE_ENV = process.env.NODE_ENV || 'development';
export default { GATEWAY_PORT, NODE_ENV };
