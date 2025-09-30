// gateway/config.js
// Centralised configuration values.

import fs from 'fs';
import path from 'path';

const cwd = process.cwd();
const LOCAL_HF_REL = 'gateway/models/base/gpt-oss-20b-bf16';
const LOCAL_HF_PATH = path.resolve(cwd, LOCAL_HF_REL);
const HAS_LOCAL_HF = (() => {
  try {
    return fs.statSync(LOCAL_HF_PATH).isDirectory();
  } catch {
    return false;
  }
})();
const LOCAL_GGUF_REL =
  'gateway/models/base/gpt_unlocked/OpenAI-20B-NEO-Uncensored2-IQ4_NL.gguf';
const LOCAL_GGUF_PATH = path.resolve(cwd, LOCAL_GGUF_REL);
const HAS_LOCAL_GGUF = (() => {
  try {
    return fs.statSync(LOCAL_GGUF_PATH).isFile();
  } catch {
    return false;
  }
})();

const DEFAULT_MODEL_PATH =
  process.env.LORA_MODEL_PATH ||
  (HAS_LOCAL_HF ? LOCAL_HF_PATH : '') ||
  (HAS_LOCAL_GGUF ? LOCAL_GGUF_PATH : '') ||
  process.env.DEFAULT_UNSLOTH_BASE ||
  'unsloth/Qwen2.5-7B';

export const GATEWAY_TIMEOUT_MS = process.env.GATEWAY_TIMEOUT_MS || '120000';
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
export const LORA_MODEL_PATH = DEFAULT_MODEL_PATH;
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
