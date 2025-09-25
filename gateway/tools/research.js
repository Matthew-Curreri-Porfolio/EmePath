import { searchSearxng } from "./searxng.js";

function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<\/?b>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html) {
  return decodeEntities(String(html || "").replace(/<[^>]+>/g, " "));
}

function cleanHtml(html) {
  // Drop scripts/styles/noscript/comments and head to reduce noise
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<head[\s\S]*?<\/head>/i, "");
}

function extractTitle(html) {
  const ogt = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i.exec(html);
  if (ogt && ogt[1]) return decodeEntities(ogt[1]);
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t && t[1]) return stripTags(t[1]);
  return "";
}

function extractDescription(html) {
  const ogd = /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i.exec(html);
  if (ogd && ogd[1]) return decodeEntities(ogd[1]);
  const md = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i.exec(html);
  if (md && md[1]) return decodeEntities(md[1]);
  return "";
}

function extractHeadings(html, limit = 12) {
  const out = [];
  const re = /<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    out.push({ tag: m[1].toLowerCase(), text: stripTags(m[2]) });
  }
  return out;
}

function guessMainBlock(html) {
  // Prefer <article>, then <main>, else return body
  const art = /<article[\s\S]*?<\/article>/i.exec(html);
  if (art) return art[0];
  const main = /<main[\s\S]*?<\/main>/i.exec(html);
  if (main) return main[0];
  const body = /<body[\s\S]*?<\/body>/i.exec(html);
  return body ? body[0] : html;
}

async function fetchPage(url, { timeoutMs = 8000, maxChars = 200_000, signal } = {}) {
  const controller = !signal ? AbortSignal.timeout(timeoutMs) : signal;
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: controller,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = res.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml\+xml/i.test(ctype)) throw new Error(`unsupported_content ${ctype}`);
  const html = (await res.text()).slice(0, maxChars);
  return html;
}

function summarizeText(txt, maxChars = 2000) {
  const t = String(txt || "").trim();
  if (t.length <= maxChars) return t;
  // Truncate at nearest sentence boundary
  const clip = t.slice(0, maxChars);
  const last = Math.max(clip.lastIndexOf(". "), clip.lastIndexOf("\n"), clip.lastIndexOf("! "), clip.lastIndexOf("? "));
  return clip.slice(0, last > 200 ? last + 1 : maxChars);
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  let active = 0;
  return await new Promise((resolve) => {
    const kick = () => {
      if (i >= items.length && active === 0) return resolve(results);
      while (active < limit && i < items.length) {
        const idx = i++;
        active++;
        Promise.resolve()
          .then(() => fn(items[idx], idx))
          .then((r) => (results[idx] = r))
          .catch((e) => (results[idx] = { error: String(e && e.message || e) }))
          .finally(() => {
            active--;
            kick();
          });
      }
    };
    kick();
  });
}

async function researchWeb(
  query,
  {
    base,
    num = 5,
    fetchNum = 3,
    concurrency = 3,
    site,
    lang = "en",
    safe = false,
    fresh,
    timeoutMs = 8000,
    maxChars = 40_000,
    signal,
  } = {}
) {
  const sr = await searchSearxng(query, { base, num, site, lang, safe, fresh, signal });
  if (!sr || !sr.ok) return { ok: false, error: (sr && sr.error) || "search_failed" };
  const results = Array.isArray(sr.results) ? sr.results : [];
  if (!results.length) return { ok: false, error: "no_results" };

  // Filter duplicates by host and skip some noisy domains
  const seenHosts = new Set();
  const skipRe = /(youtube\.com|x\.com|twitter\.com|facebook\.com|reddit\.com)/i;
  const crawl = [];
  for (const r of results) {
    try {
      const u = new URL(r.url);
      if (skipRe.test(u.hostname)) continue;
      if (seenHosts.has(u.hostname)) continue;
      seenHosts.add(u.hostname);
      crawl.push(r);
    } catch (e) {
      continue;
    }
    if (crawl.length >= fetchNum) break;
  }

  const pages = await mapLimited(crawl, Math.max(1, concurrency), async (r) => {
    try {
      const html = await fetchPage(r.url, { timeoutMs, signal });
      const safeHtml = cleanHtml(html);
      const title = extractTitle(safeHtml) || r.title || "";
      const description = extractDescription(safeHtml);
      const headings = extractHeadings(safeHtml);
      const main = guessMainBlock(safeHtml);
      const text = stripTags(main);
      const content = summarizeText(text, maxChars);
      const wc = content.split(/\s+/).filter(Boolean).length;
      return { ok: true, title, description, headings, wordCount: wc, content };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  const enriched = crawl.map((r, i) => ({ ...r, page: pages[i] }));
  return { ok: true, query, results: enriched, fetched: enriched.filter(x => x.page && x.page.ok).length };
}

export { researchWeb };
