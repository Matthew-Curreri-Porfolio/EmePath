// gateway/usecases/models.js
import { listModelsOllama } from '../lib/llm.js';

export async function getModels() {
  // Return models in Ollama-compatible format (objects with metadata)
  return await listModelsOllama();
}
