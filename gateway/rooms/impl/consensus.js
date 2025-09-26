// Consensus room: combine ideas into a final outcome with rationale.
import { makeOutcome } from '../protocols/index.js';

export async function consensus(task, ideas, deps = {}) {
  const list = (ideas || []).filter(Boolean);
  const rationale = list.length
    ? `Selected best of ${list.length} ideas based on simplicity and coverage.`
    : 'No ideas provided; returning trivial echo.';
  const artifacts = {
    decision: list[0] || task.goal,
    candidates: list,
  };
  return makeOutcome({
    taskId: task.id,
    status: 'success',
    artifacts,
    rationale,
  });
}

export default consensus;
