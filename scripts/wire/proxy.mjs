// Logging proxy for the E0/E1 wire measurement. Saves request bodies and usage, never headers; bodies stay in the scratchpad.
import http from 'node:http';
import https from 'node:https';
import { writeFileSync, mkdirSync } from 'node:fs';

const dir = process.argv[2];
const port = Number(process.argv[3] ?? 8765);
mkdirSync(dir, { recursive: true });
let seq = 0;
let lastHeaders = null; // in memory only, for /__count

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.url === '/__count') {
      const up = https.request({ host: 'api.anthropic.com', path: '/v1/messages/count_tokens?beta=true', method: 'POST', headers: { ...lastHeaders, host: 'api.anthropic.com', 'content-length': body.length } }, (r) => {
        res.writeHead(r.statusCode, { 'content-type': 'application/json' });
        r.pipe(res);
      });
      up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
      up.end(body);
      return;
    }
    const isMessages = req.method === 'POST' && req.url.startsWith('/v1/messages') && !req.url.includes('count_tokens');
    const id = String(++seq).padStart(4, '0');
    if (isMessages) writeFileSync(`${dir}/${id}.req.json`, body);
    const headers = { ...req.headers, host: 'api.anthropic.com' };
    delete headers['accept-encoding'];
    if (isMessages) lastHeaders = headers;
    const up = https.request({ host: 'api.anthropic.com', path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      let head = '';
      r.on('data', (c) => {
        if (isMessages && head.length < 4000) head += c.toString();
        res.write(c);
      });
      r.on('end', () => {
        if (isMessages) {
          writeFileSync(`${dir}/${id}.res.json`, JSON.stringify({ status: r.statusCode, head: head.slice(0, 1500) }));
        }
        res.end();
      });
    });
    up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    up.end(body);
  });
}).listen(port, '127.0.0.1');
