import { searchSearxng } from './searxng.js';
import { createHash } from 'crypto';

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<\/?b>/g, '')
    .replace(/\r/g, '')
    .replace(/\t/g, '  ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function cleanHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/i, '');
}

function extractTitle(html) {
  const ogt =
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i.exec(
      html
    );
  if (ogt && ogt[1]) return decodeEntities(ogt[1]);
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return t && t[1] ? decodeEntities(t[1]) : '';
}

function fetchTextFromHtml(html) {
  const preBlocks = [];
  const cleaned = cleanHtml(html);
  // <pre><code>...</code></pre>
  const preCodeRe =
    /<pre[^>]*>\s*(?:<code[^>]*>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/gi;
  let m;
  while ((m = preCodeRe.exec(cleaned))) {
    const raw = decodeEntities(m[1].replace(/<[^>]+>/g, '\n'));
    if (raw.trim().length < 16) continue;
    preBlocks.push(raw.trim());
  }
  // Standalone <code> that looks blocky (contains newlines)
  const codeRe = /<code[^>]*>([\s\S]*?)<\/code>/gi;
  while ((m = codeRe.exec(cleaned))) {
    const body = decodeEntities(m[1].replace(/<[^>]+>/g, '\n'));
    if (body.split('\n').length >= 3 && body.trim().length >= 16)
      preBlocks.push(body.trim());
  }
  // Fenced code blocks in text
  const fenceRe = /```([a-z0-9+#.\-]*)\n([\s\S]*?)\n```/gi;
  while ((m = fenceRe.exec(cleaned))) {
    const body = decodeEntities(m[2]);
    if (body.split('\n').length >= 3 && body.trim().length >= 16)
      preBlocks.push(body.trim());
  }
  return preBlocks;
}

function guessLang(code, hint = '') {
  const head = (
    code.split('\n').slice(0, 10).join('\n') +
    '\n' +
    hint
  ).toLowerCase();
  if (/^\s*<html|<div|<span|<script|<head|<body/i.test(code)) return 'html';
  if (
    /\bclass\s+\w+\s*\{/i.test(code) &&
    /public\s+static\s+void\s+main/.test(code)
  )
    return 'java';
  if (/^\s*#include\b|\bint\s+main\s*\(/.test(code)) return 'c';
  if (/^\s*fn\s+main\s*\(\)/.test(code) || /\bextern\s+crate\b/.test(head))
    return 'rust';
  if (/package\s+main|func\s+main\(\)/.test(head)) return 'go';
  if (/using\s+System;|Console\.WriteLine/.test(head)) return 'csharp';
  if (
    /def\s+\w+\s*\(|import\s+\w+|print\s*\(/.test(head) &&
    !/console\.log/.test(head)
  )
    return 'python';
  if (/(?:const|let|var)\s+\w+\s*=|function\s+\w+\s*\(|=>\s*\{/.test(head))
    return 'javascript';
  if (/console\.log\(|document\./.test(head)) return 'javascript';
  if (/SELECT\s+.+\s+FROM\s+/i.test(code)) return 'sql';
  if (
    /^\s*#!\/(bin\/bash|usr\/bin\/env\s+bash)/.test(code) ||
    /\bcurl\s+https?:\/\//.test(head)
  )
    return 'bash';
  return '';
}

async function fetchPage(url, { timeoutMs = 8000, signal } = {}) {
  const controller = !signal ? AbortSignal.timeout(timeoutMs) : signal;
  const res = await fetch(url, {
    redirect: 'follow',
    signal: controller,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = res.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml\+xml/i.test(ctype))
    throw new Error(`unsupported_content ${ctype}`);
  return await res.text();
}

function hashSnippet(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function normalizeSnippet(s) {
  return s
    .trim()
    .replace(/\s+$/gm, '')
    .replace(/[ \t]+/g, ' ');
}

async function codeScout(
  query,
  {
    base,
    num = 8,
    fetchNum = 6,
    minLines = 3,
    maxSnippets = 20,
    site,
    lang,
    fresh,
    timeoutMs = 8000,
    signal,
  } = {}
) {
  const sr = await searchSearxng(query, {
    base,
    num,
    site,
    fresh,
    safe: false,
    lang: 'en',
    signal,
  });
  if (!sr || !sr.ok)
    return { ok: false, error: (sr && sr.error) || 'search_failed' };
  const results = Array.isArray(sr.results) ? sr.results : [];
  if (!results.length) return { ok: false, error: 'no_results' };

  const picked = results.slice(0, fetchNum);
  const snippets = [];
  const seen = new Set();

  for (let i = 0; i < picked.length && snippets.length < maxSnippets; i++) {
    const r = picked[i];
    let html;
    try {
      html = await fetchPage(r.url, { timeoutMs, signal });
    } catch (e) {
      continue;
    }
    const codeBlocks = fetchTextFromHtml(html);
    const title = extractTitle(html) || r.title || '';
    for (const block of codeBlocks) {
      const lines = block.split('\n').length;
      if (lines < minLines) continue;
      const norm = normalizeSnippet(block);
      const id = hashSnippet(norm);
      if (seen.has(id)) continue;
      const g = guessLang(norm, title + '\n' + r.url);
      if (lang && g && g !== lang) continue;
      seen.add(id);
      snippets.push({
        id,
        lang: g || null,
        lines,
        url: r.url,
        title,
        snippet: norm,
      });
      if (snippets.length >= maxSnippets) break;
    }
  }

  if (!snippets.length) return { ok: false, error: 'no_snippets' };
  return { ok: true, query, snippets };
}

export { codeScout };
