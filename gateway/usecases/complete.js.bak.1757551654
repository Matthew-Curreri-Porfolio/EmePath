// gateway/usecases/complete.js
import crypto from 'crypto';
import { performance } from 'perf_hooks';

export async function completeUseCase(req, res, deps) {
  const {
    log,
    getTimeoutMs,
    OLLAMA,
    MODEL,
    MOCK,
    VERBOSE,
    LOG_BODY,
  } = deps;
  const id = crypto.randomUUID();
  const t0 = performance.now();
  const language = req.body?.language;
  const prefix = String(req.body?.prefix ?? "");
  const suffix = String(req.body?.suffix ?? "");
  const file = req.body?.path;
  const prompt = `You are a code completion engine.\nLanguage:${language}\n<<<PREFIX>>>${prefix}\n<<<SUFFIX>>>${suffix}\nContinue between the markers with valid code only.`;
  log({ id, event: "request_in", type: "complete", language, file, model: MODEL, prefixLen: prefix.length, suffixLen: suffix.length, promptLen: prompt.length, mock: MOCK });
  if (VERBOSE && LOG_BODY)
    log({ id, event: "request_body_samples", prefixSample: prefix.slice(-120), suffixSample: suffix.slice(0, 120) });
  if (MOCK) {
    const text = "// codexz: mock completion\n";
    log({ id, event: "response_out", type: "complete", mock: true, bytes: text.length, latencyMs: Math.round(performance.now() - t0) });
    return res.type("text/plain").send(text);
  }
  const timeoutMs = getTimeoutMs(req.body?.timeoutMs);
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  const body = {
    model: MODEL,
    prompt,
    stream: false,
    keep_alive: req.body?.keepAlive || "30m",
    options: { temperature: 0.2 },
  };
  log({ id, event: "upstream_request", type: "complete", url: `${OLLAMA}/api/generate`, timeoutMs, bodySize: JSON.stringify(body).length });
  try {
    const t1 = performance.now();
    const r = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const t2 = performance.now();
    const status = r.status;
    const raw = await r.text().catch(() => "");
    const json = (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })();
    const resp = String(json?.response ?? raw ?? "");
    const latencyUp = Math.round(t2 - t1);
    const latencyAll = Math.round(performance.now() - t0);
    log({ id, event: "upstream_response", type: "complete", status, latencyUpstreamMs: latencyUp, bytes: resp.length, eval_count: json?.eval_count, eval_duration: json?.eval_duration, prompt_eval_count: json?.prompt_eval_count, prompt_eval_duration: json?.prompt_eval_duration, load_duration: json?.load_duration });
    if (!r.ok) {
      log({ id, event: "error", where: "upstream_not_ok", type: "complete", status, preview: raw.slice(0, 200) });
      return res.status(502).json({ error: "upstream error" });
    }
    log({ id, event: "response_out", type: "complete", latencyMs: latencyAll, outBytes: resp.length, preview: resp.slice(0, 200) });
    return res.type("text/plain").send(resp);
  } catch (e) {
    const latencyAll = Math.round(performance.now() - t0);
    const reason = e?.name === "AbortError" ? "timeout" : (e?.message || "error");
    log({ id, event: "error", where: "fetch", type: "complete", reason, latencyMs: latencyAll });
    return res.status(504).json({ error: "timeout/error" });
  } finally {
    clearTimeout(to);
  }
}
