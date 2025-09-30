/* Test loader for gateway whoogle helper

This script will attempt to:
- require the CommonJS helper at gateway/tools/action/whoogle.js
- dynamically import the ESM helper at gateway/tools/whoogle.js
- call the exported searchWhoogle function with a sample query

Usage:
  node scripts/test-whoogle.js

This repo's package.json may set "type": "module"; to support require() we use createRequire.
*/

import path from 'path';

async function tryImport(p) {
  const abspath = path.resolve(p);
  console.log(`Trying dynamic import() on ${abspath}`);
  try {
    const mod = await import('file://' + abspath);
    console.log('import() loaded. keys:', Object.keys(mod));
    const fn = mod.searchWhoogle || mod.default;
    if (typeof fn === 'function') {
      console.log('Calling searchWhoogle...');
      try {
        const r = await fn('example', { base: 'http://127.0.0.1:5010', num: 3 });
        console.log('result:', JSON.stringify(r, null, 2));
      } catch (e) {
        console.error('search call failed:', e && e.stack ? e.stack : String(e));
      }
    } else {
      console.log('No callable export found in module.');
    }
  } catch (e) {
    console.error('import() failed:', e && e.stack ? e.stack : String(e));
  }
}

(async function main() {
  await tryImport('./gateway/tools/action/whoogle.js');
  console.log('\n---\n');
  await tryImport('./gateway/tools/whoogle.js');
})();
