// gateway/tools/forecast.js
// Forecasting: seed predictions and resolve outcomes periodically.

import { chat as llmChat } from '../lib/llm.js';
import { insightsEngine } from './insights.js';
import { composeSystem } from '../prompts/compose.js';
import { researchWeb } from './research.js';
import {
  insertForecast,
  listForecasts,
  listDueForecasts,
  resolveForecast,
} from '../db/db.js';

function nowIso() {
  return new Date().toISOString();
}
function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function seedPrompt(topic, horizonDays, count, insights) {
  const sys = composeSystem('forecast.seed_system', {
    horizonDays: String(horizonDays),
  });
  const usr = `TOPIC: ${topic}\nHORIZON_DAYS: ${horizonDays}\nCOUNT: ${count}\nINSIGHTS:\n${JSON.stringify(insights?.insights || {}, null, 2)}`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ];
}

function judgePrompt(question, resolution_criteria, researchSummary) {
  const sys = composeSystem('forecast.judge_system');
  const usr = `QUESTION: ${question}\nCRITERIA: ${resolution_criteria}\n\nRESEARCH:\n${researchSummary}`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ];
}

function summarizeResearch(rr, maxChars = 6000) {
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
  const y = outcome === 'yes' ? 1 : outcome === 'no' ? 0 : null;
  if (y === null) return null;
  const p = Math.max(0, Math.min(1, Number(prob) || 0));
  return (p - y) * (p - y);
}

export async function seedForecasts(
  topic,
  {
    count = 5,
    horizonDays = 30,
    mode = 'hybrid',
    base,
    num = 6,
    fetchNum = 4,
    concurrency = 3,
    site,
    lang = 'en',
    safe = false,
    fresh,
    localIndex,
    localK = 6,
    maxContextChars = 20000,
  } = {}
) {
  const insights = await insightsEngine(topic, {
    mode,
    base,
    num,
    fetchNum,
    concurrency,
    site,
    lang,
    safe,
    fresh,
    localIndex,
    localK,
    maxContextChars,
    maxAnswerTokens: 600,
  });
  const messages = seedPrompt(
    topic,
    horizonDays,
    Math.min(20, Math.max(1, Number(count) || 5)),
    insights
  );
  const r = await llmChat({
    messages,
    temperature: 0.4,
    maxTokens: 1200,
    timeoutMs: 60000,
  });
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
        methodology_tags: Array.isArray(f.methodology_tags)
          ? f.methodology_tags
          : [],
        sources: insights?.sources || [],
      });
      inserted.push(rowid);
    } catch {}
  }
  return { ok: true, topic, insertedCount: inserted.length, ids: inserted };
}

export async function resolveDueForecasts({
  limit = 20,
  base,
  num = 5,
  fetchNum = 3,
  concurrency = 2,
  site,
  lang = 'en',
  safe = false,
  fresh,
} = {}) {
  const due = listDueForecasts({ limit });
  const out = [];
  for (const f of due) {
    try {
      const rr = await researchWeb(f.question, {
        base,
        num,
        fetchNum,
        concurrency,
        site,
        lang,
        safe,
        fresh,
      });
      const summary = summarizeResearch(rr);
      const messages = judgePrompt(f.question, f.resolution_criteria, summary);
      const j = await llmChat({
        messages,
        temperature: 0.1,
        maxTokens: 400,
        timeoutMs: 40000,
      });
      let judge;
      try {
        judge = JSON.parse(j?.content || '{}');
      } catch {
        judge = {
          outcome: 'unknown',
          confidence: 0.3,
          notes: String(j?.content || ''),
        };
      }
      const outcome =
        judge?.outcome === 'yes' || judge?.outcome === 'no'
          ? judge.outcome
          : 'unknown';
      const score = brier(f.probability, outcome);
      resolveForecast(f.id, { outcome, judge, brier_score: score });
      out.push({ id: f.id, outcome, score, judge });
    } catch (e) {
      out.push({ id: f.id, error: String((e && e.message) || e) });
    }
  }
  return { ok: true, resolved: out.length, details: out };
}

export function listAllForecasts({ status, topic, limit } = {}) {
  const rows = listForecasts({ status, topic, limit });
  return { ok: true, forecasts: rows };
}

export function tagStats() {
  const rows = listForecasts({ status: 'resolved', limit: 1000 });
  const stats = new Map();
  for (const r of rows) {
    let tags = [];
    try {
      tags = JSON.parse(r.methodology_tags || '[]');
    } catch {}
    const score = typeof r.brier_score === 'number' ? r.brier_score : null;
    for (const t of tags) {
      if (!stats.has(t)) stats.set(t, { tag: t, count: 0, sum: 0, scores: [] });
      const s = stats.get(t);
      s.count++;
      if (score != null) {
        s.sum += score;
        s.scores.push(score);
      }
    }
  }
  const out = Array.from(stats.values()).map((s) => ({
    tag: s.tag,
    count: s.count,
    avgBrier: s.count && s.sum ? s.sum / s.scores.length : null,
  }));
  out.sort((a, b) => (a.avgBrier ?? 1) - (b.avgBrier ?? 1)); // lower brier is better
  return { ok: true, tags: out };
}

// Dashboard metrics: calibration curve + tag-level reliability (with topic grouping and time slices)
export function forecastMetrics({
  bins = 10,
  topic,
  minPerBin = 1,
  limit = 5000,
  groupTopics = false,
  slice,
  dateField = 'resolved',
  minPerSlice = 3,
} = {}) {
  function safeJsonParse(str, fallback) {
    try {
      return JSON.parse(String(str || ''));
    } catch {
      return fallback;
    }
  }
  function normOutcome(outcome) {
    const o = String(outcome || '').toLowerCase();
    return o === 'yes' ? 1 : o === 'no' ? 0 : null;
  }
  function clamp01(x) {
    const n = Number(x);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  }
  function bucket(ts) {
    const d = new Date(ts || 0);
    if (isNaN(+d)) return null;
    if (slice === 'day') return d.toISOString().slice(0, 10);
    if (slice === 'week') {
      const t = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      );
      const dayNum = (t.getUTCDay() + 6) % 7;
      t.setUTCDate(t.getUTCDate() - dayNum + 3);
      const week1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
      const w =
        1 +
        Math.round(
          ((t - week1) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7
        );
      return `${t.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
    }
    // month default
    return `${d.toISOString().slice(0, 7)}`;
  }

  const rows = listForecasts({ status: 'resolved', topic, limit });
  const pts = [];
  let n = 0,
    sumP = 0,
    sumY = 0,
    sumBrier = 0;
  for (const r of rows) {
    const y = normOutcome(r.outcome);
    if (y == null) continue;
    const p = clamp01(r.probability);
    const tBucket = slice
      ? bucket(dateField === 'horizon' ? r.horizon_ts : r.resolved_at)
      : null;
    pts.push({
      p,
      y,
      topic: r.topic,
      tags: safeJsonParse(r.methodology_tags, []),
      bucket: tBucket,
    });
    n++;
    sumP += p;
    sumY += y;
    sumBrier +=
      typeof r.brier_score === 'number' ? r.brier_score : (p - y) * (p - y);
  }
  if (!pts.length) return { ok: false, error: 'no_resolved_yes_no' };

  const B = Math.max(2, Math.min(50, Number(bins) || 10));
  const acc = Array.from({ length: B }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  for (const t of pts) {
    let i = Math.floor(t.p * B);
    if (i >= B) i = B - 1;
    const a = acc[i];
    a.n++;
    a.sumP += t.p;
    a.sumY += t.y;
  }
  const calibration = acc
    .map((a, i) => ({
      bin: `${(i / B).toFixed(2)}-${((i + 1) / B).toFixed(2)}`,
      i,
      n: a.n,
      avgP: a.n ? a.sumP / a.n : null,
      freqYes: a.n ? a.sumY / a.n : null,
    }))
    .filter((b) => b.n >= Math.max(1, Number(minPerBin) || 1));

  // Tag-level reliability
  const tagMap = new Map();
  for (const t of pts) {
    const tags = Array.isArray(t.tags) ? t.tags : [];
    for (const g of tags) {
      if (!tagMap.has(g))
        tagMap.set(g, { tag: g, n: 0, sumP: 0, sumY: 0, sumBrier: 0 });
      const s = tagMap.get(g);
      s.n++;
      s.sumP += t.p;
      s.sumY += t.y;
      s.sumBrier += (t.p - t.y) * (t.p - t.y);
    }
  }
  const tags = Array.from(tagMap.values()).map((s) => ({
    tag: s.tag,
    count: s.n,
    avgProb: s.n ? s.sumP / s.n : null,
    freqYes: s.n ? s.sumY / s.n : null,
    avgBrier: s.n ? s.sumBrier / s.n : null,
  }));
  tags.sort((a, b) => (a.avgBrier ?? 1) - (b.avgBrier ?? 1));

  // Optional per-topic reliability summary
  let topics = undefined;
  if (groupTopics) {
    const topicMap = new Map();
    for (const t of pts) {
      const k = String(t.topic || '');
      if (!topicMap.has(k))
        topicMap.set(k, { topic: k, n: 0, sumP: 0, sumY: 0, sumBrier: 0 });
      const s = topicMap.get(k);
      s.n++;
      s.sumP += t.p;
      s.sumY += t.y;
      s.sumBrier += (t.p - t.y) * (t.p - t.y);
    }
    topics = Array.from(topicMap.values()).map((s) => ({
      topic: s.topic,
      count: s.n,
      avgProb: s.n ? s.sumP / s.n : null,
      freqYes: s.n ? s.sumY / s.n : null,
      avgBrier: s.n ? s.sumBrier / s.n : null,
    }));
    topics.sort((a, b) => (a.avgBrier ?? 1) - (b.avgBrier ?? 1));
  }

  // Optional time-sliced reliability series
  let timeslices = undefined;
  if (slice) {
    const sliceMap = new Map();
    for (const t of pts) {
      if (!t.bucket) continue;
      if (!sliceMap.has(t.bucket))
        sliceMap.set(t.bucket, { key: t.bucket, n: 0, sumP: 0, sumY: 0 });
      const s = sliceMap.get(t.bucket);
      s.n++;
      s.sumP += t.p;
      s.sumY += t.y;
    }
    timeslices = Array.from(sliceMap.values())
      .filter((s) => s.n >= Math.max(1, Number(minPerSlice) || 1))
      .map((s) => ({
        key: s.key,
        n: s.n,
        avgProb: s.sumP / s.n,
        freqYes: s.sumY / s.n,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  return {
    ok: true,
    overall: {
      count: n,
      meanProb: sumP / n,
      baseRate: sumY / n,
      avgBrier: sumBrier / n,
    },
    calibration,
    tags,
    topics,
    timeslices,
  };
}

// Convert metrics object into a compact CSV string for downloads/exports
export function metricsToCsv(metrics) {
  const rows = [];
  // Overall
  if (metrics && metrics.overall) {
    const o = metrics.overall;
    rows.push(['section', 'metric', 'value'].join(','));
    rows.push(['overall', 'count', o.count].join(','));
    rows.push(['overall', 'meanProb', o.meanProb].join(','));
    rows.push(['overall', 'baseRate', o.baseRate].join(','));
    rows.push(['overall', 'avgBrier', o.avgBrier].join(','));
    rows.push('');
  }
  // Calibration
  if (Array.isArray(metrics?.calibration)) {
    rows.push(['calibration', 'bin', 'n', 'avgP', 'freqYes'].join(','));
    for (const b of metrics.calibration) {
      rows.push(['calibration', b.bin, b.n, b.avgP, b.freqYes].join(','));
    }
    rows.push('');
  }
  // Tags
  if (Array.isArray(metrics?.tags)) {
    rows.push(
      ['tags', 'tag', 'count', 'avgProb', 'freqYes', 'avgBrier'].join(',')
    );
    for (const t of metrics.tags)
      rows.push(
        ['tags', t.tag, t.count, t.avgProb, t.freqYes, t.avgBrier].join(',')
      );
    rows.push('');
  }
  // Topics
  if (Array.isArray(metrics?.topics)) {
    rows.push(
      ['topics', 'topic', 'count', 'avgProb', 'freqYes', 'avgBrier'].join(',')
    );
    for (const t of metrics.topics)
      rows.push(
        ['topics', t.topic, t.count, t.avgProb, t.freqYes, t.avgBrier].join(',')
      );
    rows.push('');
  }
  // Time slices
  if (Array.isArray(metrics?.timeslices)) {
    rows.push(['timeslices', 'key', 'n', 'avgProb', 'freqYes'].join(','));
    for (const s of metrics.timeslices)
      rows.push(['timeslices', s.key, s.n, s.avgProb, s.freqYes].join(','));
  }
  return rows.join('\n');
}

// Provide a plotting-friendly JSON shape (arrays ready for chart libs)
export function metricsForUi(metrics) {
  const ui = { ok: !!metrics?.ok };
  if (metrics?.overall) ui.overall = metrics.overall;
  if (Array.isArray(metrics?.calibration)) {
    ui.calibration = {
      bins: metrics.calibration.map((b) => b.bin),
      n: metrics.calibration.map((b) => b.n),
      avgP: metrics.calibration.map((b) => b.avgP),
      freqYes: metrics.calibration.map((b) => b.freqYes),
    };
  }
  if (Array.isArray(metrics?.tags)) {
    ui.tags = {
      labels: metrics.tags.map((t) => t.tag),
      count: metrics.tags.map((t) => t.count),
      avgBrier: metrics.tags.map((t) => t.avgBrier),
      avgProb: metrics.tags.map((t) => t.avgProb),
      freqYes: metrics.tags.map((t) => t.freqYes),
    };
  }
  if (Array.isArray(metrics?.topics)) {
    ui.topics = {
      labels: metrics.topics.map((t) => t.topic),
      count: metrics.topics.map((t) => t.count),
      avgBrier: metrics.topics.map((t) => t.avgBrier),
      avgProb: metrics.topics.map((t) => t.avgProb),
      freqYes: metrics.topics.map((t) => t.freqYes),
    };
  }
  if (Array.isArray(metrics?.timeslices)) {
    ui.timeslices = {
      keys: metrics.timeslices.map((s) => s.key),
      n: metrics.timeslices.map((s) => s.n),
      avgProb: metrics.timeslices.map((s) => s.avgProb),
      freqYes: metrics.timeslices.map((s) => s.freqYes),
    };
  }
  ui.raw = metrics;
  return ui;
}
// Backtest seeder helpers and entry
function unfoldIcsLines(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const out = [];
  for (const ln of lines) {
    if (ln.startsWith(' ') || ln.startsWith('\t')) {
      if (out.length) out[out.length - 1] += ln.slice(1);
      else out.push(ln.slice(1));
    } else out.push(ln);
  }
  return out;
}
function parseIcsDate(v) {
  if (!v) return null;
  const m = String(v).match(/(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})Z?)?/);
  if (!m) return null;
  const [_, Y, M, D, t, h, mi, s] = m;
  if (t)
    return new Date(
      Date.UTC(+Y, +M - 1, +D, +(h || 0), +(mi || 0), +(s || 0))
    ).toISOString();
  return new Date(+Y, +M - 1, +D).toISOString();
}
function parseICS(text) {
  const lines = unfoldIcsLines(text);
  const events = [];
  let cur = null;
  for (const ln of lines) {
    if (/^BEGIN:VEVENT/i.test(ln)) {
      cur = {};
      continue;
    }
    if (/^END:VEVENT/i.test(ln)) {
      if (cur) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = ln.indexOf(':');
    if (idx === -1) continue;
    const keyPart = ln.slice(0, idx);
    const val = ln.slice(idx + 1);
    const key = keyPart.split(';')[0].toUpperCase();
    if (key === 'DTSTART') cur.start = parseIcsDate(val);
    else if (key === 'DTEND') cur.end = parseIcsDate(val);
    else if (key === 'SUMMARY') cur.summary = val;
    else if (key === 'DESCRIPTION') cur.description = val;
    else if (key === 'LOCATION') cur.location = val;
  }
  return events.filter((e) => e.summary);
}
function backtestPrompt(
  event,
  { countPerEvent = 1, horizonOffsetDays = 0 } = {}
) {
  const sys = `You are a forecasting assistant. For the given event, propose ${countPerEvent} binary, falsifiable predictions related to the event.\nReturn strict JSON: { "forecasts": [{ "question": string, "resolution_criteria": string, "horizon_ts": string (ISO), "probability": number (0..1), "rationale": string, "methodology_tags": [string] }] }.\nConstraints: clear resolution source; horizon on or before the event date plus ${horizonOffsetDays} days.`;
  const usr = `EVENT:\n${JSON.stringify(event, null, 2)}\n\nEVENT_HORIZON_TS: ${event.start || new Date().toISOString()}`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ];
}
export async function seedBacktestForecasts({
  topic = 'backtest',
  calendarText,
  events,
  countPerEvent = 1,
  horizonOffsetDays = 0,
  limitEvents = 50,
} = {}) {
  const evts =
    Array.isArray(events) && events.length
      ? events
      : parseICS(calendarText || '');
  const selected = evts.slice(
    0,
    Math.max(1, Math.min(Number(limitEvents) || 50, 200))
  );
  const inserted = [];
  for (const ev of selected) {
    try {
      const messages = backtestPrompt(ev, { countPerEvent, horizonOffsetDays });
      const r = await llmChat({
        messages,
        temperature: 0.3,
        maxTokens: 800,
        timeoutMs: 45000,
      });
      let j;
      try {
        j = JSON.parse(r?.content || '{}');
      } catch {
        j = {};
      }
      const fcs = Array.isArray(j.forecasts) ? j.forecasts : [];
      for (const f of fcs) {
        try {
          const rowid = insertForecast({
            topic,
            question: f.question,
            resolution_criteria: f.resolution_criteria,
            horizon_ts: f.horizon_ts || ev.start || new Date().toISOString(),
            probability: f.probability,
            rationale: f.rationale,
            methodology_tags: Array.isArray(f.methodology_tags)
              ? f.methodology_tags
              : [],
            sources: [],
          });
          inserted.push(rowid);
        } catch {}
      }
    } catch {}
  }
  return {
    ok: true,
    topic,
    eventsProcessed: selected.length,
    insertedCount: inserted.length,
    ids: inserted,
  };
}

// Dashboard metrics: calibration curve + tag-level reliability
export function forecastMetrics({
  bins = 10,
  topic,
  minPerBin = 1,
  limit = 5000,
} = {}) {
  function safeJsonParse(str, fallback) {
    try {
      return JSON.parse(String(str || ''));
    } catch {
      return fallback;
    }
  }
  function normOutcome(outcome) {
    const o = String(outcome || '').toLowerCase();
    return o === 'yes' ? 1 : o === 'no' ? 0 : null;
  }
  function clamp01(x) {
    const n = Number(x);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  }

  const rows = listForecasts({ status: 'resolved', topic, limit });
  const pts = [];
  let n = 0,
    sumP = 0,
    sumY = 0,
    sumBrier = 0;
  for (const r of rows) {
    const y = normOutcome(r.outcome);
    if (y == null) continue;
    const p = clamp01(r.probability);
    pts.push({ p, y, tags: safeJsonParse(r.methodology_tags, []) });
    n++;
    sumP += p;
    sumY += y;
    sumBrier +=
      typeof r.brier_score === 'number' ? r.brier_score : (p - y) * (p - y);
  }
  if (!pts.length) return { ok: false, error: 'no_resolved_yes_no' };

  const B = Math.max(2, Math.min(50, Number(bins) || 10));
  const acc = Array.from({ length: B }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  for (const t of pts) {
    let i = Math.floor(t.p * B);
    if (i >= B) i = B - 1;
    const a = acc[i];
    a.n++;
    a.sumP += t.p;
    a.sumY += t.y;
  }
  const calibration = acc
    .map((a, i) => ({
      bin: `${(i / B).toFixed(2)}-${((i + 1) / B).toFixed(2)}`,
      i,
      n: a.n,
      avgP: a.n ? a.sumP / a.n : null,
      freqYes: a.n ? a.sumY / a.n : null,
    }))
    .filter((b) => b.n >= Math.max(1, Number(minPerBin) || 1));

  const tagMap = new Map();
  for (const t of pts) {
    const tags = Array.isArray(t.tags) ? t.tags : [];
    for (const g of tags) {
      if (!tagMap.has(g))
        tagMap.set(g, { tag: g, n: 0, sumP: 0, sumY: 0, sumBrier: 0 });
      const s = tagMap.get(g);
      s.n++;
      s.sumP += t.p;
      s.sumY += t.y;
      s.sumBrier += (t.p - t.y) * (t.p - t.y);
    }
  }
  const tags = Array.from(tagMap.values()).map((s) => ({
    tag: s.tag,
    count: s.n,
    avgProb: s.n ? s.sumP / s.n : null,
    freqYes: s.n ? s.sumY / s.n : null,
    avgBrier: s.n ? s.sumBrier / s.n : null,
  }));
  tags.sort((a, b) => (a.avgBrier ?? 1) - (b.avgBrier ?? 1));

  return {
    ok: true,
    overall: {
      count: n,
      meanProb: sumP / n,
      baseRate: sumY / n,
      avgBrier: sumBrier / n,
    },
    calibration,
    tags,
  };
}

// Backtest seeder: parse ICS or consume pre-parsed events and create forecasts
function unfoldIcsLines(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const out = [];
  for (const ln of lines) {
    if (ln.startsWith(' ') || ln.startsWith('\t')) {
      if (out.length) out[out.length - 1] += ln.slice(1);
      else out.push(ln.slice(1));
    } else out.push(ln);
  }
  return out;
}
function parseIcsDate(v) {
  if (!v) return null;
  const m = String(v).match(/(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})Z?)?/);
  if (!m) return null;
  const [_, Y, M, D, t, h, mi, s] = m;
  if (t)
    return new Date(
      Date.UTC(+Y, +M - 1, +D, +(h || 0), +(mi || 0), +(s || 0))
    ).toISOString();
  return new Date(+Y, +M - 1, +D).toISOString();
}
function parseICS(text) {
  const lines = unfoldIcsLines(text);
  const events = [];
  let cur = null;
  for (const ln of lines) {
    if (/^BEGIN:VEVENT/i.test(ln)) {
      cur = {};
      continue;
    }
    if (/^END:VEVENT/i.test(ln)) {
      if (cur) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = ln.indexOf(':');
    if (idx === -1) continue;
    const keyPart = ln.slice(0, idx);
    const val = ln.slice(idx + 1);
    const key = keyPart.split(';')[0].toUpperCase();
    if (key === 'DTSTART') cur.start = parseIcsDate(val);
    else if (key === 'DTEND') cur.end = parseIcsDate(val);
    else if (key === 'SUMMARY') cur.summary = val;
    else if (key === 'DESCRIPTION') cur.description = val;
    else if (key === 'LOCATION') cur.location = val;
  }
  return events.filter((e) => e.summary);
}
function backtestPrompt(
  event,
  { countPerEvent = 1, horizonOffsetDays = 0 } = {}
) {
  const sys = `You are a forecasting assistant. For the given event, propose ${countPerEvent} binary, falsifiable predictions related to the event.\nReturn strict JSON: { "forecasts": [{ "question": string, "resolution_criteria": string, "horizon_ts": string (ISO), "probability": number (0..1), "rationale": string, "methodology_tags": [string] }] }.\nConstraints: clear resolution source; horizon on or before the event date plus ${horizonOffsetDays} days.`;
  const usr = `EVENT:\n${JSON.stringify(event, null, 2)}\n\nEVENT_HORIZON_TS: ${event.start || new Date().toISOString()}`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ];
}
export async function seedBacktestForecasts({
  topic = 'backtest',
  calendarText,
  events,
  countPerEvent = 1,
  horizonOffsetDays = 0,
  limitEvents = 50,
} = {}) {
  const evts =
    Array.isArray(events) && events.length
      ? events
      : parseICS(calendarText || '');
  const selected = evts.slice(
    0,
    Math.max(1, Math.min(Number(limitEvents) || 50, 200))
  );
  const inserted = [];
  for (const ev of selected) {
    try {
      const messages = backtestPrompt(ev, { countPerEvent, horizonOffsetDays });
      const r = await llmChat({
        messages,
        temperature: 0.3,
        maxTokens: 800,
        timeoutMs: 45000,
      });
      let j;
      try {
        j = JSON.parse(r?.content || '{}');
      } catch {
        j = {};
      }
      const fcs = Array.isArray(j.forecasts) ? j.forecasts : [];
      for (const f of fcs) {
        try {
          const rowid = insertForecast({
            topic,
            question: f.question,
            resolution_criteria: f.resolution_criteria,
            horizon_ts: f.horizon_ts || ev.start || new Date().toISOString(),
            probability: f.probability,
            rationale: f.rationale,
            methodology_tags: Array.isArray(f.methodology_tags)
              ? f.methodology_tags
              : [],
            sources: [],
          });
          inserted.push(rowid);
        } catch {}
      }
    } catch {}
  }
  return {
    ok: true,
    topic,
    eventsProcessed: selected.length,
    insertedCount: inserted.length,
    ids: inserted,
  };
}
