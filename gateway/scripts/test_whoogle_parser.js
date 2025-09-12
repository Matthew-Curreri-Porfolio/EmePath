// Offline Whoogle parser test: stubs fetch with synthetic HTML and prints results.
// Usage: node gateway/scripts/test_whoogle_parser.js [MODE]
// MODE: 'fuLhoc' (gbv=1 style) or 'simple' (default)

import { searchWhoogle } from '../tools/whoogle.js';

const mode = process.argv[2] || 'simple';

const htmlSimple = `<!doctype html>
<html><body>
  <div id="s">
    <div class="g">
      <a href="https://example.com/alpha"><h3>Alpha Result</h3></a>
      <div><p>This is the alpha snippet</p></div>
    </div>
    <div class="g">
      <a href="https://example.org/beta"><h3>Beta Result</h3></a>
      <div class="IsZvec">Beta summary text</div>
    </div>
  </div>
</body></html>`;

const htmlFuLhoc = `<!doctype html>
<html><body>
  <div id="s">
    <a class="fuLhoc" href="https://alpha.example.com">Alpha Title</a>
    <a class="fuLhoc" href="https://beta.example.org">Beta Title</a>
  </div>
</body></html>`;

const html = mode === 'fuLhoc' ? htmlFuLhoc : htmlSimple;

global.fetch = async () => ({ ok: true, status: 200, async text() { return html; } });

const out = await searchWhoogle('offline test', { base: 'http://local', num: 5, lang: 'en' });
console.log(JSON.stringify({ mode, out }, null, 2));

