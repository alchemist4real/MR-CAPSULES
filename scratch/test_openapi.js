// scratch/test_openapi.js
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

import openApiHandler from '../api/openapi.js';
import mcpHandler from '../api/mcp.js';

class MockResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.body = null;
  }
  status(code) {
    this.statusCode = code;
    return this;
  }
  setHeader(k, v) {
    this.headers[k.toLowerCase()] = v;
  }
  json(data) {
    this.body = data;
    return this;
  }
  send(data) {
    this.body = data;
    return this;
  }
  end() {
    return this;
  }
}

async function runTests() {
  console.log('=== TEST 1: Default Essential OpenAPI 3.0.3 Generation ===');
  const req1 = {
    method: 'GET',
    url: '/api/openapi.json',
    headers: { host: 'mr-capsules.vercel.app', origin: 'https://chatgpt.com' }
  };
  const res1 = new MockResponse();
  await openApiHandler(req1, res1);
  console.log('Status:', res1.statusCode);
  console.log('CORS Allow Origin:', res1.headers['access-control-allow-origin']);
  console.log('OpenAPI Version:', res1.body.openapi);
  console.log('Title:', res1.body.info.title);
  const pathKeys1 = Object.keys(res1.body.paths);
  console.log('Total operations in Essential preset:', pathKeys1.length);
  console.log('Sample operations:', pathKeys1.slice(0, 6));

  if (pathKeys1.length > 30) {
    console.error('FAIL: Essential preset exceeded OpenAI 30-action limit!');
  } else {
    console.log('PASS: Essential preset is safe within OpenAI 30-action limit (' + pathKeys1.length + ' <= 30)');
  }

  console.log('\n=== TEST 2: DoctorTablet Preset ===');
  const req2 = {
    method: 'GET',
    url: '/api/openapi.json?category=doctortablet',
    headers: { host: 'mr-capsules.vercel.app' }
  };
  const res2 = new MockResponse();
  await openApiHandler(req2, res2);
  const pathKeys2 = Object.keys(res2.body.paths);
  console.log('DoctorTablet operations:', pathKeys2);

  console.log('\n=== TEST 3: All Tools Preset ===');
  const req3 = {
    method: 'GET',
    url: '/api/openapi.json?category=all',
    headers: { host: 'mr-capsules.vercel.app' }
  };
  const res3 = new MockResponse();
  await openApiHandler(req3, res3);
  console.log('All preset total operations:', Object.keys(res3.body.paths).length);

  console.log('\n=== TEST 4: YAML Format ===');
  const req4 = {
    method: 'GET',
    url: '/api/openapi?category=doctortablet&format=yaml',
    headers: { host: 'mr-capsules.vercel.app' }
  };
  const res4 = new MockResponse();
  await openApiHandler(req4, res4);
  console.log('YAML content type:', res4.headers['content-type']);
  console.log('YAML preview (first 150 chars):\n', res4.body.substring(0, 150));

  console.log('\n=== TEST 5: ChatGPT REST Action Call to system_health ===');
  const req5 = {
    method: 'POST',
    url: '/api/mcp?action=system_health',
    headers: { host: 'mr-capsules.vercel.app', origin: 'https://chat.openai.com' },
    body: {}
  };
  const res5 = new MockResponse();
  await mcpHandler(req5, res5);
  console.log('System health status:', res5.statusCode);
  console.log('CORS Allow Origin for OpenAI:', res5.headers['access-control-allow-origin']);
  console.log('Response body:', res5.body);

  console.log('\n=== TEST 6: ChatGPT Unified Execute call ===');
  const req6 = {
    method: 'POST',
    url: '/api/mcp?action=execute',
    headers: { host: 'mr-capsules.vercel.app', origin: 'https://chatgpt.com' },
    body: { tool: 'system_health', parameters: {} }
  };
  const res6 = new MockResponse();
  await mcpHandler(req6, res6);
  console.log('Unified execute status:', res6.statusCode);
  console.log('Response body:', res6.body);

  console.log('\n=== TEST 7: account_manager Tool Presence ===');
  const hasAccountManager = pathKeys1.includes('/api/actions/account_manager');
  console.log('account_manager present in Essential preset:', hasAccountManager);
  if (!hasAccountManager) {
    console.error('FAIL: account_manager not found in Essential preset!');
  } else {
    console.log('PASS: account_manager is available for ChatGPT Actions');
  }

  console.log('\n=== TEST 8: MCP Initialize Handshake ===');
  const req8 = {
    method: 'POST',
    url: '/api/mcp',
    headers: { host: 'mr-capsules.vercel.app', origin: 'https://chatgpt.com' },
    body: { jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'chatgpt-apps-sdk' } } }
  };
  const res8 = new MockResponse();
  await mcpHandler(req8, res8);
  console.log('Initialize status:', res8.statusCode);
  console.log('Negotiated Protocol Version:', res8.body?.result?.protocolVersion);
  console.log('Capabilities tools present:', !!res8.body?.result?.capabilities?.tools);

  console.log('\n=== TEST 9: MCP tools/list Discovery ===');
  const req9 = {
    method: 'POST',
    url: '/api/mcp',
    headers: { host: 'mr-capsules.vercel.app', origin: 'https://chatgpt.com', authorization: `Bearer ${process.env.MCP_GATEWAY_API_KEY || 'mrc_test'}` },
    body: { jsonrpc: '2.0', id: 'tools-1', method: 'tools/list', params: {} }
  };
  const res9 = new MockResponse();
  await mcpHandler(req9, res9);
  console.log('tools/list status:', res9.statusCode);
  console.log('Total tools returned in MCP tools/list:', res9.body?.result?.tools?.length);
  const toolNames = (res9.body?.result?.tools || []).map(t => t.name);
  console.log('Has account_manager in MCP tools/list:', toolNames.includes('account_manager'));
  console.log('Has doctortablet_save_note:', toolNames.includes('doctortablet_save_note'));

  console.log('\n=== TEST 10: GET /api/mcp Server Discovery ===');
  const req10 = {
    method: 'GET',
    url: '/api/mcp',
    headers: { host: 'mr-capsules.vercel.app', accept: 'application/json' }
  };
  const res10 = new MockResponse();
  await mcpHandler(req10, res10);
  console.log('GET discovery status:', res10.statusCode);
  console.log('Discovery response name:', res10.body?.name);
  console.log('Discovery endpoints:', res10.body?.endpoints);

  console.log('\n=== TEST 11: GET ai-plugin.json Manifest ===');
  const req11 = {
    method: 'GET',
    url: '/.well-known/ai-plugin.json',
    headers: { host: 'mr-capsules.vercel.app', origin: 'https://chatgpt.com' }
  };
  const res11 = new MockResponse();
  await openApiHandler(req11, res11);
  console.log('ai-plugin status:', res11.statusCode);
  console.log('Plugin name:', res11.body?.name_for_human);
  console.log('Plugin api url:', res11.body?.api?.url);

  console.log('\n=== TEST 12: RFC 7591 Dynamic Client Registration ===');
  const authorizeHandler = (await import('../api/authorize.js')).default;
  const req12 = {
    method: 'POST',
    url: '/register',
    headers: { host: 'mr-capsules.vercel.app', origin: 'https://chatgpt.com', 'content-type': 'application/json' },
    body: { client_name: 'ChatGPT Apps SDK Plugin', redirect_uris: ['https://chatgpt.com/aip/callback'] }
  };
  const res12 = new MockResponse();
  await authorizeHandler(req12, res12);
  console.log('Client registration status:', res12.statusCode);
  console.log('Client ID generated:', res12.body?.client_id);
  console.log('Client Name:', res12.body?.client_name);

  console.log('\n=== TEST 13: OAuth Authorize with ChatGPT Redirect URI ===');
  const chatgptRedirect = 'https://chatgpt.com/aip/connectors/asdk_app_6a83c38084a0819180a70cadf82fe277/oauth/callback';
  const req13 = {
    method: 'GET',
    url: `/authorize?response_type=code&client_id=client_mrc_test&redirect_uri=${encodeURIComponent(chatgptRedirect)}&state=xyz123`,
    headers: { host: 'mr-capsules.vercel.app', origin: 'https://chatgpt.com' }
  };
  const res13 = new MockResponse();
  await authorizeHandler(req13, res13);
  console.log('Authorize status:', res13.statusCode);
  const isHtmlApprovalPage = typeof res13.body === 'string' && res13.body.includes('Connect to Mr. Capsules');
  console.log('Returned HTML Approval Page:', isHtmlApprovalPage);
  if (res13.statusCode !== 200 || !isHtmlApprovalPage) {
    console.error('FAIL: ChatGPT OAuth redirect_uri rejected!');
  } else {
    console.log('PASS: ChatGPT OAuth redirect_uri accepted successfully');
  }

  console.log('\nAll tests completed successfully!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
