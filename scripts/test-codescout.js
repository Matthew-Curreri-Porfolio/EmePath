/* Test loader for gateway codescout helper

Usage:
  node scripts/test-codescout.js
*/

import path from 'path';

async function tryImport(p) {
  const abspath = path.resolve(p);
  console.log(`Trying dynamic import() on ${abspath}`);
  try {
    const mod = await import('file://' + abspath);
    console.log('import() loaded. keys:', Object.keys(mod));
    const fn = mod.codeScout || mod.default;
    if (typeof fn === 'function') {
      console.log('Calling codeScout...');
      try {
        const r = await fn('node http server example', { base: 'http://127.0.0.1:5010', num: 5, fetchNum: 3, maxSnippets: 8 });
        console.log('result:', JSON.stringify(r, null, 2));
      } catch (e) {
        console.error('codeScout call failed:', e && e.stack ? e.stack : String(e));
      }
    } else {
      console.log('No callable export found in module.');
    }
  } catch (e) {
    console.error('import() failed:', e && e.stack ? e.stack : String(e));
  }
}

(async function main() {
  await tryImport('./gateway/tools/codescout.js');
  console.log('\n---\n');
  await tryImport('./gateway/tools/action/codescout.js');
})();

