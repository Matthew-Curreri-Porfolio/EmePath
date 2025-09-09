import fg from "fast-glob"; import fs from "fs/promises"; import path from "path";
const root = process.argv[2] || process.cwd();
const files = await fg(["**/*.{ts,tsx,js,py,go,java,rs,cpp,cs}", "!**/node_modules/**"], { cwd: root });
const docs = await Promise.all(files.map(async f => ({ path: f, text: await fs.readFile(path.join(root,f), "utf8") })));
console.log(JSON.stringify({ root, count: docs.length }, null, 2));
