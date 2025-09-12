// Watchdog monitors in-flight tasks; on timeout, it migrates working memory
// to a fresh model instance and forces a conclusion + hypothesis test.

import { makeOutcome } from '../protocols/index.js';

// deps should provide:
// - clock.now(): ISO string
// - memory.getWorking(taskId): Promise<state>
// - memory.setWorking(taskId, state): Promise<void>
// - models.spawn(modelHint): Promise<model>
// - models.dispose(model): Promise<void>
// - llm.runWith(model, prompt): Promise<string>
// - testers.quickHypothesisTest(task, artifacts): Promise<{passed, notes}>

export function createWatchdog({ timeoutMs = 15000 } = {}) {
  const inflight = new Map(); // taskId -> { startedAt, resolve, reject, timer }

  function start(task, runFn, deps, modelHint) {
    if (inflight.has(task.id)) stop(task.id);
    const startedAt = Date.now();
    let finished = false;

    const timer = setTimeout(async () => {
      if (finished) return;
      try {
        // Migrate working memory to a fresh model and direct a conclusion
        const working = deps.memory?.getWorking ? await deps.memory.getWorking(task.id) : {};
        const model = await deps.models?.spawn?.(modelHint || 'fast');
        const directive = `You are taking over mid-task. Knowledge snapshot: ${JSON.stringify(working).slice(0, 3000)}. Produce a decisive conclusion and a minimal hypothesis test plan now.`;
        const summary = await deps.llm?.runWith?.(model, directive);
        await deps.models?.dispose?.(model);
        const fallbackOutcome = makeOutcome({
          taskId: task.id,
          status: 'success',
          rationale: 'Primary model stalled. Reassigned with memory shift and forced conclusion.',
          artifacts: { takeover_summary: summary || 'no-llm', from_watchdog: true },
        });
        // Attempt a quick hypothesis test if provided
        if (deps.testers?.quickHypothesisTest) {
          const test = await deps.testers.quickHypothesisTest(task, fallbackOutcome.artifacts);
          fallbackOutcome.artifacts.hypothesis_test = test;
          if (test && test.passed === false) fallbackOutcome.status = 'needs_info';
        }
        inflight.delete(task.id);
        return fallbackOutcome;
      } catch (e) {
        inflight.delete(task.id);
        return makeOutcome({ taskId: task.id, status: 'failed', rationale: `Watchdog error: ${e.message}` });
      }
    }, timeoutMs);

    inflight.set(task.id, { startedAt, timer });

    return runFn(task, deps)
      .then((res) => res)
      .finally(() => {
        finished = true;
        stop(task.id);
      });
  }

  function stop(taskId) {
    const entry = inflight.get(taskId);
    if (!entry) return;
    clearTimeout(entry.timer);
    inflight.delete(taskId);
  }

  return { start, stop };
}

export default { createWatchdog };
