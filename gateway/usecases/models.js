// gateway/usecases/models.js
import { DEFAULT_UNSLOTH_BASE, DEFAULT_UNSLOTH_4BIT } from '../config.js';

export async function getModels() {
  // LoRA server exposes only loaded models; we return a minimal OpenAI-style list
  const suggestions = [DEFAULT_UNSLOTH_BASE, DEFAULT_UNSLOTH_4BIT].filter(Boolean);
  const data = suggestions.map((id) => ({ object: 'model', id, owned_by: 'local' }));
  return { object: 'list', data };
}
