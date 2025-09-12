export function makeConsensus({ roomId, members = [], method = 'majority', evidence = [], decision = {}, confidence = 0.6 }) {
  return { roomId, members, method, evidence, decision, confidence };
}

export default { makeConsensus };

