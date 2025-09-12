// Simple tester for curated search cache
import { searchCurated } from '../tools/curated/search.mjs';

const q = process.argv.slice(2).join(' ') || 'python';
const out = await searchCurated(q, { num: 5 });
console.log(JSON.stringify(out, null, 2));

