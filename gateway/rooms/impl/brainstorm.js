// Brainstorm room: generate a small set of candidate ideas.
export async function brainstorm(task, deps = {}) {
  const { llm } = deps;
  // If an llm adapter exists, use it; otherwise return simple ideas.
  if (llm && typeof llm.generateIdeas === 'function') {
    return await llm.generateIdeas(task.goal, 5);
  }
  const base = task.goal.trim();
  return [
    `Decompose: ${base}`,
    `Research: ${base}`,
    `Draft solution: ${base}`,
    `Validate assumptions: ${base}`,
    `Summarize path: ${base}`,
  ];
}

export default brainstorm;
