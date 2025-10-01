// Brain: lightweight orchestrator for intent → goals → plan → agent steps
// Uses the gateway (LoRA server) as the LLM backend and stores cross-references
// to DB ids for projects (previously called workspaces).

import { log as gwLog } from './gateway/utils.js';
import { getConfig } from './gateway/config/index.js';
import db from './gateway/db/db.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let CFG;
try { CFG = getConfig(); } catch { CFG = { ports: { gateway: 3123 } }; }

export class Brain {
  constructor({ llm } = {}) {
    this.projects = new Map(); // projectId -> { userId, meta }
    this.agents = new Map(); // agentId -> { projectId, goal, steps, status, lastCheckIn }
    this.sessions = new Map(); // sessionId -> { userId, projectId }
    this._agentSeq = 1;
    this._sessionSeq = 1;
    this.llm = llm || this._defaultLLM();
  }

  _defaultLLM() {
    // Lazily import to avoid circular ESM at startup
    return {
      chat: async ({ messages, temperature = 0.2, maxTokens = 1024, timeoutMs = 20000 }) => {
        const mod = await import('./gateway/lib/lora_client.js');
        const loraModel = this._defaultModelConfig();
        return mod.chat({ messages, temperature, maxTokens, timeoutMs, loraModel });
      },
    };
  }

  _defaultModelConfig() {
    const envName = process.env.LORA_MODEL_NAME;
    try {
      const projectCfg = require('./project.config.js');
      const gatewayCfg = projectCfg?.default?.gateway || {};
      const cfgPath = gatewayCfg.modelPath;
      const cfgName = gatewayCfg.modelName || envName;
      if (cfgPath && cfgPath.trim()) {
        return { name: cfgName || 'default', model_path: cfgPath };
      }
    } catch {}
    const envPath = process.env.LORA_MODEL_PATH;
    if (envPath && envPath.trim()) {
      return { name: envName || 'default', model_path: envPath };
    }
    const root = path.resolve(process.cwd(), 'gateway', 'models');
    const maxDepth = 4;
    try {
      const hfHits = [];
      const stack = [{ d: root, k: 0 }];
      while (stack.length) {
        const { d, k } = stack.pop();
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) {
            if (k < maxDepth) stack.push({ d: p, k: k + 1 });
          } else if (e.isFile() && e.name === 'config.json') {
            const dir = path.dirname(p);
            if (/(^|\/)loras(\/|$)/.test(dir)) continue;
            const name = path.basename(dir);
            hfHits.push({ name, path: dir });
          }
        }
      }
      if (hfHits.length) {
        const score = (n) => {
          const s = n.toLowerCase();
          if (/gpt-oss|qwen/.test(s)) return 120;
          if (/mistral|gemma|phi/.test(s)) return 80;
          return 10;
        };
        hfHits.sort((a, b) => score(b.name) - score(a.name) || a.name.localeCompare(b.name));
        const best = hfHits[0];
        return { name: best.name, model_path: best.path };
      }
    } catch {}
    try {
      const ggufs = [];
      const stack = [{ d: root, k: 0 }];
      while (stack.length) {
        const { d, k } = stack.pop();
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) {
            if (k < maxDepth) stack.push({ d: p, k: k + 1 });
          } else if (e.isFile() && p.toLowerCase().endsWith('.gguf')) {
            ggufs.push(p);
          }
        }
      }
      if (ggufs.length) {
        const scoreG = (p) => {
          const s = String(p || '').toLowerCase();
          let sc = 0;
          if (/unlocked|uncensored|abliterated|gpt_unlocked/.test(s)) sc += 1000;
          if (/qwen|llama|mistral|gemma|phi|deepseek/.test(s)) sc += 100;
          return sc;
        };
        ggufs.sort((a, b) => scoreG(b) - scoreG(a));
        const p = ggufs[0];
        return { name: path.basename(p).replace(/\.gguf$/i, '') || (envName || 'default'), model_path: p };
      }
    } catch {}
    return { name: envName || 'default', model_path: '' };
  }

  createSession({ userId, projectId }) {
    const sid = `s_${this._sessionSeq++}`;
    this.sessions.set(sid, { userId, projectId });
    // ensure project exists in DB; alias legacy workspace to project
    const workspaceId = 'default';
    let meta = null;
    try {
      if (typeof db.getProjectByName === 'function') {
        meta = db.getProjectByName(userId, workspaceId, String(projectId));
      }
      if (!meta) {
        meta = db.createProject(userId, workspaceId, {
          name: String(projectId),
          description: 'auto-created by Brain',
          active: true,
          actionDir: '.',
        });
      } else if (!meta.active && typeof db.setProjectActive === 'function') {
        meta = db.setProjectActive(userId, workspaceId, meta.id, true) || meta;
      }
    } catch (e) {
      const msg = String(e?.message || e || '');
      if (/UNIQUE constraint failed/i.test(msg)) {
        try {
          meta = typeof db.getProjectByName === 'function'
            ? db.getProjectByName(userId, workspaceId, String(projectId))
            : meta;
        } catch {}
      } else {
        console.warn('[brain] createSession project sync failed:', msg);
      }
    }
    this.projects.set(projectId, { userId, meta: meta || { name: String(projectId) } });
    return sid;
  }

  async ingestInput({ sessionId, text, env = {} }) {
    const sess = this.sessions.get(sessionId);
    if (!sess) throw new Error('invalid_session');
    const { messages, schema } = this._buildPromptChain({ text, env });
    let out;
    try {
      out = await this.llm.chat({ messages, temperature: 0.2, maxTokens: 1024, timeoutMs: 20000 });
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
    const routed = this._decideAndRoute({ session: sess, content: out.content || '' });
    return { ok: true, routed, schema };
  }

  _buildPromptChain({ text, env }) {
    const system = [
      'You are Brain, an orchestrator that analyzes user input and produces:',
      '- intent: concise label',
      '- goals: bullet list',
      '- plan: short numbered outline',
      '- steps: JSON array of actionable agent tasks',
      'Rules:',
      '- When user interaction is required instead of execution, wrap the exact user-facing text in <INTERACT>...</INTERACT>.',
      '- Otherwise, produce steps for autonomous agents with fields: id, title, input, expected, kind.',
      '- Keep outputs compact and precise.',
    ].join('\n');
    const user = [
      `Env: ${JSON.stringify(env)}`,
      `Input: ${text}`,
      'Output JSON strictly:',
      '{ "intent": string, "goals": [string], "plan": [string], "steps": [{"title":string,"input":string,"kind":"agent","expected":string}] }',
      'If interaction is necessary now, output ONLY <INTERACT>text</INTERACT> and no JSON.',
    ].join('\n');
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    return { messages, schema: 'intent/goals/plan/steps or <INTERACT>...' };
  }

  _decideAndRoute({ session, content }) {
    const interact = this._extractInteract(content);
    if (interact) return { mode: 'interact', text: interact };
    const parsed = this._tryParseJSON(content);
    if (!parsed) return { mode: 'unknown', raw: content };
    const { intent, goals, plan, steps } = parsed;
    const spawned = [];
    for (const s of Array.isArray(steps) ? steps : []) {
      const a = this._spawnAgent({ projectId: session.projectId, goal: s.title, input: s.input, expected: s.expected });
      spawned.push(a);
    }
    return { mode: 'execute', intent, goals, plan, agents: spawned };
  }

  _extractInteract(text) {
    const m = String(text || '').match(/<INTERACT>([\s\S]*?)<\/INTERACT>/i);
    return m ? m[1].trim() : null;
  }
  _tryParseJSON(text) {
    try { return JSON.parse(String(text || '')); } catch { return null; }
  }

  _spawnAgent({ projectId, goal, input, expected }) {
    const id = `a_${this._agentSeq++}`;
    const agent = {
      id,
      projectId,
      goal: String(goal || ''),
      input: String(input || ''),
      expected: String(expected || ''),
      status: 'pending',
      lastCheckIn: new Date().toISOString(),
    };
    this.agents.set(id, agent);
    return agent;
  }

  checkIn(agentId, status = 'running', meta = {}) {
    const a = this.agents.get(agentId);
    if (!a) return false;
    a.status = status;
    a.lastCheckIn = new Date().toISOString();
    if (meta && typeof meta === 'object') {
      if (typeof meta.eotsDelta === 'number') {
        a.eots = (typeof a.eots === 'number' ? a.eots : 0) + Math.max(0, meta.eotsDelta);
      }
      if (typeof meta.note === 'string' && meta.note) {
        a.lastNote = meta.note;
      }
    }
    return true;
  }
}

export default Brain;
