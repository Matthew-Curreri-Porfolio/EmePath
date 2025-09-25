// gateway/usecases/models.js
import { listModelsOpenAI } from '../lib/llm.js';

export async function getModels() {
  // Return OpenAI-style list response; proxy upstream when available
  return await listModelsOpenAI();
}
