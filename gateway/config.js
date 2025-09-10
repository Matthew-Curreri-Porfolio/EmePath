// gateway/config.js
// Centralised configuration values.

export const GATEWAY_TIMEOUT_MS = process.env.GATEWAY_TIMEOUT_MS || "300000";
export const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
export const MODEL = process.env.MODEL || "SimonPu/gpt-oss:20b_Q4_K_M";
export const MOCK = process.env.MOCK === "1";
export const VERBOSE = process.env.VERBOSE === "1";
export const LOG_BODY = process.env.LOG_BODY === "1";
export const THINK = process.env.THINK === "1";
export const TIMEOUT = process.env.TIMEOUT || 300000; // 5 minutes