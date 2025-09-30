// Minimal scheduler to run a task through the dispatcher with provided deps.
import { runRooms } from '../controllers/dispatcher.js';

export async function runTask(task, deps = {}) {
  return runRooms(task, deps);
}

export default { runTask };
