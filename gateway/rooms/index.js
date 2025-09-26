// Public entry for the rooms subsystem
import * as Protocols from './protocols/index.js';
import Dispatcher, { decideRooms, runRooms } from './controllers/dispatcher.js';
import { runTask } from './runners/scheduler.js';
import { createWatchdog } from './runners/watchdog.js';
import brainstorm from './impl/brainstorm.js';
import consensus from './impl/consensus.js';

export const rooms = { brainstorm, consensus };

export function defaultDeps(overrides = {}) {
  return {
    rooms,
    llm: overrides.llm, // optional adapter
    search: overrides.search, // optional adapter
    clock: { now: () => new Date().toISOString() },
    memory: overrides.memory || {
      getWorking: async () => ({}),
      setWorking: async () => {},
    },
    models: overrides.models || {
      spawn: async () => ({}),
      dispose: async () => {},
    },
    testers: overrides.testers || { quickHypothesisTest: null },
  };
}

export {
  Protocols,
  Dispatcher,
  decideRooms,
  runRooms,
  runTask,
  createWatchdog,
};
export default {
  Protocols,
  Dispatcher,
  decideRooms,
  runRooms,
  runTask,
  rooms,
  defaultDeps,
  createWatchdog,
};
