export function makeTask({
  id,
  userId,
  goal,
  inputs = {},
  constraints = {},
  priority = 'normal',
  metadata = {},
}) {
  return { id, userId, goal, inputs, constraints, priority, metadata };
}

export default { makeTask };
