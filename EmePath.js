// EmePath.js — Orchestrate an agent loop to distill raw data into
// JSONL training examples for a custom MoE/LoRA system.
//
// Uses Brain to manage agent state and the prompt composer to enforce
// strict JSONL output suitable for training pipelines.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

import Brain from './brain.js';
import db from './gateway/db/db.js';
import { composeSystem } from './gateway/prompts/compose.js';
import { getPrompt } from './gateway/prompts/index.js';
import express from 'express';
import http from 'http';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { spawn } from 'child_process';
const exec = promisify(execCb);
let LAST_BRAIN = null;
let CURRENT_SERVER = null;
let CURRENT_PORT = null;
let CONSOLE_LOG_ATTACHED = false;
const WATCH_STATE = { active: false, seconds: 0, step: '', targetPort: null };
let STACK_PID_ID = null;

// Global control flags
const CONTROL = { paused: false };
const DEFAULT_WORKSPACE_ID = 'default';

function sanitizeActionDirValue(dir) {
  const raw = typeof dir === 'string' ? dir.trim() : '';
  if (!raw) return '.';
  return raw;
}

function resolveProjectConfig(projectId, { userId = 1, workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
  const result = { actionDir: '.', record: null, memory: {} };
  try {
    if (typeof db.getProjectByName === 'function') {
      const rec = db.getProjectByName(userId, workspaceId, projectId);
      if (rec) {
        result.record = rec;
        if (rec.actionDir) result.actionDir = sanitizeActionDirValue(rec.actionDir);
      }
    }
  } catch {}
  try {
    const row = db.getMemory(userId, projectId, 'short', 'config');
    if (row && row.content) {
      const cfg = JSON.parse(row.content);
      if (cfg && typeof cfg === 'object') {
        result.memory = cfg;
        const dir = cfg.actionDir != null ? sanitizeActionDirValue(cfg.actionDir) : result.actionDir;
        if (!result.record || !result.record.actionDir) result.actionDir = dir;
        else result.actionDir = sanitizeActionDirValue(result.actionDir || dir);
      }
    }
  } catch {}
  result.actionDir = sanitizeActionDirValue(result.actionDir);
  return result;
}

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
    let didChunks = false;
    // Attempt JSON parse for structured file content
    let inputObj = null;
    try { inputObj = JSON.parse(toStr(a.input || '')); } catch {}
    if (inputObj && typeof inputObj === 'object' && typeof inputObj.content === 'string') {
      const target = Number(process.env.DISTILL_TARGET_TOKENS || '600') || 600;
      const overlap = Number(process.env.DISTILL_OVERLAP_TOKENS || '80') || 80;
      const { flat, meta } = await processFileContentWithChunks(brain, systemPrompt, inputObj.path || 'unknown', inputObj.content, { temperature, maxTokens, target, overlap });
      if (flat.length) {
        await fsp.appendFile(outFile, flat.join('\n') + '\n');
      }
      if (metaOutFile && meta.length) {
        await fsp.appendFile(metaOutFile, meta.join('\n') + '\n');
      }
      brain.checkIn(a.id, 'done');
      didChunks = true;
    }
    if (didChunks) {
      if (typeof onTick === 'function') { try { onTick(a); } catch {} }
      continue;
    }
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Convert the following raw text into high-quality training examples. Return JSONL only — one object per line with fields {system,user,assistant}.\n\n' + a.input },
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

function approxTokens(s) {
  return Math.ceil(String(s || '').length / 4);
}

function chunkByTokens(text, targetTokens = 600, overlapTokens = 80) {
  const s = String(text || '');
  if (!s) return [];
  const targetChars = Math.max(200, targetTokens * 4);
  const overlapChars = Math.max(0, overlapTokens) * 4;
  const chunks = [];
  let i = 0;
  while (i < s.length) {
    const end = Math.min(s.length, i + targetChars);
    let slice = s.slice(i, end);
    // try avoid cutting in middle of paragraph
    if (end < s.length) {
      const lastBreak = slice.lastIndexOf('\n');
      if (lastBreak > targetChars * 0.6) slice = slice.slice(0, lastBreak);
    }
    chunks.push(slice);
    if (end >= s.length) break;
    i = i + (slice.length - Math.min(slice.length, overlapChars));
  }
  return chunks;
}

async function processFileContentWithChunks(brain, systemPrompt, pathLabel, content, { temperature, maxTokens, target, overlap }) {
  const chunks = chunkByTokens(content, target, overlap);
  const flat = [];
  const meta = [];
  let idx = 0;
  for (const ch of chunks) {
    idx++;
    const header = `Chunk ${idx}/${chunks.length} — Path: ${pathLabel}`;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${header}\n\n${ch}` },
    ];
    let raw = '';
    try {
      const out = await brain.llm.chat({ messages, temperature, maxTokens });
      raw = toStr(out?.content || '');
    } catch (e) {
      // mark chunk error and continue
      continue;
    }
    let { flatLines, metaLines } = extractDistillOutputs(raw);
    // Retry once with stricter instruction if empty
    if (!flatLines.length && !metaLines.length) {
      const retryMsg = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${header}\n(Make sure to produce at least one JSONL line.)\n\n${ch}` },
      ];
      try {
        const out2 = await brain.llm.chat({ messages: retryMsg, temperature, maxTokens });
        const raw2 = toStr(out2?.content || '');
        ({ flatLines, metaLines } = extractDistillOutputs(raw2));
      } catch {}
    }
    const linted = lintDistilledLines(flatLines);
    flat.push(...linted);
    meta.push(...metaLines);
  }
  // Deduplicate flat
  const seen = new Set();
  const dedupFlat = [];
  for (const ln of flat) {
    if (!seen.has(ln)) { seen.add(ln); dedupFlat.push(ln); }
  }
  return { flat: dedupFlat, meta };
}

function lintDistilledLines(lines) {
  const out = [];
  for (const ln of lines) {
    try {
      const obj = JSON.parse(ln);
      const sys = typeof obj.system === 'string' ? obj.system : '';
      let user = typeof obj.user === 'string' ? obj.user : '';
      let assistant = typeof obj.assistant === 'string' ? obj.assistant : '';
      user = user.replace(/\?\?\?\?/g, '');
      assistant = assistant.replace(/```[\s\S]*?```/g, '').replace(/\?\?\?\?/g, '');
      out.push(JSON.stringify({ system: sys, user, assistant }));
    } catch {
      // keep original if parsing fails to avoid data loss
      out.push(ln);
    }
  }
  return out;
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

  // Serve static files from public directory
  app.use(express.static(path.resolve(process.cwd(), 'public')));

  // Attach console logger to file for UI terminal tail
  try { attachConsoleFileLogger(); } catch {}

  const WORKSPACE_ID = DEFAULT_WORKSPACE_ID;
  const sanitizeActionDir = sanitizeActionDirValue;

  function projectConfigFromMemory(pid) {
    const cfg = resolveProjectConfig(pid, { userId, workspaceId: WORKSPACE_ID });
    return cfg.memory || {};
  }

  function getProjectRecord(pid) {
    const cfg = resolveProjectConfig(pid, { userId, workspaceId: WORKSPACE_ID });
    return cfg.record || null;
  }

  function ensureProjectRecord(pid, { actionDir = '.', active = true, description = null } = {}) {
    const dir = sanitizeActionDir(actionDir);
    let record = getProjectRecord(pid);
    if (!record) {
      try {
        record = db.createProject(userId, WORKSPACE_ID, {
          name: pid,
          description,
          active,
          actionDir: dir,
        });
      } catch (e) {
        const msg = String(e?.message || e || '');
        if (/UNIQUE constraint failed/i.test(msg)) {
          record = getProjectRecord(pid);
        } else {
          throw e;
        }
      }
    } else {
      if (dir && record.actionDir !== dir && typeof db.updateProjectActionDir === 'function') {
        record = db.updateProjectActionDir(userId, WORKSPACE_ID, pid, dir) || {
          ...record,
          actionDir: dir,
        };
      }
      if (active && record && !record.active) {
        record = db.setProjectActive(userId, WORKSPACE_ID, record.id, true) || record;
      }
    }
    return record;
  }

  function removeProjectRecord(pid) {
    if (typeof db.deleteProject !== 'function') return false;
    return db.deleteProject(userId, WORKSPACE_ID, pid);
  }

  function getProjectConfig(pid) {
    const cfg = resolveProjectConfig(pid, { userId, workspaceId: WORKSPACE_ID });
    let record = cfg.record || null;
    const actionDir = sanitizeActionDir(cfg.actionDir || '.');
    if (!record) {
      try {
        record = ensureProjectRecord(pid, { actionDir });
      } catch {}
    }
    return { actionDir, record, memory: cfg.memory || {} };
  }

  // Aggregate known projects and their status/config
  async function listProjectsStatus() {
    const brain = LAST_BRAIN;
    const names = new Set();
    const recordsByName = new Map();

    try {
      const rows = db.listProjects(userId, WORKSPACE_ID, {});
      for (const rec of Array.isArray(rows) ? rows : []) {
        const key = String(rec.name);
        recordsByName.set(key, rec);
        names.add(key);
      }
    } catch {}

    if (brain) {
      if (brain.agents) {
        for (const a of brain.agents.values()) names.add(String(a.projectId));
      }
      if (brain.projects) {
        for (const [pid] of brain.projects) names.add(String(pid));
      }
    }
    // Ensure the current project appears in the list
    names.add(String(projectId));

    const ordered = Array.from(names)
      .map((n) => String(n || '').trim())
      .filter((n) => n.length > 0)
      .sort((a, b) => a.localeCompare(b));

    const results = [];
    for (const pid of ordered) {
      let record = recordsByName.get(pid) || getProjectRecord(pid);
      const memCfg = projectConfigFromMemory(pid);
      let actionDir = record?.actionDir || memCfg.actionDir || '.';
      actionDir = sanitizeActionDir(actionDir);

      if (!record) {
        try {
          record = ensureProjectRecord(pid, { actionDir });
        } catch {}
      } else if (record.actionDir !== actionDir) {
        try {
          record = ensureProjectRecord(pid, { actionDir, active: record.active });
        } catch {}
      }

      const config = { ...memCfg, actionDir };
      const status = gatherStatus(pid);
      results.push({
        projectId: pid,
        status,
        config,
        active: record ? Boolean(record.active) : true,
        project: record || null,
      });
    }
    return results;
  }

  try { ensureProjectRecord(projectId, { actionDir: '.' }); } catch {}

  // Load persisted agents (best-effort)
  try { await loadAgentsState(userId, projectId, brain); } catch {}

  // Wrap checkIn to persist on updates
  try {
    const origCheckIn = brain.checkIn.bind(brain);
    brain.checkIn = (agentId, status = 'running', meta = {}) => {
      const ok = origCheckIn(agentId, status, meta);
      try {
        const a = brain.agents.get(agentId);
        if (a) {
          persistAgentsState(userId, a.projectId, brain);
          // also persist to agents_state table
          db.upsertAgentState(userId, a.projectId, a);
        }
      } catch {}
      return ok;
    };
  } catch {}

  const pinId = () => `pin_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  function parsePinsContent(content) {
    if (!content) return [];
    const pins = [];
    const lines = String(content)
      .split(/\r?\n/)
      .filter((ln) => ln && ln.trim().length);
    lines.forEach((raw, idx) => {
      let obj = null;
      try {
        obj = JSON.parse(raw);
      } catch {}
      if (obj && typeof obj === 'object') {
        const text = toStr(obj.text ?? obj.content ?? '');
        if (!text) return;
        pins.push({
          id: toStr(obj.id || pinId()),
          text,
          kind: obj.kind || null,
          ts: obj.ts || obj.timestamp || null,
          agentId: obj.agentId || null,
        });
      } else {
        pins.push({ id: `legacy_${idx}`, text: raw, kind: null, ts: null, agentId: null });
      }
    });
    return pins;
  }

  function getPinsForProject(pid) {
    try {
      const row = db.getMemory(userId, pid, 'short', 'pins');
      return parsePinsContent(row?.content || '');
    } catch {
      return [];
    }
  }

  function savePinsForProject(pid, pins) {
    const safePins = Array.isArray(pins) ? pins : [];
    if (!safePins.length) {
      try { db.deleteMemory(userId, pid, 'short', 'pins'); } catch {}
      return [];
    }
    const now = new Date().toISOString();
    const payload = safePins
      .map((p) =>
        JSON.stringify({
          id: toStr(p.id || pinId()),
          text: toStr(p.text || ''),
          kind: p.kind || null,
          ts: p.ts || now,
          agentId: p.agentId || null,
        })
      )
      .join('\n');
    db.upsertMemory(userId, pid, 'short', 'pins', payload, 'set');
    return getPinsForProject(pid);
  }

  function pruneProjectPinsForAgent(pid, agentId) {
    const cleanAgentId = toStr(agentId || '');
    if (!cleanAgentId) return 0;
    const pins = getPinsForProject(pid);
    if (!pins.length) return 0;
    const next = pins.filter((p) => toStr(p.agentId || '') !== cleanAgentId);
    if (next.length === pins.length) return 0;
    savePinsForProject(pid, next);
    return pins.length - next.length;
  }

  function removeAgentById(agentId, { prunePins = true } = {}) {
    const cleanAgentId = toStr(agentId || '');
    if (!cleanAgentId) return null;
    const brain = LAST_BRAIN;
    if (!brain || !brain.agents) return null;
    const agent = brain.agents.get(cleanAgentId);
    if (!agent) return null;
    brain.agents.delete(cleanAgentId);
    try { db.deleteAgentState(cleanAgentId); } catch {}
    persistAgentsState(userId, agent.projectId, brain);
    const removedPins = prunePins ? pruneProjectPinsForAgent(agent.projectId, cleanAgentId) : 0;
    return { agent, removedPins };
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'emepath', projectId, userId });
  });

  // Favicon
  app.get('/favicon.ico', (_req, res) => {
    // Return 204 to avoid console noise; can be replaced with a real icon later
    res.status(204).end();
  });

  // Terminal log tail
  app.get('/term', async (_req, res) => {
    try {
      const dir = path.resolve(process.cwd(), 'logs');
      const tlog = path.join(dir, 'terminal.log');
      const ttxt = fs.existsSync(tlog) ? await readFileSafe(tlog) : '';
      const tail = (s) => s.split(/\r?\n/).slice(-400).join('\n');
      res.type('text/plain').send(tail(ttxt));
    } catch (e) {
      res.status(500).type('text/plain').send(String(e?.message || e));
    }
  });
  app.post('/term/clear', (req, res) => {
    try {
      const dir = path.resolve(process.cwd(), 'logs');
      const tlog = path.join(dir, 'terminal.log');
      fs.writeFileSync(tlog, '');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });
  app.post('/logs/clear', (req, res) => {
    try {
      const pid = toStr(req.query?.project || projectId);
      const dir = path.resolve(process.cwd(), 'logs');
      const alog = path.join(dir, `agent.${pid.replace(/[^a-zA-Z0-9_.-]+/g, '_')}.log`);
      const clog = path.join(dir, `chat.${pid.replace(/[^a-zA-Z0-9_.-]+/g, '_')}.jsonl`);
      if (fs.existsSync(alog)) fs.writeFileSync(alog, '');
      if (fs.existsSync(clog)) fs.writeFileSync(clog, '');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  // Watcher state for UI countdown
  app.get('/watch/state', (_req, res) => {
    res.json({ ok: true, state: WATCH_STATE });
  });

  // Port monitor API
  function normalizePortsFromDb(rows) {
    const out = [];
    const seen = new Set();
    for (const r of Array.isArray(rows) ? rows : []) {
      const port = r && r.port != null ? Number(r.port) : null;
      const pid = r && r.pid != null ? Number(r.pid) : null;
      if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
      const key = `${port}:${pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let cmd = toStr(r.command || '');
      if (!cmd && Array.isArray(r.args) && r.args.length) cmd = toStr(r.args[0]);
      out.push({
        port,
        user: toStr(r.user || ''),
        command: cmd || 'node',
        process: pid,
      });
    }
    // Sort by port asc
    out.sort((a, b) => a.port - b.port);
    return out;
  }

  async function tryDiscoverPorts() {
    // Prefer DB since we register instances there
    try {
      if (typeof db.getAllStackPids === 'function') {
        const rows = db.getAllStackPids();
        const list = normalizePortsFromDb(rows);
        if (list.length) return list;
      }
    } catch {}

    // Fallback: attempt OS probe (best-effort, may not exist in all envs)
    try {
      const { stdout } = await exec('ss -ltnp || netstat -ltnp');
      const out = [];
      const lines = String(stdout || '').split(/\r?\n/);
      for (const ln of lines) {
        // Example: LISTEN 0 4096 127.0.0.1:51100 ... users:(("node",pid=1234,fd=23))
        const m = ln.match(/:\s*(\d{2,5})\b.*?pid=(\d+)/);
        if (!m) continue;
        const port = Number(m[1]);
        const pid = Number(m[2]);
        if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
        out.push({ port, user: '', command: 'node', process: pid });
      }
      out.sort((a, b) => a.port - b.port);
      return out;
    } catch {}
    return [];
  }

  app.get('/api/ports', async (_req, res) => {
    try {
      const ports = await tryDiscoverPorts();
      res.json({ ok: true, ports });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  async function tryKillPid(pid) {
    try {
      if (!pid || !Number.isFinite(pid)) return false;
      if (pid === process.pid) return false; // avoid self-termination
      try { process.kill(pid, 'SIGTERM'); } catch {}
      // small grace period, then SIGKILL if still alive
      await new Promise((r) => setTimeout(r, 500));
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
      return true;
    } catch { return false; }
  }

  app.post('/api/ports/:port/kill', async (req, res) => {
    try {
      const port = Number(req.params.port || '');
      if (!Number.isFinite(port)) return res.status(400).json({ ok: false, error: 'invalid_port' });
      let killed = 0;
      let targets = [];
      try {
        if (typeof db.getAllStackPids === 'function') {
          const rows = db.getAllStackPids();
          targets = rows.filter((r) => Number(r.port) === port && Number.isFinite(r.pid));
        }
      } catch {}
      if (!targets.length) {
        // OS fallback: lsof/ss to find pid(s) — avoid sed backrefs to keep JS string clean
        try {
          const cmd = [
            `lsof -nP -iTCP:${port} -sTCP:LISTEN -t`,
            `ss -ltnp | grep :${port} | grep -oE 'pid=[0-9]+' | head -n1 | cut -d= -f2`,
          ].join(' || ');
          const { stdout } = await exec(cmd);
          const pids = String(stdout || '')
            .split(/\s+/)
            .map((s) => Number(s))
            .filter((n) => Number.isFinite(n));
          targets = pids.map((pid) => ({ pid, port }));
        } catch {}
      }
      for (const t of targets) {
        const ok = await tryKillPid(Number(t.pid));
        if (ok) killed++;
        // best-effort cleanup from DB
        try {
          if (typeof db.removeStackPidByPid === 'function') db.removeStackPidByPid(Number(t.pid));
        } catch {}
      }
      res.json({ ok: true, port, killed });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
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

      // Persist last plan for this project
      try { if (parsed) db.upsertMemory(userId, pid, 'short', 'plan', JSON.stringify(parsed), 'set'); } catch {}

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
        job = enqueueKindAware(brain, { userId, projectId: pid, agents, checklist: parsed.checklist || [], baseUrl });
        if (!background) {
          await job.awaitDone();
        }
      }

      // Auto-execute suggested actions when present (survey_env, replicate_workspace, suggest_fixes, suggest_features, bootstrap_lora)
      const actionResults = [];
      if (auto && Array.isArray(parsed.actions) && parsed.actions.length) {
        for (const act of parsed.actions) {
          try {
            const r = await runControllerAction(brain, { projectId: pid, baseUrl, userId }, act, parsed);
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
        const r = await runControllerAction(brain, { projectId, baseUrl, userId }, act, parsed);
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

  // Last plan for project
  app.get('/plan', (req, res) => {
    try {
      const pid = toStr(req.query?.project || projectId);
      const row = db.getMemory(userId, pid, 'short', 'plan');
      const plan = row && row.content ? JSON.parse(row.content) : null;
      res.json({ ok: true, plan, updatedAt: row?.updatedAt || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  // Memory drawer snapshot
  app.get('/memory', (req, res) => {
    try {
      const pid = toStr(req.query?.project || projectId);
      const short = db.getMemory(userId, pid, 'short', 'chat');
      const long = db.getMemory(userId, pid, 'long', 'chat');
      const agentsSnap = db.getMemory(userId, pid, 'short', 'agents');
      const personalPath = path.resolve(process.cwd(), 'data', 'training', `personal.${String(pid).replace(/[^a-zA-Z0-9_.-]+/g, '_')}.jsonl`);
      const exists = fs.existsSync(personalPath);
      res.json({ ok: true, short: { size: short?.content?.length || 0, updatedAt: short?.updatedAt || null }, long: { size: long?.content?.length || 0, updatedAt: long?.updatedAt || null }, agents: { size: agentsSnap?.content?.length || 0, updatedAt: agentsSnap?.updatedAt || null }, personalization: { path: personalPath, exists } });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  // Project configuration
  app.get('/projects/:id/config', (req, res) => {
    try {
      const projectId = String(req.params.id || '').trim();
      if (!projectId) return res.status(400).json({ ok: false, error: 'projectId required' });
      const cfg = getProjectConfig(projectId);
      const prev = cfg.memory || {};
      const llmControl = typeof prev.llmControl === 'boolean' ? prev.llmControl : true; // default on first read
      const config = { ...prev, actionDir: cfg.actionDir, llmControl };
      // persist default if it wasn't present
      if (typeof prev.llmControl !== 'boolean') {
        try { db.upsertMemory(userId, projectId, 'short', 'config', JSON.stringify(config), 'set'); } catch {}
      }
      res.json({ ok: true, config, project: cfg.record || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });
  app.put('/projects/:id/config', async (req, res) => {
    try {
      const projectId = String(req.params.id || '').trim();
      if (!projectId) return res.status(400).json({ ok: false, error: 'projectId required' });
      const body = req.body || {};
      const prev = projectConfigFromMemory(projectId);
      const actionDir = typeof body.actionDir === 'string' ? sanitizeActionDir(body.actionDir) : sanitizeActionDir(prev.actionDir || '.');
      const llmControl = typeof body.llmControl === 'boolean' ? body.llmControl : (typeof prev.llmControl === 'boolean' ? prev.llmControl : true);
      const config = { ...prev, actionDir, llmControl };
      db.upsertMemory(userId, projectId, 'short', 'config', JSON.stringify(config), 'set');
      const record = ensureProjectRecord(projectId, { actionDir });
      res.json({ ok: true, config, project: record || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  // Static UI
  app.use(express.static(path.resolve(process.cwd(), 'public')));
  app.get('/ui', (_req, res) => {
    res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
  });

  // Pin chat content to plan (and optionally spawn an agent)
  app.post('/pin', async (req, res) => {
    try {
      const pid = toStr(req.body?.project || req.query?.project || projectId);
      const text = toStr(req.body?.text || '');
      const kind = toStr(req.body?.kind || '');
      const spawn = !!req.body?.spawn || !!kind;
      if (!text) return res.status(400).json({ ok: false, error: 'missing_text' });
      const pin = {
        id: pinId(),
        text,
        kind: spawn ? kind || 'custom' : null,
        ts: new Date().toISOString(),
        agentId: null,
      };
      let agent = null;
      if (spawn) {
        agent = LAST_BRAIN._spawnAgent({ projectId: pid, goal: `Pinned: ${text.slice(0, 60)}`, input: text, expected: 'Follow-up action' });
        if (kind) agent.kind = kind;
        pin.agentId = agent.id;
        persistAgentsState(userId, pid, LAST_BRAIN);
      }
      const pins = getPinsForProject(pid);
      pins.push(pin);
      savePinsForProject(pid, pins);
      res.json({ ok: true, pinned: true, pin, agent });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  app.get('/pins', (req, res) => {
    try {
      const pid = toStr(req.query?.project || projectId);
      const pins = getPinsForProject(pid);
      res.json({ ok: true, pins });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  app.delete('/pins/:pinId', (req, res) => {
    try {
      const pid = toStr(req.query?.project || projectId);
      const pinIdParam = toStr(req.params?.pinId || '');
      if (!pinIdParam) return res.status(400).json({ ok: false, error: 'missing_pin_id' });
      const pins = getPinsForProject(pid);
      const target = pins.find((p) => toStr(p.id) === pinIdParam);
      if (!target) return res.status(404).json({ ok: false, error: 'pin_not_found' });
      const next = pins.filter((p) => toStr(p.id) !== pinIdParam);
      savePinsForProject(pid, next);
      if (target.agentId) removeAgentById(target.agentId, { prunePins: false });
      res.json({ ok: true, removed: pinIdParam, removedAgentId: target.agentId || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });
  app.delete('/pins', (req, res) => {
    try {
      const pid = toStr(req.query?.project || projectId);
      const pins = getPinsForProject(pid);
      savePinsForProject(pid, []);
      const removedAgents = [];
      for (const pin of pins) {
        if (pin?.agentId) {
          const removed = removeAgentById(pin.agentId, { prunePins: false });
          if (removed?.agent) removedAgents.push(toStr(pin.agentId));
        }
      }
      res.json({ ok: true, removed: 'all', removedAgents });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  // Projects and status
  app.get('/projects', async (_req, res) => {
    const list = await listProjectsStatus();
    res.json({ ok: true, projects: list });
  });
  app.post('/projects', async (req, res) => {
    try {
      const body = req.body || {};
      const projectId = String(body.projectId || body.name || '').trim();
      if (!projectId) return res.status(400).json({ ok: false, error: 'projectId required' });
      if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) return res.status(400).json({ ok: false, error: 'invalid projectId: letters, numbers, underscore, dash only' });
      const sessionUserId = Number(body.userId || userId) || userId;
      const actionDir = sanitizeActionDir(body.actionDir || '.');
      const brain = LAST_BRAIN;
      if (!brain) return res.status(500).json({ ok: false, error: 'brain not initialized' });
      let record = null;
      try {
        record = ensureProjectRecord(projectId, { actionDir, active: true });
      } catch (e) {
        return res.status(500).json({ ok: false, error: toStr(e?.message || e) });
      }
      const sid = brain.createSession({ userId: sessionUserId, projectId });
      const config = { actionDir };
      db.upsertMemory(userId, projectId, 'short', 'config', JSON.stringify(config), 'set');
      const list = await listProjectsStatus();
      res.json({ ok: true, projectId, sessionId: sid, projects: list, project: record || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });
  app.delete('/projects/:id', async (req, res) => {
    try {
      const projectId = String(req.params.id || '').trim();
      if (!projectId) return res.status(400).json({ ok: false, error: 'projectId required' });
      const brain = LAST_BRAIN;
      if (!brain) return res.status(500).json({ ok: false, error: 'brain not initialized' });
      // Remove from brain projects
      if (brain.projects) brain.projects.delete(projectId);
      // Remove agents for this project
      const agentsToDelete = [];
      if (brain.agents) {
        for (const [id, a] of brain.agents) {
          if (String(a.projectId) === projectId) agentsToDelete.push(id);
        }
        for (const id of agentsToDelete) brain.agents.delete(id);
      }
      persistAgentsState(null, projectId, brain);
      try { removeProjectRecord(projectId); } catch {}
      try { db.deleteMemory(userId, projectId, 'short', 'config'); } catch {}
      const list = await listProjectsStatus();
      res.json({ ok: true, removed: projectId, projects: list });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
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

  // SSE: Rolling terminal
  app.get('/term/sse', async (req, res) => {
    try {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const dir = path.resolve(process.cwd(), 'logs');
      const tlog = path.join(dir, 'terminal.log');
      let timer = setInterval(async () => {
        try {
          const ttxt = fs.existsSync(tlog) ? await readFileSafe(tlog) : '';
          const tail = (s) => s.split(/\r?\n/).slice(-200).join('\n');
          res.write('data: ' + JSON.stringify({ text: tail(ttxt) }) + '\n\n');
        } catch {}
      }, 2000);
      req.on('close', () => clearInterval(timer));
    } catch (e) {
      res.status(500).end();
    }
  });

  // Auto memory updater state
  app.get('/auto/state', (_req, res) => {
    try {
      res.json({ ok: true, enabled: AUTO.enabled, intervalMs: AUTO.intervalMs, projects: Array.from(AUTO.projects.keys()) });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });
  app.post('/auto/toggle', (req, res) => {
    try {
      const enabledRaw = req.body?.enabled ?? req.query?.enabled;
      const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : String(enabledRaw || '').toLowerCase() === 'true';
      AUTO.enabled = enabled;
      if (AUTO.timer) { clearInterval(AUTO.timer); AUTO.timer = null; }
      if (AUTO.enabled) startAutoMemory({ intervalMs: AUTO.intervalMs });
      res.json({ ok: true, enabled: AUTO.enabled });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  // SSE: Rolling agent/chat logs for project
  app.get('/logs/sse', async (req, res) => {
    try {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const pid = toStr(req.query?.project || projectId);
      const dir = path.resolve(process.cwd(), 'logs');
      const alog = path.join(dir, `agent.${pid.replace(/[^a-zA-Z0-9_.-]+/g, '_')}.log`);
      const clog = path.join(dir, `chat.${pid.replace(/[^a-zA-Z0-9_.-]+/g, '_')}.jsonl`);
      let timer = setInterval(async () => {
        try {
          const atxt = fs.existsSync(alog) ? await readFileSafe(alog) : '';
          const ctxt = fs.existsSync(clog) ? await readFileSafe(clog) : '';
          const tail = (s) => s.split(/\r?\n/).slice(-200).join('\n');
          res.write('data: ' + JSON.stringify({ text: `# Agent Log\n${tail(atxt)}\n\n# Chat Log\n${tail(ctxt)}` }) + '\n\n');
        } catch {}
      }, 2000);
      req.on('close', () => clearInterval(timer));
    } catch (e) {
      res.status(500).end();
    }
  });

  // Simple chat
  app.get('/chat', (req, res) => {
    try {
      const pid = toStr(req.query?.project || projectId);
      let msgs = CHATS.get(pid) || [];
      if (!msgs || msgs.length === 0) {
        try { msgs = hydrateChatHistory(pid, userId) || []; } catch {}
        CHATS.set(pid, msgs);
      }
      res.json({ ok: true, projectId: pid, messages: msgs.slice(-100) });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });
  app.post('/chat', async (req, res) => {
    try {
      const pid = toStr(req.body?.project || req.query?.project || projectId);
      const uid = Number(req.body?.user || userId) || userId;
      const text = toStr(req.body?.text || '');
      const wantTextOut = toStr(req.query?.format || '').toLowerCase() === 'text' || (req.headers.accept || '').includes('text/plain');
      if (!text) return res.status(400).json({ ok: false, error: 'missing_text' });
      appendChat(pid, 'user', text, uid);
      let reply = '';
      try {
        const messages = buildChatMessages(pid);
        const out = await LAST_BRAIN.llm.chat({ messages, temperature: 0.2, maxTokens: 768 });
        reply = toStr(out?.content || '');
      } catch (e) {
        if (isNoModelError(e)) {
          const mode = String(process.env.EMEPATH_CHAT_FALLBACK || 'guide').toLowerCase();
          if (mode === 'echo') reply = '(echo) ' + text;
          else reply = 'Hi! A chat model is not configured yet. Open Actions (⌘/Ctrl+K) → “Bootstrap” to prepare a dataset, or set LORA_MODEL_PATH and restart.';
        } else {
          reply = '[error] ' + toStr(e?.message || e);
        }
      }
      appendChat(pid, 'assistant', reply, uid);
      await maybeSummarize(pid, uid);
      const payload = { ok: true, projectId: pid, reply, messages: (CHATS.get(pid) || []).slice(-100) };
      if (wantTextOut) return res.type('text/plain').send(reply);
      return res.json(payload);
    } catch (e) {
      return res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });

  // Chat export (DB preferred) and clear
  app.get('/chat/export', async (req, res) => {
    try {
      const pid = toStr(req.query?.project || projectId);
      res.setHeader('content-type', 'application/x-ndjson');
      res.setHeader('content-disposition', `attachment; filename="chat.${pid}.jsonl"`);
      let nd = '';
      try {
        if (typeof db.listChatMessages === 'function') {
          const rows = db.listChatMessages(userId, pid, { limit: 10000, asc: true });
          nd = rows.map(r => JSON.stringify({ role: r.role, content: r.content, ts: r.createdAt })).join('\n') + '\n';
        }
      } catch {}
      if (!nd) {
        const file = path.resolve(process.cwd(), 'logs', `chat.${pid.replace(/[^a-zA-Z0-9_.-]+/g, '_')}.jsonl`);
        nd = fs.existsSync(file) ? await readFileSafe(file) : '';
      }
      res.send(nd);
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
  });
  app.post('/chat/clear', async (req, res) => {
    try {
      const pid = toStr(req.body?.project || req.query?.project || projectId);
      CHATS.set(pid, []);
      try { if (typeof db.clearChatMessages === 'function') db.clearChatMessages(userId, pid); } catch {}
      try {
        const file = path.resolve(process.cwd(), 'logs', `chat.${pid.replace(/[^a-zA-Z0-9_.-]+/g, '_')}.jsonl`);
        if (fs.existsSync(file)) {
          const bak = file + '.' + Date.now() + '.bak';
          try { fs.renameSync(file, bak); } catch {}
          try { fs.writeFileSync(file, ''); } catch {}
        }
      } catch {}
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: toStr(e?.message || e) });
    }
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
  app.delete('/agent/:id', (req, res) => {
    try {
      const id = toStr(req.params?.id || '');
      if (!id) return res.status(400).json({ ok: false, error: 'missing_agent_id' });
      const result = removeAgentById(id, { prunePins: true });
      if (!result) return res.status(404).json({ ok: false, error: 'agent_not_found' });
      const { agent, removedPins } = result;
      res.json({ ok: true, removed: id, projectId: agent.projectId, removedPins });
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
  const instanceRole = (process.env.EMEPATH_WATCH_CHILD || '0') === '1' ? 'watch-child' : 'primary';
  try {
    STACK_PID_ID = db.setStackPid('emepath', process.pid, {
      role: instanceRole,
      tag: 'emepath',
      port,
      command: process.argv[1] || process.execPath,
      args: process.argv.slice(2),
      cwd: process.cwd(),
      user: process.env.USER || process.env.LOGNAME || null,
      meta: {
        hostname: os.hostname(),
        portRange: { start: portStart, end: portEnd },
        watchChild: instanceRole === 'watch-child',
        explicitPort: explicitPort || null,
      },
    });
  } catch (e) {
    console.warn('[stack] failed to register pid:', String(e?.message || e));
  }
  const releaseStackPid = () => {
    try {
      if (STACK_PID_ID && typeof db.removeStackPid === 'function') {
        db.removeStackPid(STACK_PID_ID);
      } else if (typeof db.removeStackPidByPid === 'function') {
        db.removeStackPidByPid(process.pid);
      }
    } catch {}
    STACK_PID_ID = null;
  };
  process.once('exit', releaseStackPid);
  CURRENT_SERVER = server;
  CURRENT_PORT = port;

  // Start file watcher (blue/green) unless this is a watch child
  if ((process.env.EMEPATH_WATCH || '1') === '1' && (process.env.EMEPATH_WATCH_CHILD || '0') !== '1') {
    startWatcher({ portStart, portEnd, currentPort: port, argv });
  }

  // Hydrate chat history (last 50) on boot for default project
  try { hydrateChatHistory(projectId); } catch {}

  // Start auto memory updater (env-aware, per-project)
  try { startAutoMemory({ intervalMs: Number(process.env.EMEPATH_AUTO_INTERVAL || '30000') || 30000 }); } catch {}
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
  try { db.insertJob({ id, userId: meta.userId || null, workspaceId: meta.projectId || null, status: 'pending', meta }); } catch {}
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
  try { db.updateJob(next.job.id, { status: 'running' }); } catch {}
  next.fn()
    .then(() => {
      next.job.status = 'done';
      next.job.finishedAt = new Date().toISOString();
      next.job.resolveDone();
      try { db.updateJob(next.job.id, { status: 'done', finishedAt: next.job.finishedAt }); } catch {}
    })
    .catch((e) => {
      next.job.status = 'error';
      next.job.error = toStr(e?.message || e);
      next.job.finishedAt = new Date().toISOString();
      next.job.resolveDone();
      try { db.updateJob(next.job.id, { status: 'error', error: next.job.error, finishedAt: next.job.finishedAt }); } catch {}
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

function enqueueKindAware(brain, { userId: userIdOverride = null, projectId, agents, checklist, baseUrl }) {
  const effectiveUserId = userIdOverride ?? userId;
  const job = enqueue(async () => {
    // Enforce checklist before agents
    await enforceChecklist(checklist);
    // Execute agents by kind
    for (const a of agents) {
      const k = toStr(a.kind).toLowerCase();
      if (k === 'distill') {
        await executeDistillAgent(brain, projectId, a, { baseUrl, userId: effectiveUserId });
      } else if (k === 'scan') {
        await executeScanAgent(brain, projectId, a, { userId: effectiveUserId });
      } else if (k === 'query') {
        await executeQueryAgent(brain, projectId, a);
      } else {
        brain.checkIn(a.id, 'skipped', { note: `No executor for kind=${a.kind}` });
      }
    }
    // Enforce checklist after agents (e.g., run tests)
    await enforceChecklist(checklist);
  }, { userId: effectiveUserId, projectId, count: agents.length });
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

async function executeDistillAgent(brain, projectId, agent, { baseUrl, userId = 1 } = {}) {
  // Parse input -> paths or raw content
  const parsed = parseDistillInput(agent.input);
  const cfg = resolveProjectConfig(projectId, {
    userId,
    workspaceId: DEFAULT_WORKSPACE_ID,
  });
  const configActionDir = sanitizeActionDirValue(cfg.actionDir || '.');
  const standards = await readStandards();
  const outDir = path.resolve(process.cwd(), 'data', 'training');
  await ensureDir(outDir);
  const outFile = path.join(outDir, `distilled.${agent.id}.jsonl`);
  const metaOutFile = path.join(outDir, `distilled.${agent.id}.meta.jsonl`);

  agentLog(projectId, `[${agent.id}] execute distill`);
  if (parsed.paths && parsed.paths.length) {
    const files = [];
    for (const p of parsed.paths) {
      const abs = path.resolve(configActionDir, p);
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

async function executeScanAgent(brain, projectId, agent, { userId = 1 } = {}) {
  // input JSON: { root: string, maxFileSize?: number }
  try {
    agentLog(projectId, `[${agent.id}] execute scan`);
    let j = null;
    try { j = JSON.parse(toStr(agent.input)); } catch {}
    const cfg = resolveProjectConfig(projectId, {
      userId,
      workspaceId: DEFAULT_WORKSPACE_ID,
    });
    const configActionDir = sanitizeActionDirValue(cfg.actionDir || '.');
    const root = path.resolve(configActionDir, toStr(j?.root || agent.input || ''));
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
  const effectiveUserId = Number(args.userId || 1) || 1;
  // Scan
  const scanAgent = brain._spawnAgent({ projectId, goal: 'Bootstrap: scan sources', input: JSON.stringify({ root: sources[0] }), expected: 'index ready' });
  await executeScanAgent(brain, projectId, { ...scanAgent, kind: 'scan' }, { userId: effectiveUserId });
  // Distill
  const distillAgent = brain._spawnAgent({ projectId, goal: 'Bootstrap: distill sources', input: JSON.stringify({ files: sources }), expected: 'JSONL dataset' });
  // Use effective default model config rather than env-only check
  let hasEffectiveModel = false;
  try { const eff = brain._defaultModelConfig(); hasEffectiveModel = !!String(eff?.model_path || '').trim(); } catch { hasEffectiveModel = false; }
  if (hasEffectiveModel) {
    await executeDistillAgent(brain, projectId, { ...distillAgent, kind: 'distill' }, { baseUrl: '', userId: effectiveUserId });
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

function hydrateChatHistory(projectId, limit = 50) {
  try {
    const dir = path.resolve(process.cwd(), 'logs');
    const file = path.join(dir, `chat.${String(projectId).replace(/[^a-zA-Z0-9_.-]+/g, '_')}.jsonl`);
    if (!fs.existsSync(file)) return [];
    const data = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-limit);
    const msgs = [];
    for (const ln of data) {
      try {
        const j = JSON.parse(ln);
        if (j && typeof j.role === 'string' && typeof j.ts === 'string') msgs.push({ role: j.role, content: String(j.content || ''), ts: j.ts });
      } catch {}
    }
    CHATS.set(projectId, msgs);
    return msgs;
  } catch { return []; }
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
let currentPlan = null;
let lastAgents = null;
async function loadProjects(){ const r = await fetch('/projects'); const j = await r.json(); const el = document.getElementById('projects'); el.innerHTML=''; (j.projects||[]).forEach(p=>{ const d=document.createElement('div'); d.innerHTML = '<b>'+p.projectId+'</b><br><small>pending:'+ (p.status.counts.pending||0) +' running:'+ (p.status.counts.running||0) +' done:'+ (p.status.counts.done||0) +'</small>'; d.style.cursor='pointer'; d.onclick=()=>{currentProject=p.projectId; loadChat();}; el.appendChild(d); }); }
async function loadChat(){ const r = await fetch('/chat?project='+encodeURIComponent(currentProject)); const j = await r.json(); const c = document.getElementById('chat'); c.innerHTML=''; (j.messages||[]).forEach(m=>{ const d=document.createElement('div'); d.className='msg'; d.innerHTML='<span class="role">'+m.role+':</span> '+m.content; c.appendChild(d); }); c.scrollTop=c.scrollHeight; }
async function send(){ const t = document.getElementById('ta').value.trim(); if(!t) return; document.getElementById('ta').value=''; const r = await fetch('/chat?project='+encodeURIComponent(currentProject), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ text: t }) }); const j = await r.json(); loadProjects(); loadChat(); }
document.getElementById('send').onclick=send; loadProjects(); loadChat();
</script>
</body></html>`;
}

function renderUIHtml2() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>EmePath UI</title>
    <style>
      body {
        font-family: 'Segoe UI', 'Fira Sans', 'system-ui', sans-serif;
        margin: 0;
        background: #121212;
        color: #e6e6e6;
        letter-spacing: 0.01em;
      }
      #wrap {
        display: grid;
        grid-template-columns: 360px 1fr;
        height: 100vh;
        max-width: 100%;
        margin: 0 auto;
        background: #1e1e1e;
        border-right: 1px solid #2d2d2d;
      }
      #sidebar{
        border-right: 1px solid #2d2d2d;
        padding: 12px;
        overflow: auto;
        background: #1a1a1a;
      }
      #main{
        flex:1;
        display:flex;
        flex-direction:column
      }
      #chat{
        flex:1;
        overflow:auto;
        padding:12px
      }
      #input{
        display:flex;
        border-top:1px solid #2d2d2d
      }
      #input textarea{
        flex:1;
        padding:8px;
        border:0;
        resize:vertical;
        min-height:60px;
        background: #2d2d2d;
        color: #e6e6e6;
      }
      #input button{
        width:120px;
        background: #4a90e2;
        color: #fff;
        border: none;
      }
      .agent{
        font-size:12px;
        color:#a0a8c0;
        margin:2px 0
      }
      .msg{
        margin:10px 0;
        padding:10px 14px;
        border-radius:14px;
        background:#1a1a1a;
        border:1px solid #2d2d2d;
        max-width:80ch;
        box-shadow:0 10px 30px rgba(0,0,0,0.15)
      }
      .msg .role{
        font-weight:600;
        font-size:12px;
        opacity:.75;
        display:block;
        margin-bottom:4px
      }
      .msg.user{ background: linear-gradient(180deg, #0f2344, #0b1a30); }
      .msg.asst{ background: linear-gradient(180deg, #142523, #0e1b1a); }
      .agents{
        max-height:40vh;
        overflow:auto;
        border-top:1px solid #2d2d2d;
        margin-top:8px;
        padding-top:8px
      }
      .logs{
        white-space:pre-wrap;
        font-size:12px;
        background:#1a1a1a;
        border:1px solid #2d2d2d;
        padding:8px;
        height:30vh;
        overflow:auto
      }
      .row{
        display:flex;
        gap:6px;
        align-items:center;
        margin:4px 0
      }
      h3, h4 {
        color: #a0a8c0;
      }
      #projects > div{background: #1a1a1a; border:1px solid #2d2d2d; border-radius:12px; padding:10px 12px; margin-bottom:8px; box-shadow:0 10px 30px rgba(0,0,0,0.15)}
      .pill{padding:2px 8px; border-radius:999px; border:1px solid #2d2d2d; font-size:11px}
      .status-running{background:#0b1222;color:#60a5fa}
      .status-pending{background:#111827;color:#9ca3af}
      .status-done{background:#0f1e18;color:#32d583}
      .status-error{background:#1e0f10;color:#ef4444}
      .status-paused{background:#1a1424;color:#a78bfa}
      button {
        background: #2d2d2d;
        color: #e6e6e6;
        border: 1px solid #3a3a3a;
        font-size: 14px;
        padding: 10px 14px;
        box-shadow: none;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <div id="wrap">
      <div id="sidebar">
        <h3>Projects</h3>
        <div id="projects"></div>
        <div class="row">
          <button id="pause">Pause</button>
          <button id="resume">Resume</button>
        </div>
        <h4>Agents</h4>
        <div id="agents" class="agents"></div>
        <h4>Logs</h4>
        <div id="logs" class="logs"></div>
      </div>
      <div id="main">
        <div id="chat"></div>
        <div id="input">
          <textarea id="ta" placeholder="Type a message..."></textarea>
          <button id="send">Send</button>
        </div>
      </div>
    </div>
    <script>
      let currentProject = new URLSearchParams(location.search).get('project') || 'emepath';
      async function loadProjects() {
        const r = await fetch('/projects');
        const j = await r.json();
        const el = document.getElementById('projects');
        el.innerHTML = '';
        (j.projects || []).forEach(p => {
          const d = document.createElement('div');
          d.innerHTML = '<b>' + p.projectId + '</b><br><small>pending:' + (p.status.counts.pending || 0) + ' running:' + (p.status.counts.running || 0) + ' done:' + (p.status.counts.done || 0) + '</small>';
          d.style.cursor = 'pointer';
          d.onclick = () => {
            currentProject = p.projectId;
            loadAll();
          };
          el.appendChild(d);
        });
      }
      async function loadChat() {
        const r = await fetch('/chat?project=' + encodeURIComponent(currentProject));
        const j = await r.json();
        const c = document.getElementById('chat');
        c.innerHTML = '';
        (j.messages || []).forEach(m => {
          const d = document.createElement('div');
          d.className = 'msg ' + (m.role === 'user' ? 'user' : 'asst');
          d.innerHTML = '<span class="role">' + m.role + '</span>' + m.content;
          c.appendChild(d);
        });
        c.scrollTop = c.scrollHeight;
      }
      async function loadAgents() {
        const r = await fetch('/status?project=' + encodeURIComponent(currentProject));
        const j = await r.json();
        const list = (j.status && j.status.agents) || [];
        const el = document.getElementById('agents');
        el.innerHTML = '';
        list.forEach(a => {
          const d = document.createElement('div');
          d.className = 'agent';
          const cls = 'status-' + String(a.status || '').toLowerCase();
          d.innerHTML = '<span class="pill '+cls+'">'+(a.status||'')+'</span> <b style="margin-left:6px">' + a.goal + '</b><br><small style="color:#a0a8c0">' + a.id + ' · EOT ' + (a.eots||0) + '</small> <button data-id="' + a.id + '" class="run" style="float:right">Run</button>';
          el.appendChild(d);
        });
        el.querySelectorAll('.run').forEach(btn => {
          btn.onclick = async () => {
            const id = btn.getAttribute('data-id');
            const kind = prompt('Kind to run (distill/scan/query)?', 'distill') || 'custom';
            await fetch('/agent/' + encodeURIComponent(id) + '/run', {
              method: 'POST',
              headers: {
                'content-type': 'application/json'
              },
              body: JSON.stringify({
                kind
              })
            });
            loadAgents();
          };
        });
      }
      async function loadLogs() {
        const r = await fetch('/logs?project=' + encodeURIComponent(currentProject));
        const t = await r.text();
        document.getElementById('logs').textContent = t;
      }
      async function send() {
        const t = document.getElementById('ta').value.trim();
        if (!t) return;
        document.getElementById('ta').value = '';
        const r = await fetch('/chat?project=' + encodeURIComponent(currentProject), {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            text: t
          })
        });
        const j = await r.json();
        loadProjects();
        loadChat();
      }
      document.getElementById('send').onclick = send;
      document.getElementById('pause').onclick = () => fetch('/pause', {
        method: 'POST'
      }).then(loadProjects);
      document.getElementById('resume').onclick = () => fetch('/resume', {
        method: 'POST'
      }).then(loadProjects);

      function loadAll() {
        loadProjects();
        loadChat();
        loadAgents();
        loadLogs();
        loadPlan();
      }
      loadAll();
      setInterval(loadAll, 5000);
    </script>
  </body>
</html>
`;
}

function renderModernUI() {
  return `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>EmePath</title>
<style>
:root{--bg:#0f1220;--card:#151a2e;--muted:#8ea0c0;--text:#e8ecf6;--brand:#6ad4ff;--accent:#a78bfa;--ok:#32d583;--warn:#f59e0b;--err:#ef4444;--run:#60a5fa;--pending:#9ca3af;--border:rgba(255,255,255,.08);--shadow:0 10px 30px rgba(0,0,0,.35)}
@media (prefers-color-scheme: light){:root{--bg:#f8fafc;--card:#ffffff;--muted:#475569;--text:#0f172a;--brand:#0077ff;--accent:#6d28d9;--border:#e5e7eb;--shadow:0 10px 30px rgba(0,0,0,.08)}}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(120deg,var(--bg) 0%,#101425 50%,var(--bg) 100%);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,Segoe UI,Roboto,Arial}
.app{display:grid;grid-template-columns:320px 1fr 420px;height:100vh}
.rail{border-right:1px solid var(--border);padding:14px;display:flex;flex-direction:column;gap:12px;background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,0))}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.4px}
.badge{padding:2px 8px;border-radius:999px;background:linear-gradient(90deg,var(--brand),var(--accent));color:#0b0e1a;font-weight:700;font-size:11px}
.projects{display:grid;gap:8px}
.pCard{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:10px 12px;box-shadow:var(--shadow);cursor:pointer;transition:transform .12s ease}
.pCard:hover{transform:translateY(-2px)}
.stat{font-size:11px;color:var(--muted);padding:2px 6px;border:1px solid var(--border);border-radius:8px;margin-right:6px}
.controls{display:flex;gap:8px}
.btn{border:1px solid var(--border);background:var(--card);color:var(--text);padding:8px 10px;border-radius:10px;cursor:pointer}
.btn:hover{filter:brightness(1.1)}
.canvas{position:relative;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border);background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,0))}
.topTitle{font-weight:700}
#graph{flex:1;background:radial-gradient(600px 300px at 40% 40%, rgba(106,212,255,.08), transparent), radial-gradient(600px 300px at 80% 70%, rgba(167,139,250,.08), transparent)}
.dock{border-left:1px solid var(--border);display:flex;flex-direction:column}
.chat{flex:1;overflow:auto;padding:16px}
.bubble{max-width:80ch;padding:10px 14px;border-radius:14px;margin:8px 0;box-shadow:var(--shadow);border:1px solid var(--border)}
.user{background:linear-gradient(180deg,#0f2344,#0b1a30)}
.asst{background:linear-gradient(180deg,#142523,#0e1b1a)}
.input{display:flex;gap:10px;padding:12px;border-top:1px solid var(--border)}
textarea{flex:1;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px;color:var(--text)}
.send{min-width:120px}
.agents{display:flex;flex-direction:column;gap:8px;overflow:auto;max-height:40vh}
.aRow{display:flex;align-items:flex-start;gap:10px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:10px}
.pill{padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid var(--border)}
.pill.pending{background:#111827;color:var(--pending)}.pill.running{background:#0b1222;color:var(--run)}.pill.done{background:#0f1e18;color:var(--ok)}.pill.error{background:#1e0f10;color:var(--err)}.pill.paused{background:#1a1424;color:var(--accent)}
.logs{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:10px;height:28vh;overflow:auto}
#palette{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none;align-items:flex-start;justify-content:center;padding-top:10vh}
.palBox{width:700px;background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow)}
.palBox input{width:100%;padding:12px;background:transparent;color:var(--text);border:0;border-bottom:1px solid var(--border);outline:none}
.palList{max-height:40vh;overflow:auto}
.palItem{padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer}
.palItem:hover{background:rgba(255,255,255,.04)}
#interrupt{position:fixed;right:20px;bottom:20px;width:380px;background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);padding:12px;display:none}
#interrupt textarea{width:100%;margin:6px 0}
#interrupt .out{white-space:pre-wrap;font-size:12px;color:var(--muted);max-height:24vh;overflow:auto;border-top:1px solid var(--border);padding-top:8px}
/* sleek scrollbars */
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-track{background:transparent}
*::-webkit-scrollbar-thumb{background:linear-gradient(180deg,var(--brand),var(--accent));border-radius:10px;border:2px solid rgba(0,0,0,0)}
*{scrollbar-color: var(--accent) transparent; scrollbar-width: thin}
</style></head>
<body>
  <div class="app">
    <aside class="rail">
      <div class="brand"><span class="badge">E</span><span>EmePath</span></div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin:6px 0 8px"><div class="topTitle">Projects</div>
        <div class="controls"><button class="btn" id="pause">Pause</button><button class="btn" id="resume">Resume</button></div>
      </div>
      <div id="projects" class="projects"></div>
      <div style="margin-top:8px"><div class="topTitle">Agents</div><div id="agents" class="agents"></div></div>
      <div style="margin-top:8px"><div class="topTitle">Terminal <button class="btn" id="toggleTerm" style="padding:4px 8px;font-size:12px">Show</button></div><div id="termWrap" style="display:none"><div id="term" class="logs"></div></div></div>
      <div style="margin-top:8px"><div class="topTitle">Agent/Chat Logs <button class="btn" id="toggleLogs" style="padding:4px 8px;font-size:12px">Show</button></div><div id="logsWrap" style="display:none"><div id="logs" class="logs"></div></div></div>
    </aside>
    <section class="canvas">
      <div class="topbar">
        <div class="topTitle" id="projTitle">Flow</div>
        <div class="controls"><button class="btn" id="openInterrupt">Interrupt</button><button class="btn" id="openPalette">Actions ⌘K</button><button class="btn" id="openPlan">Plan</button><button class="btn" id="openMemory">Memory</button></div>
      </div>
      <svg id="graph"></svg>
    </section>
    <aside class="dock">
      <div class="topbar"><div class="topTitle">Conversation</div></div>
      <div class="chat" id="chat"></div>
      <div class="input"><textarea id="ta" placeholder="Type a message…"></textarea><button class="btn send" id="send">Send</button></div>
    </aside>
  </div>

  <div id="palette">
    <div class="palBox">
      <input id="palInput" placeholder="Type a command… (e.g., Plan distill ./documents)" />
      <div class="palList" id="palList"></div>
    </div>
  </div>

  <div id="interrupt">
    <div class="topTitle">Interrupt (Double Message)</div>
    <textarea id="intA" rows="3" placeholder="Message A"></textarea>
    <textarea id="intB" rows="3" placeholder="Message B"></textarea>
    <div class="controls"><button class="btn" id="sendInterrupt">Send Interrupt</button><button class="btn" id="closeInterrupt">Close</button></div>
    <div class="out" id="intOut"></div>
  </div>

  <div id="plan" style="position:fixed;right:20px;top:20px;width:420px;background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);padding:12px;display:none;max-height:70vh;overflow:auto">
    <div style="display:flex;align-items:center;justify-content:space-between"><div class="topTitle">Plan</div><div class="controls"><button class="btn" id="closePlan">Close</button></div></div>
    <div id="planBody" style="margin-top:8px"></div>
  </div>

  <div id="memory" style="position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--border);box-shadow:var(--shadow);padding:12px;display:none">
    <div style="display:flex;align-items:center;justify-content:space-between"><div class="topTitle">Memory Ladder</div><div class="controls"><button class="btn" id="closeMemory">Close</button></div></div>
    <div id="memBody" style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap"></div>
  </div>

<script>
let currentProject = new URLSearchParams(location.search).get('project') || 'emepath';
const palette = document.getElementById('palette');
const palInput = document.getElementById('palInput');
const palList = document.getElementById('palList');

function statusPill(s){ s=(s||'').toLowerCase(); return '<span class="pill '+s+'">'+s+'</span>'; }

async function loadProjects(){ const r=await fetch('/projects'); const j=await r.json(); const el=document.getElementById('projects'); el.innerHTML=''; (j.projects||[]).forEach(p=>{ const d=document.createElement('div'); d.className='pCard'; d.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between"><div><div style="font-weight:700">'+p.projectId+'</div><div style="margin-top:4px"><span class="stat">pending '+(p.status.counts.pending||0)+'</span><span class="stat">running '+(p.status.counts.running||0)+'</span><span class="stat">done '+(p.status.counts.done||0)+'</span></div></div><div>'+statusPill(p.status.queue.paused?'paused':'active')+'</div></div>'; d.onclick=()=>{currentProject=p.projectId; loadAll();}; el.appendChild(d); }); document.getElementById('projTitle').textContent='Flow — '+currentProject; }

async function loadChat(){ const r=await fetch('/chat?project='+encodeURIComponent(currentProject)); const j=await r.json(); const c=document.getElementById('chat'); c.innerHTML=''; (j.messages||[]).forEach(m=>{ const d=document.createElement('div'); d.className='bubble '+(m.role==='user'?'user':'asst'); d.innerHTML='<div style="opacity:.7;font-size:12px;margin-bottom:4px">'+m.role+'</div>'+m.content; c.appendChild(d); }); c.scrollTop=c.scrollHeight; }

async function loadAgents(){ const r=await fetch('/status?project='+encodeURIComponent(currentProject)); const j=await r.json(); const list=(j.status&&j.status.agents)||[]; lastAgents=list; const el=document.getElementById('agents'); el.innerHTML=''; list.forEach(a=>{ const d=document.createElement('div'); d.className='aRow'; d.innerHTML='<div>'+statusPill(a.status)+'</div><div style="flex:1"><div style="font-weight:600">'+a.goal+'</div><div style="color:var(--muted);font-size:12px">'+a.id+' · EOT '+(a.eots||0)+'</div></div><button class="btn runBtn" data-id="'+a.id+'">Run</button>'; el.appendChild(d); }); el.querySelectorAll('.runBtn').forEach(btn=>{ btn.onclick=async ()=>{ const id=btn.getAttribute('data-id'); const kind=prompt('Kind to run (distill/scan/query)?','distill')||'custom'; await fetch('/agent/'+encodeURIComponent(id)+'/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind})}); loadAgents(); }; }); drawGraph(list); }

async function loadLogs(){ const r=await fetch('/logs?project='+encodeURIComponent(currentProject)); const t=await r.text(); const el=document.getElementById('logs'); if(el) el.textContent=t; }
async function loadTerm(){ try{ const r=await fetch('/term'); const t=await r.text(); const el=document.getElementById('term'); if(el) el.textContent=t; }catch(e){} }

async function send(){ const t=document.getElementById('ta').value.trim(); if(!t) return; document.getElementById('ta').value=''; await fetch('/chat?project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t})}); loadProjects(); loadChat(); }

document.getElementById('send').onclick=send;
document.getElementById('pause').onclick=()=>fetch('/pause',{method:'POST'}).then(loadProjects);
document.getElementById('resume').onclick=()=>fetch('/resume',{method:'POST'}).then(loadProjects);

document.getElementById('openPalette').onclick=()=>openPalette();
document.getElementById('openInterrupt').onclick=()=>toggleInterrupt(true);
document.getElementById('closeInterrupt').onclick=()=>toggleInterrupt(false);
document.getElementById('sendInterrupt').onclick=sendInterrupt;

function loadAll(){ loadProjects(); loadAgents(); loadLogs(); loadChat(); loadPlan(); }
loadAll(); setInterval(loadAll, 5000);

// Path Graph prototype — simple radial layout
function drawGraph(agents){ const svg=document.getElementById('graph'); const W=svg.clientWidth||svg.parentElement.clientWidth||800; const H=svg.clientHeight||svg.parentElement.clientHeight||600; svg.setAttribute('viewBox','0 0 ' + W + ' ' + H); svg.innerHTML=''; const cx=W/2, cy=H/2; const R=Math.min(W,H)/3; svg.appendChild(makeDefs()); const root=document.createElementNS('http://www.w3.org/2000/svg','circle'); root.setAttribute('cx',cx); root.setAttribute('cy',cy); root.setAttribute('r',12); root.setAttribute('fill','url(#gradRoot)'); root.setAttribute('stroke','rgba(255,255,255,.3)'); svg.appendChild(root); if (typeof currentPlan==='object' && currentPlan && currentPlan.intent){ const t=document.createElementNS('http://www.w3.org/2000/svg','text'); t.setAttribute('x',cx+14); t.setAttribute('y',cy+4); t.setAttribute('fill','var(--muted)'); t.setAttribute('font-size','13'); t.textContent=trim(currentPlan.intent,40); svg.appendChild(t); } const n=Math.max(1,agents.length); agents.forEach((a,i)=>{ const ang=(i/n)*Math.PI*2 - Math.PI/2; const x=cx+R*Math.cos(ang), y=cy+R*Math.sin(ang); const path=document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d','M ' + cx + ' ' + cy + ' Q ' + (cx + (x - cx)/2) + ' ' + (cy + (y - cy)/2 - 40) + ' ' + x + ' ' + y); path.setAttribute('stroke', edgeColor(a.status)); path.setAttribute('stroke-width','2'); path.setAttribute('fill','none'); path.setAttribute('opacity','.7'); svg.appendChild(path); const node=document.createElementNS('http://www.w3.org/2000/svg','circle'); node.setAttribute('cx',x); node.setAttribute('cy',y); node.setAttribute('r',8); node.setAttribute('fill', nodeColor(a.status)); node.setAttribute('stroke','rgba(255,255,255,.3)'); svg.appendChild(node); const label=document.createElementNS('http://www.w3.org/2000/svg','text'); label.setAttribute('x',x+10); label.setAttribute('y',y+4); label.setAttribute('fill','var(--muted)'); label.setAttribute('font-size','12'); label.textContent=trim(a.goal,40); svg.appendChild(label); }); }
function makeDefs(){ const defs=document.createElementNS('http://www.w3.org/2000/svg','defs'); const grad=document.createElementNS('http://www.w3.org/2000/svg','radialGradient'); grad.setAttribute('id','gradRoot'); const s1=document.createElementNS('http://www.w3.org/2000/svg','stop'); s1.setAttribute('offset','0%'); s1.setAttribute('stop-color','var(--brand)'); const s2=document.createElementNS('http://www.w3.org/2000/svg','stop'); s2.setAttribute('offset','100%'); s2.setAttribute('stop-color','var(--accent)'); s2.setAttribute('stop-opacity','.5'); grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad); return defs; }
function nodeColor(s){ s=(s||'').toLowerCase(); if(s==='running') return '#60a5fa'; if(s==='done') return '#32d583'; if(s==='error') return '#ef4444'; if(s==='paused') return '#a78bfa'; return '#9ca3af'; }
function edgeColor(s){ s=(s||'').toLowerCase(); if(s==='running') return 'rgba(96,165,250,.8)'; if(s==='done') return 'rgba(50,213,131,.6)'; if(s==='error') return 'rgba(239,68,68,.6)'; if(s==='paused') return 'rgba(167,139,250,.6)'; return 'rgba(156,163,175,.4)'; }
function trim(s,n){ s=String(s||''); return s.length>n? s.slice(0,n-1)+'…': s; }

// Palette
const PRESETS=[
  {label:'Plan: Distill ./documents (autorun)', run:()=>fetch('/process?autorun=true&project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'Distill ./documents',options:{autorun:true}})}).then(loadAll)},
  {label:'Scan current repo', run:()=>fetch('/control?project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'Scan repository',actions:[{tool:'execute',args:{kind:'scan',input:JSON.stringify({root:"."})}}]})}).then(loadAll)},
  {label:'Query: "security policy"', run:()=>fetch('/control?project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'Query security policy',actions:[{tool:'execute',args:{kind:'query',input:JSON.stringify({q:'security policy',k:8})}}]})}).then(loadAll)},
  {label:'Suggest fixes & features', run:()=>fetch('/control?project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'Survey + suggest',actions:[{tool:'survey_env'},{tool:'suggest_fixes'},{tool:'suggest_features'}]})}).then(loadAll)},
];
function openPalette(){ palette.style.display='flex'; palInput.value=''; renderPalList(PRESETS); palInput.focus(); }
function closePalette(){ palette.style.display='none'; }
palInput.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closePalette(); } if(e.key==='Enter'){ const first=palList.querySelector('.palItem'); if(first){ first.click(); } } });
document.getElementById('openPalette').addEventListener('click',openPalette);
document.addEventListener('keydown',e=>{ if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); openPalette(); } });
function renderPalList(items){ palList.innerHTML=''; items.forEach(it=>{ const d=document.createElement('div'); d.className='palItem'; d.textContent=it.label; d.onclick=()=>{ closePalette(); it.run(); }; palList.appendChild(d); }); }

// Interrupt
function toggleInterrupt(on){ document.getElementById('interrupt').style.display= on?'block':'none'; }
async function sendInterrupt(){ const a=document.getElementById('intA').value.trim(); const b=document.getElementById('intB').value.trim(); if(!a && !b) return; const r=await fetch('/interrupt?format=text&project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[a,b]})}); const t=await r.text(); document.getElementById('intOut').textContent=t; }

// Logs collapse and rolling terminal
document.getElementById('toggleLogs').addEventListener('click',()=>{ const w=document.getElementById('logsWrap'); const b=document.getElementById('toggleLogs'); const vis = w.style.display !== 'none'; w.style.display = vis ? 'none' : 'block'; b.textContent = vis ? 'Show' : 'Hide'; });
document.getElementById('toggleTerm').addEventListener('click',()=>{ const w=document.getElementById('termWrap'); const b=document.getElementById('toggleTerm'); const vis = w.style.display !== 'none'; w.style.display = vis ? 'none' : 'block'; b.textContent = vis ? 'Show' : 'Hide'; });
setInterval(loadTerm, 2000);

// Plan drawer
document.getElementById('openPlan').addEventListener('click',()=>togglePlan(true));
document.getElementById('closePlan').addEventListener('click',()=>togglePlan(false));
function togglePlan(on){ const el=document.getElementById('plan'); el.style.display= on?'block':'none'; if(on) renderPlanUI(); }
async function renderPlanUI(){ const el=document.getElementById('planBody'); el.innerHTML=''; try{ const r=await fetch('/plan?project='+encodeURIComponent(currentProject)); const j=await r.json(); const p=j.plan||{}; const wrap=document.createElement('div');
  const intent=document.createElement('div'); intent.innerHTML='<div class="topTitle">Intent</div><div class="stat">'+(p.intent||'—')+'</div>';
  const goals=document.createElement('div'); goals.innerHTML='<div class="topTitle" style="margin-top:8px">Goals</div>'; (p.goals||[]).forEach(g=>{ const it=document.createElement('div'); it.className='stat'; it.textContent=g; goals.appendChild(it); });
  const steps=document.createElement('div'); steps.innerHTML='<div class="topTitle" style="margin-top:8px">Steps</div>'; (p.plan||[]).forEach(s=>{ const it=document.createElement('div'); it.className='stat'; it.textContent=s; steps.appendChild(it); });
  const checklist=document.createElement('div'); checklist.innerHTML='<div class="topTitle" style="margin-top:8px">Checklist</div>'; (p.checklist||[]).forEach(c=>{ const box=document.createElement('div'); box.className='aRow'; const title=document.createElement('div'); title.style.flex='1'; title.innerHTML='<b>'+c.title+'</b><br><small style="color:var(--muted)">'+c.action+'</small>'; const btn=document.createElement('button'); btn.className='btn'; btn.textContent='Resolve'; btn.onclick=async ()=>{ let tool=null; if(c.action==='read_standards') tool='read_standards'; else if(c.action==='run_tests') tool='run_tests'; if(tool){ await fetch('/control?project='+encodeURIComponent(currentProject),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'resolve checklist',actions:[{tool}]})}); await renderPlanUI(); } }; box.appendChild(title); box.appendChild(btn); checklist.appendChild(box); });
  wrap.appendChild(intent); wrap.appendChild(goals); wrap.appendChild(steps); wrap.appendChild(checklist); el.appendChild(wrap); }catch(e){ el.textContent='No plan available.'; } }

 // Memory
 document.getElementById('openMemory').addEventListener('click',()=>toggleMemory(true));
 document.getElementById('closeMemory').addEventListener('click',()=>toggleMemory(false));
 function toggleMemory(on){ const el=document.getElementById('memory'); el.style.display= on?'block':'none'; if(on) loadMemory(); }
 async function loadPlan(){ try{ const r=await fetch('/plan?project='+encodeURIComponent(currentProject)); const j=await r.json(); currentPlan=j.plan||null; drawGraph(lastAgents||[]); }catch(e){} }
 async function loadMemory(){ try{ const r=await fetch('/memory?project='+encodeURIComponent(currentProject)); const j=await r.json(); const el=document.getElementById('memBody'); const fmt=(x)=> x && x.updatedAt ? new Date(x.updatedAt).toLocaleString() : '—'; el.innerHTML=''
   + '<div class="pCard" style="min-width:220px"><div class="topTitle">Short-term</div><div class="stat">size '+(j.short&&j.short.size||0)+'</div><div class="stat">updated '+fmt(j.short)+'</div></div>'
   + '<div class="pCard" style="min-width:220px"><div class="topTitle">Long-term</div><div class="stat">size '+(j.long&&j.long.size||0)+'</div><div class="stat">updated '+fmt(j.long)+'</div></div>'
   + '<div class="pCard" style="min-width:220px"><div class="topTitle">Personalization</div><div class="stat">'+(j.personalization&&j.personalization.exists?'exported':'not exported')+'</div><div class="stat" style="max-width:360px">'+(j.personalization&&j.personalization.path||'')+'</div></div>'; }catch(e){} }

</script>
</body></html>`;
}

// -------------------- Controller helpers --------------------
// -------------------- Watcher (blue/green restart) --------------------

function startWatcher({ portStart, portEnd, currentPort, argv }) {
  const exts = new Set(['.js', '.mjs', '.cjs', '.json']);
  const root = process.cwd();
  let lastSig = 0;
  let busy = false;

  // Load simple .gitignore rules (basic support for directory entries and *.ext patterns)
  const gitignorePatterns = (() => {
    try {
      const txt = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
      return txt
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'));
    } catch {
      return [];
    }
  })();

  function matchGitignore(p) {
    const u = p.replace(/\\/g, '/');
    for (const pat of gitignorePatterns) {
      if (!pat) continue;
      if (pat.endsWith('/')) {
        // directory ignore: match if path contains that segment
        const seg = pat.replace(/\/$/, '');
        if (u.includes(`/${seg}/`)) return true;
      } else if (pat.startsWith('*.')) {
        const ext = pat.slice(1); // like '.log'
        if (u.endsWith(ext)) return true;
      } else {
        // simple contains or exact path
        if (u.endsWith(pat) || u.includes(`/${pat}/`)) return true;
      }
    }
    return false;
  }

  const shouldIgnore = (p) =>
    /(^|\/)node_modules\//.test(p) ||
    /(^|\/)\.git\//.test(p) ||
    /(^|\/)logs\//.test(p) ||
    /(^|\/)data\//.test(p) ||
    /(^|\/)runs\//.test(p) ||
    /(^|\/)gateway\/db\//.test(p) ||
    /(^|\/)gateway\/logs\//.test(p) ||
    /(^|\/)\.stack\.pids\.json$/.test(p) ||
    /(^|\/)stack\.log$/.test(p) ||
    /\.(log|out|db|sqlite3?)$/i.test(p) ||
    matchGitignore(p);

  async function scanDir(dir) {
    let max = 0;
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      let ents = [];
      try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (shouldIgnore(p)) continue;
        if (e.isDirectory()) { stack.push(p); continue; }
        const ext = path.extname(p).toLowerCase();
        if (!exts.has(ext)) continue;
        try { const st = await fsp.stat(p); if (st.mtimeMs > max) max = st.mtimeMs; } catch {}
      }
    }
    return max;
  }

  async function tick() {
    try {
      const sig = await scanDir(root);
      if (!lastSig) { lastSig = sig; return; }
      if (sig > lastSig && !busy) {
        busy = true; lastSig = sig;
        // Countdown for UI
        WATCH_STATE.active = true; WATCH_STATE.step = 'restarting'; WATCH_STATE.seconds = 10; WATCH_STATE.targetPort = null;
        const iv = setInterval(() => { if (WATCH_STATE.seconds > 0) WATCH_STATE.seconds--; }, 1000);
        setTimeout(async () => {
          clearInterval(iv);
          await doRollingRestart({ portStart, portEnd, currentPort, argv });
          WATCH_STATE.active = false; WATCH_STATE.seconds = 0; WATCH_STATE.step = '';
          busy = false;
        }, 10000);
      }
    } catch {}
  }
  setInterval(tick, 1500);
}

async function doRollingRestart({ portStart, portEnd, currentPort, argv }) {
  try {
    const newPort = await findAltPort(currentPort, portStart, portEnd);
    WATCH_STATE.step = 'staging'; WATCH_STATE.targetPort = newPort;
    console.log(`[watch] change detected — starting new instance on :${newPort}`);
    const childA = spawn(
      process.execPath,
      [
        process.argv[1],
        '--server',
        '--port',
        String(newPort),
        '--portStart',
        String(portStart),
        '--portEnd',
        String(portEnd),
      ],
      { env: { ...process.env, EMEPATH_WATCH_CHILD: '1' }, stdio: 'inherit' }
    );
    let watchChildId = null;
    try {
      watchChildId = db.setStackPid('emepath', childA.pid, {
        role: 'watch-blue',
        tag: 'emepath',
        port: newPort,
        command: process.execPath,
        args: childA.spawnargs || [],
        cwd: process.cwd(),
        user: process.env.USER || process.env.LOGNAME || null,
        meta: {
          hostname: os.hostname(),
          watcher: true,
          phase: 'staging',
          targetPort: currentPort,
          stagedPort: newPort,
        },
      });
    } catch (e) {
      console.warn('[watch] failed to register blue instance pid:', String(e?.message || e));
    }
    childA.once('exit', () => {
      try {
        if (watchChildId && typeof db.removeStackPid === 'function') db.removeStackPid(watchChildId);
        else if (typeof db.removeStackPidByPid === 'function') db.removeStackPidByPid(childA.pid);
      } catch {}
    });
    const okA = await waitHealth(newPort, 20000);
    if (!okA) { console.warn('[watch] new instance failed health'); try { childA.kill(); } catch {}; return; }
    // Switch: stop current server, then delegate full restart to npm scripts
    WATCH_STATE.step = 'switching';
    try {
      db.setStackPid('emepath', childA.pid, {
        role: 'watch-blue',
        tag: 'emepath',
        port: newPort,
        command: process.execPath,
        args: childA.spawnargs || [],
        cwd: process.cwd(),
        user: process.env.USER || process.env.LOGNAME || null,
        meta: {
          hostname: os.hostname(),
          watcher: true,
          phase: 'switching',
          targetPort: currentPort,
          stagedPort: newPort,
        },
      });
    } catch {}
    await gracefulClose(CURRENT_SERVER, 5000);
    console.log(`[watch] delegating restart via npm (target original :${currentPort})`);
    try {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const child = spawn(npmCmd, ['run', '-s', 'restart'], {
        cwd: process.cwd(),
        env: { ...process.env, EMEPATH_PORT: String(currentPort) },
        detached: true,
        stdio: 'ignore',
      });
      child.unref?.();
    } catch (e) {
      console.warn('[watch] failed to spawn npm restart:', String(e?.message || e));
    }
    // Wait for new instance on original port
    const okB = await waitHealth(currentPort, 60000);
    if (okB) {
      console.log('[watch] npm restart healthy; stopping blue instance');
      try { childA.kill(); } catch {}
      setTimeout(() => process.exit(0), 500);
    } else {
      console.warn('[watch] npm restart failed to become healthy; keeping blue instance on :' + newPort);
    }
  } catch (e) {
    console.warn('[watch] error:', String(e?.message || e));
  }
}

async function gracefulClose(server, timeoutMs = 3000) {
  if (!server) return;
  await new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) resolve(); }, timeoutMs);
    try { server.close(() => { done = true; clearTimeout(t); resolve(); }); } catch { resolve(); }
  });
}

async function findAltPort(current, start, end) {
  let cand = current + 1;
  if (cand > end) cand = start;
  // Probe
  const ok = await new Promise((resolve) => {
    const s = http.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(cand);
  });
  if (ok) return cand;
  // Fallback: pick any from range
  for (let p = start; p <= end; p++) {
    if (p === current) continue;
    const ok2 = await new Promise((resolve) => {
      const s = http.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(p);
    });
    if (ok2) return p;
  }
  // End: return current to avoid errors
  return current;
}

async function waitHealth(port, timeoutMs = 10000) {
  const exp = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/health`;
  while (Date.now() < exp) {
    try {
      if (typeof fetch === 'function') {
        const r = await fetch(url);
        if (r && r.ok) return true;
      } else {
        const ok = await new Promise((resolve) => {
          const req = http.get(url, (res) => {
            // drain response quickly; status 2xx = healthy
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 300);
          });
          req.on('error', () => resolve(false));
          req.setTimeout(2000, () => { try { req.destroy(); } catch {} ; resolve(false); });
        });
        if (ok) return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function attachConsoleFileLogger() {
  if (CONSOLE_LOG_ATTACHED) return;
  CONSOLE_LOG_ATTACHED = true;
  try { fs.mkdirSync(path.resolve(process.cwd(), 'logs'), { recursive: true }); } catch {}
  const file = path.resolve(process.cwd(), 'logs', 'terminal.log');
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  function write(line) {
    try { fs.appendFileSync(file, line + '\n'); } catch {}
  }
  function ts(level, args) {
    const msg = args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    return `[${new Date().toISOString()}] [${level}] ${msg}`;
  }
  console.log = (...a) => { write(ts('log', a)); try { orig.log.apply(console, a); } catch {} };
  console.error = (...a) => { write(ts('error', a)); try { orig.error.apply(console, a); } catch {} };
  console.warn = (...a) => { write(ts('warn', a)); try { orig.warn.apply(console, a); } catch {} };
  console.info = (...a) => { write(ts('info', a)); try { orig.info.apply(console, a); } catch {} };
}

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

async function runControllerAction(brain, { projectId, baseUrl, userId = 1 }, action, parsed) {
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
      const job = await executeBootstrapLoRA(brain, projectId, { ...args, userId });
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
      const job = enqueueKindAware(brain, { userId, projectId, agents: [{ ...ag, kind: 'distill' }], checklist: parsed.checklist || [], baseUrl });
      if (!background) await job.awaitDone();
      return { tool, ok: true, job: { id: job.id, status: job.status } };
    }
    if (kind === 'scan') {
      const ag = brain._spawnAgent({ projectId, goal: 'controller-scan', input: toStr(args.input || ''), expected: 'index ready' });
      const job = enqueueKindAware(brain, { userId, projectId, agents: [{ ...ag, kind: 'scan' }], checklist: parsed.checklist || [], baseUrl });
      if (!background) await job.awaitDone();
      return { tool, ok: true, job: { id: job.id, status: job.status } };
    }
    if (kind === 'query') {
      const ag = brain._spawnAgent({ projectId, goal: 'controller-query', input: toStr(args.input || ''), expected: 'hits json' });
      const job = enqueueKindAware(brain, { userId, projectId, agents: [{ ...ag, kind: 'query' }], checklist: parsed.checklist || [], baseUrl });
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
  const envUserId = Number(env.userId || 1) || 1;
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
    const r = await runControllerAction(brain, { projectId: toStr(env.projectId || 'emepath'), baseUrl, userId: envUserId }, act, parsed);
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

// -------------------- Auto memory updater (env scanning) --------------------

const AUTO = { enabled: (process.env.EMEPATH_AUTO || '1') === '1', timer: null, intervalMs: 30000, projects: new Map() };

function shouldIgnoreDir(name) {
  return /^(node_modules|\.git|dist|build|out|\.next|target|logs|coverage|\.cache)$/i.test(String(name));
}

async function dirSnapshot(root, { maxFiles = 4000 } = {}) {
  const abs = path.resolve(process.cwd(), root || '.');
  if (!isDir(abs)) return { root: abs, files: new Map(), count: 0, mtimeMax: 0, hash: '0' };
  let count = 0;
  let mtimeMax = 0;
  const files = new Map();
  async function walk(dir) {
    let items = [];
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.isDirectory()) {
        if (shouldIgnoreDir(it.name)) continue;
        await walk(path.join(dir, it.name));
        if (count >= maxFiles) return;
      } else {
        const p = path.join(dir, it.name);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        const rel = path.relative(abs, p);
        files.set(rel, Number(st.mtimeMs || 0));
        count++;
        if (st.mtimeMs > mtimeMax) mtimeMax = Number(st.mtimeMs);
        if (count >= maxFiles) return;
      }
    }
  }
  await walk(abs);
  // Simple fingerprint: count|maxMtime|root
  const hash = `${count}|${mtimeMax}|${abs}`;
  return { root: abs, files, count, mtimeMax, hash };
}

function diffSnapshots(prev, curr, { limit = 12 } = {}) {
  const added = [];
  const removed = [];
  const modified = [];
  const p = prev?.files || new Map();
  const c = curr?.files || new Map();
  const all = new Set([...p.keys(), ...c.keys()]);
  for (const k of all) {
    const a = p.get(k);
    const b = c.get(k);
    if (a == null && b != null) added.push(k);
    else if (a != null && b == null) removed.push(k);
    else if (a != null && b != null && a !== b) modified.push(k);
    if (added.length >= limit && removed.length >= limit && modified.length >= limit) break;
  }
  return { added, removed, modified };
}

function summarizeDiff(diff, root, { limit = 5 } = {}) {
  const take = (arr) => arr.slice(0, limit).map((x) => `- ${x}`).join('\n') + (arr.length > limit ? `\n… +${arr.length - limit} more` : '');
  const parts = [];
  if (diff.added.length) parts.push(`Added (${diff.added.length}):\n${take(diff.added)}`);
  if (diff.removed.length) parts.push(`Removed (${diff.removed.length}):\n${take(diff.removed)}`);
  if (diff.modified.length) parts.push(`Modified (${diff.modified.length}):\n${take(diff.modified)}`);
  const body = parts.length ? parts.join('\n\n') : 'No notable changes';
  return `Environment update detected under ${root}\n${body}`;
}

function startAutoMemory({ intervalMs = 30000 } = {}) {
  AUTO.intervalMs = intervalMs;
  if (!AUTO.enabled) return;
  if (AUTO.timer) clearInterval(AUTO.timer);
  AUTO.timer = setInterval(tickAutoMemory, AUTO.intervalMs);

  // Expose state endpoints
  try {
    const app = CURRENT_SERVER && CURRENT_SERVER._events && CURRENT_SERVER._events.request && CURRENT_SERVER._events.request; // noop
  } catch {}
}

async function tickAutoMemory() {
  try {
    const list = await listProjectsStatus();
    for (const p of Array.isArray(list) ? list : []) {
      const pid = String(p.projectId || '').trim();
      const actionDir = (p.config && p.config.actionDir) || '.';
      if (!pid) continue;
      await autoForProject(pid, actionDir);
    }
  } catch {}
}

async function autoForProject(projectId, actionDir) {
  try {
    const rec = AUTO.projects.get(projectId) || { last: null, busy: false, lastRunAt: 0 };
    if (rec.busy) return;
    const now = Date.now();
    if (now - rec.lastRunAt < AUTO.intervalMs - 1000) return; // throttle
    rec.busy = true;
    AUTO.projects.set(projectId, rec);
    const snap = await dirSnapshot(actionDir);
    if (rec.last && rec.last.hash === snap.hash) { rec.busy = false; return; }
    const diff = diffSnapshots(rec.last, snap);
    // Compose assistant update in chat
    const msg = summarizeDiff(diff, snap.root);
    appendChat(projectId, 'assistant', msg);
    // Ask controller to update memory/index as needed
    const baseUrl = `http://127.0.0.1:${CURRENT_PORT || 0}`;
    try {
      await runControlOnce(LAST_BRAIN, {
        textRaw: 'Environment changed. Update memory and index as needed. ' + msg,
        env: { projectId },
        options: { loop: false },
        baseUrl,
      });
    } catch {}
    rec.last = snap;
    rec.lastRunAt = now;
    rec.busy = false;
    AUTO.projects.set(projectId, rec);
  } catch {
    // ignore
  }
}

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
  return /LORA_MODEL_PATH is required to load model/i.test(msg)
    || /Invalid JSON from .*\/models/i.test(msg)
    || /fetch failed/i.test(msg)
    || /ECONNREFUSED|ECONNRESET|ENOTFOUND|getaddrinfo/i.test(msg);
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
