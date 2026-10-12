import { getMcpToolsList } from '../api/mcp.js';
import openApiHandler from '../api/openapi.js';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

async function runTests() {
  console.log('=== STEP 1: Schema Verification for Connector Tools ===');
  const tools = getMcpToolsList();
  
  // 1. contributions_award_batch
  const batchPoints = tools.find(t => t.name === 'contributions_award_batch');
  assert(!!batchPoints, 'Tool contributions_award_batch exists');
  assert(batchPoints.inputSchema.required?.includes('points'), 'points is required in contributions_award_batch');
  assert('all_users' in batchPoints.inputSchema.properties, 'all_users property in contributions_award_batch');
  assert('division_id' in batchPoints.inputSchema.properties, 'division_id property in contributions_award_batch');
  assert('exclude_banned' in batchPoints.inputSchema.properties, 'exclude_banned property in contributions_award_batch');
  assert('users' in batchPoints.inputSchema.properties, 'users array property in contributions_award_batch');

  // 2. users_create_batch
  const batchUsers = tools.find(t => t.name === 'users_create_batch');
  assert(!!batchUsers, 'Tool users_create_batch exists');
  assert(batchUsers.inputSchema.required?.includes('users'), 'users is required in users_create_batch');
  assert('default_password' in batchUsers.inputSchema.properties, 'default_password in users_create_batch');
  assert('default_division' in batchUsers.inputSchema.properties, 'default_division in users_create_batch');
  assert('stop_on_error' in batchUsers.inputSchema.properties, 'stop_on_error in users_create_batch');

  // 3. users_list search & efficiency
  const usersList = tools.find(t => t.name === 'users_list');
  assert(!!usersList, 'Tool users_list exists');
  assert('search' in usersList.inputSchema.properties, 'search in users_list');
  assert('query' in usersList.inputSchema.properties, 'query in users_list');
  assert('division' in usersList.inputSchema.properties, 'division in users_list');
  assert('role' in usersList.inputSchema.properties, 'role in users_list');
  assert('limit' in usersList.inputSchema.properties, 'limit in users_list');
  assert('offset' in usersList.inputSchema.properties, 'offset in users_list');
  assert('compact' in usersList.inputSchema.properties, 'compact in users_list');

  // 4. content_tree search & efficiency
  const contentTree = tools.find(t => t.name === 'content_tree');
  assert(!!contentTree, 'Tool content_tree exists');
  assert('search' in contentTree.inputSchema.properties, 'search in content_tree');
  assert('query' in contentTree.inputSchema.properties, 'query in content_tree');
  assert('extension' in contentTree.inputSchema.properties, 'extension in content_tree');
  assert('limit' in contentTree.inputSchema.properties, 'limit in content_tree');
  assert('offset' in contentTree.inputSchema.properties, 'offset in content_tree');

  // 5. cover_list search & efficiency
  const coverList = tools.find(t => t.name === 'cover_list');
  assert(!!coverList, 'Tool cover_list exists');
  assert('search' in coverList.inputSchema.properties, 'search in cover_list');
  assert('query' in coverList.inputSchema.properties, 'query in cover_list');
  assert('limit' in coverList.inputSchema.properties, 'limit in cover_list');

  // 6. content_list search & efficiency
  const contentList = tools.find(t => t.name === 'content_list');
  assert(!!contentList, 'Tool content_list exists');
  assert('search' in contentList.inputSchema.properties, 'search in content_list');
  assert('query' in contentList.inputSchema.properties, 'query in content_list');
  assert('limit' in contentList.inputSchema.properties, 'limit in content_list');
  assert('offset' in contentList.inputSchema.properties, 'offset in content_list');

  // 7. account_manager batch_create action
  const accMgr = tools.find(t => t.name === 'account_manager');
  assert(!!accMgr, 'Tool account_manager exists');
  assert(accMgr.inputSchema.properties.action.enum.includes('batch_create'), 'batch_create action in account_manager');
  assert('users' in accMgr.inputSchema.properties, 'users property in account_manager');

  console.log('\n=== STEP 2: OpenAPI Generation & Compliance ===');
  const mockRes = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(s) { this.statusCode = s; return this; },
    json(d) { this.data = d; return this; }
  };
  await openApiHandler({ method: 'GET', url: '/api/openapi.json', headers: { host: 'mr-capsules.vercel.app' } }, mockRes);
  const paths = Object.keys(mockRes.data?.paths || {});
  assert(paths.includes('/api/actions/contributions_award_batch'), 'OpenAPI has /api/actions/contributions_award_batch');
  assert(paths.includes('/api/actions/users_create_batch'), 'OpenAPI has /api/actions/users_create_batch');
  assert(paths.includes('/api/actions/content_search'), 'OpenAPI has /api/actions/content_search');
  assert(paths.length <= 30, `OpenAPI operations count (${paths.length}) is within OpenAI 30-action ceiling`);

  console.log('\n=== ALL CONNECTOR VERIFICATION CHECKS PASSED PERFECTLY ===');
}

runTests().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
