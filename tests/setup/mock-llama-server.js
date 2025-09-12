// Minimal mock for llama.cpp server API used by gateway/lib/llm.js
// Starts before tests; sets LLAMACPP_SERVER so routes hit this mock.
import http from 'http';

const server = http.createServer((req, res) => {
  const { method, url } = req;
  let body = '';
  req.on('data', (chunk) => { body += chunk.toString(); });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    // Models listing (POST /v1/models)
    if (method === 'POST' && url === '/v1/models') {
      res.writeHead(200);
      res.end(JSON.stringify({ data: [{ id: 'default' }] }));
      return;
    }
    // Text completion
    if (method === 'POST' && url === '/v1/completions') {
      let prompt = '';
      try { prompt = JSON.parse(body || '{}').prompt || ''; } catch {}
      res.writeHead(200);
      res.end(JSON.stringify({ id: 'cmpl-1', object: 'text_completion', choices: [{ text: `ok:${String(prompt).slice(0,8)}` }] }));
      return;
    }
    // Chat completion
    if (method === 'POST' && url === '/v1/chat/completions') {
      res.writeHead(200);
      res.end(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
process.env.LLAMACPP_SERVER = `http://127.0.0.1:${port}`;

// Ensure we close when the process exits
process.on('exit', () => {
  try { server.close(); } catch {}
});

// Expose for debugging if needed
globalThis.__MOCK_LLAMA_SERVER__ = { port };

