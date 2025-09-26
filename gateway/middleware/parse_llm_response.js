// Middleware: scan LLM output for an embedded @gateway_usage.json block,
// extract JSON payload for downstream tooling, and clean the user-visible text.

function tryParseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  // Fast path
  try {
    return JSON.parse(text);
  } catch {}
  // Fallback: trim to first '{' and last '}'
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }
  return null;
}

function extractGatewayUsage(raw) {
  if (!raw || typeof raw !== 'string') return { usage: null, cleaned: raw };

  // Patterns to capture a usage JSON block in common LLM formats.
  const patterns = [
    // @gateway_usage.json then fenced json
    /@gateway_usage\.json[ \t]*[\r\n]+```(?:json|JSON)?[ \t]*[\r\n]+([\s\S]*?)```/i,
    // Fence info contains gateway_usage.json
    /```[^\n`]*gateway_usage\.json[^\n`]*\n([\s\S]*?)```/i,
    // Inline after marker
    /@gateway_usage\.json[ \t]*([\s\S]*?)$/i,
  ];

  for (const re of patterns) {
    const m = re.exec(raw);
    if (!m) continue;
    const jsonText = (m[1] || '').trim();
    const parsed = tryParseJsonLoose(jsonText);
    if (parsed && typeof parsed === 'object') {
      // Remove the matched block from the text shown to users
      const cleaned = raw.replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim();
      return { usage: parsed, cleaned };
    }
  }
  return { usage: null, cleaned: raw };
}

export function parseLLMResponse(req, res, next) {
  try {
    const llmResponse = res.locals.llmResponse;
    if (typeof llmResponse !== 'string' || !llmResponse.length) {
      return next(new Error('No LLM response found'));
    }

    const { usage, cleaned } = extractGatewayUsage(llmResponse);
    if (usage) res.locals.gatewayUsage = usage;
    res.locals.llmResponse = cleaned;
    next();
  } catch (error) {
    next(error);
  }
}

export default parseLLMResponse;
