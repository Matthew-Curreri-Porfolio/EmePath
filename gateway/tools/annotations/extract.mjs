// Dimensional markup extractor (lightweight, rule-based).
// Produces structured training-ready JSON with entities, facts, claims, metrics.

function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z(\d])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function findDates(text) {
  const re =
    /\b(\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}|\d{4})\b/gi;
  const out = new Set();
  for (const m of text.matchAll(re)) out.add(m[0]);
  return [...out];
}

function findNumbers(text) {
  const re =
    /\b(?:[-+]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[-+]?\d*\.\d+|\d+)\b(?:%|\s*(million|billion|k|M|B))?/gi;
  const out = [];
  for (const m of text.matchAll(re)) out.push(m[0]);
  return out.slice(0, 200);
}

function findEntities(text) {
  // Heuristic entity detection (capitalized multi-words, acronyms)
  const ents = new Set();
  const reCapSeq = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g;
  const reAcr = /\b([A-Z]{2,6})\b/g;
  for (const m of text.matchAll(reCapSeq)) ents.add(m[1]);
  for (const m of text.matchAll(reAcr)) ents.add(m[1]);
  return [...ents].filter((s) => s.length >= 2 && s.length <= 64).slice(0, 200);
}

function keyPhrases(sent) {
  // simple noun-ish phrase candidates: sequences of words with numbers or nouns-ish
  const tokens = sent.split(/[^A-Za-z0-9%]+/).filter(Boolean);
  const phrases = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    if (/^[A-Z]/.test(w) || /\d/.test(w)) {
      const p = [w];
      if (i + 1 < tokens.length) p.push(tokens[i + 1]);
      phrases.add(p.join(' '));
    }
  }
  return [...phrases].slice(0, 50);
}

function extractClaims(sentences) {
  const claims = [];
  for (const s of sentences) {
    const conf =
      /\b(we (find|show|demonstrate)|results? (show|suggest)|study (finds|shows)|data (indicates|suggests))\b/i.test(
        s
      )
        ? 0.8
        : 0.5;
    if (s.length > 20) claims.push({ text: s, confidence: conf });
  }
  return claims.slice(0, 200);
}

function findCitations(text) {
  const out = new Set();
  // URLs
  for (const m of text.matchAll(/https?:\/\/[^\s)]+/gi)) out.add(m[0]);
  // DOIs
  for (const m of text.matchAll(/\b10\.\d{4,9}\/[-._;()\/:A-Z0-9]+/gi))
    out.add(`doi:${m[0]}`);
  return [...out].slice(0, 200);
}

function findSections(text) {
  // Simple heuristic: markdown-style or title-like lines become section headers.
  const lines = String(text || '').split(/\n+/);
  const sections = [];
  let current = { title: 'Introduction', start: 0, content: [] };
  const headerRe = /^(#{1,6}\s+.+)|(^[A-Z][A-Za-z0-9\- ,:()]{3,80}$)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (headerRe.test(line)) {
      if (current.content.length)
        sections.push({ ...current, content: current.content.join('\n') });
      const title = line.replace(/^#{1,6}\s+/, '').trim();
      current = { title, start: i, content: [] };
    } else {
      current.content.push(lines[i]);
    }
  }
  if (current.content.length)
    sections.push({ ...current, content: current.content.join('\n') });
  return sections.map((s, idx) => ({
    id: `sec${idx + 1}`,
    title: s.title,
    startLine: s.start,
    body: s.content,
  }));
}

export function extractDimensionalMarkup(
  text,
  { source, title, lang = 'en' } = {}
) {
  const sentences = splitSentences(text);
  const dates = findDates(text);
  const numbers = findNumbers(text);
  const entities = findEntities(text);
  const claims = extractClaims(sentences);
  const citations = findCitations(text);
  const sections = findSections(text);

  // Basic relations: sentence-level co-occurrence pairs for top entities
  const rels = [];
  const entsTop = new Set(entities.slice(0, 25));
  for (const s of sentences.slice(0, 200)) {
    const present = [...entsTop].filter((e) => s.includes(e));
    for (let i = 0; i < Math.min(5, present.length); i++) {
      for (let j = i + 1; j < Math.min(5, present.length); j++) {
        rels.push({ a: present[i], b: present[j], context: s });
      }
    }
  }

  // Facts: sentence -> key phrases and numbers
  const facts = sentences.slice(0, 200).map((s, idx) => ({
    id: `s${idx + 1}`,
    sentence: s,
    phrases: keyPhrases(s),
    numbers: findNumbers(s),
    dates: findDates(s),
  }));

  // Training-ready tasks: Q/A style prompts derived from claims and facts
  const qa = facts.slice(0, 30).map((f) => ({
    prompt: `Extract facts from: ${f.sentence}`,
    completion: JSON.stringify({
      phrases: f.phrases,
      numbers: f.numbers,
      dates: f.dates,
    }),
  }));

  return {
    schema: 'dimensional-markup@v1',
    source: source || null,
    title: title || (sentences[0] || '').slice(0, 80),
    lang,
    meta: {
      length: text?.length || 0,
      sentences: sentences.length,
      extracted_at: new Date().toISOString(),
    },
    entities,
    numbers,
    dates,
    citations,
    sections,
    relations: rels,
    claims,
    facts,
    training: { qa },
  };
}

export default { extractDimensionalMarkup };
