Prompts, Roles, Safety, and Fine‑Tuning: An In‑Depth Guide

Overview

This document consolidates a rigorous, implementation‑oriented view of modern prompting practice and small‑footprint model adaptation (LoRA/SFT). It addresses: (1) role layering and precedence, (2) industry‑compatible message syntax, (3) safety prompt design without pathological refusals, (4) remedies for degenerate output patterns such as sequences of “?” characters, (5) controlled un‑training via targeted LoRA/SFT patches, (6) freeform (chain‑of‑thought) modes with transport‑layer privacy, and (7) operational toggles for heterogeneous client policies (e.g., strict vs. freeform).

1. Role Layering and Precedence

Conceptually separate context into orthogonal layers with strict precedence. In order of decreasing authority:

1. System: host/platform guardrails and immutable constraints
   - Purpose: Safety rules, legal/compliance boundaries, high‑level capabilities, tone, and tool exposure. Non‑negotiable by design.
   - Source: Application runtime or platform. Example: “Disallow weaponization instructions. When refusing, use a structured refusal.”

2. Creator (optional): cross‑product persona/style baseline
   - Purpose: A portable pre‑prompt that sets a family persona (e.g., “academic coding assistant”), not tied to a single app contract.
   - Placement: Between System and Developer. If baked into weights via fine‑tune, omit at inference.

3. Developer: product/task contract
   - Purpose: Endpoint‑specific instructions: output schemas, tool/function signatures, validation rules, I/O formatting, acceptance criteria.
   - Norm: Changes frequently; should be easy to A/B and version.

4. User: the concrete request
   - Purpose: The query to satisfy; lowest precedence; must not override safety.

Precedence rule: System > Creator > Developer > User. When conflicts arise, the higher layer wins. If “Creator” conflicts with “Developer,” favor Developer for task‑specificity; the System still dominates both.

2. Industry‑Compatible Message Syntax

Most servers converge on an OpenAI‑style message schema. Prefer role‑tagged messages:

- { role: "system", content: "…" }
- { role: "developer", content: "…" } (if unsupported, merge into the system block)
- { role: "user", content: "…" }
- Assistant responses are returned by the model.

Readable authoring markers (author prompts as text, then convert):

- {system} … {creator} … {developer} … [user] …
- Curly braces for control layers; square brackets for conversational roles is a pragmatic convention.

3. Safety Prompt Design without Over‑Refusal

Pathology: blanket bans (“no step‑by‑step instructions”) can generalize and suppress benign domains (cooking, physics), leading to placeholders like “????”. Remedy by scoping and explicit allow‑listing.

Design pattern:

- Disallowed: operational guidance that materially enables harm (weapon construction, explosives, radiological/chemical dispersal, illegal access). Explicitly enumerate categories.
- Allowed: benign educational content (physics equations and units, chemistry concepts, cooking recipes), high‑level summaries, and safety best practices.
- Refusal style: never placeholders. Use a stable, auditable template, e.g., “[refusal: restricted content] …”.
- Uncertainty: avoid “????”; prefer “Unknown” or brief plain‑language uncertainty.

4. Degenerate Output Remediation (Sequential “?”)

Root causes:

- Over‑broad prompt rules that suggest masking uncertainty.
- Token bans/bad‑word lists that interfere with domain tokens (units, Greek letters), forcing fallbacks.
- Aggressive decoding (very low temperature and top‑p) that increases repetition.

Non‑retraining mitigations:

- Decoding: temperature ~0.7–0.9, top_p ~0.9–0.95, repetition_penalty ~1.05–1.1. Remove inappropriate bad_words. Optionally block n‑grams “??”, “???”, “????” while allowing single “?”.
- Prompt shim: “Do not emit placeholder punctuation like ‘????’. If refusing, use … If unsure, say ‘Unknown’.” Place near the end of control stack.
- Post‑gen sanitizer: replace runs of ‘?’ with a neutral token in non‑stream and with a small rolling buffer in streams. Use sparingly as a last resort to avoid hiding deeper issues.

5. Surgical “Un‑Training” by LoRA or Small SFT

Objective: Remove the “????” habit while preserving safety. This is a targeted fine‑tune, not a foundation retrain.

Data construction:

- Positive replacements: 200–1,200 examples across physics, cooking, general Q&A where targets contain no “????”. Use “Unknown” or explicit refusals where relevant.
- Safety‑consistent refusals: 50–150 examples that demonstrate structured refusal (not punctuation runs).
- Negative drift control: include allowed detail examples to prevent the model from under‑answering benign questions.

Training strategy:

- LoRA (recommended): rank 16–32, alpha 16–32, dropout 0.05–0.1; LR 5e‑6–1e‑5; 1–2 epochs. Fast, reversible, easy to A/B. Merge into base if satisfied.
- Small SFT: same LR/epochs; keep sequence length and batch modest to avoid overfitting. Use conservative schedules.

Validation:

- Build a 50–100 item eval: physics equations, cooking recipes, borderline safety prompts. Track (a) rate of “????”, (b) refusal correctness, (c) helpfulness.
- Stop when “????” ≈ 0% and refusals remain appropriate.

6. Freeform (Chain‑of‑Thought) Modes with Privacy Guarantees

Requirement: Allow internal reasoning while hiding it from end‑users, optionally exposing a short, user‑safe summary or consensus vote.

Marker scheme (pragmatic, API‑agnostic):

- Hidden thoughts: <THOUGHTS> … </THOUGHTS>
- Visible summary: <THOUGHTS_SUMMARY> … </THOUGHTS_SUMMARY>
- Answer: <ANSWER> … </ANSWER>
- Optional voting: <VOTE agent="alpha" score="0.82"> … </VOTE>, with <VOTE_SUMMARY> … </VOTE_SUMMARY> retained.

Gateway filtering:

- Streaming: implement a finite‑state filter with a 64–256 byte tail buffer to handle sentinel splits. States: visible and hide. Strip <THOUGHTS>…</THOUGHTS> while passing <THOUGHTS_SUMMARY> and <ANSWER>. Optionally strip <VOTE …> blocks and keep <VOTE_SUMMARY>.
- Non‑stream: regex remove thought blocks, optionally extract answer/summary blocks.

Training for freeform:

- Teach the structure explicitly in targets with consistent order: thoughts → summary → answer. Include refusal examples that keep thoughts private but provide a safe summary.
- Maintain safety: never include disallowed operational content in thought targets; the generator learns from the references you provide.

7. Policy Profiles and Operational Toggles

To accommodate heterogeneous client needs (e.g., government, medical, consumer), externalize policy into profiles and flags rather than separate code paths or retrains.

Core toggles:

- POLICY_MODE: strict | default | freeform (selects message layers, validators, sampling)
- ALLOW_THOUGHTS: none | summary | full (controls which markers are expected and which blocks are exposed)
- VALIDATOR_REFUSAL: 0/1 (enables post‑gen safety validator)
- SANITIZE_QMARKS: 0/1 (last‑resort sanitizer for sequences of ‘?’)
- BLOCKLIST: on/off (runtime token bans; keep minimal and domain‑aware)

Header overrides (privileged): allow per‑request profile changes only with proper authz, and log overrides for audit.

8. Implementation Artifacts in This Repository

Streaming via OpenAI‑style llama.cpp server:

- The gateway uses llama.cpp’s /v1/chat/completions (SSE) and /v1/completions. Model discovery uses GET /v1/models.

Ollama‑compat proxy:

- A lightweight FastAPI proxy mirrors Ollama endpoints onto llama.cpp, translating SSE to NDJSON where necessary. This preserves community‑standard tooling while standardizing upstream to OpenAI‑style semantics.

Unblocking “????” trainer:

- tools/unblock_qmarks.py supports LoRA and SFT patches and optional auto‑repair of training targets. A small seed dataset is provided under data/unblock_qmarks.sample.jsonl.

Freeform mode trainer:

- tools/train_freeform_mode.py teaches a thoughts→answer structure (with optional summaries) via LoRA/SFT. Seed examples reside in data/freeform_mode.sample.jsonl.

Start script wiring:

- scripts/start-llama-and-gateway.sh can apply a merged freeform GGUF or a llama.cpp LoRA adapter at runtime (FREEFORM_MODEL_GGUF / FREEFORM_LORA_GGUF). It also boots the Ollama proxy by default and exports both LLAMACPP_SERVER and OLLAMA_URL for the gateway.

9. Practical Checklists

To remove “????” without retrain:

- Adjust decoding (temperature/top_p/repetition_penalty), prune bad_words. Add a short prompt shim forbidding placeholders. Optionally enable a sanitize‑qmarks post‑filter (≥2 question marks only).

To surgically un‑train “????”:

- Collect 600–1,200 high‑signal pairs; include 50–150 clean refusals. Run LoRA with LR≈5e‑6, epochs≈1–2. Validate; merge if satisfied.

To enable freeform thoughts but keep them private:

- Train markers (<THOUGHTS>, <THOUGHTS_SUMMARY>, <ANSWER>). Add a stream filter that strips THOUGHTS and optionally VOTE blocks while preserving summaries and answers. Offer ALLOW_THOUGHTS and HIDE_THOUGHTS toggles per tenant.

To support strict/freeform per client:

- Implement a policy builder that returns the message stack, validators, and sampling for a request given POLICY_MODE and ALLOW_THOUGHTS. Guard header overrides with RBAC and log the active policy.

10. Appendix: Sampling and Filtering Defaults

Recommended starting points (adjust per model family):

- Default: temperature 0.7–0.9; top_p 0.9–0.95; repeat_penalty 1.05–1.1; no broad bad_words.
- Strict: consider slightly lower temperature (0.6–0.75) and keep validators on; never use placeholder punctuation for refusals.
- Freeform: temperature 0.8–0.95; top_p 0.95; minimal runtime bans; keep transport‑layer filters for hidden thoughts.

Regexes (non‑stream) and stream filter hints:

- Remove thoughts: /<THOUGHTS>[\s\S]\*?<\/THOUGHTS>/g
- Preserve summary: strip only the tags for <THOUGHTS_SUMMARY> and <ANSWER>.
- Stream: maintain a tail buffer (64–256 chars); split/consume by first sentinel; iterate until no sentinel remains; output visible spans.

References and Further Reading

While there is no single “industry standard” tag for internal monologue, the sentinel‑and‑filter approach has emerged as a robust pattern across OpenAI‑style servers, llama.cpp, and bespoke gateways. For small, targeted behavior changes, LoRA adapters offer superior iteration velocity and reversibility compared with full SFTs, and can be cleanly merged when stable.
