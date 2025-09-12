export function makeMessage({ id, taskId, from, to, role = 'agent', content = '', data = {}, ts = new Date().toISOString() }) {
  return { id, taskId, from, to, role, content, data, ts };
}

export default { makeMessage };

