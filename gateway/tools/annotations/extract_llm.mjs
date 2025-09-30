// LLM-assisted dimensional markup via Gateway /chat
// Env: GATEWAY_BASE (e.g., http://localhost:3000), MODEL (optional)

function buildPrompt(text) {
  return (
    `You are an information extraction system. Read the text and output ONLY a JSON object with this schema (no prose):\n\n{
  "schema": "dimensional-markup@v1",
  "title": string,
  "lang": "en",
  "entities": string[],               // key entities and acronyms
  "numbers": string[],                // numeric literals with units if present
  "dates": string[],                  // yyyy, yyyy-mm, yyyy-mm-dd, or natural dates found
  "citations": string[],              // URLs and DOIs in the text; keep as-is (prefix DOIs with doi:)
  "sections": [                       // section headings and bodies
    { "id": string, "title": string, "body": string }
  ],
  "relations": [                      // light co-occurrence relations
    { "a": string, "b": string, "context": string }
  ],
  "claims": [                         // salient claims/assertions with confidence 0-1
    { "text": string, "confidence": number }
  ],
  "facts": [                          // sentence-grained facts with phrases, numbers, dates
    { "id": string, "sentence": string, "phrases": string[], "numbers": string[], "dates": string[] }
  ],
  "training": { "qa": [ { "prompt": string, "completion": any } ] }
}\n\nGuidelines:\n- Be faithful to the text.\n- Extract section headings if present (markdown or obvious titles).\n- Citations: include all URLs and DOIs you find.\n- Keep JSON compact and valid.\n\nTEXT:\n\n` +
    text
  );
}

export async function extractDimensionalMarkupLLM(
  text,
  {
    base = process.env.GATEWAY_BASE || 'http://localhost:3000',
    model = process.env.MODEL,
    temperature = 0.2,
  } = {}
) {
  const body = {
    messages: [
      {
        role: 'system',
        content: 'You convert text into structured JSON facts.',
      },
      { role: 'user', content: buildPrompt(text) },
    ],
    temperature,
    responseFormat: 'json',
    outputContract: `Contract: Strictly output a JSON object with the following keys and types. No extra fields.\n{
  "schema": "dimensional-markup@v1",
  "title": string,
  "lang": "en",
  "entities": string[],
  "numbers": string[],
  "dates": string[],
  "citations": string[],
  "sections": [{ "id": string, "title": string, "body": string }],
  "relations": [{ "a": string, "b": string, "context": string }],
  "claims": [{ "text": string, "confidence": number }],
  "facts": [{ "id": string, "sentence": string, "phrases": string[], "numbers": string[], "dates": string[] }],
  "training": { "qa": [{ "prompt": string, "completion": any }] }
}`,
  };
  if (model) body.model = model;
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`LLM chat failed: ${res.status} ${t}`);
  }
  const json = await res.json();
  // Expect either { ok, messages:[{content}] } or a direct content
  const content =
    json?.messages?.[json.messages.length - 1]?.content || json?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // try to extract JSON block
    const m = content.match(/[\{\[][\s\S]*[\}\]]/);
    if (!m) throw new Error('LLM returned non-JSON content');
    parsed = JSON.parse(m[0]);
  }
  // Ensure required fields
  parsed.schema = parsed.schema || 'dimensional-markup@v1';
  parsed.lang = parsed.lang || 'en';
  parsed.entities = parsed.entities || [];
  parsed.numbers = parsed.numbers || [];
  parsed.dates = parsed.dates || [];
  parsed.citations = parsed.citations || [];
  parsed.sections = parsed.sections || [];
  parsed.relations = parsed.relations || [];
  parsed.claims = parsed.claims || [];
  parsed.facts = parsed.facts || [];
  parsed.training = parsed.training || { qa: [] };
  return parsed;
}

export default { extractDimensionalMarkupLLM };
