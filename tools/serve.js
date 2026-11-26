#!/usr/bin/env node
// Zero-dependency static server for the lighting experiment window.
//
//   node tools/serve.js            # http://localhost:8080/
//   node tools/serve.js 9000       # custom port
//
// Serves the repo root so ES modules under src/ and the UI under ui/ resolve.
// Path traversal outside the repo is rejected.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const port = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') {
      // Redirect so the UI's relative URLs (./app.js, ./styles.css) resolve
      // under /ui/ rather than at the server root.
      res.writeHead(302, { location: '/ui/' });
      res.end();
      return;
    }
    if (rel === '/ui') {
      res.writeHead(302, { location: '/ui/' });
      res.end();
      return;
    }
    const abs = path.resolve(root, '.' + rel);
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    let target = abs;
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      target = path.join(target, 'index.html');
    }
    if (!fs.existsSync(target)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`not found: ${rel}`);
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(target).pipe(res);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});

server.listen(port, () => {
  console.log(`Multi-strategy lighting window: http://localhost:${port}/`);
  console.log(`(serving ${root}; UI entry is /ui/index.html)`);
});
