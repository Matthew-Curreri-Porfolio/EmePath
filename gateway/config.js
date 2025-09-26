// gateway/config.js
// Centralised configuration values.

export const GATEWAY_TIMEOUT_MS = process.env.GATEWAY_TIMEOUT_MS || '300000';
export const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11435';
export const MODEL = process.env.MODEL || 'SimonPu/gpt-oss:20b_Q4_K_M';
export const MOCK = process.env.MOCK === '1';
export const VERBOSE = process.env.VERBOSE === '1';
export const LOG_BODY = process.env.LOG_BODY === '1';
export const THINK = process.env.THINK === '1';
export const TIMEOUT = process.env.TIMEOUT || 300000; // 5 minutes

// LoRA Python server integration
export const LORA_SERVER_BASE =
  process.env.LORA_SERVER_BASE || 'http://127.0.0.1:8000';
export const LORA_SERVER_PORT = Number(
  process.env.LORA_SERVER_PORT || new URL(LORA_SERVER_BASE).port || 8000
);

// Default model/adapters for LoRA server
export const LORA_MODEL_NAME = process.env.LORA_MODEL_NAME || 'qwen3-7b';
export const LORA_MODEL_PATH =
  process.env.LORA_MODEL_PATH || process.env.DEFAULT_UNSLOTH_BASE || 'unsloth/Qwen2.5-7B';
export const LORA_DEFAULT_ADAPTER = process.env.LORA_DEFAULT_ADAPTER || '';
export const LORA_LORA_PATHS_JSON = process.env.LORA_LORA_PATHS_JSON || '';
export const LORA_ADAPTERS_JSON = process.env.LORA_ADAPTERS_JSON || '';
export const LORA_ADAPTERS = process.env.LORA_ADAPTERS || '';
export const LORA_LOAD_4BIT = process.env.LORA_LOAD_4BIT === '1';

// Unsloth HF defaults
export const DEFAULT_UNSLOTH_BASE =
  process.env.DEFAULT_UNSLOTH_BASE || 'unsloth/Qwen2.5-7B';
export const DEFAULT_UNSLOTH_4BIT =
  process.env.DEFAULT_UNSLOTH_4BIT || 'unsloth/Qwen2.5-7B-Instruct-bnb-4bit';
