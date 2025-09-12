export function makeOutcome({ taskId, status = 'success', artifacts = {}, rationale = '', metrics = {}, consensus = null }) {
  return { taskId, status, artifacts, rationale, metrics, consensus };
}

export default { makeOutcome };

