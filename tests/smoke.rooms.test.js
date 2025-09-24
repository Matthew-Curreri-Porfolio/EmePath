// Minimal smoke test for rooms flow: brainstorm -> consensus
import { Protocols, runTask, defaultDeps } from '../index.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

async function main() {
  const task = Protocols.makeTask({ id: 't1', goal: 'Plan a simple feature rollout with minimal risk' });
  const deps = defaultDeps();
  const outcome = await runTask(task, deps);
  assert(outcome && outcome.status === 'success', 'Outcome should be success');
  assert(outcome.artifacts && outcome.artifacts.decision, 'Decision should exist');
  console.log('rooms smoke ok:', JSON.stringify({ status: outcome.status, decision: outcome.artifacts.decision }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('rooms smoke failed:', e); process.exit(1); });
}

export default main;
