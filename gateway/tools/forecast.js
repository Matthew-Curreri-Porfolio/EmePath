// gateway/tools/forecast.js
// Forecasting: seed predictions and resolve outcomes periodically.

import { chat as llmChat } from "../lib/llm.js";
import { insightsEngine } from "./insights.js";
import { researchWeb } from "./research.js";
import { insertForecast, listForecasts, listDueForecasts, resolveForecast } from "../db/db.js";

function nowIso() { return new Date().toISOString(); }
function addDays(days) { const d = new Date(); d.setDate(d.getDate()+days); return d.toISOString(); }

function seedPrompt(topic, horizonDays, count, insights) {
  const sys = `You are a forecaster. Propose likely world events and measurable outcomes.
Return strict JSON: {
  "forecasts": [{
    "question": string,
    "resolution_criteria": string,
    "horizon_ts": string (ISO timestamp within ${horizonDays} days),
    "probability": number (0..1),
    "rationale": string,
    "methodology_tags": [string]
  }]
}
Rules: be specific and testable. Include clear resolution sources (who will publish the outcome).`;
  const usr = `TOPIC: ${topic}\nHORIZON_DAYS: ${horizonDays}\nCOUNT: ${count}\nINSIGHTS:\n${JSON.stringify(insights?.insights || {}, null, 2)}`;
  return [ { role:'system', content: sys }, { role:'user', content: usr } ];
}

function judgePrompt(question, resolution_criteria, researchSummary) {
  const sys = `You are a resolution judge. Decide if the outcome occurred per criteria.
Return strict JSON: { "outcome": "yes|no|unknown", "confidence": number (0..1), "notes": string }.
Use only the research summary. Be conservative if uncertain.`;
  const usr = `QUESTION: ${question}\nCRITERIA: ${resolution_criteria}\n\nRESEARCH:\n${researchSummary}`;
  return [ { role:'system', content: sys }, { role:'user', content: usr } ];
}

function summarizeResearch(rr, maxChars=6000) {
  if (!rr || !rr.ok) return '';
  const parts = [];
  for (const r of rr.results || []) {
    const t = r.page?.title || r.title || r.url;
    const d = r.page?.description || r.snippet || '';
    parts.push(`- ${t}: ${d}`);
    if (parts.join('\n').length > maxChars) break;
  }
  return parts.join('\n');
}

function brier(prob, outcome) {
  const y = outcome === 'yes' ? 1 : (outcome === 'no' ? 0 : null);
  if (y === null) return null;
  const p = Math.max(0, Math.min(1, Number(prob)||0));
  return (p - y) * (p - y);
}

export async function seedForecasts(
  topic,
  { count=5, horizonDays=30, mode='hybrid', base, num=6, fetchNum=4, concurrency=3, site, lang='en', safe=false, fresh, localIndex, localK=6, maxContextChars=20000 } = {}
) {
  const insights = await insightsEngine(topic, { mode, base, num, fetchNum, concurrency, site, lang, safe, fresh, localIndex, localK, maxContextChars, maxAnswerTokens:600 });
  const messages = seedPrompt(topic, horizonDays, Math.min(20, Math.max(1, Number(count)||5)), insights);
  const r = await llmChat({ messages, temperature: 0.4, maxTokens: 1200, timeoutMs: 60000 });
  let forecasts = [];
  try {
    const j = JSON.parse(r?.content || '{}');
    forecasts = Array.isArray(j.forecasts) ? j.forecasts : [];
  } catch {}
  const inserted = [];
  for (const f of forecasts) {
    try {
      const rowid = insertForecast({
        topic,
        question: f.question,
        resolution_criteria: f.resolution_criteria,
        horizon_ts: f.horizon_ts || addDays(horizonDays),
        probability: f.probability,
        rationale: f.rationale,
        methodology_tags: Array.isArray(f.methodology_tags) ? f.methodology_tags : [],
        sources: insights?.sources || []
      });
      inserted.push(rowid);
    } catch {}
  }
  return { ok:true, topic, insertedCount: inserted.length, ids: inserted };
}

export async function resolveDueForecasts({ limit=20, base, num=5, fetchNum=3, concurrency=2, site, lang='en', safe=false, fresh } = {}) {
  const due = listDueForecasts({ limit });
  const out = [];
  for (const f of due) {
    try {
      const rr = await researchWeb(f.question, { base, num, fetchNum, concurrency, site, lang, safe, fresh });
      const summary = summarizeResearch(rr);
      const messages = judgePrompt(f.question, f.resolution_criteria, summary);
      const j = await llmChat({ messages, temperature: 0.1, maxTokens: 400, timeoutMs: 40000 });
      let judge;
      try { judge = JSON.parse(j?.content || '{}'); } catch { judge = { outcome:'unknown', confidence:0.3, notes:String(j?.content||'') }; }
      const outcome = (judge?.outcome === 'yes' || judge?.outcome === 'no') ? judge.outcome : 'unknown';
      const score = brier(f.probability, outcome);
      resolveForecast(f.id, { outcome, judge, brier_score: score });
      out.push({ id:f.id, outcome, score, judge });
    } catch (e) {
      out.push({ id:f.id, error:String(e&&e.message||e) });
    }
  }
  return { ok:true, resolved: out.length, details: out };
}

export function listAllForecasts({ status, topic, limit } = {}) {
  const rows = listForecasts({ status, topic, limit });
  return { ok:true, forecasts: rows };
}

export function tagStats() {
  const rows = listForecasts({ status: 'resolved', limit: 1000 });
  const stats = new Map();
  for (const r of rows) {
    let tags = [];
    try { tags = JSON.parse(r.methodology_tags || '[]'); } catch {}
    const score = typeof r.brier_score === 'number' ? r.brier_score : null;
    for (const t of tags) {
      if (!stats.has(t)) stats.set(t, { tag: t, count:0, sum:0, scores:[] });
      const s = stats.get(t);
      s.count++;
      if (score != null) { s.sum += score; s.scores.push(score); }
    }
  }
  const out = Array.from(stats.values()).map(s => ({ tag:s.tag, count:s.count, avgBrier: s.count && s.sum ? (s.sum/s.scores.length) : null }));
  out.sort((a,b) => (a.avgBrier??1) - (b.avgBrier??1)); // lower brier is better
  return { ok:true, tags: out };
}
