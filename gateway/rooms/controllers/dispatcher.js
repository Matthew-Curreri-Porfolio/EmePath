// Central entry for routing tasks to rooms.
import { makeOutcome } from '../protocols/index.js';

// Simple routing rules for now:
// - if goal length < 40: handle inline (no room)
// - else: send to brainstorm then consensus

export function decideRooms(task) {
  if (!task || !task.goal) throw new Error('invalid task');
  if (task.goal.length < 40) return ['inline'];
  return ['brainstorm', 'consensus'];
}

export async function runRooms(task, deps) {
  const plan = decideRooms(task);
  if (plan[0] === 'inline') {
    return makeOutcome({
      taskId: task.id,
      status: 'success',
      rationale: 'Trivial task handled inline',
      artifacts: { answer: task.goal },
    });
  }
  const { brainstorm, consensus } = deps.rooms;
  const ideas = await brainstorm(task, deps);
  const result = await consensus(task, ideas, deps);
  return result;
}

export default { decideRooms, runRooms };
