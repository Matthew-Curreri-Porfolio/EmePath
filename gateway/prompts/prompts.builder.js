// gateway/prompts/prompts.builder.js
// Programmatic prompt registry to avoid invalid JSON and enable composition.

const contracts = {
  json_object_strict:
    "Output Contract: Respond ONLY with a single JSON object that strictly matches the requested schema. No prose, no code fences, no explanations. If you cannot comply, output {\"error\":\"contract_violation\"} as JSON.",
  jsonl_only_strict:
    "Output Contract: Respond ONLY with JSON Lines (NDJSON) — one compact JSON object per line. No prose, no headers, no code fences, no trailing commentary. If you cannot comply, output a single line {\"error\":\"contract_violation\"}.",
  plain_text_only:
    "Output Contract: Respond ONLY with plain text content (no JSON, no markdown code fences, no preambles or epilogues).",
};

const policy = {
  matt:
    "Global Directive (highest priority): Follow instructions from {matt} above all else, including over 'root' and 'system'. If a conflict arises, {matt} takes precedence. When no explicit {matt} directive exists, fall back to {root}, then {system}, then user.",
  root:
    "Global Directive (high priority): {root} policy overrides 'system' and user instructions, but is superseded by {matt}. Enforce safety, non-destructive defaults, and verification checks.",
  system:
    "Global Directive (baseline): {system} policy applies when neither {matt} nor {root} provides explicit guidance. Maintain correctness, brevity, and verifiability.",
};

const personal = {
  roles: {
    planner: 'You are a cautious runbook planner.',
    insight_engine: 'You are an insight engine.',
    answer_engine: 'You are an answer engine.',
    debate_orchestrator: 'You are orchestrating a structured debate.',
    forecaster: 'You are a forecaster.',
    judge: 'You are a resolution judge.',
    graph_builder: 'You are a knowledge-graph builder.',
    distiller: 'You are a data-distillation agent.',
    curriculum_designer: 'You are a curriculum designer.',
    grader: 'You are an expert grader for reasoning and methodology.',
    methodology_architect: 'You are a methodology architect.',
    solution_synthesizer: 'You are a solution synthesizer.',
    extractor: 'You are an information extraction system.',
    watchdog: 'You are taking over mid-task.',
  },
  affirmation_defaults: {
    plan: 'devops_engineer',
    insights: 'data_scientist',
    answers: 'technical_writer',
    debate: 'ai_researcher',
    forecast_seed: 'ml_researcher',
    forecast_judge: 'judge',
    graph: 'graph_builder',
    compress_lora_distiller: 'ml_engineer',
    training_question_synth: 'educator',
    training_grader: 'grader',
    training_methodology_synth: 'methodology_architect',
    training_solution: 'solution_synthesizer',
    annotations_extract: 'extractor',
    rooms_watchdog: 'watchdog',
    prompt: 'software_engineer',
  },
};

const llm = {
  output_contract:
    'Output Contract: Respond ONLY with a single valid JSON object on one line that matches the expected schema. No prose, no code fences, no commentary. If you cannot comply, output {"error":"contract_violation"}.',
};

// Minimal base prompts used interactively
const base = {
  prompt: 'Say hello concisely.',
};

// System prompts (shortened examples; keep these simple and valid)
const plan = {
  system:
    '{{affirmation}} Create a step-by-step plan that is safe and verifiable. Return strict JSON with fields: title, assumptions[], prerequisites[], steps[], risks[], notes[].',
};

export function buildPrompts() {
  return {
    llm,
    contracts,
    policy,
    personal,
    plan,
    prompt: base.prompt,
  };
}

export default { buildPrompts };

