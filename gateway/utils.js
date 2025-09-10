// gateway/utils.js
// Shared helper functions used by the routes.

import fs from "fs";
import path from "path";
import ignore from "ignore";

export function log(e) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...e });
  console.log(line);
  try {
    const stream = fs.createWriteStream(process.env.LOG_FILE || path.join(__dirname, "logs", "gateway.log"), { flags: "a" });
    stream.write(line + "\n");
  } catch {}
}

export function getTimeoutMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : Number(process.env.GATEWAY_TIMEOUT_MS || 20000);
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function loadGitignore(root) {
  const ig = ignore();
  const gitignorePath = path.join(root, ".gitignore");
  try {
    const data = fs.readFileSync(gitignorePath, "utf8");
    ig.add(data);
  } catch {}
  ig.add(DEFAULT_GITIGNORE);
  return ig;
}

export function scanDirectory(root, maxFileSize = 262144) {
  const files = [];
  const ig = loadGitignore(root);
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs);
      const relPosix = rel.split(path.sep).join("/");
      if (ig.ignores(relPosix)) continue;
      if (ent.isDirectory()) {
        walk(abs);
      } else if (ent.isFile()) {
        let st;
        try {
          st = fs.statSync(abs);
        } catch (_) {
          continue;
        }
        if (st.size > maxFileSize) continue;
        let text;
        try {
          text = fs.readFileSync(abs, "utf8");
        } catch (_) {
          continue;
        }
        files.push({ path: rel, text });
      }
    }
  }
  walk(root);
  return files;
}

export function makeSnippets(text, terms) {
  if (!terms.length) return [];
  const snippets = [];
  const searchRx = new RegExp(`\\b(${terms.map(escapeRe).join('|')})\\b`, 'gi');
  let m;
  while ((m = searchRx.exec(text)) !== null) {
    const start = Math.max(0, m.index - 25);
    const end = Math.min(text.length, m.index + m[0].length + 25);
    const snippet = text.slice(start, end);
    snippets.push(snippet);
  }
  // Dedupe and limit snippets
  return [...new Set(snippets)].slice(0, 5);
}

const DEFAULT_GITIGNORE = `
# Node / tooling artefacts
node_modules/
dist/
build/
coverage/
logs/
*.lock
*.min.js
*.map
*.png
*.jpg
*.jpeg
*.gif
*.webp
*.svg
*.pdf
*.zip
*.tar
*.gz
*.7z
*.rar
`;
