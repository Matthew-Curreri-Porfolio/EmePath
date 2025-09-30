// EmePath.js — Orchestrate an agent loop to distill raw data into
// JSONL training examples for a custom MoE/LoRA system.
//
// Uses Brain to manage agent state and the prompt composer to enforce
// strict JSONL output suitable for training pipelines.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

import Brain from './brain.js';
import db from './gateway/db/db.js';
import { composeSystem } from './gateway/prompts/compose.js';
import { getPrompt } from './gateway/prompts/index.js';
import express from 'express';
import http from 'http';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execCb);
let LAST_BRAIN = null;

// Global control flags
const CONTROL = { paused: false };

function toStr(x) {
  return typeof x === 'string' ? x : x == null ? '' : String(x);
}

async function readFileSafe(p) {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return '';
  }
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

function isFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    const st = fs.statSync(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function listFilesRecursive(root, exts) {
  const out = [];
  async function walk(dir) {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const d of items) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!exts || !exts.length) {
        out.push(p);
      } else if (exts.some((e) => p.toLowerCase().endsWith(e))) {
        out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}

function extractDistillOutputs(text) {
  // Returns { flatLines: string[], metaLines: string[] }
  const raw = toStr(text)
    .replace(/^```(?:json|ndjson)?/gim, '')
    .replace(/```$/gim, '');
  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const flatLines = [];
  const metaLines = [];
  for (const ln of lines) {
    if (!ln.startsWith('{') || !ln.endsWith('}')) continue;
    let obj;
    try {
      obj = JSON.parse(ln);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    // If multi-attempt schema present, keep a meta copy and derive a flat record.
    const hasAttempts = Array.isArray(obj.attempts) && obj.attempts.length > 0;
    if (hasAttempts) {
      // Ensure assistant present; if missing, derive from 'best'
      if (typeof obj.assistant !== 'string' || !obj.assistant.trim()) {
        let chosen;
        if (String(obj.best || '').toLowerCase() === 'redemption') {
          const fail = obj.attempts.find((a) => a && a.redemption);
          if (fail && fail.redemption) {
            chosen = `${toStr(fail.redemption.thoughts)}\n${toStr(
              fail.redemption.answer
            )}`.trim();
          }
        }
        if (!chosen) {
          const byId = obj.attempts.find((a) => toStr(a.id) === toStr(obj.best));
          if (byId) chosen = `${toStr(byId.thoughts)}\n${toStr(byId.answer)}`.trim();
        }
        if (!chosen && obj.attempts[0]) {
          const a0 = obj.attempts[0];
          chosen = `${toStr(a0.thoughts)}\n${toStr(a0.answer)}`.trim();
        }
        obj.assistant = toStr(chosen || obj.assistant || '');
      }
      // Sanitize fields minimally
      const sys = typeof obj.system === 'string' ? obj.system : '';
      const usr = typeof obj.user === 'string' ? obj.user : '';
      const asst = typeof obj.assistant === 'string' ? obj.assistant : '';
      flatLines.push(JSON.stringify({ system: sys, user: usr, assistant: asst }));
      metaLines.push(JSON.stringify(obj));
      continue;
    }
    // Otherwise accept simple {system,user,assistant}
    if (typeof obj.user === 'string' && typeof obj.assistant === 'string') {
      flatLines.push(
        JSON.stringify({
          system: typeof obj.system === 'string' ? obj.system : '',
          user: obj.user,
          assistant: obj.assistant,
        })
      );
    }
  }
  return { flatLines, metaLines };
}

async function readStandards() {
  const p = path.resolve(process.cwd(), 'work', 'standards');
  return await readFileSafe(p);
}

function sliceMid(text, max) {
  const s = toStr(text);
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + '\n...\n' + s.slice(s.length - half);
}

async function spawnAgentsForFiles(brain, { projectId, files, maxCharsPerAgent }) {
  const spawned = [];
  for (const f of files) {
    const content = await readFileSafe(f);
    const use = maxCharsPerAgent ? sliceMid(content, maxCharsPerAgent) : content;
    const agent = brain._spawnAgent({
      projectId,
      goal: `Distill file to JSONL training examples: ${path.basename(f)}`,
      input: `Path: ${f}\nContent (possibly truncated):\n\n${use}`,
      expected: 'JSONL lines, one object per line with {system,user,assistant}',
    });
    spawned.push(agent);
  }
  return spawned;
}

async function runAgentLoop(
  brain,
  agents,
  { standards, outFile, metaOutFile, temperature = 0.2, maxTokens = 1024, onTick }
) {
  await ensureDir(path.dirname(outFile));
  if (metaOutFile) await ensureDir(path.dirname(metaOutFile));
  const contract = getPrompt('contracts.jsonl_only_strict') || 'Output Contract: Respond only with JSONL.';
  const minAttempts = Number(process.env.DISTILL_MIN_ATTEMPTS || process.env.ATTEMPTS_MIN || '2') || 2;
  const maxAttempts = Number(process.env.DISTILL_MAX_ATTEMPTS || process.env.ATTEMPTS_MAX || '3') || 3;
  const forceOneFailure = String(process.env.DISTILL_FORCE_FAILURE || process.env.FORCE_FAILURE || 'false').toLowerCase() === 'true';
  const systemPrompt = composeSystem('training.distill.system', {
    standards,
    contract,
    minAttempts,
    maxAttempts,
    forceOneFailure,
  });

  for (const a of agents) {
    if (CONTROL.paused) {
      brain.checkIn(a.id, 'paused', { note: 'paused by interrupt' });
      continue;
    }
    // Update status and lastCheckIn
    agentLog(a.projectId, `[${a.id}] start distill: ${a.goal}`);
    brain.checkIn(a.id, 'running');
    const messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          'Convert the following raw text into high-quality training examples.',
          'Return JSONL only — one object per line with fields {system,user,assistant}.',
          '',
          a.input,
        ].join('\n'),
      },
    ];
    try {
      if (CONTROL.paused) {
        brain.checkIn(a.id, 'paused', { note: 'paused by interrupt' });
        continue;
      }
      const res = await brain.llm.chat({ messages, temperature, maxTokens });
      const raw = toStr(res?.content || '');
      const { flatLines, metaLines } = extractDistillOutputs(raw);
      if (flatLines.length) {
        await fsp.appendFile(outFile, flatLines.join('\n') + '\n');
      }
      if (metaOutFile && metaLines.length) {
        await fsp.appendFile(metaOutFile, metaLines.join('\n') + '\n');
      }
      brain.checkIn(a.id, 'done');
      agentLog(a.projectId, `[${a.id}] done distill: wrote ${flatLines.length} flat, ${metaLines.length} meta lines`);
      if (typeof onTick === 'function') {
        try { onTick(a); } catch {}
      }
    } catch (e) {
      const emsg = String(e?.message || e);
      console.error('[agent:error]', a.id, emsg);
      agentLog(a.projectId, `[${a.id}] error distill: ${emsg}`);
      brain.checkIn(a.id, 'error');
    }
  }
}

async function main() {
  // CLI args:
  //   Distill mode: --in <file|dir> --out <file> [--metaOut <file>] --project <id> --user <id>
  //   Server mode:  --server [--port <n> | --portStart <a> --portEnd <b>] [--project <id>] [--user <id>]
  const argv = process.argv.slice(2);
  function arg(k, def) {
    const i = argv.indexOf(`--${k}`);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    return def;
  }
  const has = (k) => argv.includes(`--${k}`);

  // Decide mode
  const serverMode = has('server') || String(process.env.EMEPATH_SERVER || '0') === '1';

  const brain = new Brain();
  LAST_BRAIN = brain;
  if (serverMode) {
    const projectId = arg('project', 'emepath');
    const userId = Number(arg('user', '1')) || 1;
    brain.createSession({ userId, projectId });

    await startServer(brain, { projectId, userId, argv });
    return;
  }

  // Distill mode
  const inPath = path.resolve(process.cwd(), arg('in', 'documents'));
  const outFile = path.resolve(process.cwd(), arg('out', 'data/training/distilled.jsonl'));
  const metaOutFile = path.resolve(process.cwd(), arg('metaOut', 'data/training/distilled.meta.jsonl'));
  const projectId = arg('project', 'moe-train');
  const userId = Number(arg('user', '1')) || 1;
  const maxCharsPerAgent = Number(arg('maxChars', '8000')) || 8000;

  // Attempts control (CLI overrides env)
  if (argv.includes('--attemptsMin')) process.env.ATTEMPTS_MIN = String(arg('attemptsMin'));
  if (argv.includes('--attemptsMax')) process.env.ATTEMPTS_MAX = String(arg('attemptsMax'));
  if (argv.includes('--forceFailure')) process.env.FORCE_FAILURE = String(arg('forceFailure'));

  brain.createSession({ userId, projectId });

  if (!isFile(inPath) && !isDir(inPath)) {
    console.error(`[error] input does not exist: ${inPath}`);
    process.exit(1);
  }

  const exts = ['.md', '.txt', '.json', '.jsonl'];
  const fileList = isFile(inPath) ? [inPath] : await listFilesRecursive(inPath, exts);
  if (!fileList.length) {
    console.error('[warn] no input files found');
    process.exit(0);
  }

  const standards = await readStandards();
  const agents = await spawnAgentsForFiles(brain, { projectId, files: fileList, maxCharsPerAgent });
  await runAgentLoop(brain, agents, { standards, outFile, metaOutFile });

  console.log(`[ok] processed ${agents.length} agent(s). Output: ${outFile}`);
  console.log(`[ok] meta written to: ${metaOutFile}`);
}

// Run if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[fatal]', String(e?.message || e));
    process.exit(1);
  });
}

export default { main };

// -------------------- Service Mode --------------------

async function startServer(brain, { projectId, userId, argv }) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.text({ type: ['text/*', 'application/x-ndjson'], limit: '2mb' }));

  // Load persisted agents (best-effort)
  try { await loadAgentsState(userId, projectId, brain); } catch {}

  // Wrap checkIn to persist on updates
  try {
    const origCheckIn = brain.checkIn.bind(brain);
    brain.checkIn = (agentId, status = 'running', meta = {}) => {
      const ok = origCheckIn(agentId, status, meta);
      try { const a = brain.agents.get(agentId); if (a) persistAgentsState(userId, a.projectId, brain); } catch {}
      return ok;
    };
  } catch {}

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'emepath', projectId, userId });
  });

  // Pause/resume control
  app.post('/pause', (_req, res) => {
    CONTROL.paused = true;
    res.json({ ok: true, paused: CONTROL.paused });
  });
  app.post('/resume', (_req, res) => {
    CONTROL.paused = false;
    // Kick queue
    setImmediate(runNext);
    res.json({ ok: true, paused: CONTROL.paused });
  });

  // Agent check-in endpoint
  app.post('/agent/checkin', (req, res) => {
    const agentId = toStr(req.body?.agentId || '');
    const status = toStr(req.body?.status || 'running');
    const eots = Number(req.body?.eots || 0) || 0;
    const note = toStr(req.body?.note || '');
    if (!agentId) return res.status(400).json({ ok: false, error: 'missing_agentId' });
    const ok = brain.checkIn(agentId, status, { eotsDelta: eots, note });
    return res.json({ ok, agentId, status, eotsDelta: eots });
  });

  // Text-in → plan + agent manifest out
  app.post('/process', async (req, res) => {
    try {
      // Accept JSON body or plain text. If plain text resembles JSON, try parsing to extract fields.
      let textRaw = '';
      let env = {};
      let opts = {};
      if (req.is('application/json')) {
        textRaw = toStr(req.body?.text || req.body?.prompt || '');
        env = (req.body && req.body.env) || {};
        opts = (req.body && req.body.options) || {};
      } else if (req.is('text/*') || typeof req.body === 'string') {
        const bodyText = toStr(req.body);
        // Lint attempt: if JSON-like, parse and pretty-print; else trim excessive whitespace
        let parsed = null;
        if (/^[\[{]/.test(bodyText.trim())) {
          try { parsed = JSON.parse(bodyText); } catch {}
        }
        if (parsed && typeof parsed === 'object') {
          textRaw = toStr(parsed.text || parsed.prompt || '');
          env = parsed.env || {};
          opts = parsed.options || {};
        } else {
          // treat as raw task text
          textRaw = bodyText.replace(/[\t\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
        }
      } else {
        textRaw = toStr(req.body || '');
      }
      const pid = toStr((req.body && req.body.project) || req.query?.project || projectId);
      env = env || {}; env.projectId = env.projectId || pid;

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const contract = getPrompt('contracts.json_object_strict') || '';
      const hasModelPath = !!process.env.LORA_MODEL_PATH;
      const system = composeSystem('emepath.planner.system', {
        checkInBase: baseUrl,
        checkInIntervalEOT: Number(process.env.AGENT_CHECKIN_EOT || '1') || 1,
        capabilities: toStr(process.env.EMEPATH_CAPABILITIES || 'distill,scan,query'),
        contract,
        modelConfigured: hasModelPath ? 'true' : 'false',
      });
      const userMsg = [
        `Env: ${JSON.stringify(env)}`,
        `Input: ${textRaw}`,
        `Respond strictly with the JSON object as per schema.`,
      ].join('\n');
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ];

      let raw;
      try {
        const out = await brain.llm.chat({ messages, temperature: Number(opts.temperature || 0.2), maxTokens: Number(opts.maxTokens || 1024) });
        raw = toStr(out?.content || '');
      } catch (e) {
        if (isNoModelError(e)) {
          const fb = bootstrapFallbackPlan(baseUrl);
          const wantTextOut = toStr(req.query?.format || '').toLowerCase() === 'text' || (req.headers.accept || '').includes('text/plain');
          if (wantTextOut) return res.type('text/plain').send([fb.text, JSON.stringify(fb.plan)].join('\n'));
          return res.json({ ok: true, text: fb.text, plan: fb.plan, agents: [] });
        }
        throw e;
      }
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {}
      const wantTextOut = toStr(req.query?.format || '').toLowerCase() === 'text' || (req.headers.accept || '').includes('text/plain');
      if (!parsed) return res.status(200).type(wantTextOut ? 'text/plain' : 'application/json').send(wantTextOut ? raw : JSON.stringify({ ok: true, raw }));

      // Spawn agents per manifest
      const agents = [];
      const maxAgents = Number(process.env.EMEPATH_MAX_AGENTS || '100') || 100;
      for (const a of Array.isArray(parsed.agents) ? parsed.agents : []) {
        const ag = brain._spawnAgent({ projectId: pid, goal: a.title, input: a.input, expected: a.expected });
        agents.push({ ...ag, kind: a.kind || 'custom' });
        if (agents.length >= maxAgents) break;
      }
      try { persistAgentsState(userId, pid, brain); } catch {}

      // Compose a human-readable text response while keeping API JSON in body
      const manifestText = [
        `Intent: ${toStr(parsed.intent)}`,
        `Goals: ${(Array.isArray(parsed.goals) ? parsed.goals : []).join(' | ')}`,
        `Plan: ${(Array.isArray(parsed.plan) ? parsed.plan : []).join(' -> ')}`,
        parsed.checklist && Array.isArray(parsed.checklist) && parsed.checklist.length ? ['','Checklist:', ...parsed.checklist.map((c) => `- [${c.required ? 'x' : ' '}] ${c.id}: ${c.title} (${c.action})`)].join('\n') : '',
        '',
        'Agents:',
        ...agents.map((a) => `- ${a.id}: ${a.goal} (kind=${a.kind}) [check-in: POST ${baseUrl}/agent/checkin]`),
      ].join('\n');

      // Auto-execution (kind-aware) and optional background queue
      const auto = opts.autorun === true || toStr(req.query?.autorun).toLowerCase() === 'true';
      const background = opts.background === true || toStr(req.query?.background).toLowerCase() === 'true';

      let job = null;
      if (auto && agents.length) {
        job = enqueueKindAware(brain, { projectId: pid, agents, checklist: parsed.checklist || [], baseUrl });
        if (!background) {
          await job.awaitDone();
        }
      }

      // Auto-execute suggested actions when present (survey_env, replicate_workspace, suggest_fixes, suggest_features, bootstrap_lora)
      const actionResults = [];
      if (auto && Array.isArray(parsed.actions) && parsed.actions.length) {
        for (const act of parsed.actions) {
          try {
            const r = await runControllerAction(brain, { projectId: pid, baseUrl }, act, parsed);
            actionResults.push(r);
          } catch (e) {
            actionResults.push({ tool: String(act?.tool || 'unknown'), ok: false, error: toStr(e?.message || e) });
          }
        }
      }

      if (wantTextOut) {
        const extra = job ? `\nJob: ${job.id} status=${job.status}` : '';
        const aextra = actionResults.length ? `\nActions: ${actionResults.map(a => a.tool+':' + (a.ok?'ok':('error:'+ (a.error||'')))).join(', ')}` : '';
        return res.type('text/plain').send(manifestText + extra + aextra);
      }
      return res.json({ ok: true, text: manifestText, plan: parsed, agents, job: job ? { id: job.id, status: job.status } : null, actions: actionResults });
    } catch (e) {
      return res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  // Controller: LLM decides updates, requirements, and tool calls
  app.post('/control', async (req, res) => {
    try {
      // Accept JSON or plain text
      let textRaw = '';
      let env = {};
      let opts = {};
      if (req.is('application/json')) {
        textRaw = toStr(req.body?.text || req.body?.prompt || '');
        env = req.body?.env || {};
        opts = req.body?.options || {};
      } else if (req.is('text/*') || typeof req.body === 'string') {
        const bodyText = toStr(req.body);
        try {
          const parsed = JSON.parse(bodyText);
          textRaw = toStr(parsed.text || parsed.prompt || '');
          env = parsed.env || {};
          opts = parsed.options || {};
        } catch {
          textRaw = bodyText.replace(/[\t\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
        }
      } else {
        textRaw = toStr(req.body || '');
      }

      const pidCtl = toStr((req.body && req.body.project) || req.query?.project || projectId);
      env = env || {}; env.projectId = env.projectId || pidCtl;
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const contract = getPrompt('contracts.json_object_strict') || '';
      const toolsSpec = buildToolsSpec(baseUrl);
      const system = composeSystem('emepath.controller.system', { toolsSpec, contract });
      const userMsg = [
        `Env: ${JSON.stringify(env)}`,
        `Input: ${textRaw}`,
        `Respond strictly with the JSON object as per schema.`,
      ].join('\n');
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ];

      const wantTextOut = toStr(req.query?.format || '').toLowerCase() === 'text' || (req.headers.accept || '').includes('text/plain');
      const loop = (opts.loop === true) || (toStr(req.query?.loop).toLowerCase() === 'true');
      const maxTurns = Number(opts.maxTurns || req.query?.maxTurns || 3) || 3;
      const turnRes = loop
        ? await runControlLoop(brain, { textRaw, env, options: opts, baseUrl, maxTurns })
        : await runControlOnce(brain, { textRaw, env, options: opts, baseUrl });

      if (wantTextOut) return res.type('text/plain').send(turnRes.text);
      return res.json(turnRes);
    } catch (e) {
      return res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  // Interrupt: accept a double message, summarize status, decide pause, and update plan
  app.post('/interrupt', async (req, res) => {
    try {
      const wantTextOut = toStr(req.query?.format || '').toLowerCase() === 'text' || (req.headers.accept || '').includes('text/plain');
      let messages = [];
      let env = {};
      let opts = {};
      if (req.is('application/json')) {
        if (Array.isArray(req.body?.messages)) messages = req.body.messages.map((x) => toStr(x));
        if (req.body?.text) messages = [toStr(req.body.text)];
        env = req.body?.env || {};
        opts = req.body?.options || {};
      } else {
        const bodyText = toStr(req.body || '');
        try {
          const parsed = JSON.parse(bodyText);
          if (Array.isArray(parsed?.messages)) messages = parsed.messages.map((x) => toStr(x));
          else if (parsed?.text) messages = [toStr(parsed.text)];
          env = parsed?.env || {};
          opts = parsed?.options || {};
        } catch {
          const parts = bodyText.split(/\n\n+|^---$|\n---\n/).map((s) => s.trim()).filter(Boolean);
          messages = parts.slice(0, 2);
        }
      }
      if (!messages.length) messages = [''];

      const pidInt = toStr((req.body && req.body.project) || req.query?.project || projectId);
      env = env || {}; env.projectId = env.projectId || pidInt;
      const status = gatherStatus(pidInt);
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const contract = getPrompt('contracts.json_object_strict') || '';
      const toolsSpec = buildToolsSpec(baseUrl);
      const system = composeSystem('emepath.interrupt.system', { toolsSpec, contract });
      const userMsg = [
        'STATUS_JSON:',
        JSON.stringify(status),
        '',
        'NEW_MESSAGES:',
        ...messages.map((m, i) => `#${i + 1}: ${m}`),
        '',
        'Decide pause vs continue. If pause is not needed, keep agents running and extend the plan.',
      ].join('\n');
      let raw;
      try {
        const chat = await brain.llm.chat({ messages: [ { role: 'system', content: system }, { role: 'user', content: userMsg } ], temperature: Number(opts.temperature || 0.2), maxTokens: Number(opts.maxTokens || 1024) });
        raw = toStr(chat?.content || '');
      } catch (e) {
        if (isNoModelError(e)) {
          const fb = bootstrapFallbackPlan(baseUrl);
          const wantTextOut = toStr(req.query?.format || '').toLowerCase() === 'text' || (req.headers.accept || '').includes('text/plain');
          if (wantTextOut) return res.type('text/plain').send([renderStatusText(status), '', fb.text, JSON.stringify(fb.plan)].join('\n'));
          return res.json({ ok: true, paused: CONTROL.paused, status, decision: { pauseNow: false, reason: 'no_model' }, updatedPlan: fb.plan.plan || [], text: fb.text, plan: fb.plan });
        }
        throw e;
      }
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {}
      if (!parsed) return res.status(200).type(wantTextOut ? 'text/plain' : 'application/json').send(wantTextOut ? raw : JSON.stringify({ ok: true, raw }));

      // Apply pause decision
      const pauseNow = !!parsed.pauseNow;
      CONTROL.paused = pauseNow;
      if (!pauseNow) setImmediate(runNext);

      // Evaluate requirements and run actions
      const reqStatus = await evaluateRequirements(Array.isArray(parsed.requirements) ? parsed.requirements : []);
      const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      const results = [];
      let job = null;
      for (const act of actions) {
        const r = await runControllerAction(brain, { projectId, baseUrl }, act, parsed);
        results.push(r);
        if (r && r.job && !job) job = r.job;
      }

      const text = [
        renderStatusText(status),
        '',
        `Decision: ${pauseNow ? 'PAUSE' : 'CONTINUE'} — ${toStr(parsed.reason)}`,
        '',
        'Updated Plan:',
        ...(Array.isArray(parsed.updatedPlan) ? parsed.updatedPlan : []).map((s) => `- ${s}`),
        '',
        renderControllerText(parsed, reqStatus, results),
      ].join('\n');

      if (wantTextOut) return res.type('text/plain').send(text);
      return res.json({ ok: true, paused: CONTROL.paused, status, decision: { pauseNow, reason: parsed.reason || '' }, updatedPlan: parsed.updatedPlan || [], requirements: reqStatus, actions: results, text, job: job ? { id: job.id, status: job.status } : null });
    } catch (e) {
      return res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  // Job status
  app.get('/job/:id', (req, res) => {
    const id = toStr(req.params?.id || '');
    const job = QUEUE.jobs.get(id);
    if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });
    return res.json({ ok: true, id: job.id, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, meta: job.meta, error: job.error });
  });

  // Projects and status
  app.get('/projects', (_req, res) => {
    const list = listProjectsStatus();
    res.json({ ok: true, projects: list });
  });
  app.get('/status', (req, res) => {
    const pid = toStr(req.query?.project || '');
    const st = gatherStatus(pid || undefined);
    res.json({ ok: true, status: st });
  });

  // Logs tail
  app.get('/logs', async (req, res) => {
    try {
      const pid = toStr(req.query?.project || projectId);
      const dir = path.resolve(process.cwd(), 'logs');
      const alog = path.join(dir, `agent.${pid.replace(/[^a-zA-Z0-9_.-]+/g, '_')}.log`);
      const clog = path.join(dir, `chat.${pid.replace(/[^a-zA-Z0-9_.-]+/g, '_')}.jsonl`);
      const atxt = fs.existsSync(alog) ? await readFileSafe(alog) : '';
      const ctxt = fs.existsSync(clog) ? await readFileSafe(clog) : '';
      const tail = (s) => s.split(/\r?\n/).slice(-200).join('\n');
      res.type('text/plain').send(`# Agent Log\n${tail(atxt)}\n\n# Chat Log\n${tail(ctxt)}`);
    } catch (e) {
      res.status(500).type('text/plain').send(String(e?.message || e));
    }
  });

  // Simple chat
  app.get('/chat', (req, res) => {
    const pid = toStr(req.query?.project || projectId);
    const msgs = CHATS.get(pid) || [];
    res.json({ ok: true, projectId: pid, messages: msgs.slice(-100) });
  });
  app.post('/chat', async (req, res) => {
    try {
      const pid = toStr(req.body?.project || req.query?.project || projectId);
      const uid = Number(req.body?.user || userId) || userId;
      const text = toStr(req.body?.text || '');
      const wantTextOut = toStr(req.query?.format || '').toLowerCase() === 'text' || (req.headers.accept || '').includes('text/plain');
      if (!text) return res.status(400).json({ ok: false, error: 'missing_text' });
      appendChat(pid, 'user', text);
      let reply = '';
      try {
        const messages = buildChatMessages(pid);
        const out = await LAST_BRAIN.llm.chat({ messages, temperature: 0.2, maxTokens: 768 });
        reply = toStr(out?.content || '');
      } catch (e) {
        if (isNoModelError(e)) reply = '[no-model] Received. You can bootstrap a dataset via /control (bootstrap_lora).';
        else throw e;
      }
      appendChat(pid, 'assistant', reply);
      await maybeSummarize(pid, uid);
      const payload = { ok: true, projectId: pid, reply, messages: (CHATS.get(pid) || []).slice(-100) };
      if (wantTextOut) return res.type('text/plain').send(reply);
      return res.json(payload);
    } catch (e) {
      return res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  // Minimal web UI
  app.get('/ui', (_req, res) => {
    res.type('text/html').send(renderUIHtml2());
  });

  // Agent management endpoints
  app.post('/agent/:id/mark', (req, res) => {
    const id = toStr(req.params?.id || '');
    const status = toStr(req.body?.status || 'pending');
    const note = toStr(req.body?.note || '');
    const ok = LAST_BRAIN && LAST_BRAIN.checkIn(id, status, { note });
    if (!ok) return res.status(404).json({ ok: false, error: 'agent_not_found' });
    res.json({ ok: true, id, status });
  });
  app.post('/agent/:id/run', async (req, res) => {
    try {
      const id = toStr(req.params?.id || '');
      const kind = toStr(req.body?.kind || 'custom').toLowerCase();
      const agent = LAST_BRAIN && LAST_BRAIN.agents && LAST_BRAIN.agents.get(id);
      if (!agent) return res.status(404).json({ ok: false, error: 'agent_not_found' });
      const pid = agent.projectId;
      const job = enqueueKindAware(LAST_BRAIN, { projectId: pid, agents: [{ ...agent, kind }], checklist: [], baseUrl: '' });
      res.json({ ok: true, job: { id: job.id, status: job.status } });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  const portStart = Number(process.env.EMEPATH_PORT_START || (argv.includes('--portStart') ? argv[argv.indexOf('--portStart') + 1] : '51100')) || 51100;
  const portEnd = Number(process.env.EMEPATH_PORT_END || (argv.includes('--portEnd') ? argv[argv.indexOf('--portEnd') + 1] : '51199')) || 51199;
  const explicitPort = Number(process.env.EMEPATH_PORT || (argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : '0')) || 0;

  const server = http.createServer(app);
  const port = await pickPort(server, { portStart, portEnd, explicitPort });
  await new Promise((resolve) => server.listen(port, resolve));
  console.log(`[emepath] listening on :${port}`);
}

async function pickPort(server, { portStart, portEnd, explicitPort }) {
  const tryListen = (p) => new Promise((resolve) => {
    const s = http.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(p);
  });
  if (explicitPort) return explicitPort;
  for (let p = portStart; p <= portEnd; p++) {
    // Quick probe: create ephemeral server to check availability
    // Reuse main server after choosing
    // eslint-disable-next-line no-await-in-loop
    const ok = await tryListen(p);
    if (ok) return p;
  }
  // fallback to 0 (random)
  return 0;
}

// -------------------- Kind-aware executor + queue --------------------

const QUEUE = { running: 0, max: Number(process.env.EMEPATH_CONCURRENCY || '4') || 4, seq: 1, jobs: new Map() };

function createJob(meta = {}) {
  const id = `job_${QUEUE.seq++}`;
  let resolveDone;
  const doneP = new Promise((r) => (resolveDone = r));
  const job = { id, status: 'pending', meta, startedAt: null, finishedAt: null, resolveDone, awaitDone: () => doneP };
  QUEUE.jobs.set(id, job);
  return job;
}

function runNext() {
  if (CONTROL.paused) return;
  if (QUEUE.running >= QUEUE.max) return;
  const next = QUEUE.pending?.shift();
  if (!next) return;
  QUEUE.running++;
  next.job.status = 'running';
  next.job.startedAt = new Date().toISOString();
  next.fn()
    .then(() => {
      next.job.status = 'done';
      next.job.finishedAt = new Date().toISOString();
      next.job.resolveDone();
    })
    .catch((e) => {
      next.job.status = 'error';
      next.job.error = toStr(e?.message || e);
      next.job.finishedAt = new Date().toISOString();
      next.job.resolveDone();
    })
    .finally(() => {
      QUEUE.running--;
      runNext();
    });
}

function enqueue(fn, meta) {
  if (!QUEUE.pending) QUEUE.pending = [];
  const job = createJob(meta);
  QUEUE.pending.push({ fn, job });
  setImmediate(runNext);
  return job;
}

function enqueueKindAware(brain, { projectId, agents, checklist, baseUrl }) {
  const job = enqueue(async () => {
    // Enforce checklist before agents
    await enforceChecklist(checklist);
    // Execute agents by kind
    for (const a of agents) {
      const k = toStr(a.kind).toLowerCase();
      if (k === 'distill') {
        await executeDistillAgent(brain, projectId, a, { baseUrl });
      } else if (k === 'scan') {
        await executeScanAgent(brain, projectId, a);
      } else if (k === 'query') {
        await executeQueryAgent(brain, projectId, a);
      } else {
        brain.checkIn(a.id, 'skipped', { note: `No executor for kind=${a.kind}` });
      }
    }
    // Enforce checklist after agents (e.g., run tests)
    await enforceChecklist(checklist);
  }, { projectId, count: agents.length });
  return job;
}

async function enforceChecklist(list = []) {
  for (const item of Array.isArray(list) ? list : []) {
    const id = toStr(item.id || '');
    const required = !!item.required;
    const action = toStr(item.action || '').toLowerCase();
    try {
      if (action === 'file_exists') {
        const p = path.resolve(process.cwd(), toStr(item.args?.path || ''));
        if (!p || !fs.existsSync(p)) throw new Error(`missing file: ${p}`);
      } else if (action === 'read_standards') {
        const s = await readStandards();
        if (!s) throw new Error('standards not found');
      } else if (action === 'run_tests') {
        await runTests();
      } else {
        if (required) throw new Error(`unknown action: ${action}`);
      }
    } catch (e) {
      if (required) throw e;
    }
  }
}

async function runTests() {
  // Try vitest, fallback to npm test
  try {
    const { stdout, stderr } = await exec('npx -y vitest run', { cwd: process.cwd(), timeout: 120000 });
    return { ok: true, stdout, stderr };
  } catch {}
  try {
    const { stdout, stderr } = await exec('npm run -s test', { cwd: process.cwd(), timeout: 180000 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    // Surface but do not crash non-required workflows
    const msg = toStr(e?.message || e);
    throw new Error(`tests_failed: ${msg}`);
  }
}

async function runLint() {
  try {
    const { stdout, stderr } = await exec('npm run -s lint', { cwd: process.cwd(), timeout: 120000 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    // Try npx eslint fallback
    try {
      const { stdout, stderr } = await exec('npx -y eslint "**/*.{js,mjs,cjs,ts,tsx}"', { cwd: process.cwd(), timeout: 180000 });
      return { ok: true, stdout, stderr };
    } catch (e2) {
      return { ok: false, error: toStr(e2?.message || e2) };
    }
  }
}

async function executeDistillAgent(brain, projectId, agent, { baseUrl }) {
  // Parse input -> paths or raw content
  const parsed = parseDistillInput(agent.input);
  const standards = await readStandards();
  const outDir = path.resolve(process.cwd(), 'data', 'training');
  await ensureDir(outDir);
  const outFile = path.join(outDir, `distilled.${agent.id}.jsonl`);
  const metaOutFile = path.join(outDir, `distilled.${agent.id}.meta.jsonl`);

  agentLog(projectId, `[${agent.id}] execute distill`);
  if (parsed.paths && parsed.paths.length) {
    const files = [];
    for (const p of parsed.paths) {
      const abs = path.resolve(process.cwd(), p);
      if (isFile(abs)) files.push(abs);
      else if (isDir(abs)) {
        const more = await listFilesRecursive(abs, ['.md', '.txt', '.json', '.jsonl']);
        files.push(...more);
      }
    }
    const fileAgents = await spawnAgentsForFiles(brain, { projectId, files, maxCharsPerAgent: parsed.maxChars || 8000 });
    await runAgentLoop(brain, fileAgents, {
      standards,
      outFile,
      metaOutFile,
      onTick: () => brain.checkIn(agent.id, 'running', { eotsDelta: 1 }),
    });
  } else if (parsed.content) {
    // Distill raw content as a single virtual file-agent
    const a = brain._spawnAgent({ projectId, goal: `Distill content`, input: parsed.content, expected: 'JSONL lines' });
    await runAgentLoop(brain, [a], {
      standards,
      outFile,
      metaOutFile,
      onTick: () => brain.checkIn(agent.id, 'running', { eotsDelta: 1 }),
    });
  }
  brain.checkIn(agent.id, 'done', { note: `distilled to ${outFile}` });
  agentLog(projectId, `[${agent.id}] distill complete -> ${outFile}`);
}

async function executeScanAgent(brain, projectId, agent) {
  // input JSON: { root: string, maxFileSize?: number }
  try {
    agentLog(projectId, `[${agent.id}] execute scan`);
    let j = null;
    try { j = JSON.parse(toStr(agent.input)); } catch {}
    const root = toStr(j?.root || agent.input || '');
    const maxFileSize = Number(j?.maxFileSize || process.env.SCAN_MAX_FILE || '262144') || 262144;
    const r = await scanDirToIndex(root, maxFileSize);
    brain.checkIn(agent.id, 'done', { note: `scan ok root=${r.root} files=${r.count}`, eotsDelta: 1 });
    agentLog(projectId, `[${agent.id}] scan complete: ${r.count} files`);
  } catch (e) {
    const emsg = toStr(e?.message || e);
    brain.checkIn(agent.id, 'error', { note: emsg });
    agentLog(projectId, `[${agent.id}] scan error: ${emsg}`);
  }
}

async function executeQueryAgent(brain, projectId, agent) {
  // input JSON: { q: string, k?: number }
  try {
    agentLog(projectId, `[${agent.id}] execute query`);
    let j = null;
    try { j = JSON.parse(toStr(agent.input)); } catch {}
    const q = toStr(j?.q || agent.input || '');
    const k = Number(j?.k || 8) || 8;
    const out = queryIndex(q, k);
    const outDir = path.resolve(process.cwd(), 'data', 'query');
    await ensureDir(outDir);
    const outFile = path.join(outDir, `hits.${agent.id}.json`);
    await fsp.writeFile(outFile, JSON.stringify(out, null, 2), 'utf8');
    brain.checkIn(agent.id, 'done', { note: `query ok hits=${out.hits.length} -> ${outFile}`, eotsDelta: 1 });
    agentLog(projectId, `[${agent.id}] query complete: hits=${out.hits.length}`);
  } catch (e) {
    const emsg = toStr(e?.message || e);
    brain.checkIn(agent.id, 'error', { note: emsg });
    agentLog(projectId, `[${agent.id}] query error: ${emsg}`);
  }
}

async function executeBootstrapLoRA(brain, projectId, args = {}) {
  // Bootstrap: scan sources, distill dataset, optionally prepare training command.
  const sources = Array.isArray(args.sources) && args.sources.length ? args.sources : ['.', 'documents', 'docs'];
  // Scan
  const scanAgent = brain._spawnAgent({ projectId, goal: 'Bootstrap: scan sources', input: JSON.stringify({ root: sources[0] }), expected: 'index ready' });
  await executeScanAgent(brain, projectId, { ...scanAgent, kind: 'scan' });
  // Distill
  const distillAgent = brain._spawnAgent({ projectId, goal: 'Bootstrap: distill sources', input: JSON.stringify({ files: sources }), expected: 'JSONL dataset' });
  const hasModelPath = !!process.env.LORA_MODEL_PATH;
  if (hasModelPath) {
    await executeDistillAgent(brain, projectId, { ...distillAgent, kind: 'distill' }, { baseUrl: '' });
  } else {
    // Create a placeholder dataset plan instead of running LLM distillation
    const outDir = path.resolve(process.cwd(), 'data', 'training');
    await ensureDir(outDir);
    const noteFile = path.join(outDir, `distill.plan.${distillAgent.id}.txt`);
    const note = [
      'No LORA_MODEL_PATH configured. Skipping distillation.\n',
      'Set LORA_MODEL_PATH to a base model path and re-run bootstrap or distill agents.',
      `Suggested sources: ${sources.join(', ')}`,
    ].join('\n');
    await fsp.writeFile(noteFile, note + '\n', 'utf8');
    brain.checkIn(distillAgent.id, 'skipped', { note: 'no model: wrote distill plan' });
  }

  // Prepare training script (do not auto-run by default)
  const outDir = path.resolve(process.cwd(), 'runs', 'bootstrap');
  await ensureDir(outDir);
  const dataset = path.resolve(process.cwd(), 'data', 'training');
  const trainScript = path.join(outDir, 'train.sh');
  const cmd = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'MODEL_PATH="${LORA_MODEL_PATH:-/path/to/base-model}"',
    `DATASET="${dataset}/distilled.${distillAgent.id}.jsonl"`,
    'OUT_DIR="runs/freeform-lora"',
    'python tools/train_freeform_mode.py --mode lora --model "$MODEL_PATH" --train "$DATASET" --out "$OUT_DIR" --bf16 || python3 tools/train_freeform_mode.py --mode lora --model "$MODEL_PATH" --train "$DATASET" --out "$OUT_DIR"',
    'echo "[OK] LoRA saved to $OUT_DIR"',
    'echo "Set: export LORA_ADAPTERS=\"user=$OUT_DIR\""',
  ].join('\n');
  await fsp.writeFile(trainScript, cmd + '\n', 'utf8');
  try { await fsp.chmod(trainScript, 0o755); } catch {}
  brain.checkIn(distillAgent.id, 'done', { note: `bootstrap prepared; train: ${trainScript}` });

  // Optionally auto-run training (if allowed)
  if (args.allowTrain === true) {
    try {
      await exec(trainScript, { cwd: process.cwd(), timeout: 0 });
    } catch (e) {
      // non-fatal; leave script ready
    }
  }
  // Return a dummy job record for symmetry
  // Also suggest env survey and replication
  try { await surveyEnvironment(); } catch {}
  try { await replicateWorkspace({ source: '.', target: 'work/replica', linkDependencies: true }); } catch {}
  agentLog(projectId, `[bootstrap] prepared training script and replication`);
  const job = { id: `bootstrap_${Date.now()}`, status: 'done' };
  return job;
}

function parseDistillInput(input) {
  const s = toStr(input || '');
  // Try JSON first
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object') {
      const paths = [];
      if (Array.isArray(j.files)) paths.push(...j.files);
      if (typeof j.path === 'string') paths.push(j.path);
      if (typeof j.dir === 'string') paths.push(j.dir);
      if (typeof j.file === 'string') paths.push(j.file);
      return { paths, content: toStr(j.content || ''), maxChars: j.maxChars };
    }
  } catch {}
  // Heuristics
  const m = s.match(/(?:path|file|dir)\s*:\s*([^\n]+)/i);
  if (m) return { paths: [m[1].trim()] };
  if (fs.existsSync(path.resolve(process.cwd(), s))) return { paths: [s] };
  // Default: treat as content
  return { content: s };
}

// -------------------- Status helpers --------------------

function gatherStatus(filterProjectId) {
  const agentsList = [];
  const counts = { pending: 0, running: 0, done: 0, error: 0, paused: 0, other: 0 };
  const brain = LAST_BRAIN;
  if (brain && brain.agents) {
    for (const a of brain.agents.values()) {
      if (filterProjectId && String(a.projectId) !== String(filterProjectId)) continue;
      const st = toStr(a.status || 'other').toLowerCase();
      if (counts[st] !== undefined) counts[st]++;
      else counts.other++;
      agentsList.push({ id: a.id, goal: a.goal, status: a.status, lastCheckIn: a.lastCheckIn, eots: a.eots || 0, note: a.lastNote || '' });
    }
  }
  const q = {
    running: QUEUE.running,
    pending: (QUEUE.pending && QUEUE.pending.length) || 0,
    max: QUEUE.max,
    paused: CONTROL.paused,
  };
  const scan = { root: SCAN_INDEX.root, files: Array.isArray(SCAN_INDEX.files) ? SCAN_INDEX.files.length : 0 };
  return { counts, agents: agentsList.slice(0, 50), queue: q, scan };
}

function renderStatusText(status) {
  const lines = [
    'Status:',
    `- Agents: pending=${status.counts?.pending || 0} running=${status.counts?.running || 0} done=${status.counts?.done || 0} error=${status.counts?.error || 0} paused=${status.counts?.paused || 0}`,
    `- Queue: running=${status.queue.running} pending=${status.queue.pending} max=${status.queue.max} paused=${status.queue.paused}`,
    `- Scan: root=${status.scan.root || '(none)'} files=${status.scan.files}`,
  ];
  return lines.join('\n');
}

function listProjectsStatus() {
  const brain = LAST_BRAIN;
  const set = new Set();
  if (brain) {
    for (const a of brain.agents.values()) set.add(String(a.projectId));
    for (const [pid] of brain.projects) set.add(String(pid));
  }
  const arr = Array.from(set);
  return arr.map((pid) => ({ projectId: pid, status: gatherStatus(pid) }));
}

function agentsSnapshot(brain, projectId) {
  const list = [];
  if (brain && brain.agents) {
    for (const a of brain.agents.values()) {
      if (projectId && String(a.projectId) !== String(projectId)) continue;
      list.push({ id: a.id, projectId: a.projectId, goal: a.goal, input: a.input, expected: a.expected, status: a.status, lastCheckIn: a.lastCheckIn, eots: a.eots || 0, note: a.lastNote || '' });
    }
  }
  return list;
}

function persistAgentsState(userId, projectId, brain) {
  try {
    const snapshot = agentsSnapshot(brain, projectId);
    db.upsertMemory(userId, projectId, 'short', 'agents', JSON.stringify(snapshot), 'set');
  } catch {}
}

async function loadAgentsState(userId, projectId, brain) {
  try {
    const row = db.getMemory(userId, projectId, 'short', 'agents');
    if (!row || !row.content) return;
    const arr = JSON.parse(row.content);
    if (!Array.isArray(arr)) return;
    for (const a of arr) {
      if (!a || !a.id) continue;
      brain.agents.set(a.id, a);
    }
  } catch {}
}

async function surveyEnvironment() {
  const info = { node: null, npm: null, git: null, files: {}, suggestions: [] };
  try { const { stdout } = await exec('node -v'); info.node = stdout.trim(); } catch {}
  try { const { stdout } = await exec('npm -v'); info.npm = stdout.trim(); } catch {}
  try { const { stdout } = await exec('git rev-parse --is-inside-work-tree'); info.git = stdout.trim() === 'true'; } catch {}
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  if (fs.existsSync(pkgPath)) {
    try { info.files.packageJson = JSON.parse(await readFileSafe(pkgPath)); } catch {}
  }
  const pyProj = path.resolve(process.cwd(), 'pyproject.toml');
  if (fs.existsSync(pyProj)) info.files.pyproject = await readFileSafe(pyProj);
  const makefile = path.resolve(process.cwd(), 'Makefile');
  if (fs.existsSync(makefile)) info.files.makefile = await readFileSafe(makefile);

  // Heuristic suggestions
  if (!info.node) info.suggestions.push('Install Node.js for JS tooling.');
  if (info.files.packageJson && !('test' in (info.files.packageJson.scripts || {}))) info.suggestions.push('Add a test script to package.json.');
  if (!info.git) info.suggestions.push('Initialize git to track changes and enable CI.');
  if (!fs.existsSync(path.resolve(process.cwd(), 'work', 'standards'))) info.suggestions.push('Add work/standards to document environment replication.');
  return info;
}

async function replicateWorkspace({ source = '.', target = 'work/replica', linkDependencies = true } = {}) {
  const src = path.resolve(process.cwd(), source);
  const dst = path.resolve(process.cwd(), target);
  if (!isDir(src)) throw new Error(`replicate_source_invalid: ${src}`);
  await ensureDir(dst);

  const copied = [];
  const skipped = [];
  const linked = [];
  const excludeDirs = new Set(['.git', 'node_modules', '.cache', 'runs', 'logs', 'data', 'dist', 'build', '.next']);
  const maxCopySize = Number(process.env.REPLICA_MAX_COPY || '524288');

  async function walk(curSrc, curDst) {
    const entries = await fsp.readdir(curSrc, { withFileTypes: true });
    for (const e of entries) {
      const s = path.join(curSrc, e.name);
      const d = path.join(curDst, e.name);
      if (e.isDirectory()) {
        if (excludeDirs.has(e.name)) { skipped.push(s); continue; }
        await ensureDir(d);
        await walk(s, d);
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(s);
          if (st.size <= maxCopySize) {
            await ensureDir(path.dirname(d));
            await fsp.copyFile(s, d);
            copied.push({ from: s, to: d, bytes: st.size });
          } else {
            skipped.push(s);
          }
        } catch {
          skipped.push(s);
        }
      }
    }
  }

  await walk(src, dst);
  // Link dependencies
  if (linkDependencies && fs.existsSync(path.join(src, 'node_modules'))) {
    const linkPath = path.join(dst, 'node_modules');
    try {
      try { await fsp.rm(linkPath, { recursive: true, force: true }); } catch {}
      await fsp.symlink(path.join(src, 'node_modules'), linkPath, 'junction');
      linked.push({ name: 'node_modules', from: path.join(src, 'node_modules'), to: linkPath });
    } catch {
      // ignore
    }
  }
  return { source: src, target: dst, copied: copied.length, skipped: skipped.length, linked };
}

async function suggestFixes() {
  const out = { fixes: [], features: [], updates: [], lint: null, tests: null };
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  let pkg = null;
  if (fs.existsSync(pkgPath)) {
    try { pkg = JSON.parse(await readFileSafe(pkgPath)); } catch {}
  }
  const hasVitestCfg = fs.existsSync(path.resolve(process.cwd(), 'vitest.config.ts')) || fs.existsSync(path.resolve(process.cwd(), 'vitest.config.js'));
  const hasEslint = fs.existsSync(path.resolve(process.cwd(), '.eslintrc.cjs')) || fs.existsSync(path.resolve(process.cwd(), '.eslintrc.js')) || fs.existsSync(path.resolve(process.cwd(), '.eslintrc.json'));
  const hasPrettier = fs.existsSync(path.resolve(process.cwd(), '.prettierrc')) || fs.existsSync(path.resolve(process.cwd(), 'prettier.config.js'));
  const hasGithub = fs.existsSync(path.resolve(process.cwd(), '.github'));
  const hasStandards = fs.existsSync(path.resolve(process.cwd(), 'work', 'standards'));
  const hasTsConfig = fs.existsSync(path.resolve(process.cwd(), 'tsconfig.json'));

  // Fixes
  if (pkg) {
    const scripts = pkg.scripts || {};
    if (!('test' in scripts)) out.fixes.push('Add "test" script (e.g., vitest or npm test).');
    if (!('lint' in scripts)) out.fixes.push('Add "lint" script for ESLint.');
    if (!('format' in scripts)) out.fixes.push('Add "format" script for Prettier.');
    if (!('ci' in scripts)) out.fixes.push('Add "ci" script to run checks in CI.');
  }
  if (!hasEslint) out.fixes.push('Add ESLint config (.eslintrc.*) for consistent linting.');
  if (!hasPrettier) out.fixes.push('Add Prettier config (.prettierrc) for consistent formatting.');
  if (!hasGithub) out.fixes.push('Add GitHub Actions workflow for CI.');
  if (!hasStandards) out.fixes.push('Add work/standards to document environment replication.');

  // Updates suggestions
  if (pkg && pkg.dependencies) {
    // lightweight heuristic — flag very old versions if caret missing or pre-1.0
    for (const [dep, ver] of Object.entries(pkg.dependencies)) {
      if (typeof ver === 'string' && !ver.startsWith('^') && !ver.startsWith('~')) {
        out.updates.push(`Consider using caret ranges for ${dep}@${ver} to allow patch/minor updates.`);
      }
    }
  }

  // Feature ideas (heuristic)
  out.features.push('Persist agent/job state to a lightweight DB table for restarts and auditing.');
  out.features.push('Expose a Web UI console to visualize plans, agents, and job status.');
  out.features.push('Add metrics for tokens, EOTs, and throughput with daily rollups.');
  if (hasVitestCfg) out.features.push('Gate merging on passing tests in CI.');
  if (hasTsConfig) out.features.push('Type-check on CI and generate types for public endpoints.');

  // Parse lint and test outputs for targeted suggestions
  try {
    const lint = await runLint();
    out.lint = { ok: !!lint.ok, error: lint.error || null };
    if (!lint.ok) out.fixes.push('Lint errors detected — run npm run lint and address reported issues.');
  } catch {}
  try {
    const tests = await runTests();
    out.tests = { ok: true };
  } catch (e) {
    out.tests = { ok: false, error: toStr(e?.message || e) };
    out.fixes.push('Tests failing — run tests locally and fix failures.');
  }

  return out;
}

async function suggestFeatures(pattern) {
  // Ensure index
  if (!SCAN_INDEX.root || !Array.isArray(SCAN_INDEX.files) || !SCAN_INDEX.files.length) {
    try { await scanDirToIndex('.'); } catch {}
  }
  const feats = [];
  const needles = pattern ? [String(pattern)] : ['TODO', 'ROADMAP', 'FEATURE', 'IDEA', 'BACKLOG', 'PLAN'];
  for (const f of SCAN_INDEX.files) {
    const name = path.basename(f.path).toLowerCase();
    if (/(todo|roadmap|ideas?)/i.test(name)) {
      feats.push({ path: f.path, snippet: f.text.slice(0, 500) });
      continue;
    }
    for (const n of needles) {
      const idx = f.text.indexOf(n);
      if (idx !== -1) {
        const start = Math.max(0, idx - 120);
        const end = Math.min(f.text.length, idx + 380);
        feats.push({ path: f.path, snippet: f.text.slice(start, end).replace(/\s+/g, ' ') });
        break;
      }
    }
  }
  return feats.slice(0, 50);
}

function appendChat(projectId, role, content) {
  const arr = CHATS.get(projectId) || [];
  arr.push({ role, content, ts: new Date().toISOString() });
  CHATS.set(projectId, arr);
  // persist to logs
  const dir = path.resolve(process.cwd(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `chat.${String(projectId).replace(/[^a-zA-Z0-9_.-]+/g, '_')}.jsonl`);
  try { fs.appendFileSync(file, JSON.stringify({ role, content, ts: new Date().toISOString() }) + '\n'); } catch {}
}

function agentLog(projectId, text) {
  try {
    const dir = path.resolve(process.cwd(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `agent.${String(projectId).replace(/[^a-zA-Z0-9_.-]+/g, '_')}.log`);
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`);
  } catch {}
}

function buildChatMessages(projectId, limit = 40) {
  const arr = CHATS.get(projectId) || [];
  const take = arr.slice(-limit).map((m) => ({ role: m.role, content: m.content }));
  // System preface optional: keep minimal
  return take;
}

async function maybeSummarize(projectId, userId) {
  const arr = CHATS.get(projectId) || [];
  if (arr.length % CHAT_SUMMARY_EVERY !== 0) return;
  const recent = arr.slice(-CHAT_SUMMARY_EVERY);
  const transcript = recent.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  const contract = getPrompt('contracts.plain_text_only') || '';
  const system = composeSystem('emepath.chat.summarize_system', { contract });
  let summary = '';
  try {
    const out = await LAST_BRAIN.llm.chat({ messages: [ { role: 'system', content: system }, { role: 'user', content: transcript } ], temperature: 0.1, maxTokens: 512 });
    summary = toStr(out?.content || '');
  } catch (e) {
    summary = '[summary] ' + transcript.slice(0, 500);
  }
  try {
    const s = db.upsertMemory(userId, projectId, 'short', 'chat', summary, 'append');
    const total = (s && s.content ? s.content.length : 0) || 0;
    if (total > SHORT_MAX_CHARS) await compressShortToLong(userId, projectId);
  } catch {}
}

async function compressShortToLong(userId, projectId) {
  try {
    const short = db.getMemory(userId, projectId, 'short', 'chat');
    const text = short && short.content ? short.content : '';
    if (!text) return;
    const contract = getPrompt('contracts.plain_text_only') || '';
    const system = composeSystem('emepath.chat.summarize_system', { contract });
    let long = '';
    try {
      const out = await LAST_BRAIN.llm.chat({ messages: [ { role: 'system', content: system }, { role: 'user', content: 'Condense further:\n' + text } ], temperature: 0.1, maxTokens: 768 });
      long = toStr(out?.content || '');
    } catch (e) {
      long = '[long] ' + text.slice(0, 1000);
    }
    db.upsertMemory(userId, projectId, 'long', 'chat', long, 'append');
    // clear short
    db.upsertMemory(userId, projectId, 'short', 'chat', '', 'clear');
    const l = db.getMemory(userId, projectId, 'long', 'chat');
    const total = (l && l.content ? l.content.length : 0) || 0;
    if (total > LONG_MAX_CHARS) await exportLongToPersonalization(userId, projectId);
  } catch {}
}

async function exportLongToPersonalization(userId, projectId) {
  // Convert recent chat pairs into personalization JSONL for LoRA fine-tuning
  const msgs = (CHATS.get(projectId) || []).slice(-100);
  const pairs = [];
  for (let i = 0; i < msgs.length - 1; i++) {
    if (msgs[i].role === 'user' && msgs[i + 1].role === 'assistant') {
      pairs.push({ user: msgs[i].content, assistant: msgs[i + 1].content });
    }
  }
  if (!pairs.length) return;
  const outDir = path.resolve(process.cwd(), 'data', 'training');
  await ensureDir(outDir);
  const file = path.join(outDir, `personal.${String(projectId).replace(/[^a-zA-Z0-9_.-]+/g, '_')}.jsonl`);
  const lines = pairs.map((p) => JSON.stringify({ system: 'You are a personalized assistant for this user.', user: p.user, assistant: p.assistant }));
  await fsp.appendFile(file, lines.join('\n') + '\n');
}

function renderUIHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>EmePath UI</title>
<style>
body{font-family:system-ui,Arial,sans-serif;margin:0;display:flex;height:100vh}
#sidebar{width:320px;border-right:1px solid #ddd;padding:12px;overflow:auto}
#main{flex:1;display:flex;flex-direction:column}
#chat{flex:1;overflow:auto;padding:12px}
#input{display:flex;border-top:1px solid #ddd}
#input textarea{flex:1;padding:8px;border:0;resize:vertical;min-height:60px}
#input button{width:120px}
.agent{font-size:12px;color:#444;margin:2px 0}
.msg{margin:6px 0}
.msg .role{font-weight:bold}
</style></head><body>
<div id="sidebar">
  <h3>Projects</h3>
  <div id="projects"></div>
</div>
<div id="main">
  <div id="chat"></div>
  <div id="input"><textarea id="ta" placeholder="Type a message..."></textarea><button id="send">Send</button></div>
</div>
<script>
let currentProject = new URLSearchParams(location.search).get('project') || 'emepath';
async function loadProjects(){ const r = await fetch('/projects'); const j = await r.json(); const el = document.getElementById('projects'); el.innerHTML=''; (j.projects||[]).forEach(p=>{ const d=document.createElement('div'); d.innerHTML = '<b>'+p.projectId+'</b><br><small>pending:'+ (p.status.counts.pending||0) +' running:'+ (p.status.counts.running||0) +' done:'+ (p.status.counts.done||0) +'</small>'; d.style.cursor='pointer'; d.onclick=()=>{currentProject=p.projectId; loadChat();}; el.appendChild(d); }); }
async function loadChat(){ const r = await fetch('/chat?project='+encodeURIComponent(currentProject)); const j = await r.json(); const c = document.getElementById('chat'); c.innerHTML=''; (j.messages||[]).forEach(m=>{ const d=document.createElement('div'); d.className='msg'; d.innerHTML='<span class="role">'+m.role+':</span> '+m.content; c.appendChild(d); }); c.scrollTop=c.scrollHeight; }
async function send(){ const t = document.getElementById('ta').value.trim(); if(!t) return; document.getElementById('ta').value=''; const r = await fetch('/chat?project='+encodeURIComponent(currentProject), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ text: t }) }); const j = await r.json(); loadProjects(); loadChat(); }
document.getElementById('send').onclick=send; loadProjects(); loadChat();
</script>
</body></html>`;
}

function renderUIHtml2() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>EmePath UI</title>
<style>
body{font-family:system-ui,Arial,sans-serif;margin:0;display:flex;height:100vh}
#sidebar{width:360px;border-right:1px solid #ddd;padding:12px;overflow:auto}
#main{flex:1;display:flex;flex-direction:column}
#chat{flex:1;overflow:auto;padding:12px}
#input{display:flex;border-top:1px solid #ddd}
#input textarea{flex:1;padding:8px;border:0;resize:vertical;min-height:60px}
#input button{width:120px}
.agent{font-size:12px;color:#444;margin:2px 0}
.msg{margin:6px 0}
.msg .role{font-weight:bold}
.agents{max-height:40vh;overflow:auto;border-top:1px solid #eee;margin-top:8px;padding-top:8px}
.logs{white-space:pre-wrap;font-size:12px;background:#fafafa;border:1px solid #eee;padding:8px;height:30vh;overflow:auto}
.row{display:flex;gap:6px;align-items:center;margin:4px 0}
</style></head><body>
<div id="sidebar">
  <h3>Projects</h3>
  <div id="projects"></div>
  <div class="row"><button id="pause">Pause</button><button id="resume">Resume</button></div>
  <h4>Agents</h4>
  <div id="agents" class="agents"></div>
  <h4>Logs</h4>
  <div id="logs" class="logs"></div>
</div>
<div id="main">
  <div id="chat"></div>
  <div id="input"><textarea id="ta" placeholder="Type a message..."></textarea><button id="send">Send</button></div>
</div>
<script>
let currentProject = new URLSearchParams(location.search).get('project') || 'emepath';
async function loadProjects(){ const r = await fetch('/projects'); const j = await r.json(); const el = document.getElementById('projects'); el.innerHTML=''; (j.projects||[]).forEach(p=>{ const d=document.createElement('div'); d.innerHTML = '<b>'+p.projectId+'</b><br><small>pending:'+ (p.status.counts.pending||0) +' running:'+ (p.status.counts.running||0) +' done:'+ (p.status.counts.done||0) +'</small>'; d.style.cursor='pointer'; d.onclick=()=>{currentProject=p.projectId; loadAll();}; el.appendChild(d); }); }
async function loadChat(){ const r = await fetch('/chat?project='+encodeURIComponent(currentProject)); const j = await r.json(); const c = document.getElementById('chat'); c.innerHTML=''; (j.messages||[]).forEach(m=>{ const d=document.createElement('div'); d.className='msg'; d.innerHTML='<span class=\"role\">'+m.role+':</span> '+m.content; c.appendChild(d); }); c.scrollTop=c.scrollHeight; }
async function loadAgents(){ const r = await fetch('/status?project='+encodeURIComponent(currentProject)); const j = await r.json(); const list = (j.status && j.status.agents) || []; const el = document.getElementById('agents'); el.innerHTML=''; list.forEach(a=>{ const d=document.createElement('div'); d.className='agent'; d.innerHTML = '<b>'+a.id+'</b> '+a.status+' — '+a.goal+' <button data-id=\"'+a.id+'\" class=\"run\">Run</button>'; el.appendChild(d); }); el.querySelectorAll('.run').forEach(btn=>{ btn.onclick=async ()=>{ const id=btn.getAttribute('data-id'); const kind=prompt('Kind to run (distill/scan/query)?','distill')||'custom'; await fetch('/agent/'+encodeURIComponent(id)+'/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind})}); loadAgents(); }; }); }
async function loadLogs(){ const r = await fetch('/logs?project='+encodeURIComponent(currentProject)); const t = await r.text(); document.getElementById('logs').textContent=t; }
async function send(){ const t = document.getElementById('ta').value.trim(); if(!t) return; document.getElementById('ta').value=''; const r = await fetch('/chat?project='+encodeURIComponent(currentProject), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ text: t }) }); const j = await r.json(); loadProjects(); loadChat(); }
document.getElementById('send').onclick=send; document.getElementById('pause').onclick=()=>fetch('/pause',{method:'POST'}).then(loadProjects); document.getElementById('resume').onclick=()=>fetch('/resume',{method:'POST'}).then(loadProjects);
function loadAll(){ loadProjects(); loadChat(); loadAgents(); loadLogs(); }
loadAll(); setInterval(loadAll, 5000);
</script>
</body></html>`;
}

// -------------------- Controller helpers --------------------

function buildToolsSpec(baseUrl) {
  return [
    '- update_user: { text: string, level?: "info"|"warn"|"error" }',
    '- requirements: list each requirement in the top-level "requirements" array; not a tool call',
    '- plan_agents: { agents: [ { title: string, kind: "distill"|"scan"|"query"|"custom", input: string, expected: string } ] }',
    `- execute: { kind: "distill"|"scan"|"query", input: any, background?: boolean }  // triggers server-side execution; check-in: POST ${baseUrl}/agent/checkin`,
    `- bootstrap_lora: { allowTrain?: boolean, sources?: string[] }  // scan+distill local sources and optionally prepare training; run training manually or via a separate job`,
    '- survey_env: {}  // gather environment info (node/npm/git, package.json, pyproject, Makefile)',
    '- replicate_workspace: { source?: string, target?: string, linkDependencies?: boolean }  // create a replica directory per work/standards, symlinking heavy deps',
    '- suggest_fixes: {}  // analyze repo (scripts, configs, CI) and propose fixes/updates/features',
    '- suggest_features: { pattern?: string }  // mine TODO/ROADMAP/issues from the indexed codebase',
    '- read_standards: {}  // validates ./work/standards exists',
    '- run_tests: { pattern?: string }  // runs vitest or npm test',
  ].join('\n');
}

async function evaluateRequirements(reqs) {
  const out = [];
  for (const r of Array.isArray(reqs) ? reqs : []) {
    const id = toStr(r.id || '');
    const action = toStr(r.action || '').toLowerCase();
    const required = String(r.severity || '').toLowerCase() === 'hard';
    let ok = false;
    let error = '';
    try {
      if (action === 'file_exists') {
        const p = path.resolve(process.cwd(), toStr(r.args?.path || ''));
        ok = !!(p && fs.existsSync(p));
        if (!ok) error = `missing file: ${p}`;
      } else if (action === 'read_standards') {
        const s = await readStandards();
        ok = !!s;
        if (!ok) error = 'standards missing';
      } else if (action === 'run_tests') {
        try {
          await runTests();
          ok = true;
        } catch (e) {
          ok = false;
          error = toStr(e?.message || e);
        }
      } else {
        ok = false; // unknown custom — cannot auto-verify
      }
    } catch (e) {
      ok = false;
      error = toStr(e?.message || e);
    }
    out.push({ id, action, required, ok, error: ok ? null : error });
  }
  return out;
}

async function runControllerAction(brain, { projectId, baseUrl }, action, parsed) {
  const tool = toStr(action?.tool || '').toLowerCase();
  const args = action?.args || {};
  if (tool === 'update_user') {
    return { tool, ok: true, update: { text: toStr(args.text || ''), level: toStr(args.level || 'info') } };
  }
  if (tool === 'read_standards') {
    try { await readStandards(); return { tool, ok: true }; } catch (e) { return { tool, ok: false, error: toStr(e?.message || e) }; }
  }
  if (tool === 'run_tests') {
    try { await runTests(); return { tool, ok: true }; } catch (e) { return { tool, ok: false, error: toStr(e?.message || e) }; }
  }
  if (tool === 'bootstrap_lora') {
    try {
      const job = await executeBootstrapLoRA(brain, projectId, args);
      return { tool, ok: true, job: job ? { id: job.id, status: job.status } : null };
    } catch (e) {
      return { tool, ok: false, error: toStr(e?.message || e) };
    }
  }
  if (tool === 'survey_env') {
    const info = await surveyEnvironment();
    return { tool, ok: true, info };
  }
  if (tool === 'replicate_workspace') {
    try {
      const rep = await replicateWorkspace({
        source: toStr(args.source || '.'),
        target: toStr(args.target || 'work/replica'),
        linkDependencies: typeof args.linkDependencies === 'boolean' ? args.linkDependencies : true,
      });
      return { tool, ok: true, replica: rep };
    } catch (e) {
      return { tool, ok: false, error: toStr(e?.message || e) };
    }
  }
  if (tool === 'suggest_fixes') {
    try {
      const s = await suggestFixes();
      return { tool, ok: true, suggestions: s };
    } catch (e) {
      return { tool, ok: false, error: toStr(e?.message || e) };
    }
  }
  if (tool === 'suggest_features') {
    try {
      const feats = await suggestFeatures(args && args.pattern);
      return { tool, ok: true, features: feats };
    } catch (e) {
      return { tool, ok: false, error: toStr(e?.message || e) };
    }
  }
  if (tool === 'plan_agents') {
    const list = Array.isArray(args.agents) ? args.agents : [];
    const spawned = [];
    for (const a of list) {
      const ag = brain._spawnAgent({ projectId, goal: a.title, input: a.input, expected: a.expected });
      spawned.push({ ...ag, kind: a.kind || 'custom' });
    }
    return { tool, ok: true, agents: spawned };
  }
  if (tool === 'execute') {
    const kind = toStr(args.kind || '').toLowerCase();
    const background = !!args.background;
    if (kind === 'distill') {
      const ag = brain._spawnAgent({ projectId, goal: 'controller-distill', input: toStr(args.input || ''), expected: 'JSONL' });
      const job = enqueueKindAware(brain, { projectId, agents: [{ ...ag, kind: 'distill' }], checklist: parsed.checklist || [], baseUrl });
      if (!background) await job.awaitDone();
      return { tool, ok: true, job: { id: job.id, status: job.status } };
    }
    return { tool, ok: false, error: `unknown kind: ${kind}` };
  }
  return { tool, ok: false, error: 'unknown_tool' };
}

function renderControllerText(parsed, reqStatus, results) {
  const lines = [];
  if (Array.isArray(parsed.updates) && parsed.updates.length) {
    lines.push('Updates:');
    for (const u of parsed.updates) lines.push(`- (${u.level || 'info'}) ${toStr(u.text)}`);
  }
  if (Array.isArray(parsed.requirements) && parsed.requirements.length) {
    lines.push('', 'Requirements:');
    for (const r of parsed.requirements) {
      const st = reqStatus.find((x) => x.id === r.id);
      const ok = st ? st.ok : false;
      lines.push(`- [${ok ? 'x' : ' '}] ${r.id}: ${r.title} (${r.severity || 'soft'})`);
    }
  }
  if (Array.isArray(parsed.alternatives) && parsed.alternatives.length) {
    lines.push('', 'Alternatives:');
    for (const a of parsed.alternatives) lines.push(`- ${toStr(a)}`);
  }
  if (Array.isArray(parsed.agents) && parsed.agents.length) {
    lines.push('', 'Agents Planned:');
    for (const a of parsed.agents) lines.push(`- ${a.title} (kind=${a.kind})`);
  }
  if (Array.isArray(results) && results.length) {
    lines.push('', 'Actions:');
    for (const r of results) lines.push(`- ${r.tool}: ${r.ok ? 'ok' : `error: ${r.error || ''}`}`);
  }
  return lines.join('\n');
}

async function runControlOnce(brain, { textRaw, env = {}, options = {}, baseUrl }) {
  const contract = getPrompt('contracts.json_object_strict') || '';
  const toolsSpec = buildToolsSpec(baseUrl);
  const system = composeSystem('emepath.controller.system', { toolsSpec, contract });
  const userMsg = [
    `Env: ${JSON.stringify(env)}`,
    `Input: ${textRaw}`,
    `Respond strictly with the JSON object as per schema.`,
  ].join('\n');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userMsg },
  ];
  let raw;
  try {
    const out = await brain.llm.chat({ messages, temperature: Number(options.temperature || 0.2), maxTokens: Number(options.maxTokens || 1024) });
    raw = toStr(out?.content || '');
  } catch (e) {
    if (isNoModelError(e)) {
      const fb = bootstrapFallbackPlan(baseUrl);
      const text = [fb.text, JSON.stringify(fb.plan)].join('\n');
      return { ok: true, plan: fb.plan, text, requirements: [], actions: [] };
    }
    throw e;
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  if (!parsed) return { ok: true, raw, text: raw };
  const reqStatus = await evaluateRequirements(Array.isArray(parsed.requirements) ? parsed.requirements : []);
  const results = [];
  let job = null;
  for (const act of Array.isArray(parsed.actions) ? parsed.actions : []) {
    const r = await runControllerAction(brain, { projectId: toStr(env.projectId || 'emepath'), baseUrl }, act, parsed);
    results.push(r);
    if (r && r.job && !job) job = r.job;
  }
  const text = renderControllerText(parsed, reqStatus, results);
  return { ok: true, plan: parsed, requirements: reqStatus, actions: results, text, job: job ? { id: job.id, status: job.status } : null };
}

async function runControlLoop(brain, { textRaw, env = {}, options = {}, baseUrl, maxTurns = 3 }) {
  const history = [];
  let last = null;
  for (let t = 1; t <= maxTurns; t++) {
    const turnHeader = `Turn ${t}/${maxTurns}`;
    const preface = history.length ? `\nState: ${JSON.stringify(history[history.length - 1]).slice(0, 1200)}` : '';
    const r = await runControlOnce(brain, { textRaw: `${textRaw}${preface}`, env, options, baseUrl });
    last = r;
    history.push({ turn: t, requirements: r.requirements, actions: r.actions });
    // Stop if all hard requirements are ok or there are none
    const hard = (r.requirements || []).filter((x) => x.required);
    const allOk = hard.length === 0 || hard.every((x) => x.ok);
    if (allOk) break;
  }
  if (!last) return { ok: false, error: 'no_turns' };
  return { ...last, turns: history.length, history };
}
// In-memory index for scan/query tools
const SCAN_INDEX = { root: '', files: [] }; // files: { path, text }

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeSnippets(text, terms, context = 80, maxSnippets = 3) {
  const lower = text.toLowerCase();
  const found = [];
  for (const t of terms) {
    const needle = String(t || '').toLowerCase();
    if (!needle) continue;
    let from = 0;
    let c = 0;
    while (c < maxSnippets) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      const start = Math.max(0, idx - context);
      const end = Math.min(text.length, idx + needle.length + context);
      found.push(text.slice(start, end).replace(/\s+/g, ' '));
      from = idx + needle.length;
      c++;
    }
  }
  return found.slice(0, maxSnippets);
}

async function scanDirToIndex(root, maxFileSize = 262144) {
  const absRoot = path.resolve(process.cwd(), root);
  if (!isDir(absRoot)) throw new Error(`scan_root_invalid: ${absRoot}`);
  const paths = await listFilesRecursive(absRoot, null);
  const files = [];
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (st.size > maxFileSize) continue;
      const txt = await readFileSafe(p);
      files.push({ path: p, text: txt });
    } catch {}
  }
  SCAN_INDEX.root = absRoot;
  SCAN_INDEX.files = files;
  return { root: absRoot, count: files.length };
}

function queryIndex(q, k = 8) {
  if (!SCAN_INDEX.root || !Array.isArray(SCAN_INDEX.files) || !SCAN_INDEX.files.length) {
    throw new Error('index_empty: run scan first');
  }
  const terms = String(q || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
  if (!terms.length) return { root: SCAN_INDEX.root, hits: [] };
  const scored = [];
  for (const f of SCAN_INDEX.files) {
    const lower = f.text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      let from = 0;
      const tlen = t.length;
      while (true) {
        const idx = lower.indexOf(t, from);
        if (idx === -1) break;
        const leftOk = idx === 0 || !/[a-z0-9_]/.test(lower[idx - 1]);
        const rightIdx = idx + tlen;
        const rightOk = rightIdx >= lower.length || !/[a-z0-9_]/.test(lower[rightIdx]);
        if (leftOk && rightOk) score++;
        from = idx + tlen;
      }
    }
    if (score > 0) scored.push({ f, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, Math.min(Math.max(1, Number(k) || 8), 20)).map(({ f, score }) => ({
    path: f.path,
    score,
    snippets: makeSnippets(f.text, terms),
  }));
  return { root: SCAN_INDEX.root, hits };
}
function isNoModelError(err) {
  const msg = toStr(err && (err.message || err));
  return /LORA_MODEL_PATH is required to load model/i.test(msg) || /Invalid JSON from .*\/models/i.test(msg);
}

function bootstrapFallbackPlan(baseUrl) {
  const text = [
    'No LoRA model is configured yet. You can bootstrap a local, user-curated dataset and optionally train a first adapter.',
    '',
    'Next steps:',
    '- 1) Prepare a dataset by scanning and distilling local sources (docs, code, notes).',
    `- 2) Optionally run training (tools/train_freeform_mode.py) to produce a LoRA adapter.`,
    '- 3) Configure env vars and restart service:',
    '     export LORA_MODEL_PATH=/path/to/base/model',
    '     export LORA_ADAPTERS="user=/path/to/lora-out"',
    '',
    'You can trigger bootstrapping via controller tools or directly:',
    `- POST ${baseUrl}/control { actions: [ { tool: "survey_env" }, { tool: "replicate_workspace", args: { target: "work/replica" } }, { tool: "bootstrap_lora", args: { allowTrain: false } }, { tool: "suggest_fixes" } ] }`,
    '',
    'Planner-compatible JSON (you can POST this to /control):',
  ].join('\n');
  const plan = {
    intent: 'bootstrap_lora',
    updates: [{ text: 'No model configured; offering bootstrap flow', level: 'warn' }],
    requirements: [
      { id: 'standards', title: 'Read work/standards', action: 'read_standards', severity: 'soft' },
      { id: 'model_path', title: 'Set LORA_MODEL_PATH after training', action: 'custom', severity: 'hard', help: 'export LORA_MODEL_PATH=/path/to/base' },
    ],
    alternatives: [ 'Proceed without training: continue using planning-only routes' ],
    agents: [
      { title: 'Scan repository', kind: 'scan', input: JSON.stringify({ root: '.' }), expected: 'index ready' },
      { title: 'Distill docs and code', kind: 'distill', input: JSON.stringify({ dir: 'documents' }), expected: 'JSONL dataset' },
    ],
    actions: [
      { tool: 'survey_env' },
      { tool: 'replicate_workspace', args: { target: 'work/replica' } },
      { tool: 'bootstrap_lora', args: { allowTrain: false } },
      { tool: 'suggest_fixes' },
    ],
  };
  return { text, plan };
}
// Chat state per project
const CHATS = new Map(); // projectId -> [{ role, content, ts }]
const CHAT_SUMMARY_EVERY = Number(process.env.CHAT_SUMMARY_EVERY || '10') || 10;
const SHORT_MAX_CHARS = Number(process.env.MEM_SHORT_MAX || '4000') || 4000;
const LONG_MAX_CHARS = Number(process.env.MEM_LONG_MAX || '8000') || 8000;
