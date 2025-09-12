// gateway/usecases/models.js
import { listModels } from '../lib/llm.js';

export async function getModels() {
  return await listModels();
}
