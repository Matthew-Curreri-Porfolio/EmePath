// Minimal protocol contracts to unblock early integration and smoke tests.

export function makeTask({
  id,
  userId,
  goal,
  inputs = {},
  constraints = {},
  priority = 0,
}) {
  if (!id || !goal) throw new Error('task requires id and goal');
  return { id, userId: userId || 'anon', goal, inputs, constraints, priority };
}

export function makeMessage({
  id,
  taskId,
  from,
  to,
  role = 'agent',
  content = '',
  data = {},
  ts,
}) {
  return {
    id: id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    from: from || 'system',
    to: to || 'room',
    role,
    content,
    data,
    ts: ts || new Date().toISOString(),
  };
}

export function makeOutcome({
  taskId,
  status = 'success',
  artifacts = {},
  rationale = '',
}) {
  return { taskId, status, artifacts, rationale };
}

export function makeConsensus({
  roomId,
  members = [],
  method = 'majority',
  evidence = [],
  decision = {},
}) {
  return { roomId, members, method, evidence, decision };
}

export default { makeTask, makeMessage, makeOutcome, makeConsensus };
