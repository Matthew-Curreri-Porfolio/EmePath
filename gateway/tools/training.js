// gateway/tools/training.js
// Orchestrated self-training loop using insights, debate, plan, and a grader.

import { chat as llmChat } from "../lib/llm.js";
import { insightsEngine } from "./insights.js";
import { debateEngine } from "./debate.js";
import { planEngine } from "./plan.js";
import { researchWeb } from "./research.js";

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function buildQuestionSynthPrompt(topic, n=3, difficulty='hard', evidence='') {
  const sys = `You are a curriculum designer. Create complex, multi-hop questions grounded in the evidence.
Return strict JSON: { "questions": [string] }.
Each question should require reasoning across 2-3 concepts, include constraints, and be realistic for practitioners.
Difficulty: ${difficulty}. Output JSON only.`;
  const usr = `TOPIC: ${topic}\n\nEVIDENCE:\n${evidence}\n\nCOUNT: ${n}`;
  return [ { role:'system', content: sys }, { role:'user', content: usr } ];
}

function buildGraderPrompt(question, answer, debate, plan, sources) {
  const sys = `You are an expert grader for reasoning and methodology.
Return strict JSON:
{
  "score": number (0..1),
  "logic": {"valid": boolean, "issues": [string]},
  "evidenceUse": {"grounded": boolean, "notes": [string]},
  "methodology": {"strengths": [string], "weaknesses": [string], "improvements": [string]},
  "nextDrills": [string]
}
Rules: be strict but constructive. Penalize hallucinations or missing verification. Output JSON only.`;
  const usr = `QUESTION:\n${question}\n\nANSWER:\n${answer}\n\nDEBATE:\n${JSON.stringify(debate||{}, null, 2)}\n\nPLAN:\n${JSON.stringify(plan||{}, null, 2)}\n\nSOURCES:\n${JSON.stringify(sources||[], null, 2)}`;
  return [ { role:'system', content: sys }, { role:'user', content: usr } ];
}

function buildMethodologySynthPrompt(topic, prior, improvements) {
  const sys = `You are a methodology architect. Merge improvements into a concise protocol.
Return strict JSON: { "protocol": string, "principles": [string], "checks": [string] }.
Protocol should be stepwise and verifiable. Output JSON only.`;
  const usr = `TOPIC: ${topic}\nPRIOR:\n${typeof prior === 'string' ? prior : JSON.stringify(prior||{}, null, 2)}\n\nIMPROVEMENTS:\n${JSON.stringify(improvements||[], null, 2)}`;
  return [ { role:'system', content: sys }, { role:'user', content: usr } ];
}

function buildSolutionPrompt(question, insights, debate, plan) {
  const sys = `You are a solution synthesizer. Produce a grounded, concise solution with citations.
Return strict JSON: { "solution": string, "keyCitations": [string], "limits": [string] }.
Use inline citations like [W1] or [L2] consistent with sources.
If the plan includes verification steps, summarize pass/fail criteria. Output JSON only.`;
  const usr = `QUESTION: ${question}\n\nINSIGHTS:\n${JSON.stringify(insights?.insights||{}, null, 2)}\n\nDEBATE VERDICT:\n${JSON.stringify(debate?.debate?.verdict||{}, null, 2)}\n\nPLAN SUMMARY:\n${JSON.stringify(plan?.plan?.steps?.slice(0,4)||[], null, 2)}\n`;
  return [ { role:'system', content: sys }, { role:'user', content: usr } ];
}

async function synthQuestions(topic, { mode, base, num, fetchNum, concurrency, site, lang, safe, fresh, localIndex, localK, maxContextChars }) {
  // Gather small evidence excerpt to seed question generation
  let evidence = '';
  try {
    if (mode !== 'local') {
      const rr = await researchWeb(topic, { base, num: Math.min(5, num||5), fetchNum: Math.min(3, fetchNum||3), concurrency: Math.min(2, concurrency||2), site, lang, safe, fresh });
      if (rr && rr.ok) {
        const parts = [];
        for (const r of rr.results || []) {
          const d = r.page?.description || r.snippet || '';
          if (d) parts.push(`${r.title || r.url}: ${d}`);
          if (parts.join('\n').length > (maxContextChars||6000)) break;
        }
        evidence = parts.join('\n');
      }
    }
  } catch {}

  const messages = buildQuestionSynthPrompt(topic, 3, 'hard', evidence);
  const r = await llmChat({ messages, temperature: 0.8, maxTokens: 600, timeoutMs: 40000 });
  try {
    const j = JSON.parse(r?.content || '{}');
    const arr = Array.isArray(j.questions) ? j.questions.filter(x => typeof x === 'string' && x.trim()).slice(0,3) : [];
    return arr.length ? arr : [ `What are the core trade-offs in ${topic}, and how to verify a chosen approach in practice?` ];
  } catch {
    return [ `What are the core trade-offs in ${topic}, and how to verify a chosen approach in practice?` ];
  }
}

export async function trainLoop(
  topic,
  {
    mode='hybrid',
    iterations=2,
    perIter=2,
    difficulty='hard',
    base,
    num=6,
    fetchNum=4,
    concurrency=3,
    site,
    lang='en',
    safe=false,
    fresh,
    localIndex,
    localK=6,
    maxContextChars=22000,
    maxAnswerTokens=1200,
    persist=false,
    setLongTerm,
    userId,
    workspaceId,
    datasetPath,
  } = {}
) {
  const runs = [];
  let methodology = { protocol: '', principles: [], checks: [] };
  for (let it=0; it<clamp(iterations,1,10); it++) {
    const qs = await synthQuestions(topic, { mode, base, num, fetchNum, concurrency, site, lang, safe, fresh, localIndex, localK, maxContextChars });
    const chosen = qs.slice(0, clamp(perIter,1,10));
    for (const q of chosen) {
      const insights = await insightsEngine(q, { mode, base, num, fetchNum, concurrency, site, lang, safe, fresh, localIndex, localK, maxContextChars, maxAnswerTokens: 700 });
      const debate = await debateEngine(q, { mode, useInsights:true, rounds:2, base, num, fetchNum, concurrency, site, lang, safe, fresh, localIndex, localK, maxContextChars, maxAnswerTokens: 700 });
      const plan = await planEngine({ query:q, target:'general', envOs:'linux', risk:'medium' }, { mode, base, num, fetchNum, concurrency, site, lang, safe, fresh, localIndex, localK, maxContextChars, maxAnswerTokens: 900 });
      const solMsgs = buildSolutionPrompt(q, insights, debate, plan);
      const sol = await llmChat({ messages: solMsgs, temperature: 0.2, maxTokens: 700, timeoutMs: 45000 });
      let solution;
      try { solution = JSON.parse(sol?.content || '{}'); } catch { solution = { solution: String(sol?.content||'').trim() } }

      const gradeMsgs = buildGraderPrompt(q, solution, debate, plan, insights?.sources || []);
      const grd = await llmChat({ messages: gradeMsgs, temperature: 0.2, maxTokens: 600, timeoutMs: 45000 });
      let grade;
      try { grade = JSON.parse(grd?.content || '{}'); } catch { grade = { score: 0.5, methodology: { improvements: [String(grd?.content||'').slice(0,400)] } } }

      runs.push({ question: q, insights, debate, plan, solution, grade });

      // Update methodology
      const methMsgs = buildMethodologySynthPrompt(topic, methodology, grade?.methodology?.improvements || []);
      const meth = await llmChat({ messages: methMsgs, temperature: 0.2, maxTokens: 800, timeoutMs: 45000 });
      try { methodology = JSON.parse(meth?.content || '{}'); } catch {}
    }
  }

  // Optional persistence into long-term memory
  if (persist && typeof setLongTerm === 'function' && userId && workspaceId) {
    const payload = {
      topic,
      methodology,
      timestamp: Date.now(),
      exemplars: runs.map(r => ({ question: r.question, solution: r.solution, grade: r.grade?.score ?? null }))
    };
    try { setLongTerm(userId, workspaceId, JSON.stringify(payload, null, 2)); } catch {}
  }

  // Optional dataset dump (JSONL of instruction/response pairs)
  if (datasetPath) {
    try {
      const fs = await import('fs');
      const lines = [];
      for (const r of runs) {
        const example = {
          instruction: r.question,
          context: { sources: r.insights?.sources || [], plan: r.plan?.plan || null, verdict: r.debate?.debate?.verdict || null },
          output: r.solution?.solution || r.solution || '',
          meta: { score: r.grade?.score ?? null }
        };
        lines.push(JSON.stringify(example));
      }
      fs.writeFileSync(datasetPath, lines.join('\n'), 'utf8');
    } catch {}
  }

  return { ok:true, topic, iterations, perIter, methodology, runsCount: runs.length, runs };
}

export { trainLoop as default };
