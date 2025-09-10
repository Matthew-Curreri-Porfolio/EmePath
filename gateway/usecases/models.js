import { OLLAMA } from '../config.js';

// Returns a list of available models
export async function getModels() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`);
    if (!res.ok) {
      console.error(`Failed to fetch models from Ollama: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.models;
  } catch (error) {
    console.error('Error fetching models from Ollama:', error);
    return [];
  }
}
