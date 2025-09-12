#!/usr/bin/env bash
set -euo pipefail

FILE="gateway/db/db.js"
BACKUP="${FILE}.bak.$(date +%s)"

[ -f "$FILE" ] || { echo "ERR: $FILE not found. Run from repo root."; exit 1; }

echo "[*] Backing up -> $BACKUP"
cp -f "$FILE" "$BACKUP"

# Patch db.js to resolve migrations dir relative to this file (ESM-safe)
node - <<'NODE'
const fs = require('fs');
const path = require('path');

const file = 'gateway/db/db.js';
let s = fs.readFileSync(file, 'utf8');

const ensureImport = (code, what, from) => {
  const re = new RegExp(`^\\s*import\\s+[^;]*\\b${what}\\b[^;]*from\\s+["']${from}["']`, 'm');
  if (!re.test(code)) {
    // insert after the first import
    code = code.replace(/(^\s*import[\s\S]*?;)(\s*)/, (m, a, b) => `${a}\nimport ${what} from "${from}";${b}`);
  }
  return code;
};

const ensureNamedImport = (code, names, from) => {
  const re = new RegExp(`^\\s*import\\s+\\{[^}]*\\b${names[0]}\\b[^}]*\\}\\s*from\\s+["']${from}["']`, 'm');
  if (!re.test(code)) {
    // add a new named import line (safe duplicate)
    const line = `import { ${names.join(', ')} } from "${from}";\n`;
    code = code.replace(/(^\s*import[\s\S]*?;)(\s*)/, (m, a, b) => `${a}\n${line}${b}`);
  }
  return code;
};

s = ensureImport(s, 'path', 'path');
s = ensureNamedImport(s, ['fileURLToPath'], 'url');

// Ensure a MIGRATIONS_DIR const exists and is used
const dirConst = `const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "migrations");`;

if (!/MIGRATIONS_DIR/.test(s)) {
  // insert after imports block
  s = s.replace(/(^\s*import[\s\S]*?;)(\s*)/, (m, a, b) => `${a}\n${dirConst}\n${b}`);
}

// Replace any hard-coded or CWD-based migrations paths with MIGRATIONS_DIR
s = s
  .replace(/path\.resolve\(\s*process\.cwd\(\)\s*,\s*['"]gateway\/db\/migrations['"]\s*\)/g, 'MIGRATIONS_DIR')
  .replace(/path\.resolve\(\s*process\.cwd\(\)\s*,\s*['"]db\/migrations['"]\s*\)/g, 'MIGRATIONS_DIR')
  .replace(/['"]gateway\/db\/migrations['"]/g, 'MIGRATIONS_DIR')
  .replace(/['"]db\/migrations['"]/g, 'MIGRATIONS_DIR');

// Also handle fs.readdirSync(...) call targets that include "migrations"
s = s.replace(/fs\.readdirSync\(([^)]*migrations[^)]*)\)/g, 'fs.readdirSync(MIGRATIONS_DIR)');

fs.writeFileSync(file, s, 'utf8');
console.log('[*] Patched', file);
NODE

# Ensure the real migrations dir exists
mkdir -p gateway/db/migrations

echo "[*] Syntax check import of the patched module..."
node -e "import('file://$PWD/gateway/db/db.js').then(()=>console.log('OK: db.js loads')).catch(e=>{console.error('FAIL:', e?.message||e); process.exit(1)})"

echo "[*] Start the gateway:"
echo "npm --prefix gateway run start"

