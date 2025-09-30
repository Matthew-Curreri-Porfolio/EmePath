// gateway/state.js
// In‑memory repo index state.

let REPO_INDEX = { root: null, files: [] };

export function getIndex() {
  return REPO_INDEX;
}

export function setIndex(idx) {
  REPO_INDEX = idx;
}
