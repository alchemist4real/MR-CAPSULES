import fs from 'fs';
import path from 'path';

const SB_URL = 'https://hdhvrlkizorscvehttzd.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkaHZybGtpem9yc2N2ZWh0dHpkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzI2MzA3MiwiZXhwIjoyMDkyODM5MDcyfQ.1fW24fXFAZx98dtLelrWmw8ROvkRcap8ObsMkWpy-6E';
const BASE_URL = 'http://localhost:3000';

const results = [];

function assert(condition, title, details) {
  if (condition) {
    results.push({ scenario: title, status: 'PASS', details });
    console.log(`[PASS] ${title} - ${details || ''}`);
  } else {
    results.push({ scenario: title, status: 'FAIL', details });
    console.error(`[FAIL] ${title} - ${details || ''}`);
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('   COMPREHENSIVE E2E & DOM DIFF TEST SUITE - MR-CAPSULES');
  console.log('================================================================\n');

  // ─────────────────────────────────────────────────────────────
  // SCENARIO 1: DOM & Div Structure Comparison (admin.html)
  // ─────────────────────────────────────────────────────────────
  console.log('>>> SCENARIO 1: DOM & Div Structure Comparison in admin.html');
  const adminHtml = fs.readFileSync('admin.html', 'utf8');

  // Check Stats Bar
  const hasStatTiles = adminHtml.includes('class="api-stat-tile"') &&
                       adminHtml.includes('id="statActiveKeys"') &&
                       adminHtml.includes('id="statOauthSessions"') &&
                       adminHtml.includes('id="statMcpGateway"');
  assert(hasStatTiles, 'DOM: Stats Bar 3-Tiles Structure', 'statActiveKeys, statOauthSessions, statMcpGateway all exist');

  // Check Modal Pop-up for Created API Key
  const hasApiKeyCreatedModal = adminHtml.includes('id="apiKeyCreatedModal"') &&
                                adminHtml.includes('id="createdApiKeyInput"') &&
                                adminHtml.includes('id="btnCopyCreatedKey"') &&
                                adminHtml.includes('onclick="this.select();"');
  assert(hasApiKeyCreatedModal, 'DOM: ApiKeyCreatedModal Component', '#apiKeyCreatedModal contains 1-click select input, copy button, and modal card');

  // Check Permanent 3-Column AI Connectors Grid
  const hasConnectorsGrid = adminHtml.includes('class="api-connector-grid"') &&
                            adminHtml.includes('Google Antigravity Connector') &&
                            adminHtml.includes('Claude.ai Connector (Streamable HTTP)') &&
                            adminHtml.includes('ChatGPT Custom GPT Connector');
  assert(hasConnectorsGrid, 'DOM: 3-Column AI Connectors Grid', 'Google Antigravity, Claude.ai, ChatGPT cards permanently positioned');

  // Ensure 3 giant cards were removed from #apiKeyRevealBox
  const revealBoxIdx = adminHtml.indexOf('id="apiKeyRevealBox"');
  const revealBoxEnd = adminHtml.indexOf('</div>', revealBoxIdx);
  const revealBoxContent = adminHtml.slice(revealBoxIdx, revealBoxEnd + 500);
  const revealBoxClean = !revealBoxContent.includes('Google Antigravity Connector') && !revealBoxContent.includes('Claude.ai Connector');
  assert(revealBoxClean, 'DOM: Clean Reveal Box', '#apiKeyRevealBox no longer contains bloated connector cards');

  // ─────────────────────────────────────────────────────────────
  // SCENARIO 2: MCP API Gateway Lifecycle (api/mcp.js)
  // ─────────────────────────────────────────────────────────────
  console.log('\n>>> SCENARIO 2: MCP Gateway Key Lifecycle');
  const linkRes = await fetch(`${SB_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: 'muqorroben@gmail.com' })
  });
  const linkData = await linkRes.json();
  const tokenHash = linkData.properties?.email_otp || linkData.hashed_token;

  const verifyRes = await fetch(`${SB_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash })
  });
  const sessionData = await verifyRes.json();
  const accessToken = sessionData.access_token;
  assert(!!accessToken, 'Auth: Supabase JWT Token Acquisition', `User: ${sessionData.user?.email}`);

  // List keys
  const listRes = await fetch(`${BASE_URL}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ method: 'apikeys_list', params: {} })
  });
  const listData = await listRes.json();
  assert(listData.success === true && Array.isArray(listData.result?.keys), 'API: apikeys_list Endpoint', `Retrieved ${listData.result?.keys?.length} keys`);

  // Create key
  const createRes = await fetch(`${BASE_URL}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ method: 'apikeys_create', params: { name: 'Automated Suite Test Key', expires_in_days: 14 } })
  });
  const createData = await createRes.json();
  const rawKey = createData.result?.raw_key;
  const prefix = createData.result?.key_prefix;
  assert(createData.success === true && rawKey?.startsWith('mrc_'), 'API: apikeys_create Endpoint', `Generated key: ${rawKey?.slice(0, 16)}...`);

  // Revoke created key
  const findRes = await fetch(`${SB_URL}/rest/v1/api_keys?key_prefix=eq.${prefix}&select=id`, {
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
  });
  const findRows = await findRes.json();
  const createdId = findRows[0]?.id;

  const revokeRes = await fetch(`${BASE_URL}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ method: 'apikeys_revoke', params: { key_id: createdId } })
  });
  const revokeData = await revokeRes.json();
  assert(revokeData.success === true && revokeData.result?.revoked === true, 'API: apikeys_revoke Endpoint', `Revoked key ID: ${createdId}`);

  // ─────────────────────────────────────────────────────────────
  // SCENARIO 3: Google Antigravity Dedicated Flow (/authorize)
  // ─────────────────────────────────────────────────────────────
  console.log('\n>>> SCENARIO 3: Dedicated Google Antigravity Flow');
  const agyRes = await fetch(`${BASE_URL}/authorize?client_id=antigravity-mcp&redirect_uri=antigravity://oauth/callback`);
  assert(agyRes.status === 200, 'OAuth: Antigravity /authorize Endpoint', 'Status 200 OK');
  const agyHtml = await agyRes.text();
  assert(agyHtml.includes('Google Antigravity') && agyHtml.includes('#003870'), 'DOM: Antigravity Branding & Pill Badge', 'Found client title and #003870 badge styling');
  assert(agyHtml.includes('id="auth-form"') && agyHtml.includes('id="submit-btn"'), 'DOM: Auth Box & Action Button', 'Found auth-form and submit-btn');

  // Security test: Malicious redirect URI
  const evilRes = await fetch(`${BASE_URL}/authorize?client_id=bad&redirect_uri=https://evil-hacker.com/callback`);
  assert(evilRes.status === 400, 'Security: Reject Malicious Redirect URI', 'Returned HTTP 400 as expected');

  // ─────────────────────────────────────────────────────────────
  // SCENARIO 4: Decoupling & Content Fallback
  // ─────────────────────────────────────────────────────────────
  console.log('\n>>> SCENARIO 4: Decoupling & Content Fallback');
  const contentApiRes = await fetch(`${BASE_URL}/api/content`);
  const contentData = await contentApiRes.json();
  assert(contentApiRes.status === 200 && contentData.semesters?.length > 0, 'Content API: Recursive Tree Catalog', `Semesters: ${contentData.semesters?.length}, Files: ${contentData.files?.length}`);
  assert(contentData.contentCdn !== undefined, 'Content API: Content CDN Configuration Expose', `contentCdn field present: "${contentData.contentCdn}"`);

  // App.html CDN Helper
  const appHtml = fs.readFileSync('app.html', 'utf8');
  assert(appHtml.includes('function getContentCdnUrl') && appHtml.includes('getContentCdnUrl(item.cover)') && appHtml.includes('getContentCdnUrl(path)'),
    'App: getContentCdnUrl Resolution', 'Coverflow art-bg, info mImg, and viewerFrame all use getContentCdnUrl');

  // Dev server content fallback
  const cbtFileRes = await fetch(`${BASE_URL}/content/semester%202/2.5/2.5%20CBT_21%20REECHARD%20GANTENG.html`);
  assert(cbtFileRes.status === 200 && cbtFileRes.headers.get('content-type')?.includes('text/html'),
    'DevServer: Static Content Fallback Handler', 'CBT module HTML resolved with HTTP 200');

  // ─────────────────────────────────────────────────────────────
  // SCENARIO 5: Localhost Cleanliness & Deployment Readiness
  // ─────────────────────────────────────────────────────────────
  console.log('\n>>> SCENARIO 5: Localhost Cleanliness & Deployment Readiness');
  const adminApiJs = fs.readFileSync('api/admin.js', 'utf8');
  assert(!adminApiJs.includes("const host = req.headers.host || 'localhost';") && adminApiJs.includes('mr-capsules.vercel.app'),
    'Deploy: api/admin.js Production Host Fallback', 'mr-capsules.vercel.app used as fallback instead of localhost');

  const publicFiles = fs.existsSync('public/content') || fs.existsSync('public/cover');
  assert(!publicFiles, 'Deploy: Slim Public Assets', 'public/content and public/cover excluded, keeping deployment light');

  console.log('\n================================================================');
  console.log(`TEST SUMMARY: ${results.filter(r => r.status === 'PASS').length} PASSED / ${results.filter(r => r.status === 'FAIL').length} FAILED`);
  console.log('================================================================');

  if (results.some(r => r.status === 'FAIL')) {
    process.exit(1);
  }
}

runTests().catch(e => {
  console.error('Test suite uncaught error:', e);
  process.exit(1);
});
