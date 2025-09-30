// project.config.js — Unified project configuration for EmePath + Gateway
// Customize these values; both the EmePath service and the Gateway will read them at runtime.

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

export default {
  gateway: {
    // Base URL for the Python LoRA server
    serverBase: process.env.LORA_SERVER_BASE || 'http://127.0.0.1:8000',
    // Base model directory (HF/Transformers layout: contains config.json, tokenizer.json, etc.)
    modelPath: DEFAULT_MODEL_PATH,
    modelName: process.env.LORA_MODEL_NAME || 'qwen3-7b',
    adaptersJson: process.env.LORA_ADAPTERS_JSON || '',
    adapters: process.env.LORA_ADAPTERS || '',
    load4bit: (process.env.LORA_LOAD_4BIT || '0') === '1',
    autoStart: (process.env.GATEWAY_AUTOSTART || '0') === '1',
  },
  emepath: {
    portStart: Number(process.env.EMEPATH_PORT_START || 51100),
    portEnd: Number(process.env.EMEPATH_PORT_END || 51199),
    watch: (process.env.EMEPATH_WATCH || '1') === '1',
    chatFallback: process.env.EMEPATH_CHAT_FALLBACK || 'guide', // or 'echo'
    launchGateway: (process.env.EMEPATH_LAUNCH_GATEWAY || '0') === '1',
  },
};
