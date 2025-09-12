import { searchWhoogle } from './gateway/tools/whoogle.js';
const out = await searchWhoogle('openai', { base: 'https://www.google.com', num: 5, lang: 'en' });
console.log(JSON.stringify(out, null, 2));
