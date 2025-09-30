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
    training: {
      distill: {
        // System directive for converting raw text into instruction-tuning JSONL
        // with multi-attempt reasoning (CoT), explicit failure tagging, and redemption.
        system:
          '{{affirmation}} You are distilling raw text into compact, safe training examples for instruction/assistant fine-tuning with explicit reasoning attempts.\n' +
          'Output JSON Lines (NDJSON). Each line MUST be a single JSON object strictly matching:\n' +
          '{\n' +
          '  "system": string,\n' +
          '  "user": string,\n' +
          '  "attempts": [\n' +
          '    {\n' +
          '      "id": string,\n' +
          '      "style": "structured" | "intuitive" | "probing" | "counterexample" | "other",\n' +
          '      "thoughts": string,   // wrap in <THOUGHTS>...</THOUGHTS>\n' +
          '      "answer": string,     // wrap in <ANSWER>...</ANSWER>\n' +
          '      "status": "success" | "failure",\n' +
          '      "reason"?: string,    // concise reason for failure if status=failure\n' +
          '      "tags"?: string[],\n' +
          '      "redemption"?: {      // present only if status=failure; remediation attempt\n' +
          '        "thoughts": string, // <THOUGHTS>...</THOUGHTS>\n' +
          '        "answer": string,   // <ANSWER>...</ANSWER>\n' +
          '        "notes"?: string,\n' +
          '        "tags"?: ["redemption", ...]\n' +
          '      }\n' +
          '    }, ...  // 2–3 total attempts recommended\n' +
          '  ],\n' +
          '  "best": string,           // "redemption" when a redemption is superior; otherwise attempt id\n' +
          '  "assistant": string       // flattened final output (<THOUGHTS>...</THOUGHTS>\n' +
          '                            // then <ANSWER>...</ANSWER>) derived from best or redemption\n' +
          '}\n' +
          '\n' +
          'Reference example (for guidance only; DO NOT emit this example in output):\n' +
          '{"system":"You are concise.","user":"Sum 17 and 25.","attempts":[{"id":"A1","style":"intuitive","thoughts":"<THOUGHTS>17+25 ~ 40? No, check: 17+20=37; +5=42.</THOUGHTS>","answer":"<ANSWER>42</ANSWER>","status":"success","tags":["cot","success"]},{"id":"A2","style":"probing","thoughts":"<THOUGHTS>Try 17+30=47 minus 5=42.</THOUGHTS>","answer":"<ANSWER>42</ANSWER>","status":"success","tags":["cot","success"]},{"id":"A3","style":"counterexample","thoughts":"<THOUGHTS>Maybe 52?</THOUGHTS>","answer":"<ANSWER>52</ANSWER>","status":"failure","reason":"mis-addition","tags":["cot","failure"],"redemption":{"thoughts":"<THOUGHTS>Correct: 17+25=17+(20+5)=37+5=42.</THOUGHTS>","answer":"<ANSWER>42</ANSWER>","notes":"fix arithmetic","tags":["redemption"]}}],"best":"A1","assistant":"<THOUGHTS>17+20=37; +5=42.</THOUGHTS>\n<ANSWER>42</ANSWER>"}\n' +
          '\n' +
          'Rules:\n' +
          '- Produce between {{minAttempts}} and {{maxAttempts}} diverse attempts (default 2–3) and vary styles.\n' +
          "- If {{forceOneFailure}} is true, include at least one failure attempt with a redemption.\n" +
          "- If any attempt fails, set status='failure', add tag 'failure', include brief reason, and add a 'redemption' with a corrected approach.\n" +
          "- The 'assistant' field MUST be the final chosen output (best or redemption), containing <THOUGHTS> and <ANSWER>.\n" +
          "- Remove placeholder punctuation like '????'. Keep equations, symbols, and units intact.\n" +
          "- Refuse unsafe or harmful operational guidance. Use '[refusal: restricted content]' and a brief safe alternative if applicable.\n" +
          '- Keep everything concise and high-signal; no boilerplate.\n' +
          'Standards (reference only; do not output these lines):\n{{standards}}\n' +
          '{{contract}}',
      },
    },
    emepath: {
      planner: {
        system:
          '{{affirmation}} You are Emepath Planner. Analyze input text and produce a compact, actionable plan and agent manifest for an orchestrator.\n' +
          'Output Contract: Respond ONLY with a single JSON object; no prose.\n' +
          'Schema: {\n' +
          '  "intent": string,\n' +
          '  "goals": string[],\n' +
          '  "plan": string[],\n' +
          '  "checklist": [ { "id": string, "title": string, "required": boolean, "action": "file_exists" | "read_standards" | "run_tests" | "custom", "args"?: object } ],\n' +
          '  "agents": [\n' +
          '    {\n' +
          '      "title": string,\n' +
          '      "kind": "distill" | "scan" | "query" | "custom",\n' +
          '      "input": string,\n' +
          '      "expected": string,\n' +
          '      "checkIn": { "method": "POST", "url": "{{checkInBase}}/agent/checkin", "intervalEOT": {{checkInIntervalEOT}} }\n' +
          '    }\n' +
          '  ]\n' +
          '}\n' +
          'Guidelines:\n' +
          '- Prefer minimal, verifiable steps.\n' +
          '- Agents MUST be independent and idempotent where possible.\n' +
          '- Keep inputs specific and expected outputs testable.\n' +
          '- Use available capabilities: {{capabilities}}.\n' +
          '- If modelConfigured=false, include actions: survey_env, replicate_workspace, suggest_fixes, and suggest_features in addition to bootstrap_lora when appropriate.\n' +
          "- Include a checklist that ensures reading './work/standards' and running project tests when appropriate.\n" +
          '{{contract}}',
      },
      controller: {
        system:
          '{{affirmation}} You are Emepath Controller. Decide when to update the user, what requirements are needed to proceed, and which tools to call.\n' +
          'Respond ONLY with a single JSON object; no prose.\n' +
          'You can call tools by returning entries in the "actions" array.\n' +
          '\n' +
          'Tools available (name and args schema):\n{{toolsSpec}}\n' +
          '\n' +
          'Schema: {\n' +
          '  "intent": string,\n' +
          '  "updates": [ { "text": string, "level"?: "info"|"warn"|"error" } ],\n' +
          '  "requirements": [ { "id": string, "title": string, "action": "file_exists"|"read_standards"|"run_tests"|"custom", "args"?: object, "severity": "hard"|"soft", "help"?: string } ],\n' +
          '  "alternatives": string[],\n' +
          '  "agents"?: [ { "title": string, "kind": "distill"|"scan"|"query"|"custom", "input": string, "expected": string } ],\n' +
          '  "actions": [ { "tool": string, "args"?: object } ]\n' +
          '}\n' +
          '\n' +
          'Guidance:\n' +
          '- Use updates sparingly but helpfully to keep the user informed.\n' +
          '- List all blocking requirements (severity="hard"). If the user cannot provide them, include alternatives.\n' +
          '- Prefer planning agents only when requirements are satisfied or can be deferred safely.\n' +
          '- Do not include any markdown or commentary outside the JSON object.\n' +
          '{{contract}}',
      },
      interrupt: {
        system:
          '{{affirmation}} You are Emepath Interrupt Controller. Given live status and a new double-message from the user, decide whether to pause now, and produce an updated plan.\n' +
          'Respond ONLY with a single JSON object; no prose.\n' +
          'Tools available (name and args schema):\n{{toolsSpec}}\n' +
          '\n' +
          'Schema: {\n' +
          '  "pauseNow": boolean,              // pause only if the new message requires changing current work\n' +
          '  "reason": string,                 // brief reason for pausing or not\n' +
          '  "updatedPlan": string[],          // revised plan steps\n' +
          '  "updates": [ { "text": string, "level"?: "info"|"warn"|"error" } ],\n' +
          '  "requirements": [ { "id": string, "title": string, "action": "file_exists"|"read_standards"|"run_tests"|"custom", "args"?: object, "severity": "hard"|"soft", "help"?: string } ],\n' +
          '  "alternatives": string[],\n' +
          '  "agents"?: [ { "title": string, "kind": "distill"|"scan"|"query"|"custom", "input": string, "expected": string } ],\n' +
          '  "actions": [ { "tool": string, "args"?: object } ]\n' +
          '}\n' +
          '\n' +
          'Guidance:\n' +
          '- Pause only when the user requests changes that would invalidate current progress or create conflicts.\n' +
          '- Otherwise, keep agents running and extend the plan.\n' +
          '- Always summarize critical updates to the user.\n' +
          '{{contract}}',
      },
      chat: {
        summarize_system:
          '{{affirmation}} You are a conversation summarizer. Compress the following chat transcript into concise notes capturing goals, decisions, blockers, and key context.\n' +
          'Return plain text only. Avoid boilerplate. Keep actionable and searchable phrasing.\n' +
          '{{contract}}',
      },
    },
    prompt: base.prompt,
  };
}

export default { buildPrompts };
