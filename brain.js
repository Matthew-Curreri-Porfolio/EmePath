// Brain: lightweight orchestrator for intent → goals → plan → agent steps
// Uses the gateway (LoRA server) as the LLM backend and stores cross-references
// to DB ids for projects (previously called workspaces).

import { log as gwLog } from './gateway/utils.js';
import { getConfig } from './gateway/config/index.js';
import db from './gateway/db/db.js';

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
        return mod.chat({ messages, temperature, maxTokens, timeoutMs });
      },
    };
  }

  createSession({ userId, projectId }) {
    const sid = `s_${this._sessionSeq++}`;
    this.sessions.set(sid, { userId, projectId });
    // ensure project exists in DB; alias legacy workspace to project
    try {
      const p = db.createProject(userId, projectId, {
        name: String(projectId),
        description: 'auto-created by Brain',
        active: 1,
      });
      this.projects.set(projectId, { userId, meta: p });
    } catch (e) {
      // ignore unique conflicts
      this.projects.set(projectId, { userId, meta: { name: String(projectId) } });
    }
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

  checkIn(agentId, status = 'running') {
    const a = this.agents.get(agentId);
    if (!a) return false;
    a.status = status;
    a.lastCheckIn = new Date().toISOString();
    return true;
  }
}

export default Brain;
