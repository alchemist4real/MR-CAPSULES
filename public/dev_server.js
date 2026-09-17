import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables from .env.local or .env
for (const envFile of ['.env.local', '.env']) {
  const envPath = path.join(__dirname, envFile);
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(parsedUrl.pathname);

  // ── Vercel Route Rewrites for OAuth & MCP ──
  if (pathname === '/authorize' || pathname === '/api/mcp/authorize') {
    pathname = '/api/authorize';
  } else if (pathname === '/token' || pathname === '/api/mcp/token') {
    pathname = '/api/token';
  } else if (pathname === '/register' || pathname === '/api/mcp/register') {
    pathname = '/api/authorize';
    parsedUrl.searchParams.set('action', 'register');
  } else if (pathname === '/.well-known/oauth-authorization-server' || pathname === '/.well-known/openid-configuration') {
    pathname = '/api/authorize';
  } else if (pathname === '/.well-known/ai-plugin.json' || pathname === '/ai-plugin.json' || pathname === '/api/mcp/.well-known/ai-plugin.json') {
    pathname = '/api/openapi';
    parsedUrl.searchParams.set('type', 'plugin');
  } else if (pathname === '/openapi.json' || pathname === '/api/openapi.json') {
    pathname = '/api/openapi';
  } else if (pathname.startsWith('/.well-known/oauth-protected-resource')) {
    pathname = '/api/mcp';
  } else if (pathname.startsWith('/api/actions')) {
    pathname = '/api/mcp';
  } else if (pathname === '/api/upload') {
    pathname = '/api/mcp';
    parsedUrl.searchParams.set('upload', 'true');
  }

  // ── Handle /api routes ──
  if (pathname.startsWith('/api/')) {
    let apiName = pathname.replace('/api/', '').split('?')[0];
    
    // Rewrites from vercel.json
    if (apiName === 'config') {
      apiName = 'env';
      parsedUrl.searchParams.set('type', 'config');
    } else if (apiName === 'uptime') {
      apiName = 'env';
      parsedUrl.searchParams.set('type', 'uptime');
    }

    const apiFile = path.join(__dirname, 'api', `${apiName}.js`);
    if (fs.existsSync(apiFile)) {
      let bodyData = '';
      req.on('data', chunk => { bodyData += chunk; });
      req.on('end', async () => {
        try {
          req.body = bodyData ? JSON.parse(bodyData) : {};
        } catch(e) {
          req.body = bodyData;
        }

        req.query = Object.fromEntries(parsedUrl.searchParams.entries());

        res.status = (code) => {
          res.statusCode = code;
          return res;
        };
        res.json = (data) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(data));
        };
        res.send = (data) => {
          if (typeof data === 'object' && !Buffer.isBuffer(data)) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(data));
          } else {
            if (!res.getHeader('Content-Type')) {
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
            }
            res.end(data);
          }
        };
        res.redirect = (url) => {
          res.writeHead(302, { Location: url });
          res.end();
        };

        try {
          const mod = await import(`file://${apiFile}?t=${Date.now()}`);
          const handler = mod.default || mod;
          await handler(req, res);
        } catch (err) {
          console.error(`API Error in ${apiName}:`, err);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message }));
          }
        }
      });
      return;
    }
  }

  // ── Route rewrites ──
  if (pathname === '/' || pathname === '/index') {
    pathname = '/index.html';
  } else if (pathname === '/app') {
    pathname = '/app.html';
  } else if (pathname === '/admin') {
    pathname = '/admin.html';
  } else if (pathname === '/docs') {
    pathname = '/docs.html';
  } else if (pathname === '/privacy') {
    pathname = '/docs.html';
  }

  // Clean trailing slashes
  let filePath = path.join(__dirname, pathname);

  // If path is directory, look for index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // Try appending .html if not found
  if (!fs.existsSync(filePath) && fs.existsSync(filePath + '.html')) {
    filePath = filePath + '.html';
  }

  // Content & Cover Fallback Handler (for decoupled content repository)
  const isContentOrCover = pathname.startsWith('/content/') || pathname.startsWith('/cover/');
  if ((!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) && isContentOrCover) {
    // 1. Check local sibling directory MR-CAPSULES-CONTENT
    const siblingPath = path.join(__dirname, '..', 'MR-CAPSULES-CONTENT', pathname);
    if (fs.existsSync(siblingPath) && fs.statSync(siblingPath).isFile()) {
      filePath = siblingPath;
    } else {
      // 2. Fallback to remote GitHub Raw CDN or redirect
      const contentRepo = process.env.GITHUB_CONTENT_REPO || 'MR-CAPSULES-CONTENT';
      const owner = process.env.GITHUB_CONTENT_OWNER || process.env.GITHUB_OWNER || 'alchemist4real';
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${contentRepo}/main${pathname}`;
      res.writeHead(302, { 'Location': rawUrl });
      res.end();
      return;
    }
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    
    // Support partial range requests for mp4 videos
    const stat = fs.statSync(filePath);
    const range = req.headers.range;

    if (range && ext === '.mp4') {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      });
      file.pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size });
      fs.createReadStream(filePath).pipe(res);
    }
  } else {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h1>404 Not Found</h1><p>The requested path <code>${pathname}</code> does not exist.</p><p><a href="/">Return to Home</a> | <a href="/app">Go to App</a></p>`);
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  MR-CAPSULES Local Development Server Ready`);
  console.log(`  - Landing Page:  http://localhost:${PORT}`);
  console.log(`  - Study App:     http://localhost:${PORT}/app`);
  console.log(`  - Docs:          http://localhost:${PORT}/docs`);
  console.log(`  - Admin Portal:  http://localhost:${PORT}/admin`);
  console.log(`======================================================\n`);
});
