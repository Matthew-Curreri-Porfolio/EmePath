import { getPrompt } from './index.js';

function boolEnv(name, def) {
  const v = String(process.env[name] || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return def;
}

function pickAffirmation() {
  let arr;
  try {
    // Lazy import to avoid re-reading JSON every call; getPrompt caches
    arr = JSON.parse(JSON.stringify(getPrompt('personal.affirmations')));
  } catch {}
  if (!Array.isArray(arr) || !arr.length) return '';
  const rand = boolEnv('PROMPT_PERSONAL_RANDOM', false);
  const idxEnv = process.env.PROMPT_PERSONAL_INDEX;
  let idx = Number.isFinite(Number(idxEnv)) ? Number(idxEnv) : 0;
  if (rand) idx = Math.floor(Math.random() * arr.length);
  idx = Math.max(0, Math.min(arr.length - 1, idx));
  return String(arr[idx] || '');
}

const ROLE_MAP = {
  'plan.system': 'planner',
  'insights.system': 'insight_engine',
  'answers.system': 'answer_engine',
  'debate.system': 'debate_orchestrator',
  'forecast.seed_system': 'forecaster',
  'forecast.judge_system': 'judge',
  'graph.system': 'graph_builder',
  'compress.lora_distiller': 'distiller',
  'training.distill.system': 'distiller',
  'emepath.planner.system': 'planner',
  'emepath.controller.system': 'planner',
  'emepath.interrupt.system': 'planner',
  'emepath.chat.summarize_system': 'planner',
  'training.question_synth': 'curriculum_designer',
  'training.grader': 'grader',
  'training.methodology_synth': 'methodology_architect',
  'training.solution': 'solution_synthesizer',
  'annotations.extract_system': 'extractor',
  'rooms.watchdog_directive': 'watchdog',
};

export function composeSystem(baseKey, vars = {}) {
  const includePolicy = boolEnv('PROMPT_INCLUDE_POLICY', true);
  const includePersonal = boolEnv('PROMPT_INCLUDE_PERSONAL', true);
  const names = {
    matt: process.env.MATT || 'matt',
    root: process.env.ROOT || 'root',
    system: process.env.SYSTEM || 'system',
  };
  const pieces = [];
  if (includePolicy) {
    const matt = getPrompt('policy.matt', names);
    const root = getPrompt('policy.root', names);
    const sys = getPrompt('policy.system', names);
    if (matt) pieces.push(matt);
    if (root) pieces.push(root);
    if (sys) pieces.push(sys);
  }
  // Determine affirmation to inject via {{affirmation}}
  let affirmation = '';
  if (includePersonal) {
    const roleKey = ROLE_MAP[baseKey];
    if (roleKey) {
      affirmation = getPrompt(`personal.roles.${roleKey}`) || '';
    }
    if (!affirmation) affirmation = pickAffirmation();
  }
  const base = getPrompt(baseKey, { ...vars, affirmation });
  if (base) pieces.push(base);
  return pieces.join('\n\n');
}

export default { composeSystem };
