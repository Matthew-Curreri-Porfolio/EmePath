import express from "express"; import cors from "cors"; import fetch from "node-fetch";
import { randomUUID } from "crypto"; import fs from "fs"; import path from "path";
import { fileURLToPath } from "url"; import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "logs"); fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = process.env.LOG_FILE || path.join(LOG_DIR, "gateway.log");

const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const MODEL  = process.env.MODEL || "qwen2.5-coder:7b-instruct";
const MOCK   = process.env.MOCK === "1";
const TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 20000);
const VERBOSE = process.env.VERBOSE === "1";
const LOG_BODY = process.env.LOG_BODY === "1";

const app = express(); app.use(cors()); app.use(express.json({ limit: "4mb" }));
const stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
const log = (e)=>{ const line = JSON.stringify({ ts:new Date().toISOString(), ...e }); console.log(line); try{stream.write(line+"\n");}catch{} };

// parse timeout override coming from the client
const getTimeoutMs = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : TIMEOUT_MS;
};

app.get("/health", (_req,res)=>res.json({ ok:true, mock:MOCK, model:MODEL, ollama:OLLAMA, timeoutMs:TIMEOUT_MS, pid:process.pid }));

// === COMPLETIONS (kept, for reference/testing) ===
app.post("/complete", async (req, res) => {
  const id = randomUUID(); const t0 = performance.now();
  const language = req.body?.language; const prefix = String(req.body?.prefix ?? ""); const suffix = String(req.body?.suffix ?? ""); const file = req.body?.path;
  const prompt = `You are a code completion engine.\nLanguage:${language}\n<<<PREFIX>>>${prefix}\n<<<SUFFIX>>>${suffix}\nContinue between the markers with valid code only.`;
  log({ id, event:"request_in", type:"complete", language, file, model:MODEL, prefixLen:prefix.length, suffixLen:suffix.length, promptLen:prompt.length, mock:MOCK });
  if (VERBOSE && LOG_BODY) log({ id, event:"request_body_samples", prefixSample:prefix.slice(-120), suffixSample:suffix.slice(0,120) });
  if (MOCK){ const text="// codexz: mock completion\n"; log({ id, event:"response_out", type:"complete", mock:true, bytes:text.length, latencyMs:Math.round(performance.now()-t0) }); return res.type("text/plain").send(text); }

  const timeoutMs = getTimeoutMs(req.body?.timeoutMs);
  const controller = new AbortController(); const to = setTimeout(()=>controller.abort(), timeoutMs);

  const body = {
    model: MODEL,
    prompt,
    stream: false,
    keep_alive: req.body?.keepAlive || "30m",
    options: { temperature: 0.2 }
  };
  log({ id, event:"upstream_request", type:"complete", url:`${OLLAMA}/api/generate`, timeoutMs, bodySize:JSON.stringify(body).length });

  try{
    const t1=performance.now();
    const r = await fetch(`${OLLAMA}/api/generate`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body), signal:controller.signal });
    const t2=performance.now(); const status=r.status; const raw=await r.text().catch(()=> ""); let json=null; try{ json=JSON.parse(raw) }catch{}
    const resp = String(json?.response ?? raw ?? ""); const latencyUp=Math.round(t2-t1); const latencyAll=Math.round(performance.now()-t0);
    log({ id, event:"upstream_response", type:"complete", status, latencyUpstreamMs:latencyUp, bytes:resp.length, eval_count:json?.eval_count, eval_duration:json?.eval_duration, prompt_eval_count:json?.prompt_eval_count, prompt_eval_duration:json?.prompt_eval_duration, load_duration:json?.load_duration });
    if(!r.ok){ log({ id, event:"error", where:"upstream_not_ok", type:"complete", status, preview:raw.slice(0,200) }); return res.status(502).json({ error:"upstream error" }); }
    log({ id, event:"response_out", type:"complete", latencyMs:latencyAll, outBytes:resp.length, preview:resp.slice(0,200) });
    return res.type("text/plain").send(resp);
  }catch(e){
    const latencyAll=Math.round(performance.now()-t0); const reason = e?.name==="AbortError"?"timeout":(e?.message||"error");
    log({ id, event:"error", where:"fetch", type:"complete", reason, latencyMs:latencyAll }); return res.status(504).json({ error:"timeout/error" });
  }finally{ clearTimeout(to); }
});

// === CHAT ===
app.post("/chat", async (req, res) => {
  const id = randomUUID(); const t0 = performance.now();
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const model = req.body?.model || MODEL;
  log({ id, event:"request_in", type:"chat", model, messagesCount: messages.length, mock:MOCK });
  if (VERBOSE && LOG_BODY) log({ id, event:"chat_preview", messages: messages.slice(-2) });

  if (MOCK) { const text = "Mock reply. (Enable Ollama to chat.)"; log({ id, event:"response_out", type:"chat", mock:true, bytes:text.length }); return res.json({ message: { role:"assistant", content: text } }); }

  const timeoutMs = getTimeoutMs(req.body?.timeoutMs);
  const controller = new AbortController(); const to = setTimeout(()=>controller.abort(), timeoutMs);

  const body = {
    model,
    messages,
    stream: false,
    keep_alive: req.body?.keepAlive || "30m",
    options: { temperature: 0.2 }
  };
  log({ id, event:"upstream_request", type:"chat", url:`${OLLAMA}/api/chat`, timeoutMs, bodySize:JSON.stringify(body).length });

  try{
    const t1=performance.now();
    const r = await fetch(`${OLLAMA}/api/chat`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body), signal: controller.signal });
    const t2=performance.now(); const status=r.status; const raw=await r.text().catch(()=> ""); let json=null; try{ json=JSON.parse(raw) }catch{}
    const assistant = json?.message?.content ?? ""; const latencyUp=Math.round(t2-t1); const latencyAll=Math.round(performance.now()-t0);
    log({ id, event:"upstream_response", type:"chat", status, latencyUpstreamMs:latencyUp, bytes:assistant.length, eval_count:json?.eval_count, eval_duration:json?.eval_duration, prompt_eval_count:json?.prompt_eval_count, prompt_eval_duration:json?.prompt_eval_duration, load_duration:json?.load_duration });
    if(!r.ok){ log({ id, event:"error", where:"upstream_not_ok", type:"chat", status, preview:raw.slice(0,200) }); return res.status(502).json({ error:"upstream error", status }); }
    log({ id, event:"response_out", type:"chat", latencyMs:latencyAll, outBytes:assistant.length, preview:String(assistant).slice(0,200) });
    return res.json({ message: { role:"assistant", content: assistant } });
  }catch(e){
    const latencyAll=Math.round(performance.now()-t0); const reason = e?.name==="AbortError"?"timeout":(e?.message||"error");
    log({ id, event:"error", where:"fetch", type:"chat", reason, latencyMs:latencyAll });
    return res.status(504).json({ error:"timeout/error" });
  }finally{ clearTimeout(to); }
});

// === MODELS LIST ===
app.get("/models", async (_req, res) => {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { headers: { "Content-Type": "application/json" } });
    if (!r.ok) throw new Error(await r.text().catch(() => r.statusText));
    const data = await r.json();
    const names = (data.models ?? data ?? [])
      .map((m) => m.name || m.model)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    res.json({ models: names });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// === WARMUP (load model into RAM) ===
app.post("/warmup", async (req, res) => {
  const id = randomUUID(); const t0 = performance.now();
  const model = req.body?.model || MODEL;
  const keepAlive = req.body?.keepAlive || "2h";
  const timeoutMs = getTimeoutMs(req.body?.timeoutMs);

  log({ id, event:"request_in", type:"warmup", model, keepAlive, timeoutMs });
  if (MOCK) return res.json({ ok: true, mock: true, model });

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: " ", // minimal token to trigger load
        stream: false,
        keep_alive: keepAlive,
        options: { temperature: 0.0 }
      }),
      signal: controller.signal
    });

    const raw = await r.text().catch(() => "");
    const json = (() => { try { return JSON.parse(raw); } catch { return null; } })();
    const loadMs = Math.round(performance.now() - t0);

    log({ id, event:"warmup_done", status: r.status, load_duration: json?.load_duration, latencyMs: loadMs });

    if (!r.ok) return res.status(502).json({ ok: false, status: r.status, error: raw.slice(0, 200) });
    return res.json({ ok: true, model, loadMs, load_duration: json?.load_duration });
  } catch (e) {
    const loadMs = Math.round(performance.now() - t0);
    log({ id, event:"error", where:"warmup", reason: e?.message || String(e), latencyMs: loadMs });
    return res.status(504).json({ ok: false, error: "timeout/error", loadMs });
  } finally {
    clearTimeout(to);
  }
});
// ===== In-memory repo index =====
let REPO_INDEX = { root: null, files: [] };

// tiny helpers
const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",".git",".vscode",".venv",".idea",".cache","dist","build","coverage","logs",".next",".turbo"
]);
const DEFAULT_IGNORE_PATH_FRAGMENTS = [
  path.sep + "extension" + path.sep + "dist" + path.sep,
  path.sep + "gateway"   + path.sep + "logs" + path.sep
];
const DEFAULT_IGNORE_FILE_REGEX = [
  /\.(lock|min\.js|map)$/i,
  /\.(png|jpg|jpeg|gif|webp|svg|pdf|zip|tar|gz|7z|rar)$/i
];

const isIgnoredDir = (name) => DEFAULT_IGNORE_DIRS.has(name);
const isIgnoredPath = (abs, rel) =>
  DEFAULT_IGNORE_PATH_FRAGMENTS.some(f => abs.includes(f)) ||
  rel.split(path.sep).some(seg => isIgnoredDir(seg));

const isIgnoredFile = (rel) => DEFAULT_IGNORE_FILE_REGEX.some(rx => rx.test(rel));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function scanDirectory(root, maxFileSize = 262144 /* 256 KB */) {
  const files = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs);
      if (ent.isDirectory()) {
        if (isIgnoredDir(ent.name) || isIgnoredPath(abs, rel)) continue;
        walk(abs);
      } else if (ent.isFile()) {
        if (isIgnoredPath(abs, rel) || isIgnoredFile(rel)) continue;
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (st.size > maxFileSize) continue;
        let text; try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
        files.push({ path: rel, text });
      }
    }
  }
  walk(root);
  return files;
}

function makeSnippets(text, terms, maxSnippets = 3, windowLines = 6) {
  const lines = text.split(/\r?\n/);
  const joined = lines.join("\n");
  const snippets = [];
  const re = new RegExp("\\b(" + terms.map(escapeRe).join("|") + ")\\b", "gi");
  let m;
  const seen = new Set();
  while ((m = re.exec(joined)) && snippets.length < maxSnippets) {
    // map index back to line
    let idx = m.index;
    let acc = 0, line = 0;
    for (; line < lines.length; line++) {
      const len = lines[line].length + 1; // + newline
      if (acc + len > idx) break;
      acc += len;
    }
    const start = Math.max(0, line - windowLines);
    const end   = Math.min(lines.length - 1, line + windowLines);
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const slice = lines.slice(start, end + 1).join("\n");
    snippets.push({ lineStart: start + 1, lineEnd: end + 1, text: slice });
  }
  return snippets;
}

// === Scan the workspace into memory ===
app.post("/scan", async (req, res) => {
  const root = req.body?.root;
  const maxFileSize = Math.min(Number(req.body?.maxFileSize) || 262144, 2 * 1024 * 1024);
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return res.status(400).json({ ok: false, error: "valid 'root' directory required" });
  }
  const t0 = performance.now();
  const files = scanDirectory(root, maxFileSize);
  REPO_INDEX = { root, files };
  log({ event:"scan_done", root, count: files.length, ms: Math.round(performance.now() - t0) });
  return res.json({ ok: true, root, count: files.length });
});

// === Query the indexed repo for relevant snippets ===
app.post("/query", async (req, res) => {
  const q = String(req.body?.q || "").trim();
  const k = Math.min(Number(req.body?.k) || 8, 20);
  if (!REPO_INDEX.root || REPO_INDEX.files.length === 0) {
    return res.status(400).json({ ok: false, error: "index is empty; call /scan first" });
  }
  if (!q) return res.status(400).json({ ok: false, error: "query 'q' required" });

  const terms = q.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  const scored = [];
  for (const f of REPO_INDEX.files) {
    let score = 0;
    for (const t of terms) {
      const rx = new RegExp("\\b" + escapeRe(t) + "\\b", "gi");
      const matches = f.text.match(rx);
      if (matches) score += matches.length;
    }
    if (score > 0) scored.push({ f, score });
  }
  scored.sort((a,b) => b.score - a.score);

  const hits = scored.slice(0, k).map(({ f, score }) => ({
    path: f.path,
    score,
    snippets: makeSnippets(f.text, terms)
  }));

  return res.json({ ok: true, root: REPO_INDEX.root, hits });
});

app.listen(3030, ()=>log({ event:"boot", msg:"gateway listening", url:"http://127.0.0.1:3030" }));
