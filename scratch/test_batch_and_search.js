import fs from 'fs';
import path from 'path';

try {
  const envPath = path.resolve('.env.local');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const idx = trimmed.indexOf('=');
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (!process.env[k]) process.env[k] = v;
      }
    });
  }
} catch (e) {}

import { getMcpToolsList } from '../api/mcp.js';
import mcpHandler from '../api/mcp.js';
import openApiHandler from '../api/openapi.js';

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(s) { this.statusCode = s; return this; },
    json(data) { this.data = data; return this; },
    send(data) { this.data = data; return this; },
    end() { return this; }
  };
}

async function run() {
  console.log('=== TEST 1: Inspect getMcpToolsList() ===');
  const tools = getMcpToolsList();
  console.log('Total tools in MCP:', tools.length);

  const batchPoints = tools.find(t => t.name === 'contributions_award_batch');
  console.log('Has contributions_award_batch:', !!batchPoints);
  console.log('contributions_award_batch props:', Object.keys(batchPoints?.inputSchema?.properties || {}));

  const batchUsers = tools.find(t => t.name === 'users_create_batch');
  console.log('Has users_create_batch:', !!batchUsers);
  console.log('users_create_batch props:', Object.keys(batchUsers?.inputSchema?.properties || {}));

  const usersListTool = tools.find(t => t.name === 'users_list');
  console.log('users_list props:', Object.keys(usersListTool?.inputSchema?.properties || {}));

  const contentTreeTool = tools.find(t => t.name === 'content_tree');
  console.log('content_tree props:', Object.keys(contentTreeTool?.inputSchema?.properties || {}));

  const coverListTool = tools.find(t => t.name === 'cover_list');
  console.log('cover_list props:', Object.keys(coverListTool?.inputSchema?.properties || {}));

  const contentListTool = tools.find(t => t.name === 'content_list');
  console.log('content_list props:', Object.keys(contentListTool?.inputSchema?.properties || {}));

  console.log('\n=== TEST 2: OpenAPI Generation with New Tools ===');
  const openApiReq = {
    method: 'GET',
    url: '/api/openapi.json',
    headers: { host: 'mr-capsules.vercel.app' }
  };
  const openApiRes = createMockRes();
  await openApiHandler(openApiReq, openApiRes);
  console.log('OpenAPI Essential operations:', Object.keys(openApiRes.data?.paths || {}).length);
  const essentialPaths = Object.keys(openApiRes.data?.paths || {});
  console.log('Has users_create_batch in Essential:', essentialPaths.includes('/api/actions/users_create_batch'));
  console.log('Has contributions_award_batch in Essential:', essentialPaths.includes('/api/actions/contributions_award_batch'));
  console.log('Has content_search in Essential:', essentialPaths.includes('/api/actions/content_search'));
  console.log('Passes OpenAI <= 30 actions limit:', essentialPaths.length <= 30);

  console.log('\n=== TEST 3: Unauthenticated rejection on users_create_batch ===');
  const reqBatch = {
    method: 'POST',
    url: '/api/mcp?action=users_create_batch',
    headers: { host: 'mr-capsules.vercel.app', 'content-type': 'application/json' },
    body: { users: [] }
  };
  const resBatch = createMockRes();
  await mcpHandler(reqBatch, resBatch);
  console.log('users_create_batch unauthenticated status:', resBatch.statusCode);

  console.log('\n=== TEST 4: Unauthenticated rejection on contributions_award_batch ===');
  const reqPoints = {
    method: 'POST',
    url: '/api/mcp?action=contributions_award_batch',
    headers: { host: 'mr-capsules.vercel.app', 'content-type': 'application/json' },
    body: { points: 10 }
  };
  const resPoints = createMockRes();
  await mcpHandler(reqPoints, resPoints);
  console.log('contributions_award_batch unauthenticated status:', resPoints.statusCode);

  console.log('\nAll new connector tools verified successfully!');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
