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

import handler from '../api/mcp.js';

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(s) { this.statusCode = s; return this; },
    json(data) {
      this.data = data;
      return this;
    },
    send(data) {
      this.data = data;
      return this;
    },
    end() { return this; }
  };
}

async function runTests() {
  console.log('--- TEST 1: Unauthenticated initialize ---');
  {
    const req = {
      method: 'POST',
      url: '/api/mcp',
      headers: { host: 'mr-capsules.vercel.app', 'content-type': 'application/json' },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
    };
    const res = createMockRes();
    await handler(req, res);
    console.log('Status:', res.statusCode);
    console.log('Success:', res.statusCode === 200);
  }

  console.log('\n--- TEST 2: Unauthenticated tools/list (should be 401) ---');
  {
    const req = {
      method: 'POST',
      url: '/api/mcp',
      headers: { host: 'mr-capsules.vercel.app', 'content-type': 'application/json' },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    };
    const res = createMockRes();
    await handler(req, res);
    console.log('Status:', res.statusCode);
    console.log('Response:', JSON.stringify(res.data));
    console.log('Protected correctly:', res.statusCode === 401);
  }

  console.log('\n--- TEST 3: Unauthenticated system.health (should be 200) ---');
  {
    const req = {
      method: 'POST',
      url: '/api/mcp',
      headers: { host: 'mr-capsules.vercel.app', 'content-type': 'application/json' },
      body: { jsonrpc: '2.0', id: 3, method: 'system.health', params: {} }
    };
    const res = createMockRes();
    await handler(req, res);
    console.log('Status:', res.statusCode);
    console.log('Success:', res.statusCode === 200);
  }

  console.log('\n--- TEST 4: Query key bypass attempt ?key=mrc_test (should be 401) ---');
  {
    const req = {
      method: 'POST',
      url: '/api/mcp?key=mrc_fake_key',
      headers: { host: 'mr-capsules.vercel.app', 'content-type': 'application/json' },
      body: { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }
    };
    const res = createMockRes();
    await handler(req, res);
    console.log('Status:', res.statusCode);
    console.log('Protected correctly:', res.statusCode === 401);
  }

  console.log('\n--- TEST 5: Verify extractSmartContent on real CBT file ---');
  try {
    const sampleHtml = fs.readFileSync('content/semester 2/2.5/2.5 CBT_21 REECHARD GANTENG.html', 'utf8');
    console.log('Original size (bytes):', sampleHtml.length);
    const qMatch = sampleHtml.match(/(?:const|let|var)\s+QUESTIONS\s*=\s*(\[[\s\S]*?\]);/i);
    if (qMatch) {
      const qs = Function(`"use strict"; return (${qMatch[1]});`)();
      console.log('Successfully extracted questions:', qs.length);
      console.log('Sample question 1:', qs[0].q);
      console.log('Answer:', qs[0].a);
      const cleanJson = JSON.stringify(qs);
      console.log('Clean questions size (bytes):', cleanJson.length);
      console.log('Byte reduction:', Math.round((1 - cleanJson.length / sampleHtml.length) * 100) + '%');
    }
  } catch (err) {
    console.error('Test 5 error:', err);
  }

  console.log('\n--- TEST 6: Verify lecture strip on real lecture file ---');
  try {
    const lecHtml = fs.readFileSync('content/semester 1/1.4/1.4 CBT_Histologi Lecture.html', 'utf8');
    console.log('Original lecture size (bytes):', lecHtml.length);
    const stripped = lecHtml
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    console.log('Stripped lecture text size (bytes):', stripped.length);
    console.log('Lecture byte reduction:', Math.round((1 - stripped.length / lecHtml.length) * 100) + '%');
  } catch (err) {
    console.error('Test 6 error:', err);
  }

  console.log('\n--- TEST 7: Verify getMcpToolsList schemas for content_get and content_pull_to_sandbox ---');
  try {
    const { getMcpToolsList } = await import('../api/mcp.js');
    const tools = getMcpToolsList();
    const contentGetTool = tools.find(t => t.name === 'content_get');
    const pullTool = tools.find(t => t.name === 'content_pull_to_sandbox');
    console.log('content_get has format prop:', !!contentGetTool?.inputSchema?.properties?.format);
    console.log('content_get format enum:', contentGetTool?.inputSchema?.properties?.format?.enum);
    console.log('content_pull_to_sandbox description updated:', pullTool?.description?.includes('without exposing API credentials'));
  } catch (err) {
    console.error('Test 7 error:', err);
  }

  console.log('\n--- TEST 8: Verify Phase 2 tools in getMcpToolsList ---');
  try {
    const { getMcpToolsList } = await import('../api/mcp.js');
    const tools = getMcpToolsList();
    const searchTool = tools.find(t => t.name === 'content_search');
    const listTool = tools.find(t => t.name === 'content_list');
    const treeTool = tools.find(t => t.name === 'content_tree');
    const deleteTool = tools.find(t => t.name === 'content_delete');

    console.log('content_search exists:', !!searchTool);
    console.log('content_search required:', searchTool?.inputSchema?.required);
    console.log('content_list has compact prop:', !!listTool?.inputSchema?.properties?.compact);
    console.log('content_tree has paths_only prop:', !!treeTool?.inputSchema?.properties?.paths_only);
    console.log('content_delete has paths array prop:', !!deleteTool?.inputSchema?.properties?.paths);
  } catch (err) {
    console.error('Test 8 error:', err);
  }

  console.log('\n--- TEST 9: Verify docs_get outline on real docs.html ---');
  try {
    const docsHtml = fs.readFileSync('docs.html', 'utf8');
    console.log('Full docs.html size (bytes):', docsHtml.length);
    const rawSections = docsHtml.split('<div class="docs-section">');
    const outline = [];
    for (let i = 1; i < rawSections.length; i++) {
      const sec = rawSections[i];
      const endIdx = sec.indexOf('</div>');
      const secBody = endIdx !== -1 ? sec.substring(0, endIdx) : sec;
      const titleMatch = secBody.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Section ${i}`;
      outline.push({ sectionIndex: i, title });
    }
    const outlineJson = JSON.stringify({ total_sections: outline.length, outline });
    console.log('Total sections in docs.html:', outline.length);
    console.log('Outline JSON size (bytes):', outlineJson.length);
    console.log('Docs token reduction:', Math.round((1 - outlineJson.length / docsHtml.length) * 100) + '%');
  } catch (err) {
    console.error('Test 9 error:', err);
  }

  console.log('\n--- TEST 10: Verify tasks_list and codebase_read_file schemas ---');
  try {
    const { getMcpToolsList } = await import('../api/mcp.js');
    const tools = getMcpToolsList();
    const tasksTool = tools.find(t => t.name === 'tasks_list');
    const codebaseTool = tools.find(t => t.name === 'codebase_read_file');
    const docsTool = tools.find(t => t.name === 'docs_get');

    console.log('tasks_list has status filter:', !!tasksTool?.inputSchema?.properties?.status);
    console.log('tasks_list has compact prop:', !!tasksTool?.inputSchema?.properties?.compact);
    console.log('codebase_read_file has start_line prop:', !!codebaseTool?.inputSchema?.properties?.start_line);
    console.log('codebase_read_file has force prop:', !!codebaseTool?.inputSchema?.properties?.force);
    console.log('docs_get has sectionIndex prop:', !!docsTool?.inputSchema?.properties?.sectionIndex);
  } catch (err) {
    console.error('Test 10 error:', err);
  }
}

runTests();
