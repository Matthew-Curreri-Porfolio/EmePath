// gateway/usecases/compress.js
import db from '../db/db.js';

const MAX_LONG = 512 * 1024;

function isoSeconds(d=new Date()){
  const t = Math.floor(d.getTime()/1000)*1000;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/,'Z');
}

function ensureAuth(req, res) {
  const userId = req.session && req.session.userId ? req.session.userId : null;
  const workspaceId = req.session && req.session.workspaceId ? req.session.workspaceId : null;
  if (!userId || !workspaceId) { res.status(401).json({ ok:false, error:'unauthorized' }); return null; }
  return { userId, workspaceId };
}

function pickModel(body, defaultModel) {
  if (body && typeof body.model === 'string' && body.model.length > 0) return body.model;
  return defaultModel;
}

async function callOllamaChat(_OLLAMA, model, messages, _keepAlive){
  // Updated: use llama.cpp OpenAI-style server for non-streaming chat
  const base = String(process.env.LLAMACPP_SERVER || '').replace(/\/$/, '');
  if (!base) throw new Error('LLAMACPP_SERVER not set');
  const url = base + '/v1/chat/completions';
  const payload = {
    model: model || 'default',
    messages: (messages || []).map(m => ({ role: m.role || 'user', content: String(m.content ?? '') })),
    temperature: 0.2,
    stream: false,
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error('llama.cpp chat failed: ' + r.status + ' ' + txt);
  }
  const j = await r.json();
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (typeof content !== 'string') throw new Error('llama.cpp chat bad response');
  return content;
}

import { composeSystem } from '../prompts/compose.js';
function loraDistillerSystemPrompt(){
  return composeSystem('compress.lora_distiller');
}

function makeChatHistoryFromMemory(shortItems){
  // Fallback synthesizer if chatHistory not provided
  // Alternate user/assistant lines to form a rough transcript.
  const lines = [];
  let userTurn = true;
  for (const it of shortItems) {
    const role = userTurn ? 'user' : 'assistant';
    const ts = it.updatedAt || it.createdAt || isoSeconds();
    lines.push("[" + role + " " + ts + "] " + it.content);
    userTurn = !userTurn;
  }
  return lines.join("\n");
}

function parseJsonlLines(text){
  const out = [];
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (s.length === 0) continue;
    if (s[0] !== '{') continue;
    try {
      const obj = JSON.parse(s);
      out.push(obj);
    } catch (_e) {
      // skip bad line
    }
  }
  return out;
}

function appendCorpus(userId, jsonlObjs){
  const rec = db.getTraining(userId);
  const baseData = rec && rec.data && typeof rec.data === 'object' ? rec.data : {};
  const baseCorpus = Array.isArray(baseData.corpus) ? baseData.corpus : [];
  const merged = baseCorpus.concat(jsonlObjs);
  const next = {};
  const keys = Object.keys(baseData);
  for (const k of keys) next[k] = baseData[k];
  next.corpus = merged;
  const keepTrainId = rec && rec.trainid ? rec.trainid : null;
  if (keepTrainId) db.setTraining(userId, next, keepTrainId); else db.setTraining(userId, next);
  return merged.length;
}

function sizeUtf8(s){ return Buffer.byteLength(String(s || ''), 'utf8'); }

async function compressShortToLongUseCase(req, res, deps){
  const auth = ensureAuth(req, res); if (!auth) return;
  const { OLLAMA, MODEL, log } = deps;
  const body = req.body || {};
  const ws = auth.workspaceId;

  const shortItems = db.listMemory(auth.userId, ws, 'short');
  let chatHistory = typeof body.chatHistory === 'string' && body.chatHistory.length > 0 ? body.chatHistory : makeChatHistoryFromMemory(shortItems);

  const sys = loraDistillerSystemPrompt();
  const nowIso = isoSeconds();
  const sysMsg = { role: "system", content: sys };
  const userMsg = { role: "user", content: chatHistory };

  const model = pickModel(body, MODEL);
  const keepAlive = typeof body.keepAlive === 'string' ? body.keepAlive : undefined;

  let distill;
  try {
    distill = await callOllamaChat(OLLAMA, model, [sysMsg, userMsg], keepAlive);
  } catch (e) {
    res.status(502).json({ ok:false, error: String(e.message ? e.message : e) });
    return;
  }

  const jsonl = parseJsonlLines(distill);
  const appended = appendCorpus(auth.userId, jsonl);

  // Summarize short items into a compact long entry
  const summaryPrompt = [
    "Summarize the following notes into a compact long-term memory for future retrieval.",
    "Keep facts and key commands; remove redundancy. Output plain text.",
    "Limit to the most useful 1-2 screens of text."
  ].join(" ");
  const sumMsgs = [
    { role: "system", content: summaryPrompt },
    { role: "user", content: shortItems.map(i => "- " + (i.content || "")).join("\n") }
  ];
  let summary = "";
  try {
    summary = await callOllamaChat(OLLAMA, model, sumMsgs, keepAlive);
  } catch (e) {
    summary = ""; // do not fail the whole pipeline
  }

  const memid = "short_compact_" + Date.now().toString(36);
  const record = db.upsertMemory(auth.userId, ws, 'long', memid, summary, 'set');
  const bytes = sizeUtf8(record.content);
  if (bytes > MAX_LONG) {
    // truncate safely if model overshot; keep tail
    const text = String(record.content || "");
    const cut = text.slice(text.length - 64000);
    db.upsertMemory(auth.userId, ws, 'long', memid, cut, 'set');
  }

  if (log) log("compress.shortToLong", { userId: auth.userId, ws, appended, memid });

  res.json({
    ok: true,
    appendedToCorpus: appended,
    longMemid: memid,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  });
}

async function compressLongGlobalUseCase(req, res, deps){
  const auth = ensureAuth(req, res); if (!auth) return;
  const { OLLAMA, MODEL, log } = deps;
  const body = req.body || {};
  const ws = auth.workspaceId;

  const longItems = db.listMemory(auth.userId, ws, 'long');
  const model = pickModel(body, MODEL);
  const keepAlive = typeof body.keepAlive === 'string' ? body.keepAlive : undefined;

  const prompt = [
    "You are compressing a user's long-term memory into an evergreen knowledge base.",
    "Group by topic, deduplicate, keep commands and exact paths/ports, remove stale or repeated lines.",
    "Output a concise markdown knowledge base with headings and bullet points.",
    "Second-precision timestamps are not required inside the text."
  ].join(" ");

  const msgs = [
    { role: "system", content: prompt },
    { role: "user", content: longItems.map(i => "## " + i.memid + "\n" + (i.content || "")).join("\n\n") }
  ];

  let kb = "";
  try {
    kb = await callOllamaChat(OLLAMA, model, msgs, keepAlive);
  } catch (e) {
    res.status(502).json({ ok:false, error: String(e.message ? e.message : e) });
    return;
  }

  const memid = "long_compact_" + Date.now().toString(36);
  const rec = db.upsertMemory(auth.userId, ws, 'long', memid, kb, 'set');

  if (log) log("compress.long", { userId: auth.userId, ws, memid });

  res.json({ ok:true, memid, createdAt: rec.createdAt, updatedAt: rec.updatedAt });
}

export { compressShortToLongUseCase, compressLongGlobalUseCase };
