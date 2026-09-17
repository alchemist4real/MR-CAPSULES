import zlib from 'zlib';

// api/mcp.js
// MCP/API Gateway v1.1.0 — supports both JWT auth, API key auth, and OAuth 2.0 PKCE Bearer tokens
// Exposes 78 tools (MR-CAPSULES 71 tools + Doctor Tablet 7 tools)

export default async function handler(req, res) {
  // ── CORS — Whitelist for Claude, ChatGPT, OpenAI, and Developer Environments ──
  function isOriginAllowed(origin) {
    if (!origin) return true;
    const lower = origin.toLowerCase();
    return (
      lower.endsWith('claude.ai') ||
      lower.endsWith('anthropic.com') ||
      lower.endsWith('openai.com') ||
      lower.endsWith('chatgpt.com') ||
      lower.endsWith('oaistatic.com') ||
      lower.endsWith('oaiusercontent.com') ||
      lower.endsWith('vercel.app') ||
      lower.includes('localhost') ||
      lower.includes('127.0.0.1')
    );
  }

  const requestOrigin = req.headers.origin || '';
  if (requestOrigin && isOriginAllowed(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  // Required headers per MCP spec 2025-06-18 & OpenAI Custom GPT Actions
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, x-api-key, api-key, openai-gpt-id, openai-organization-id, openai-account-id, openai-conversation-id'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Content-Disposition');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Preflight — MUST return 200 (not 204) for Claude.ai and OpenAI compatibility
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ── Constants ─────────────────────────────────────────────────────────────
  const SUPABASE_URL = 'https://hdhvrlkizorscvehttzd.supabase.co';
  const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GH_OWNER = process.env.GITHUB_CONTENT_OWNER || process.env.GITHUB_OWNER || 'alchemist4real';
  const GH_CODEBASE_REPO = 'MR-CAPSULES';
  const GH_CONTENT_REPO = process.env.GITHUB_CONTENT_REPO || 'MR-CAPSULES-CONTENT';
  const GH_REPO = GH_CONTENT_REPO; // Default for content, upload, and cover tools
  const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'muqorroben@gmail.com';
  const MAX_KEYS_PER_USER = 5;

  const initUrlObj = new URL(req.url, `https://${req.headers.host || 'mr-capsules.vercel.app'}`);
  if (initUrlObj.searchParams.get('upload') === 'true') {
    return handleDirectUpload(req, res, SUPABASE_URL, SB_SERVICE_KEY, GITHUB_TOKEN, GH_OWNER, GH_CONTENT_REPO, SUPERADMIN_EMAIL);
  }


  if (req.url && req.url.includes('oauth-protected-resource')) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'mr-capsules.vercel.app';
    const issuer = `https://${host}`;
    const resourceUrl = `${issuer}/api/mcp`;
    return res.status(200).json({
      resource: resourceUrl,
      authorization_servers: [issuer],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
      logo_uri: `${issuer}/logo.png`,
      icon_uri: `${issuer}/logo.png`
    });
  }

  // ── Streamable HTTP MCP Transport (GET) ──────────────────────────────────
  // Claude.ai web sends a GET to open a streaming connection, then POST for calls.
  // The MCP spec 2025-06-18 uses a SINGLE endpoint for both GET (streaming)
  // and POST (JSON-RPC). This is the "Streamable HTTP" pattern.
  if (req.method === 'GET') {
    return handleMcpStreamableGet(req, res, SUPABASE_URL, SB_SERVICE_KEY);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) {
      return res.status(400).json({ success: false, error: 'Invalid JSON body' });
    }
  }

  // ── Streamable HTTP MCP: handle JSON-RPC envelope from MCP clients ────────
  // Claude.ai sends MCP messages as JSON-RPC 2.0 via POST.
  // We handle both: (a) direct REST calls { method, params }
  // and (b) MCP JSON-RPC { jsonrpc: '2.0', id, method, params }
  let isMcpJsonRpc = false;
  let mcpRequestId = null;
  let method, params = {};

  if (body && body.jsonrpc === '2.0') {
    // Incoming MCP JSON-RPC message from Claude.ai or MCP client
    isMcpJsonRpc = true;
    mcpRequestId = body.id;
    method = body.method;
    params = body.params || {};

    // MCP initialize handshake — respond immediately, no auth needed
    if (method === 'initialize') {
      const clientProtocolVersion = body.params?.protocolVersion || '2024-11-05';
      return res.status(200).json({
        jsonrpc: '2.0',
        id: mcpRequestId,
        result: {
          protocolVersion: clientProtocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
            prompts: { listChanged: false },
            logging: {}
          },
          serverInfo: { name: 'mr-capsules', version: '1.2.0' }
        }
      });
    }

    // MCP notifications (initialized, cancelled) — no response needed
    if (method === 'notifications/initialized' || method === 'notifications/cancelled' || method.startsWith('notifications/')) {
      return res.status(202).end();
    }

    // MCP ping
    if (method === 'ping') {
      return res.status(200).json({
        jsonrpc: '2.0',
        id: mcpRequestId,
        result: {}
      });
    }

    // MCP tools/call — map to our internal method routing
    if (method === 'tools/call') {
      method = params.name;     // e.g. 'content.list'
      params = params.arguments || {};
    }

    // MCP resources/list
    if (method === 'resources/list') {
      return res.status(200).json({
        jsonrpc: '2.0', id: mcpRequestId,
        result: { resources: [] }
      });
    }

    // MCP resources/templates/list
    if (method === 'resources/templates/list') {
      return res.status(200).json({
        jsonrpc: '2.0', id: mcpRequestId,
        result: { resourceTemplates: [] }
      });
    }

    // MCP prompts/list
    if (method === 'prompts/list') {
      return res.status(200).json({
        jsonrpc: '2.0', id: mcpRequestId,
        result: { prompts: [] }
      });
    }

    // MCP logging/setLevel
    if (method === 'logging/setLevel') {
      return res.status(200).json({
        jsonrpc: '2.0', id: mcpRequestId,
        result: {}
      });
    }
  } else {
    // Direct REST call: ChatGPT Custom GPT Action or { method, params } or unified execute
    const actionFromQuery = initUrlObj.searchParams.get('action') || initUrlObj.searchParams.get('tool');
    if (body && typeof body === 'object') {
      if (body.tool && (actionFromQuery === 'execute' || !actionFromQuery)) {
        method = body.tool;
        params = body.parameters || body.args || body.arguments || body.params || {};
      } else if (body.action || body.method) {
        method = body.action || body.method;
        params = body.params || body.arguments || body.args || body;
      } else if (actionFromQuery && actionFromQuery !== 'execute') {
        method = actionFromQuery;
        params = body.params || body;
      } else {
        method = body.method;
        params = body.params || body;
      }
    } else {
      method = actionFromQuery;
      params = {};
    }
  }

  if (!method) {
    const errResp = isMcpJsonRpc
      ? { jsonrpc: '2.0', id: mcpRequestId, error: { code: -32600, message: 'Missing method' } }
      : { success: false, error: 'Missing method or action parameter in request body/URL' };
    return res.status(400).json(errResp);
  }

  // ── system.health is public, no auth needed ───────────────────────────────
  if (method === 'system.health' || method === 'system_health') {
    const healthResult = {
      status: 'ok',
      version: '1.2.0',
      transport: 'Streamable HTTP (MCP 2025-06-18) + OpenAPI 3.0.3 Actions',
      endpoints: {
        mcp: 'POST /api/mcp (JSON-RPC or Streamable HTTP)',
        chatgpt_actions: 'POST /api/actions/{tool_name} (REST)',
        openapi_spec: 'GET /api/openapi.json (OpenAPI 3.0.3)'
      },
      ai_assistants_setup: {
        claude: 'Add https://mr-capsules.vercel.app/api/mcp as Custom Connector in Claude.ai',
        chatgpt: 'Import OpenAPI schema from https://mr-capsules.vercel.app/api/openapi.json into Custom GPT Actions'
      },
      docs: 'https://mr-capsules.vercel.app/docs'
    };
    if (isMcpJsonRpc) {
      return res.status(200).json({ jsonrpc: '2.0', id: mcpRequestId, result: { content: [{ type: 'text', text: JSON.stringify(healthResult, null, 2) }] } });
    }
    return res.status(200).json({ success: true, result: healthResult });
  }

  // ── Authenticate ─────────────────────────────────────────────────────────
  if (!SB_SERVICE_KEY) {
    return res.status(500).json({ success: false, error: 'Server configuration error: missing service key' });
  }

  // Supports OAuth Bearer Access Tokens (mrc_at_...), API keys (mrc_...), and JWTs
  const authHeader = (req.headers.authorization || '').trim();
  const xApiKey = (req.headers['x-api-key'] || req.headers['api-key'] || '').trim();

  let authResult = null;
  const currentReqHost = req.headers['x-forwarded-host'] || req.headers.host || 'mr-capsules.vercel.app';

  if (authHeader.startsWith('Bearer ')) {
    const bearerVal = authHeader.slice(7).trim();
    if (bearerVal.startsWith('mrc_at_')) {
      authResult = await authenticateOAuthAccessToken(bearerVal, SUPABASE_URL, SB_SERVICE_KEY, currentReqHost);
    } else if (bearerVal.startsWith('mrc_')) {
      authResult = await authenticateApiKey(bearerVal, SUPABASE_URL, SB_SERVICE_KEY);
    } else {
      authResult = await authenticateJWT(bearerVal, SUPABASE_URL, SB_SERVICE_KEY);
    }
  } else if (authHeader.startsWith('ApiKey ')) {
    authResult = await authenticateApiKey(authHeader.slice(7).trim(), SUPABASE_URL, SB_SERVICE_KEY);
  } else if (authHeader.startsWith('mrc_')) {
    authResult = await authenticateApiKey(authHeader, SUPABASE_URL, SB_SERVICE_KEY);
  } else if (xApiKey.startsWith('mrc_')) {
    authResult = await authenticateApiKey(xApiKey, SUPABASE_URL, SB_SERVICE_KEY);
  } else {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="https://${currentReqHost}", error="invalid_token", error_description="Bearer token required", resource_metadata="https://${currentReqHost}/.well-known/oauth-protected-resource"`
    );
    const authErr = { message: 'Unauthorized. Bearer token required.' };
    if (isMcpJsonRpc) {
      return res.status(401).json({ jsonrpc: '2.0', id: mcpRequestId, error: { code: -32001, message: authErr.message } });
    }
    return res.status(401).json({ success: false, error: authErr.message });
  }

  if (!authResult || authResult.error) {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="https://${currentReqHost}", error="invalid_token", error_description="Invalid or expired token", resource_metadata="https://${currentReqHost}/.well-known/oauth-protected-resource"`
    );
    const msg = authResult?.error || 'Unauthorized';
    if (isMcpJsonRpc) {
      return res.status(401).json({ jsonrpc: '2.0', id: mcpRequestId, error: { code: -32001, message: msg } });
    }
    return res.status(401).json({ success: false, error: msg });
  }

  // ── Block Guest Accounts from MCP Gateway ─────────────────────────────────
  const userEmail = (authResult.email || '').toLowerCase().trim();
  const isGuest = userEmail.startsWith('guest_') || /^guest_\d+_\d+@/i.test(userEmail) || authResult.userMetadata?.is_guest === true;
  if (isGuest) {
    const guestErrMsg = 'Forbidden: Guest accounts cannot access MCP connector tools. Please sign in with a registered account.';
    if (isMcpJsonRpc) {
      return res.status(403).json({ jsonrpc: '2.0', id: mcpRequestId, error: { code: -32003, message: guestErrMsg } });
    }
    return res.status(403).json({ success: false, error: guestErrMsg });
  }

  // ── Rate limit (Universal: API keys, OAuth Tokens, JWTs) ─────────────────
  const rateLimitId = authResult.isApiKey ? `key_${authResult.keyId}` : `user_${authResult.userId}`;
  const allowed = await checkRateLimit(rateLimitId, SUPABASE_URL, SB_SERVICE_KEY);
  if (!allowed) {
    const rateLimitMsg = 'Rate limit exceeded (60 requests/minute). Wait and retry.';
    if (isMcpJsonRpc) {
      return res.status(429).json({ jsonrpc: '2.0', id: mcpRequestId, error: { code: -32029, message: rateLimitMsg } });
    }
    return res.status(429).json({ success: false, error: rateLimitMsg });
  }

  // ── Resolve roles (same logic as api/admin.js) ────────────────────────────
  const roles = await resolveRoles(authResult.userId, authResult.email, SUPABASE_URL, SB_SERVICE_KEY, SUPERADMIN_EMAIL);

  // ── MCP tools/list — return tool list only for verified authenticated callers ──
  if (method === 'tools/list') {
    const staticTools = getMcpToolsList().map(t => ({
      ...t,
      name: t.name.replace(/\./g, '_')
    }));
    let customTools = [];
    try {
      customTools = (await getActiveCustomTools(SUPABASE_URL, SB_SERVICE_KEY)).map(ct => ({
        name: ct.name,
        description: `[Custom Tool] ${ct.description}`,
        inputSchema: ct.inputSchema || { type: 'object', properties: {} }
      }));
    } catch (e) {
      customTools = [];
    }
    if (isMcpJsonRpc) {
      return res.status(200).json({
        jsonrpc: '2.0',
        id: mcpRequestId,
        result: {
          tools: [...staticTools, ...customTools],
          nextCursor: null
        }
      });
    }
    return res.status(200).json({ success: true, tools: [...staticTools, ...customTools] });
  }

  // ── Route to handler ──────────────────────────────────────────────────────
  try {
    const result = await routeMethod(method, params, authResult, roles, {
      SUPABASE_URL, SB_SERVICE_KEY, GITHUB_TOKEN, GH_OWNER, GH_REPO, GH_CODEBASE_REPO, GH_CONTENT_REPO, MAX_KEYS_PER_USER, SUPERADMIN_EMAIL,
      reqHost: currentReqHost
    });

    // Respond in the correct format: MCP JSON-RPC or plain REST
    if (isMcpJsonRpc) {
      // MCP tools/call response wraps result in content array
      const textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return res.status(200).json({
        jsonrpc: '2.0',
        id: mcpRequestId,
        result: { content: [{ type: 'text', text: textContent }] }
      });
    }
    return res.status(200).json({ success: true, result });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    if (isMcpJsonRpc) {
      // Per MCP spec 2024-11-05 / 2025-06-18: tool errors return 200 OK with isError: true in result
      return res.status(200).json({
        jsonrpc: '2.0',
        id: mcpRequestId,
        result: {
          content: [{ type: 'text', text: `Error (${statusCode}): ${err.message}` }],
          isError: true
        }
      });
    }
    return res.status(statusCode).json({ success: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// MCP TOOLS LIST — Returned for tools/list requests
// This is what Claude sees in its tool picker
// ═══════════════════════════════════════════════════════════════

export function getMcpToolsList() {
  return [
    { name: 'system_health', description: 'Health check — returns server info and usage instructions', inputSchema: { type: 'object', properties: {} } },
    { name: 'content_list', description: 'List educational content organized by semester and block. Supports filtering by semester, block, category, or search keyword. Without filters, returns a compact curriculum overview to save tokens.', inputSchema: { type: 'object', properties: { semester: { type: 'string', description: 'Filter by semester name or number, e.g. "semester 1" or "1"' }, block: { type: 'string', description: 'Filter by block code, e.g. "1.2" or "2.5"' }, category: { type: 'string', description: 'Filter by category prefix, e.g. "CBT", "IDENT", "LECTURE"' }, search: { type: 'string', description: 'Search term to match file titles' }, compact: { type: 'boolean', description: 'If true, returns compact summary counts per block instead of full file lists (default true when no filters provided)' } } } },
    { name: 'content_search', description: 'Fast keyword search across educational content titles, modules, categories, semesters, and blocks without downloading heavy HTML. Returns matching file paths and direct public URLs in <100 tokens.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search keyword, e.g. "farmakologi", "reechard", "histologi", "cbt 2"' }, semester: { type: 'string', description: 'Optional semester filter, e.g. "semester 1" or "1"' }, block: { type: 'string', description: 'Optional block filter, e.g. "1.2" or "2.5"' }, category: { type: 'string', description: 'Optional category filter, e.g. "CBT", "IDENT", "LECTURE"' }, limit: { type: 'number', description: 'Maximum matching items to return (default 20, max 50)' } }, required: ['query'] } },
    { name: 'content_get', description: 'Download and extract educational content from a file. By default uses smart extraction to strip redundant CSS/scripts and extract structured quiz questions or clean lecture text, saving up to 90% tokens.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path, e.g. content/semester 2/2.5/2.5 CBT_21 REECHARD GANTENG.html' }, format: { type: 'string', enum: ['smart', 'quiz_only', 'text_only', 'metadata', 'raw'], description: 'Extraction format: "smart" (default, extracts questions or clean text), "quiz_only" (structured questions array), "text_only" (markdown notes), "metadata" (title & question count in <100 tokens), "raw" (full HTML)' }, offset: { type: 'number', description: 'Question offset for pagination (0-indexed, default 0)' }, limit: { type: 'number', description: 'Number of questions to return (default 30, max 100)' }, max_chars: { type: 'number', description: 'Safety character cap for text extraction (default 40000)' } }, required: ['path'] } },
    { name: 'content_tree', description: 'Get content file paths. By default returns a clean array of paths saving 80% tokens, with optional prefix filtering.', inputSchema: { type: 'object', properties: { prefix: { type: 'string', description: 'Optional path prefix to filter, e.g. "content/semester 2/"' }, paths_only: { type: 'boolean', description: 'If true (default), returns string paths array. If false, returns raw git tree blobs with SHAs.' } } } },
    { name: 'content_upload', description: 'Upload a content file directly. You can pass contentBase64, contentGzipBase64 (compressed & 100% checksum-verified, ideal when network egress is blocked), OR a public url (for files up to 100MB) to fetch and commit the file reliably without chunking.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Target path, e.g. content/Semester 1/file.html' }, contentBase64: { type: 'string', description: 'Base64 encoded file content' }, contentGzipBase64: { type: 'string', description: 'Gzip compressed base64 encoded content (80% smaller, checksum verified)' }, url: { type: 'string', description: 'Public URL to fetch the file from' } }, required: ['path'] } },
    { name: 'content_upload_from_agent_path', description: 'Generates authenticated curl commands and instructions for Claude to upload a large local file directly from the sandbox filesystem (avoiding base64 typing corruption).', inputSchema: { type: 'object', properties: { agentFilePath: { type: 'string', description: 'Absolute file path in agent sandbox, e.g. /mnt/user-data/outputs/farmakokinetik.html' }, targetPath: { type: 'string', description: 'Target path in repository, e.g. content/semester 3/3.1/3.1 LECTURE_Am I Kinetic.html' } }, required: ['agentFilePath', 'targetPath'] } },
    { name: 'content_pull_to_sandbox', description: 'Pull/download a content file directly into the sandbox filesystem without exposing API credentials. Returns clean curl and python commands.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Repository file path, e.g. content/semester 3/3.1/3.1 LECTURE_Farmakokinetika.html' }, saveTo: { type: 'string', description: 'Optional absolute destination path in sandbox. Defaults to /mnt/user-data/outputs/<filename>' } }, required: ['path'] } },
    { name: 'upload_init', description: 'Initialize a bulletproof chunked upload session for large files of any size (videos, PDFs, zip pools, large HTML). Prevents serverless size limits & timeouts.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Target path, e.g. content/Semester 1/video.mp4 or cover/semester1.png' }, totalChunks: { type: 'number', description: 'Total number of chunks to be uploaded' }, totalSizeBytes: { type: 'number', description: 'Optional estimated file size in bytes' } }, required: ['path', 'totalChunks'] } },
    { name: 'upload_chunk', description: 'Upload a single Base64 chunk (recommended size: 500KB - 1.5MB per chunk) for an active upload session.', inputSchema: { type: 'object', properties: { uploadId: { type: 'string', description: 'Session ID returned by upload_init' }, chunkIndex: { type: 'number', description: '1-indexed chunk number (1 to totalChunks)' }, chunkBase64: { type: 'string', description: 'Base64 encoded chunk data' } }, required: ['uploadId', 'chunkIndex', 'chunkBase64'] } },
    { name: 'upload_commit', description: 'Reassemble all uploaded chunks, verify integrity, and commit the complete large file to GitHub reliably.', inputSchema: { type: 'object', properties: { uploadId: { type: 'string', description: 'Session ID returned by upload_init' } }, required: ['uploadId'] } },
    { name: 'upload_status', description: 'Check status, received chunks, and missing chunks of an active chunked upload session.', inputSchema: { type: 'object', properties: { uploadId: { type: 'string', description: 'Session ID returned by upload_init' } }, required: ['uploadId'] } },
    { name: 'upload_cancel', description: 'Cancel an active chunked upload session and clean up temporary chunk data.', inputSchema: { type: 'object', properties: { uploadId: { type: 'string', description: 'Session ID returned by upload_init' } }, required: ['uploadId'] } },
    { name: 'content_delete', description: 'Delete one or more content files in a single atomic Git commit. Accepts either a single path string or an array of paths.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Single file path to delete' }, paths: { type: 'array', items: { type: 'string' }, description: 'Array of file paths to delete in bulk' } } } },
    { name: 'content_rename', description: 'Rename or move a content file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, newPath: { type: 'string' } }, required: ['path', 'newPath'] } },
    { name: 'tasks_list', description: 'List content tasks on the board. Supports filtering by status, priority, semester, block, and pagination. By default returns compact task summaries saving tokens.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'in_progress', 'in_review', 'done'], description: 'Filter by task status' }, priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Filter by priority' }, semester: { type: 'string', description: 'Filter by semester' }, block: { type: 'string', description: 'Filter by block' }, limit: { type: 'number', description: 'Max tasks to return (default 20, max 100)' }, offset: { type: 'number', description: 'Offset for pagination (default 0)' }, compact: { type: 'boolean', description: 'If true (default), returns compact task summaries without lengthy descriptions' } } } },
    { name: 'tasks_create', description: 'Create a new content task (management only)', inputSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, semester: { type: 'string' }, block: { type: 'string' }, category: { type: 'string' }, priority: { type: 'string', enum: ['low','normal','high','urgent'] } }, required: ['title'] } },
    { name: 'tasks_claim', description: 'Claim an open task (developer only)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
    { name: 'tasks_submit', description: 'Submit a task for review (developer only)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
    { name: 'tasks_approve', description: 'Approve a reviewed task (reviewer only)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
    { name: 'tasks_reject', description: 'Reject a task back to in-progress (reviewer only)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, note: { type: 'string' } }, required: ['task_id'] } },
    { name: 'tasks_logs', description: 'Get activity history for a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
    { name: 'divisions_list', description: 'List all organization divisions', inputSchema: { type: 'object', properties: {} } },
    { name: 'divisions_my', description: 'Get your division membership', inputSchema: { type: 'object', properties: {} } },
    { name: 'account_manager', description: 'Unified account manager: create accounts, set passwords, set usernames/names, assign divisions, grant/revoke admin roles, ban/unban users, fetch detailed profiles, or delete accounts.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'update', 'set_password', 'set_username', 'set_division', 'set_admin', 'set_ban', 'get', 'list', 'delete'], description: 'Operation to perform' }, user_id: { type: 'string', description: 'Target user UUID' }, email: { type: 'string', description: 'User email address' }, password: { type: 'string', description: 'Password for creation or reset (min 6 chars)' }, username: { type: 'string', description: 'Username handle' }, full_name: { type: 'string', description: 'User full name (e.g. Ahmad Muqorrobin)' }, whatsapp: { type: 'string', description: 'WhatsApp contact number' }, division_id: { type: 'string', enum: ['management', 'development', 'review', 'none'], description: 'Division assignment ("management", "development", "review", or "none" to unassign)' }, is_admin: { type: 'boolean', description: 'True to grant admin privileges, false to revoke' }, banned: { type: 'boolean', description: 'True to ban user account, false to unban' }, query: { type: 'string', description: 'Optional search keyword when action is "list"' } }, required: ['action'] } },
    { name: 'users_create', description: 'Directly create a new user account with email, password, optional username/full name, division, and admin status (Admin only).', inputSchema: { type: 'object', properties: { email: { type: 'string', description: 'User email address' }, password: { type: 'string', description: 'Account password (minimum 6 characters)' }, full_name: { type: 'string', description: 'Full name (e.g. Ahmad Muqorrobin)' }, username: { type: 'string', description: 'Username' }, whatsapp: { type: 'string', description: 'WhatsApp phone number' }, division_id: { type: 'string', enum: ['management', 'development', 'review'], description: 'Division to assign' }, is_admin: { type: 'boolean', description: 'Grant admin rights' } }, required: ['email', 'password'] } },
    { name: 'users_list', description: 'List all registered users (SuperAdmin only)', inputSchema: { type: 'object', properties: {} } },
    { name: 'users_ban', description: 'Ban or unban a user (SuperAdmin only)', inputSchema: { type: 'object', properties: { user_id: { type: 'string' }, banned: { type: 'boolean' } }, required: ['user_id', 'banned'] } },
    { name: 'users_reset_password', description: 'Reset a user password by user_id or email (Admin / SuperAdmin only)', inputSchema: { type: 'object', properties: { user_id: { type: 'string' }, email: { type: 'string' }, new_password: { type: 'string' } }, required: ['new_password'] } },
    { name: 'config_get', description: 'Get app configuration settings (Admin only)', inputSchema: { type: 'object', properties: {} } },
    { name: 'config_update', description: 'Update app settings (Admin only)', inputSchema: { type: 'object', properties: { allowSignup: { type: 'boolean' }, maintenanceMode: { type: 'boolean' } } } },
    { name: 'contributions_leaderboard', description: 'Get the contribution points leaderboard', inputSchema: { type: 'object', properties: {} } },
    { name: 'contributions_my', description: 'Get your own contribution history and total points', inputSchema: { type: 'object', properties: {} } },
    { name: 'contributions_record', description: 'Manually award or record contribution points for a user (Management/Admin only)', inputSchema: { type: 'object', properties: { user_id: { type: 'string', description: 'Target user UUID' }, user_email: { type: 'string', description: 'Target user email' }, points: { type: 'number', description: 'Points to award (e.g. 1, 2, 5)' }, type: { type: 'string', description: 'Contribution type or description' }, task_id: { type: 'string', description: 'Optional task UUID' } }, required: ['points'] } },
    { name: 'review_issues', description: 'Get review issues for a task (reviewer only)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
    { name: 'review_report', description: 'Report a review issue on a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, issue_type: { type: 'string' }, description: { type: 'string' } }, required: ['task_id'] } },
    { name: 'review_resolve', description: 'Mark a review issue as resolved', inputSchema: { type: 'object', properties: { issue_id: { type: 'string' } }, required: ['issue_id'] } },
    { name: 'apikeys_list', description: 'List your active API keys', inputSchema: { type: 'object', properties: {} } },
    { name: 'apikeys_create', description: 'Generate a new API key', inputSchema: { type: 'object', properties: { name: { type: 'string' }, expires_in_days: { type: 'number' } }, required: ['name'] } },
    { name: 'apikeys_revoke', description: 'Revoke an API key by ID', inputSchema: { type: 'object', properties: { key_id: { type: 'string' } }, required: ['key_id'] } },
    { name: 'oauth_tokens_list', description: 'List your active OAuth connector tokens (Claude/MCP)', inputSchema: { type: 'object', properties: {} } },
    { name: 'oauth_tokens_revoke', description: 'Revoke an OAuth connector token by ID', inputSchema: { type: 'object', properties: { token_id: { type: 'string' } }, required: ['token_id'] } },
    { name: 'users_add_admin', description: 'Promote a user to Admin role (SuperAdmin only)', inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] } },
    { name: 'users_remove_admin', description: 'Revoke Admin role from a user (SuperAdmin only)', inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] } },
    { name: 'users_delete', description: 'Permanently delete a user account (SuperAdmin only)', inputSchema: { type: 'object', properties: { user_id: { type: 'string' } }, required: ['user_id'] } },
    { name: 'divisions_add_member', description: 'Assign a user to an organization division (Admin only)', inputSchema: { type: 'object', properties: { user_id: { type: 'string' }, division_id: { type: 'string', enum: ['management','development','review'] }, whatsapp: { type: 'string' } }, required: ['user_id', 'division_id'] } },
    { name: 'divisions_remove_member', description: 'Remove a user from an organization division (Admin only)', inputSchema: { type: 'object', properties: { user_id: { type: 'string' }, division_id: { type: 'string' } }, required: ['user_id', 'division_id'] } },
    { name: 'content_delete_files', description: 'Delete multiple content files in a single atomic Git commit', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } },
    { name: 'tasks_delete', description: 'Permanently delete a task from the board (Management/Admin only)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
    { name: 'review_delete_issue', description: 'Delete a review issue report (Reviewer/Admin only)', inputSchema: { type: 'object', properties: { issue_id: { type: 'string' } }, required: ['issue_id'] } },
    { name: 'activity_logs', description: 'Get system & user activity logs (Admin only)', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
    { name: 'system_cleanup_guests', description: 'Run automated cleanup of expired guest/temporary accounts (Admin only)', inputSchema: { type: 'object', properties: {} } },
    { name: 'tasks_unclaim', description: 'Unclaim a task back to open status (Developer only)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
    { name: 'tasks_start_review', description: 'Start active review on a submitted task (Reviewer only)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
    { name: 'tasks_add_note', description: 'Add a note/comment to a task log', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, note: { type: 'string' } }, required: ['task_id', 'note'] } },
    { name: 'tasks_reset_phase', description: 'Reset a task phase/status back for re-planning (Management/Dev/Reviewer)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, new_status: { type: 'string', enum: ['open', 'in_progress'] }, unassign: { type: 'boolean' }, note: { type: 'string' } }, required: ['task_id', 'note'] } },
    { name: 'tasks_re_review', description: 'Request re-review on a done task, sends it back to in_review (Reviewer/Management)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, note: { type: 'string' } }, required: ['task_id', 'note'] } },
    { name: 'tasks_retrack', description: 'Reopen a completed task back to open status with full timestamp reset (Management/Admin only)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, note: { type: 'string' } }, required: ['task_id', 'note'] } },
    { name: 'tasks_resubmit', description: 'Pull back a developed or in_review task to in_progress for rework (Assigned dev/Management/Admin)', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, note: { type: 'string' } }, required: ['task_id', 'note'] } },
    { name: 'divisions_join', description: 'Join an organization division', inputSchema: { type: 'object', properties: { division_id: { type: 'string', enum: ['management','development','review'] }, whatsapp: { type: 'string' } }, required: ['division_id'] } },
    { name: 'divisions_update_whatsapp', description: 'Update your WhatsApp contact info', inputSchema: { type: 'object', properties: { whatsapp: { type: 'string' } }, required: ['whatsapp'] } },
    { name: 'divisions_get_members', description: 'Get detailed member list of a specific division (or all divisions)', inputSchema: { type: 'object', properties: { division_id: { type: 'string' } } } },
    { name: 'cover_list', description: 'List all cover image files in the cover/ directory', inputSchema: { type: 'object', properties: {} } },
    { name: 'cover_upload', description: 'Upload or update a cover image in cover/ (base64 encoded)', inputSchema: { type: 'object', properties: { filename: { type: 'string', description: 'e.g. semester 1.png' }, contentBase64: { type: 'string' } }, required: ['filename', 'contentBase64'] } },
    { name: 'cover_delete', description: 'Delete a cover image from cover/', inputSchema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] } },
    { name: 'docs_get', description: 'Get documentation outline or a specific section from docs.html. By default returns table of contents in ~250 tokens instead of full 86KB HTML.', inputSchema: { type: 'object', properties: { sectionIndex: { type: 'number', description: '1-indexed section number to fetch only that specific section' }, full_html: { type: 'boolean', description: 'If true, returns full raw docs.html' } } } },
    { name: 'docs_update_section', description: 'Update or revise a specific documentation section in docs.html', inputSchema: { type: 'object', properties: { sectionIndex: { type: 'number', description: '1-indexed section number' }, title: { type: 'string' }, contentHtml: { type: 'string' } }, required: ['sectionIndex'] } },
    { name: 'docs_add_section', description: 'Append a new documentation section to docs.html', inputSchema: { type: 'object', properties: { title: { type: 'string' }, contentHtml: { type: 'string' } }, required: ['title', 'contentHtml'] } },
    { name: 'users_remove_device', description: 'Remove a registered device entry from a user account (Admin/User self)', inputSchema: { type: 'object', properties: { user_id: { type: 'string' }, device_id: { type: 'string' } }, required: ['user_id', 'device_id'] } },
    { name: 'users_block_device', description: 'Block or unblock a device ID globally in system settings (Admin only)', inputSchema: { type: 'object', properties: { device_id: { type: 'string' }, banned: { type: 'boolean' } }, required: ['device_id', 'banned'] } },
    { name: 'codebase_read_file', description: 'Read content of a codebase file in the repository (SuperAdmin only). Supports line range pagination to prevent token exhaustion on large files.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative path, e.g. api/admin.js or build.js' }, start_line: { type: 'number', description: '1-indexed start line' }, end_line: { type: 'number', description: '1-indexed end line' }, force: { type: 'boolean', description: 'Set true to force reading entire file even if > 40KB' } }, required: ['path'] } },
    { name: 'codebase_write_file', description: 'Create or update any codebase file in the repository (SuperAdmin only)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, contentBase64: { type: 'string' }, commitMessage: { type: 'string' } }, required: ['path', 'contentBase64'] } },
    { name: 'codebase_delete_file', description: 'Delete any codebase file from the repository (SuperAdmin only)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, commitMessage: { type: 'string' } }, required: ['path'] } },
    { name: 'codebase_search', description: 'Search text or code across the codebase repository (SuperAdmin only)', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'codebase_git_history', description: 'Get recent git commit history for the codebase repository (SuperAdmin only)', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
    { name: 'mcp_create_tool', description: 'Dynamically create and register a new custom MCP tool at runtime (SuperAdmin/Admin only).', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Unique tool name, e.g. custom_quiz_parser' }, description: { type: 'string', description: 'Description of what the tool does' }, inputSchema: { type: 'object', description: 'JSON Schema object for inputs' }, handler: { type: 'string', description: 'JavaScript code snippet returning a result object' }, minRole: { type: 'string', enum: ['superadmin', 'admin', 'reviewer', 'developer', 'authenticated'] } }, required: ['name', 'description', 'handler'] } },
    { name: 'mcp_delete_tool', description: 'Delete/unregister a custom MCP tool created at runtime (SuperAdmin/Admin only).', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Name of custom tool to delete' } }, required: ['name'] } },
    { name: 'mcp_list_custom_tools', description: 'List all active custom dynamic MCP tools registered at runtime.', inputSchema: { type: 'object', properties: {} } },
    { name: 'doctortablet_list_notes', description: 'List all medical notes and categories in Doctor Tablet vault', inputSchema: { type: 'object', properties: { categoryId: { type: 'string', description: 'Optional category/folder ID filter' }, tag: { type: 'string', description: 'Optional tag filter' } } } },
    { name: 'doctortablet_read_note', description: 'Read full content, frontmatter, and wikilinks of a Doctor Tablet note', inputSchema: { type: 'object', properties: { slug: { type: 'string', description: 'Note slug or file path (e.g. Gizi-dan-Metabolisme)' } }, required: ['slug'] } },
    { name: 'doctortablet_save_note', description: 'Save, create, or update a medical note in Doctor Tablet vault with GitHub auto-sync. MANDATORY DOCTORTABLET RULES: 1) Must analyze & map source structure & concept hierarchy first. 2) Content must be high-density clinical reasoning with real cases & exam traps (NOT a raw PPT slide transcript). 3) MUST use GitHub Callouts ([!NOTE], [!TIP], [!WARNING]), Tables (comparisons/labs), Mermaid diagrams (algorithms/ADME/pathways), & LaTeX formulas ($...$ / $$...$$ for medical math/scores/equations). 4) Parameter author MUST match the authenticated MCP user FULL NAME ONLY WITHOUT TITLES (e.g. "Ahmad Muqorrobin", no "dr." or "S.Ked").', inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Note title' }, categoryId: { type: 'string', description: 'Target folder/category ID (e.g. Kuliah-Kardiologi)' }, content: { type: 'string', description: 'Markdown body content with YAML frontmatter, GitHub callouts, tables, mermaid diagrams, and LaTeX formulas' }, tags: { type: 'array', items: { type: 'string' }, description: 'Tags, e.g. ["#medical", "#kardiologi"]' }, author: { type: 'string', description: 'Authenticated MCP user FULL NAME ONLY WITHOUT TITLES (e.g. "Ahmad Muqorrobin", do not include "dr.", "S.Ked", or generic AI names)' } }, required: ['title', 'content'] } },
    { name: 'doctortablet_list_categories', description: 'Get folder hierarchy tree of categories in Doctor Tablet', inputSchema: { type: 'object', properties: {} } },
    { name: 'doctortablet_create_category', description: 'Create a new category folder in Doctor Tablet vault', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Category/folder name' }, parentId: { type: 'string', description: 'Optional parent category ID' } }, required: ['name'] } },
    { name: 'doctortablet_search_notes', description: 'Full-text search notes across titles, content, tags, or categories in Doctor Tablet', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search term or keyword' }, tag: { type: 'string' } }, required: ['query'] } },
    { name: 'doctortablet_delete_note', description: 'Delete a note from Doctor Tablet vault and GitHub repo', inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'Relative file path, e.g. notes/Kebugaran-Fisik.md' } }, required: ['filePath'] } },
    { name: 'doctortablet_export_merged_document', description: 'Export and merge all medical notes under a category and subcategories into a single continuous Markdown document with Table of Contents', inputSchema: { type: 'object', properties: { categoryId: { type: 'string', description: 'Target category/folder ID (e.g. Kuliah-Kardiologi)' }, title: { type: 'string', description: 'Custom document title' } } } },
  ];
}

// ═══════════════════════════════════════════════════════════════
// AUTH HELPERS
// ═══════════════════════════════════════════════════════════════

async function sbFetch(url, options = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt === retries) throw err;
      const msg = err.message || '';
      const code = err.code || err.cause?.code || '';
      if (
        msg.includes('fetch failed') ||
        code === 'UND_ERR_SOCKET' ||
        code === 'UND_ERR_CONNECT_TIMEOUT' ||
        err.name === 'TypeError'
      ) {
        await new Promise(r => setTimeout(r, 150 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function authenticateApiKey(rawKey, supabaseUrl, sbKey) {
  const encoder = new TextEncoder();
  const data = encoder.encode(rawKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const keyHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const rpcRes = await sbFetch(`${supabaseUrl}/rest/v1/rpc/validate_api_key`, {
    method: 'POST',
    headers: {
      'apikey': sbKey,
      'Authorization': `Bearer ${sbKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ p_key_hash: keyHash })
  });

  if (!rpcRes.ok) {
    return { error: 'Key validation failed' };
  }

  const rows = await rpcRes.json();
  if (!rows || rows.length === 0) {
    return { error: 'Invalid, expired, or revoked API key' };
  }

  const { out_key_id: keyId, out_user_id: userId } = rows[0];

  const userRes = await sbFetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
  });

  if (!userRes.ok) {
    return { error: 'User not found for this API key' };
  }

  const userData = await userRes.json();

  return {
    isApiKey: true,
    keyId,
    userId,
    email: userData.email,
    token: rawKey,
    userMetadata: userData.user_metadata || {}
  };
}

async function authenticateJWT(token, supabaseUrl, sbKey) {
  const userRes = await sbFetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      'apikey': sbKey,
      'Authorization': `Bearer ${token}`
    }
  });

  if (!userRes.ok) {
    return { error: 'Invalid JWT token' };
  }

  const userData = await userRes.json();

  return {
    isApiKey: false,
    keyId: null,
    userId: userData.id,
    email: userData.email,
    token: token,
    userMetadata: userData.user_metadata || {}
  };
}

function canonicalizeUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    const scheme = parsed.protocol.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    const port = (parsed.port && parsed.port !== '80' && parsed.port !== '443') ? `:${parsed.port}` : '';
    let pathname = parsed.pathname.replace(/\/+$/, '');
    return `${scheme}//${host}${port}${pathname}`;
  } catch (e) {
    return rawUrl.trim().toLowerCase().replace(/\/+$/, '');
  }
}

async function authenticateOAuthAccessToken(token, supabaseUrl, sbKey, reqHost = 'mr-capsules.vercel.app') {
  const res = await sbFetch(`${supabaseUrl}/rest/v1/oauth_tokens?access_token=eq.${encodeURIComponent(token)}&revoked=eq.false&select=*`, {
    headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
  });

  if (!res.ok) {
    console.error(`[OAuth Token Verification Failure] timestamp="${new Date().toISOString()}" reason="Database lookup failed" token="${token.slice(0, 15)}..."`);
    return { error: 'OAuth token lookup failed' };
  }

  const rows = await res.json();
  if (!rows || rows.length === 0) {
    console.error(`[OAuth Token Verification Failure] timestamp="${new Date().toISOString()}" reason="Invalid or revoked token" token="${token.slice(0, 15)}..."`);
    return { error: 'Invalid, revoked, or non-existent OAuth token' };
  }

  const tokenRecord = rows[0];
  if (new Date(tokenRecord.expires_at) < new Date()) {
    console.error(`[OAuth Token Verification Failure] timestamp="${new Date().toISOString()}" reason="Token expired" token="${token.slice(0, 15)}..." sub="${tokenRecord.user_email}"`);
    return { error: 'OAuth token expired' };
  }

  // RFC 8707 Canonical Audience Check — with flexible host/alias matching
  const canonicalServerUrl = canonicalizeUrl(`https://${reqHost}/api/mcp`);
  const canonicalServerHost = canonicalizeUrl(`https://${reqHost}`);
  const defaultServerUrl = canonicalizeUrl(`https://mr-capsules.vercel.app/api/mcp`);
  const defaultServerHost = canonicalizeUrl(`https://mr-capsules.vercel.app`);
  const tokenAudience = canonicalizeUrl(tokenRecord.resource);

  const matchesAudience = !tokenAudience ||
    tokenAudience === canonicalServerUrl ||
    tokenAudience === canonicalServerHost ||
    tokenAudience === defaultServerUrl ||
    tokenAudience === defaultServerHost ||
    tokenAudience.includes('mr-capsules');

  if (!matchesAudience) {
    console.error(`[OAuth Token Audience Mismatch] timestamp="${new Date().toISOString()}" expected="${canonicalServerUrl}" received="${tokenAudience}" sub="${tokenRecord.user_email}"`);
    return { error: 'OAuth token audience mismatch: token resource does not match server URI' };
  }

  return {
    isApiKey: false,
    keyId: null,
    userId: tokenRecord.user_id,
    email: tokenRecord.user_email,
    token: token,
    userMetadata: {}
  };
}

// ═══════════════════════════════════════════════════════════════
// ROLE RESOLVER — resolves roles & division membership
// ═══════════════════════════════════════════════════════════════

async function resolveRoles(userId, email, supabaseUrl, sbKey, superAdminEmail) {
  const isSuperAdmin = email === superAdminEmail;

  const encEmail = encodeURIComponent(email || '');
  const roleRes = await sbFetch(`${supabaseUrl}/rest/v1/user_roles?identifier=eq.${encEmail}&select=role`, {
    headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
  });
  let hasAdminRole = false;
  if (roleRes.ok) {
    const roleData = await roleRes.json();
    hasAdminRole = Array.isArray(roleData) && roleData.length > 0 && roleData[0].role === 'admin';
  }

  let divisionId = null;
  const divRes = await sbFetch(`${supabaseUrl}/rest/v1/division_members?user_id=eq.${userId}&select=division_id`, {
    headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
  });
  if (divRes.ok) {
    const divData = await divRes.json();
    if (Array.isArray(divData) && divData.length > 0) {
      divisionId = divData[0].division_id;
    }
  }

  // Fallback: If no division found by userId, look up real Supabase auth user by email
  if (!divisionId && email && sbKey) {
    try {
      const sbUsersRes = await sbFetch(`${supabaseUrl}/auth/v1/admin/users?per_page=1000`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      if (sbUsersRes.ok) {
        const usersData = await sbUsersRes.json();
        const matchedUser = (usersData.users || []).find(u => u.email === email);
        if (matchedUser && matchedUser.id !== userId) {
          const fallbackDivRes = await sbFetch(`${supabaseUrl}/rest/v1/division_members?user_id=eq.${matchedUser.id}&select=division_id`, {
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
          });
          if (fallbackDivRes.ok) {
            const fbData = await fallbackDivRes.json();
            if (Array.isArray(fbData) && fbData.length > 0) {
              divisionId = fbData[0].division_id;
            }
          }
        }
      }
    } catch(e) {}
  }

  const isAdmin = isSuperAdmin || hasAdminRole;
  const hasDivision = divisionId !== null;

  return {
    isSuperAdmin,
    isAdmin,
    hasDivision,
    divisionId,
    isManagement: divisionId === 'management' || isAdmin,
    isDeveloper: divisionId === 'development' || isAdmin,
    isReviewer: divisionId === 'review' || isAdmin,
    canUseApiKeys: !!userId
  };
}

// ═══════════════════════════════════════════════════════════════
// RATE LIMIT CHECKER
// ═══════════════════════════════════════════════════════════════

async function checkRateLimit(keyId, supabaseUrl, sbKey) {
  const rpcRes = await sbFetch(`${supabaseUrl}/rest/v1/rpc/check_and_increment_rate_limit`, {
    method: 'POST',
    headers: {
      'apikey': sbKey,
      'Authorization': `Bearer ${sbKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ p_key_id: keyId })
  });
  if (!rpcRes.ok) return true; // Fail open
  const allowed = await rpcRes.json();
  return allowed === true;
}

// ═══════════════════════════════════════════════════════════════
// GITHUB API HELPER
// ═══════════════════════════════════════════════════════════════

async function ghApi(method, endpoint, bodyObj, githubToken, owner, repo) {
  let res = await fetch(`https://api.github.com/repos/${owner}/${repo}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });

  if (!res.ok && res.status === 404 && repo !== 'MR-CAPSULES' && method === 'GET') {
    res = await fetch(`https://api.github.com/repos/${owner}/MR-CAPSULES${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: bodyObj ? JSON.stringify(bodyObj) : undefined
    });
  }

  return res;
}

// ═══════════════════════════════════════════════════════════════
// METHOD ROUTER
// ═══════════════════════════════════════════════════════════════

async function routeMethod(method, params, auth, roles, cfg) {
  const { SUPABASE_URL: su, SB_SERVICE_KEY: sk, GITHUB_TOKEN: gt, GH_OWNER: go, GH_REPO: gr, GH_CODEBASE_REPO: gcr = 'MR-CAPSULES', MAX_KEYS_PER_USER: maxKeys, SUPERADMIN_EMAIL } = cfg;

  validateToolArguments(method, params);

  const m = (method || '').replace(/\./g, '_');

  if (m === 'system_health') {
    return {
      status: 'healthy',
      version: '1.0.0',
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      authenticated_user: auth.email,
      roles: {
        isSuperAdmin: roles.isSuperAdmin,
        isAdmin: roles.isAdmin,
        division: roles.divisionId || 'None'
      }
    };
  }

  if (m === 'apikeys_list') {
    if (!roles.canUseApiKeys) throw err403('Authenticated account required to manage API keys');
    return listApiKeys(auth.userId, su, sk);
  }
  if (m === 'apikeys_create') {
    if (!roles.canUseApiKeys) throw err403('Authenticated account required to create API keys');
    return createApiKey(auth.userId, params, su, sk, maxKeys);
  }
  if (m === 'apikeys_revoke') {
    if (!roles.canUseApiKeys) throw err403('Authenticated account required to revoke API keys');
    const res = await revokeApiKey(auth.userId, params, su, sk);
    await logAction(auth.email, 'mcp_apikey_revoke', { key_id: params.key_id }, su, sk);
    return res;
  }
  if (m === 'oauth_tokens_list') {
    if (!roles.canUseApiKeys) throw err403('Authenticated account required to view OAuth tokens');
    return listOAuthTokens(auth.userId, auth.email, roles.isSuperAdmin, su, sk);
  }
  if (m === 'oauth_tokens_revoke') {
    if (!roles.canUseApiKeys) throw err403('Authenticated account required to revoke OAuth tokens');
    if (!params.token_id && !params.access_token) throw err400('Missing params.token_id or params.access_token');
    const res = await revokeOAuthToken(params.token_id || params.access_token, su, sk);
    await logAction(auth.email, 'mcp_oauth_revoke', { token_id: params.token_id || params.access_token }, su, sk);
    return res;
  }

  if (m === 'content_list') return contentList(params, gt, go, gr);
  if (m === 'content_search') {
    if (!params.query) throw err400('Missing params.query');
    return contentSearch(params, gt, go, gr, cfg.reqHost);
  }
  if (m === 'content_get') {
    if (!params.path) throw err400('Missing params.path');
    return contentGet(params, gt, go, gr, cfg.reqHost);
  }
  if (m === 'content_tree') return contentTree(params, gt, go, gr);
  if (m === 'content_upload') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required to upload');
    if (!params.path || (!params.contentBase64 && !params.url)) throw err400('Missing params.path, params.contentBase64, or params.url');
    validatePath(params.path);
    return contentUpload(params, auth.email, gt, go, gr, su, sk);
  }
  if (m === 'content_upload_from_agent_path') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required to upload');
    if (!params.agentFilePath || !params.targetPath) throw err400('Missing params.agentFilePath or params.targetPath');
    validatePath(params.targetPath);
    return contentUploadFromAgentPath(params, auth, cfg.reqHost, gt, go, gr);
  }
  if (m === 'content_pull_to_sandbox') {
    if (!params.path) throw err400('Missing params.path');
    return contentPullToSandbox(params, gt, go, gr, cfg.reqHost);
  }
  if (m === 'upload_init') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required to upload');
    if (!params.path || !params.totalChunks) throw err400('Missing params.path or params.totalChunks');
    validatePath(params.path);
    return uploadInit(params, auth.email, su, sk);
  }
  if (m === 'upload_chunk') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required to upload');
    return uploadChunk(params, auth.email, su, sk);
  }
  if (m === 'upload_commit') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required to upload');
    return uploadCommit(params, auth.email, gt, go, gr, su, sk);
  }
  if (m === 'upload_status') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required');
    return uploadStatus(params, su, sk);
  }
  if (m === 'upload_cancel') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required');
    return uploadCancel(params, auth.email, su, sk);
  }
  if (m === 'content_delete') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required to delete');
    if (!params.path && !params.paths) throw err400('Missing params.path or params.paths');
    return contentDelete(params, auth.email, gt, go, gr, su, sk);
  }
  if (m === 'content_rename') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required to rename');
    if (!params.path || !params.newPath) throw err400('Missing params.path or params.newPath');
    validatePath(params.path);
    validatePath(params.newPath);
    return contentRename(params, auth.email, gt, go, gr, su, sk);
  }

  if (m === 'tasks_list') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required');
    return tasksList(params, su, sk);
  }
  if (m === 'tasks_create') {
    if (!roles.isManagement) throw err403('Management division only');
    return tasksCreate(params, auth.userId, su, sk);
  }
  if (m === 'tasks_claim') {
    if (!roles.isDeveloper) throw err403('Development division only');
    if (!params.task_id) throw err400('Missing params.task_id');
    return tasksClaim(params.task_id, auth.userId, su, sk);
  }
  if (m === 'tasks_submit') {
    if (!roles.isDeveloper) throw err403('Development division only');
    if (!params.task_id) throw err400('Missing params.task_id');
    return tasksSubmit(params.task_id, auth.userId, su, sk);
  }
  if (m === 'tasks_approve') {
    if (!roles.isReviewer) throw err403('Review division only');
    if (!params.task_id) throw err400('Missing params.task_id');
    return tasksApprove(params.task_id, auth.userId, su, sk);
  }
  if (m === 'tasks_reject') {
    if (!roles.isReviewer) throw err403('Review division only');
    if (!params.task_id) throw err400('Missing params.task_id');
    return tasksReject(params.task_id, params.note || '', auth.userId, su, sk);
  }
  if (m === 'tasks_logs') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required');
    if (!params.task_id) throw err400('Missing params.task_id');
    return tasksGetLogs(params.task_id, su, sk);
  }
  if (m === 'tasks_unclaim') {
    if (!roles.isDeveloper) throw err403('Development division only');
    if (!params.task_id) throw err400('Missing params.task_id');
    return tasksUnclaim(params.task_id, auth.userId, su, sk);
  }
  if (m === 'tasks_start_review') {
    if (!roles.isReviewer) throw err403('Review division only');
    if (!params.task_id) throw err400('Missing params.task_id');
    return tasksStartReview(params.task_id, auth.userId, su, sk);
  }
  if (m === 'tasks_add_note') {
    if (!params.task_id || !params.note) throw err400('Missing params.task_id or params.note');
    return tasksAddNote(params.task_id, auth.userId, params.note, su, sk);
  }
  if (m === 'tasks_reset_phase') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required');
    if (!params.task_id || !params.note) throw err400('Missing params.task_id or params.note');
    return tasksResetPhase(params.task_id, params.new_status, params.unassign, params.note, auth.userId, su, sk);
  }
  if (m === 'tasks_re_review') {
    if (!roles.isReviewer && !roles.isManagement && !roles.isAdmin) throw err403('Reviewers or Management required');
    if (!params.task_id || !params.note) throw err400('Missing params.task_id or params.note');
    return tasksReReview(params.task_id, params.note, auth.userId, su, sk);
  }
  if (m === 'tasks_retrack') {
    if (!roles.isManagement && !roles.isAdmin) throw err403('Management or Admin required');
    if (!params.task_id || !params.note) throw err400('Missing params.task_id or params.note');
    return tasksRetrack(params.task_id, params.note, auth.userId, su, sk);
  }
  if (m === 'tasks_resubmit') {
    if (!params.task_id || !params.note) throw err400('Missing params.task_id or params.note');
    return tasksResubmit(params.task_id, params.note, auth.userId, su, sk);
  }

  if (m === 'divisions_list') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required');
    return divisionsList(su, sk);
  }
  if (m === 'divisions_my') return divisionsMyDivision(auth.userId, su, sk);
  if (m === 'divisions_join') {
    if (!params.division_id) throw err400('Missing params.division_id');
    return divisionsJoin(auth.userId, params.division_id, params.whatsapp || '', su, sk);
  }
  if (m === 'divisions_update_whatsapp') {
    if (!params.whatsapp) throw err400('Missing params.whatsapp');
    return divisionsUpdateWhatsapp(auth.userId, params.whatsapp, su, sk);
  }
  if (m === 'divisions_get_members') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required');
    return divisionsGetMembers(params.division_id, su, sk);
  }

  if (m === 'cover_list') return coverList(gt, go, gr);
  if (m === 'cover_upload') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required to upload cover');
    if (!params.filename || !params.contentBase64) throw err400('Missing params.filename or params.contentBase64');
    const path = params.filename.startsWith('cover/') ? params.filename : `cover/${params.filename}`;
    validatePath(path);
    return contentUpload({ path, contentBase64: params.contentBase64 }, auth.email, gt, go, gr, su, sk);
  }
  if (m === 'cover_delete') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required to delete cover');
    if (!params.filename) throw err400('Missing params.filename');
    const path = params.filename.startsWith('cover/') ? params.filename : `cover/${params.filename}`;
    validatePath(path);
    return contentDelete({ path }, auth.email, gt, go, gr, su, sk);
  }

  if (m === 'docs_get') return docsGet(params, gt, go, gr, cfg.reqHost);
  if (m === 'docs_update_section') {
    if (!roles.isAdmin) throw err403('Admin only to edit documentation');
    return docsUpdateSection(params, auth.email, gt, go, gr, su, sk);
  }
  if (m === 'docs_add_section') {
    if (!roles.isAdmin) throw err403('Admin only to edit documentation');
    return docsAddSection(params, auth.email, gt, go, gr, su, sk);
  }

  if (m === 'users_remove_device') {
    if (!params.user_id || !params.device_id) throw err400('Missing params.user_id or params.device_id');
    const isSelf = auth.userId === params.user_id;
    if (!isSelf && !roles.isAdmin) throw err403('Admin or account owner required');
    return usersRemoveDevice(params.user_id, params.device_id, auth.email, su, sk);
  }
  if (m === 'users_block_device') {
    if (!roles.isAdmin) throw err403('Admin only');
    if (!params.device_id || params.banned === undefined) throw err400('Missing params.device_id or params.banned');
    return usersBlockDevice(params.device_id, params.banned, auth.email, su, sk);
  }

  if (m === 'account_manager' || m === 'account_manage' || m === 'users_manage_account') {
    return handleAccountManager(params, auth, roles, su, sk, SUPERADMIN_EMAIL);
  }
  if (m === 'users_create' || m === 'account_create') {
    if (!roles.isAdmin && !roles.isSuperAdmin) throw err403('Admin or SuperAdmin only');
    return handleAccountManager({ ...params, action: 'create' }, auth, roles, su, sk, SUPERADMIN_EMAIL);
  }

  if (m === 'users_list') {
    if (!roles.isSuperAdmin) throw err403('SuperAdmin only');
    return usersList(su, sk);
  }
  if (m === 'users_ban') {
    if (!roles.isSuperAdmin) throw err403('SuperAdmin only');
    if (!params.user_id || params.banned === undefined) throw err400('Missing params.user_id or params.banned');
    return usersBan(params.user_id, params.banned, auth.email, su, sk);
  }
  if (m === 'users_reset_password') {
    if (!roles.isAdmin && !roles.isSuperAdmin) throw err403('Admin only');
    if (!params.new_password) throw err400('Missing params.new_password');
    return usersResetPassword(params.user_id, params.email, params.new_password, auth.email, su, sk);
  }
  if (m === 'users_delete') {
    if (!roles.isSuperAdmin) throw err403('SuperAdmin only');
    if (!params.user_id) throw err400('Missing params.user_id');
    return usersDelete(params.user_id, su, sk);
  }
  if (m === 'users_add_admin') {
    if (!roles.isSuperAdmin) throw err403('SuperAdmin only');
    if (!params.email) throw err400('Missing params.email');
    return usersAddAdmin(params.email, auth.email, su, sk);
  }
  if (m === 'users_remove_admin') {
    if (!roles.isSuperAdmin) throw err403('SuperAdmin only');
    if (!params.email) throw err400('Missing params.email');
    return usersRemoveAdmin(params.email, auth.email, su, sk);
  }

  if (m === 'divisions_add_member') {
    if (!roles.isAdmin) throw err403('Admin only');
    if (!params.user_id || !params.division_id) throw err400('Missing params.user_id or params.division_id');
    return divisionsAddMember(params.user_id, params.division_id, params.whatsapp || '', auth.email, su, sk);
  }
  if (m === 'divisions_remove_member') {
    if (!roles.isAdmin) throw err403('Admin only');
    if (!params.user_id || !params.division_id) throw err400('Missing params.user_id or params.division_id');
    return divisionsRemoveMember(params.user_id, params.division_id, auth.email, su, sk);
  }

  if (m === 'content_delete_files') {
    if (!roles.hasDivision && !roles.isAdmin) throw err403('Division membership required to delete files');
    if (!params.paths || !Array.isArray(params.paths) || params.paths.length === 0) throw err400('Missing params.paths array');
    params.paths.forEach(p => validatePath(p));
    return contentDeleteFiles(params.paths, auth.email, gt, go, gr, su, sk);
  }

  if (m === 'tasks_delete') {
    if (!roles.isManagement && !roles.isAdmin) throw err403('Management or Admin only');
    if (!params.task_id) throw err400('Missing params.task_id');
    return tasksDelete(params.task_id, auth.email, su, sk);
  }

  if (m === 'config_get') {
    if (!roles.isAdmin) throw err403('Admin only');
    return configGet(su, sk);
  }
  if (m === 'config_update') {
    if (!roles.isAdmin) throw err403('Admin only');
    return configUpdate(params, auth.email, su, sk);
  }

  if (m === 'contributions_leaderboard') return contributionsLeaderboard(su, sk);
  if (m === 'contributions_my') return contributionsMy(auth.userId, su, sk);
  if (m === 'contributions_record') {
    if (!roles.isManagement && !roles.isAdmin) throw err403('Management or Admin only');
    return contributionsRecord(params, auth.email, su, sk);
  }

  if (m === 'review_issues') {
    if (!roles.isReviewer) throw err403('Review division only');
    if (!params.task_id) throw err400('Missing params.task_id');
    return reviewIssuesList(params.task_id, su, sk);
  }
  if (m === 'review_report') {
    if (!roles.isReviewer) throw err403('Review division only');
    return reviewIssuesReport(params, auth.userId, su, sk);
  }
  if (m === 'review_resolve') {
    if (!roles.isReviewer) throw err403('Review division only');
    if (!params.issue_id) throw err400('Missing params.issue_id');
    return reviewIssuesResolve(params.issue_id, su, sk);
  }
  if (m === 'review_delete_issue') {
    if (!roles.isReviewer && !roles.isAdmin) throw err403('Reviewer or Admin only');
    if (!params.issue_id) throw err400('Missing params.issue_id');
    const res = await reviewIssuesDelete(params.issue_id, su, sk);
    await logAction(auth.email, 'mcp_review_delete_issue', { issue_id: params.issue_id }, su, sk);
    return res;
  }

  if (m === 'activity_logs') {
    if (!roles.isAdmin) throw err403('Admin only');
    return activityLogsList(params.limit || 100, su, sk);
  }

  if (m === 'system_cleanup_guests') {
    if (!roles.isAdmin) throw err403('Admin only');
    return systemCleanupGuests(su, sk);
  }

  if (m === 'codebase_read_file') {
    if (!roles.isSuperAdmin) throw err403('SuperAdmin only to access codebase files');
    if (!params.path) throw err400('Missing params.path');
    validateCodebasePath(params.path);
    return codebaseReadFile(params, auth.email, gt, go, gcr, su, sk);
  }
  if (m === 'codebase_write_file') {
    if (!roles.isSuperAdmin) throw err403('SuperAdmin only to modify codebase files');
    if (!params.path || !params.contentBase64) throw err400('Missing params.path or params.contentBase64');
    validateCodebasePath(params.path);
    return codebaseWriteFile(params, auth.email, gt, go, gcr, su, sk);
  }
  if (m === 'codebase_delete_file') {
    if (!roles.isSuperAdmin) throw err403('SuperAdmin only to delete codebase files');
    if (!params.path) throw err400('Missing params.path');
    validateCodebasePath(params.path);
    return codebaseDeleteFile(params, auth.email, gt, go, gcr, su, sk);
  }
  if (m === 'codebase_search') {
    if (!roles.isSuperAdmin) throw err403('SuperAdmin only');
    if (!params.query) throw err400('Missing params.query');
    return codebaseSearch(params.query, gt, go, gcr);
  }
  if (m === 'mcp_create_tool') {
    if (!roles.isSuperAdmin) throw err403('SuperAdmin only to create custom MCP tools');
    return mcpCreateTool(params, auth.email, su, sk, roles);
  }
  if (m === 'mcp_delete_tool') {
    if (!roles.isAdmin) throw err403('Admin or SuperAdmin only to delete custom MCP tools');
    return mcpDeleteTool(params, auth.email, su, sk);
  }
  if (m === 'mcp_list_custom_tools') {
    return mcpListCustomTools(su, sk);
  }

  // Doctor Tablet Tool Routing
  if (m.startsWith('doctortablet_')) {
    return handleDoctorTabletMethod(m, params, gt);
  }

  // Check if requested method matches a dynamic custom tool created at runtime
  const activeCustomTools = await getActiveCustomTools(su, sk);
  const customTool = activeCustomTools.find(ct => ct.name === m);
  if (customTool) {
    return executeCustomTool(customTool, params, auth, roles, su, sk, gt);
  }

  throw err400(`Unknown method: ${method}`);
}

// ═══════════════════════════════════════════════════════════════
// ERROR HELPERS
// ═══════════════════════════════════════════════════════════════

function err400(msg) { const e = new Error(msg); e.statusCode = 400; return e; }
function err403(msg) { const e = new Error(msg); e.statusCode = 403; return e; }
function err404(msg) { const e = new Error(msg); e.statusCode = 404; return e; }

function sanitizeAndNormalizePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') throw err400('Path must be a non-empty string');
  let clean = rawPath.replace(/\0/g, '');
  try {
    clean = decodeURIComponent(clean);
  } catch (e) {}
  clean = clean.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (clean.includes('..') || clean.includes('./') || clean.startsWith('/') || clean.toLowerCase().includes('%2e%2e')) {
    throw err400('Invalid path: directory traversal is strictly forbidden');
  }
  return clean.trim();
}

function validatePath(path) {
  const cleanPath = sanitizeAndNormalizePath(path);
  if (!cleanPath.startsWith('content/') && !cleanPath.startsWith('cover/')) {
    throw err400('Path must start with content/ or cover/');
  }
  return cleanPath;
}

function validateCodebasePath(path) {
  const cleanPath = sanitizeAndNormalizePath(path);
  const forbiddenFiles = [
    '.env', '.env.local', '.env.production', '.env.development',
    'vercel.json', '.vercel', 'package-lock.json'
  ];
  const lower = cleanPath.toLowerCase();
  if (forbiddenFiles.includes(lower) || lower.startsWith('.git') || lower.startsWith('.github/secrets')) {
    throw err403(`Access denied: Access to sensitive codebase file "${cleanPath}" is strictly prohibited.`);
  }
  return cleanPath;
}

function validateToolArguments(method, params) {
  if (params === null || params === undefined) {
    params = {};
  }
  if (typeof params !== 'object') {
    throw err400('Invalid params format: must be a JSON object');
  }

  const m = (method || '').replace(/\./g, '_');
  const tools = getMcpToolsList();
  const toolDef = tools.find(t => t.name === m);

  if (!toolDef || !toolDef.inputSchema) return;

  const schema = toolDef.inputSchema;
  const required = schema.required || [];
  const props = schema.properties || {};

  for (const reqField of required) {
    if (params[reqField] === undefined || params[reqField] === null || params[reqField] === '') {
      throw err400(`Missing required parameter: params.${reqField}`);
    }
  }

  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null || val === '') continue;
    const propSchema = props[key];
    if (!propSchema) continue;

    if (propSchema.type === 'string') {
      if (typeof val !== 'string') throw err400(`Invalid type for params.${key}: expected string`);
      const isLargePayload = key.toLowerCase().includes('base64') || key.toLowerCase().includes('content');
      const maxLen = isLargePayload ? 5242880 : 20000;
      if (val.length > maxLen) throw err400(`Parameter params.${key} exceeds maximum allowed length`);
    } else if (propSchema.type === 'number') {
      const numVal = Number(val);
      if (Number.isNaN(numVal)) throw err400(`Invalid type for params.${key}: expected number`);
      params[key] = numVal;
    } else if (propSchema.type === 'boolean') {
      if (typeof val !== 'boolean') throw err400(`Invalid type for params.${key}: expected boolean`);
    } else if (propSchema.type === 'array') {
      if (!Array.isArray(val)) throw err400(`Invalid type for params.${key}: expected array`);
      if (key === 'paths' && val.length > 20) throw err400(`Parameter params.${key} exceeds maximum limit of 20 items per request`);
    }

    if (propSchema.enum && !propSchema.enum.includes(val)) {
      throw err400(`Invalid value for params.${key}: must be one of [${propSchema.enum.join(', ')}]`);
    }
  }

  if (m === 'upload_init') {
    if (!Number.isInteger(params.totalChunks) || params.totalChunks < 1 || params.totalChunks > 500) {
      throw err400('params.totalChunks must be an integer between 1 and 500');
    }
  }
}

async function codebaseReadFile(paramsOrPath, adminEmail, githubToken, owner, repo, su, sk) {
  const isString = typeof paramsOrPath === 'string';
  const path = isString ? paramsOrPath : paramsOrPath.path;
  const params = isString ? {} : paramsOrPath;

  const cleanPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}`, {
    headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'MR-CAPSULES-MCP' }
  });
  if (!res.ok) throw new Error(`Failed to read codebase file ${path}: ${res.statusText}`);
  const data = await res.json();
  if (data.type !== 'file') throw err400(`Path ${path} is a ${data.type}, not a file`);
  const contentUtf8 = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
  await logAction(adminEmail, 'mcp_codebase_read', { path }, su, sk);

  const lines = contentUtf8.split('\n');
  const totalLines = lines.length;

  if (params.start_line !== undefined || params.end_line !== undefined) {
    const start = Math.max(1, parseInt(params.start_line) || 1);
    const end = Math.min(totalLines, Math.max(start, parseInt(params.end_line) || (start + 100)));
    const sliced = lines.slice(start - 1, end).join('\n');
    return {
      path,
      total_lines: totalLines,
      slice: { start_line: start, end_line: end, returned_lines: end - start + 1 },
      content: sliced,
      sha: data.sha,
      size: data.size
    };
  }

  if (contentUtf8.length > 40000 && params.force !== true) {
    const sliced = lines.slice(0, 100).join('\n');
    return {
      path,
      total_lines: totalLines,
      slice: { start_line: 1, end_line: 100, returned_lines: 100 },
      content: sliced,
      truncated: true,
      sha: data.sha,
      size: data.size,
      warning: `File is large (${(data.size / 1024).toFixed(1)} KB, ${totalLines} lines). Showing first 100 lines. Call with start_line and end_line, or pass force: true for full file.`
    };
  }

  return { path, total_lines: totalLines, content: contentUtf8, sha: data.sha, size: data.size };
}

async function codebaseWriteFile(params, adminEmail, githubToken, owner, repo, su, sk) {
  const { path, contentBase64, commitMessage } = params;
  const message = commitMessage || `mcp: update codebase file ${path}`;
  const uploadRes = await contentUpload(
    { path, contentBase64, isChunkedCommit: true },
    adminEmail,
    githubToken,
    owner,
    repo,
    su,
    sk
  );
  await logAction(adminEmail, 'mcp_codebase_write', { path, message }, su, sk);
  return { success: true, path, sha: uploadRes.sha, message };
}

async function codebaseDeleteFile(params, adminEmail, githubToken, owner, repo, su, sk) {
  const { path } = params;
  const delRes = await contentDelete({ path }, adminEmail, githubToken, owner, repo, su, sk);
  await logAction(adminEmail, 'mcp_codebase_delete', { path }, su, sk);
  return { success: true, path };
}

async function codebaseSearch(query, githubToken, owner, repo) {
  const searchRes = await fetch(`https://api.github.com/search/code?q=${encodeURIComponent(query)}+repo:${owner}/${repo}`, {
    headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'MR-CAPSULES-MCP' }
  });
  if (!searchRes.ok) throw new Error(`Code search failed: ${searchRes.statusText}`);
  const data = await searchRes.json();
  const items = (data.items || []).slice(0, 30).map(item => ({
    name: item.name,
    path: item.path,
    sha: item.sha,
    url: item.html_url
  }));
  return { total_count: data.total_count, query, matches: items };
}

async function codebaseGitHistory(limit, githubToken, owner, repo) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=${limit}`, {
    headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'MR-CAPSULES-MCP' }
  });
  if (!res.ok) throw new Error('Failed to fetch commit history');
  const commitsData = await res.json();
  const commits = (commitsData || []).map(c => ({
    sha: c.sha ? c.sha.substring(0, 7) : '',
    full_sha: c.sha,
    message: c.commit ? c.commit.message : '',
    author: c.commit && c.commit.author ? c.commit.author.name : '',
    date: c.commit && c.commit.author ? c.commit.author.date : ''
  }));
  return { limit, commits };
}

// ═══════════════════════════════════════════════════════════════
// DYNAMIC CUSTOM MCP TOOLS ENGINE
// ═══════════════════════════════════════════════════════════════
const customMcpToolsMap = new Map();

async function getActiveCustomTools(su, sk) {
  try {
    const res = await fetch(`${su}/rest/v1/activity_logs?action=eq.mcp_custom_tool_def&order=time.asc`, {
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
    });
    if (!res.ok) return Array.from(customMcpToolsMap.values());
    const logs = await res.json();
    if (!Array.isArray(logs)) return Array.from(customMcpToolsMap.values());
    const activeTools = {};
    logs.forEach(log => {
      const details = log.details || {};
      if (details.deleted) {
        delete activeTools[details.name];
        customMcpToolsMap.delete(details.name);
      } else if (details.name && details.handler) {
        activeTools[details.name] = details;
        customMcpToolsMap.set(details.name, details);
      }
    });
    return Object.values(activeTools);
  } catch (e) {
    return Array.from(customMcpToolsMap.values());
  }
}

async function mcpCreateTool(params, adminEmail, su, sk, roles) {
  if (!roles || !roles.isSuperAdmin) {
    throw err403('SuperAdmin role required to create dynamic custom MCP tools.');
  }

  const { name, description, inputSchema, handler, minRole = 'admin' } = params;
  if (!name || !description || !handler) throw err400('Missing required fields: name, description, handler');

  const forbiddenPatterns = [
    /process\s*\./i,
    /process\s*\[/i,
    /process\s*env/i,
    /SUPABASE_SERVICE_ROLE_KEY/i,
    /SB_SERVICE_KEY/i,
    /GITHUB_TOKEN/i,
    /eval\s*\(/i,
    /Function\s*\(/i,
    /globalThis/i,
    /global\s*\./i,
    /import\s*\(/i,
    /require\s*\(/i
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(handler)) {
      throw err400(`Custom tool handler rejected: Contains forbidden security pattern matching ${pattern.toString()}`);
    }
  }

  const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  
  const toolDef = {
    name: cleanName,
    description,
    inputSchema: inputSchema || { type: 'object', properties: {} },
    handler,
    minRole,
    createdBy: adminEmail,
    createdAt: new Date().toISOString()
  };

  customMcpToolsMap.set(cleanName, toolDef);
  await logAction(adminEmail, 'mcp_custom_tool_def', toolDef, su, sk);

  return {
    success: true,
    name: cleanName,
    message: `Dynamic MCP tool "${cleanName}" created and registered successfully!`
  };
}

async function mcpDeleteTool(params, adminEmail, su, sk) {
  const { name } = params;
  if (!name) throw err400('Missing tool name');

  customMcpToolsMap.delete(name);
  await logAction(adminEmail, 'mcp_custom_tool_def', { name, deleted: true }, su, sk);

  return { success: true, name, message: `Custom MCP tool "${name}" deleted.` };
}

async function mcpListCustomTools(su, sk) {
  const tools = await getActiveCustomTools(su, sk);
  return { count: tools.length, tools };
}

async function executeCustomTool(toolDef, params, auth, roles, su, sk, gt) {
  const roleRank = { superadmin: 4, admin: 3, reviewer: 2, developer: 2, authenticated: 1 };
  const requiredRank = roleRank[toolDef.minRole || 'admin'] || 3;
  let userRank = 1;
  if (roles.isSuperAdmin) userRank = 4;
  else if (roles.isAdmin) userRank = 3;
  else if (roles.isReviewer || roles.isDeveloper) userRank = 2;

  if (userRank < requiredRank) {
    throw err403(`Permission denied: Tool "${toolDef.name}" requires ${toolDef.minRole} role.`);
  }

  try {
    const fn = new Function('params', 'auth', 'su', 'gt', 'fetch', `
      return (async () => {
        ${toolDef.handler}
      })();
    `);
    const result = await fn(params, auth, su, gt, fetch);
    return { success: true, tool: toolDef.name, result };
  } catch (err) {
    throw new Error(`Execution error in custom tool "${toolDef.name}": ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// API KEY HANDLERS
// ═══════════════════════════════════════════════════════════════

async function listApiKeys(userId, su, sk) {
  const res = await sbFetch(`${su}/rest/v1/api_keys?user_id=eq.${userId}&revoked_at=is.null&select=id,name,key_prefix,expires_at,last_used_at,request_count,created_at&order=created_at.desc`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (!res.ok) throw new Error('Failed to list API keys');
  const keys = await res.json();
  return { keys };
}

async function createApiKey(userId, params, su, sk, maxKeys) {
  const { name, expires_in_days } = params;
  if (!name || typeof name !== 'string' || name.trim().length === 0) throw err400('Missing or empty params.name');
  if (name.trim().length > 50) throw err400('Key name max 50 characters');

  const countRes = await sbFetch(`${su}/rest/v1/api_keys?user_id=eq.${userId}&revoked_at=is.null&select=id`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (countRes.ok) {
    const existing = await countRes.json();
    if (existing.length >= maxKeys) throw err400(`Maximum ${maxKeys} active API keys allowed. Revoke one first.`);
  }

  const rawBytes = new Uint8Array(32);
  crypto.getRandomValues(rawBytes);
  const rawHex = Array.from(rawBytes).map(b => b.toString(16).padStart(2,'0')).join('');
  const rawKey = `mrc_${rawHex}`;

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawKey));
  const keyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2,'0')).join('');
  const keyPrefix = rawKey.slice(0, 12);

  let expiresAt = null;
  const numDays = (expires_in_days !== undefined && expires_in_days !== null && expires_in_days !== '') ? Number(expires_in_days) : null;
  if (numDays !== null && !isNaN(numDays) && numDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() + numDays);
    expiresAt = d.toISOString();
  }

  const insertRes = await sbFetch(`${su}/rest/v1/api_keys`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ user_id: userId, name: name.trim(), key_hash: keyHash, key_prefix: keyPrefix, expires_at: expiresAt })
  });

  if (!insertRes.ok) throw new Error('Failed to create key: ' + await insertRes.text());
  const rows = await insertRes.json();
  const keyRecord = Array.isArray(rows) ? rows[0] : rows;

  return {
    raw_key: rawKey,
    key_prefix: keyPrefix,
    name: keyRecord ? keyRecord.name : name.trim(),
    expires_at: keyRecord ? keyRecord.expires_at : expiresAt,
    created_at: keyRecord ? keyRecord.created_at : new Date().toISOString(),
    warning: 'Copy this key now. It will not be shown again.'
  };
}

async function revokeApiKey(userId, params, su, sk) {
  const { key_id } = params;
  if (!key_id) throw err400('Missing params.key_id');

  const checkRes = await sbFetch(`${su}/rest/v1/api_keys?id=eq.${key_id}&user_id=eq.${userId}&select=id`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (checkRes.ok) {
    const rows = await checkRes.json();
    if (!rows || rows.length === 0) throw err403('Key not found or does not belong to you');
  }

  const revokeRes = await sbFetch(`${su}/rest/v1/api_keys?id=eq.${key_id}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revoked_at: new Date().toISOString() })
  });
  if (!revokeRes.ok) throw new Error('Failed to revoke key');
  return { revoked: true };
}

async function listOAuthTokens(userId, userEmail, isSuperAdmin, su, sk) {
  let query = `${su}/rest/v1/oauth_tokens?revoked=eq.false&select=access_token,client_id,user_id,user_email,resource,expires_at,created_at&order=created_at.desc`;
  if (!isSuperAdmin) {
    query += `&user_id=eq.${encodeURIComponent(userId)}`;
  }
  try {
    const res = await sbFetch(query, {
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
    });
    if (!res.ok) {
      return { tokens: [] };
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) return { tokens: [] };
    const tokens = rows.map(r => ({
      token_id: r.access_token,
      token_prefix: r.access_token ? `${r.access_token.slice(0, 12)}...` : 'mrc_oauth...',
      client_id: r.client_id,
      user_id: r.user_id,
      user_email: r.user_email || userEmail,
      resource: r.resource,
      expires_at: r.expires_at,
      created_at: r.created_at
    }));
    return { tokens };
  } catch (e) {
    console.error('Error listing oauth tokens:', e);
    return { tokens: [] };
  }
}

async function revokeOAuthToken(tokenIdOrAccessToken, su, sk) {
  const res = await sbFetch(`${su}/rest/v1/oauth_tokens?access_token=eq.${encodeURIComponent(tokenIdOrAccessToken)}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revoked: true })
  });
  if (!res.ok) throw new Error('Failed to revoke OAuth token');
  return { revoked: true };
}

// ═══════════════════════════════════════════════════════════════
// CONTENT HANDLERS
// ═══════════════════════════════════════════════════════════════

async function contentList(paramsOrGt, gtOrOwner, ownerOrRepo, repoOptional) {
  let params = {}, gt, owner, repo;
  if (typeof paramsOrGt === 'object' && paramsOrGt !== null) {
    params = paramsOrGt;
    gt = gtOrOwner;
    owner = ownerOrRepo;
    repo = repoOptional;
  } else {
    gt = paramsOrGt;
    owner = gtOrOwner;
    repo = ownerOrRepo;
  }

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`, {
    headers: { 'Authorization': `Bearer ${gt}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'MR-CAPSULES-MCP' }
  });
  if (!res.ok) throw new Error('GitHub API error fetching tree');
  const data = await res.json();

  const contentFiles = data.tree.filter(item =>
    item.type === 'blob' && item.path.startsWith('content/') && item.path.endsWith('.html')
  );

  const semFilter = params.semester ? String(params.semester).toLowerCase().replace(/^semester\s*/i, '') : null;
  const blockFilter = params.block ? String(params.block).toLowerCase() : null;
  const catFilter = params.category ? String(params.category).toLowerCase() : null;
  const searchFilter = params.search ? String(params.search).toLowerCase() : null;

  const isFilterActive = !!(semFilter || blockFilter || catFilter || searchFilter);
  const isCompact = params.compact === true || (!isFilterActive && params.compact !== false);

  const semMap = {};
  let matchedCount = 0;

  contentFiles.forEach(item => {
    const parts = item.path.split('/');
    const semName = parts.length >= 3 ? parts[1] : 'Other';
    const blkName = parts.length >= 3 ? parts[2] : (parts.length >= 2 ? parts[1] : 'Other');
    const fileName = parts[parts.length - 1];
    const fileParts = fileName.split('_');
    const category = fileParts.length > 1 ? fileParts[0] : 'Other';
    const name = fileParts.length > 1 ? fileParts.slice(1).join('_').replace('.html', '') : fileName.replace('.html', '');

    if (semFilter) {
      const cleanSem = semName.toLowerCase().replace(/^semester\s*/i, '');
      if (cleanSem !== semFilter) return;
    }
    if (blockFilter && blkName.toLowerCase() !== blockFilter) return;
    if (catFilter && !category.toLowerCase().includes(catFilter)) return;
    if (searchFilter && !name.toLowerCase().includes(searchFilter) && !fileName.toLowerCase().includes(searchFilter)) return;

    matchedCount++;

    if (!semMap[semName]) semMap[semName] = {};
    if (!semMap[semName][blkName]) semMap[semName][blkName] = {};
    if (!semMap[semName][blkName][category]) semMap[semName][blkName][category] = [];
    semMap[semName][blkName][category].push({ title: name, path: item.path, size_bytes: item.size });
  });

  if (isCompact && !isFilterActive) {
    const summary = Object.entries(semMap).map(([sem, blks]) => ({
      semester: sem,
      blocks: Object.entries(blks).map(([blk, cats]) => ({
        block: blk,
        total_files: Object.values(cats).reduce((acc, f) => acc + f.length, 0),
        categories: Object.keys(cats)
      }))
    }));
    return {
      compact: true,
      total_files: matchedCount,
      curriculum: summary,
      hint: "Call content_list with { semester: 'semester 2' } or { block: '2.5' } to list files, or use content_search({ query: 'keyword' })."
    };
  }

  const semesters = Object.entries(semMap).map(([semName, blocks]) => ({
    semester: semName,
    blocks: Object.entries(blocks).map(([blockName, cats]) => ({
      block: blockName,
      categories: Object.entries(cats).map(([catName, files]) => ({
        category: catName,
        files: files.map(f => ({ title: f.title, path: f.path }))
      }))
    }))
  }));

  return { compact: false, semesters, total_files: matchedCount };
}

async function contentSearch(params, githubToken, owner, repo, reqHost = 'mr-capsules.vercel.app') {
  const query = (params.query || '').toLowerCase().trim();
  if (!query) throw err400('Missing params.query');
  const semFilter = params.semester ? String(params.semester).toLowerCase().replace(/^semester\s*/i, '') : null;
  const blockFilter = params.block ? String(params.block).toLowerCase() : null;
  const catFilter = params.category ? String(params.category).toLowerCase() : null;
  const limit = Math.min(50, Math.max(1, parseInt(params.limit) || 20));

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`, {
    headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'MR-CAPSULES-MCP' }
  });
  if (!res.ok) throw new Error('GitHub API error fetching tree');
  const data = await res.json();

  const contentFiles = data.tree.filter(item =>
    item.type === 'blob' && item.path.startsWith('content/') && item.path.endsWith('.html')
  );

  const matches = [];

  for (const item of contentFiles) {
    const parts = item.path.split('/');
    const semName = parts.length >= 3 ? parts[1] : 'Other';
    const blkName = parts.length >= 3 ? parts[2] : (parts.length >= 2 ? parts[1] : 'Other');
    const fileName = parts[parts.length - 1];
    const fileParts = fileName.split('_');
    const category = fileParts.length > 1 ? fileParts[0] : 'Other';
    const title = fileParts.length > 1 ? fileParts.slice(1).join('_').replace('.html', '') : fileName.replace('.html', '');

    if (semFilter) {
      const cleanSem = semName.toLowerCase().replace(/^semester\s*/i, '');
      if (cleanSem !== semFilter) continue;
    }
    if (blockFilter && blkName.toLowerCase() !== blockFilter) continue;
    if (catFilter && !category.toLowerCase().includes(catFilter)) continue;

    const fullSearchable = `${title} ${fileName} ${category} ${blkName} ${semName}`.toLowerCase();
    if (fullSearchable.includes(query)) {
      const cleanPath = item.path.split('/').map(encodeURIComponent).join('/');
      matches.push({
        title,
        category,
        semester: semName,
        block: blkName,
        path: item.path,
        size_kb: item.size ? +(item.size / 1024).toFixed(1) : undefined,
        public_url: `https://${reqHost || 'mr-capsules.vercel.app'}/${cleanPath}`
      });
      if (matches.length >= limit) break;
    }
  }

  return {
    query: params.query,
    total_matches: matches.length,
    matches
  };
}

function extractSmartContent(html, format = 'smart', options = {}, reqHost = 'mr-capsules.vercel.app', filePath = '') {
  const cleanPath = filePath.split('/').map(encodeURIComponent).join('/');
  const publicUrl = `https://${reqHost || 'mr-capsules.vercel.app'}/${cleanPath}`;
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i) || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const title = titleMatch ? titleMatch[1].trim() : (filePath.split('/').pop() || 'Untitled');

  if (format === 'raw') {
    const isLarge = html.length > 50000;
    return {
      path: filePath,
      format: 'raw',
      size_bytes: html.length,
      warning: isLarge ? 'Payload > 50KB. Consider format: "smart" for up to 90% token reduction.' : undefined,
      content: html,
      public_url: publicUrl
    };
  }

  // Check for Quiz / Questions / Flashcards array in scripts
  const quizRegex = /(?:const|let|var|window\.)\s*([a-zA-Z0-9_]*(?:questions?|quizBank|quizPool|quizData|masterQuestions|flashcardsData)[a-zA-Z0-9_]*)\s*=\s*(\[[\s\S]*?\])\s*;/i;
  const match = html.match(quizRegex);
  let parsedQuiz = null;

  if (match) {
    try {
      const arrayStr = match[2];
      parsedQuiz = Function(`"use strict"; return (${arrayStr});`)();
    } catch (e) {
      parsedQuiz = null;
    }
  }

  if (format === 'metadata') {
    return {
      path: filePath,
      title,
      type: parsedQuiz ? 'quiz' : 'lecture',
      total_questions: parsedQuiz && Array.isArray(parsedQuiz) ? parsedQuiz.length : null,
      size_bytes: html.length,
      public_url: publicUrl
    };
  }

  if (format === 'quiz_only' || (format === 'smart' && parsedQuiz && Array.isArray(parsedQuiz) && parsedQuiz.length > 0)) {
    if (!parsedQuiz || !Array.isArray(parsedQuiz) || parsedQuiz.length === 0) {
      return {
        path: filePath,
        title,
        error: 'No structured quiz questions detected in this file.',
        public_url: publicUrl
      };
    }

    const offset = Math.max(0, parseInt(options.offset) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(options.limit) || (options.offset !== undefined ? 20 : 30)));
    const sliced = parsedQuiz.slice(offset, offset + limit);

    return {
      path: filePath,
      title,
      type: 'quiz',
      format: format,
      total_questions: parsedQuiz.length,
      pagination: {
        offset,
        limit,
        returned: sliced.length,
        has_more: offset + limit < parsedQuiz.length
      },
      questions: sliced,
      public_url: publicUrl
    };
  }

  // Lecture / Notes / Text extraction
  let cleanText = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '$1\n')
    .replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, ' | $1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

  const maxChars = parseInt(options.max_chars) || 40000;
  let truncated = false;
  if (cleanText.length > maxChars) {
    cleanText = cleanText.slice(0, maxChars) + `\n\n[... Truncated due to size (${cleanText.length} chars). Use public_url to read online ...]`;
    truncated = true;
  }

  return {
    path: filePath,
    title,
    type: 'lecture_notes',
    format: 'text',
    truncated,
    length_chars: cleanText.length,
    original_size_bytes: html.length,
    content: cleanText,
    public_url: publicUrl
  };
}

async function contentGet(paramsOrPath, githubToken, owner, repo, reqHost = 'mr-capsules.vercel.app') {
  const isString = typeof paramsOrPath === 'string';
  const path = isString ? paramsOrPath : paramsOrPath.path;
  const format = (!isString && paramsOrPath.format) ? paramsOrPath.format : (isString ? 'raw' : 'smart');
  const options = isString ? {} : paramsOrPath;

  const cleanPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}`, {
    headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'MR-CAPSULES-MCP' }
  });
  if (!res.ok) throw err404('File not found: ' + path);
  const data = await res.json();
  const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');

  if (format === 'raw') {
    return { path, content: decoded, sha: data.sha, size: data.size, public_url: `https://${reqHost || 'mr-capsules.vercel.app'}/${cleanPath}` };
  }

  const result = extractSmartContent(decoded, format, options, reqHost, path);
  result.sha = data.sha;
  return result;
}

async function contentTree(paramsOrGt, gtOrOwner, ownerOrRepo, repoOptional) {
  let params = {}, gt, owner, repo;
  if (typeof paramsOrGt === 'object' && paramsOrGt !== null) {
    params = paramsOrGt;
    gt = gtOrOwner;
    owner = ownerOrRepo;
    repo = repoOptional;
  } else {
    gt = paramsOrGt;
    owner = gtOrOwner;
    repo = ownerOrRepo;
  }

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`, {
    headers: { 'Authorization': `Bearer ${gt}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'MR-CAPSULES-MCP' }
  });
  if (!res.ok) throw new Error('GitHub API error');
  const data = await res.json();

  let filtered = data.tree.filter(item => item.path.startsWith('content/') || item.path.startsWith('cover/'));
  if (params.prefix) {
    const pfx = String(params.prefix).toLowerCase();
    filtered = filtered.filter(item => item.path.toLowerCase().startsWith(pfx));
  }

  const pathsOnly = params.paths_only !== false;
  if (pathsOnly) {
    return { total: filtered.length, paths: filtered.map(item => item.path) };
  }

  return { tree: filtered };
}

// ═══════════════════════════════════════════════════════════════
// CHUNKED UPLOAD SESSION SYSTEM (In-Memory + Supabase Fallback)
// ═══════════════════════════════════════════════════════════════
const uploadSessions = new Map();
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function cleanExpiredUploadSessions() {
  const now = Date.now();
  for (const [uploadId, session] of uploadSessions.entries()) {
    const createdTime = new Date(session.createdAt).getTime();
    if (isNaN(createdTime) || (now - createdTime) > UPLOAD_SESSION_TTL_MS) {
      uploadSessions.delete(uploadId);
    }
  }
}

async function uploadInit(params, adminEmail, su, sk) {
  cleanExpiredUploadSessions();
  const { path, totalChunks, totalSizeBytes } = params;
  if (!path || !totalChunks || totalChunks < 1) throw err400('Missing path or valid totalChunks');
  validatePath(path);

  const uploadId = `up_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const sessionData = {
    uploadId,
    path,
    adminEmail,
    totalChunks,
    totalSizeBytes: totalSizeBytes || 0,
    chunks: {},
    createdAt: new Date().toISOString()
  };

  uploadSessions.set(uploadId, sessionData);

  // Store in Supabase for cross-container serverless persistence
  await logAction(adminEmail, 'mcp_upload_init', { uploadId, path, totalChunks, totalSizeBytes }, su, sk);

  return {
    success: true,
    uploadId,
    path,
    totalChunks,
    maxRecommendedChunkSizeBytes: 1500000,
    message: `Upload session initialized. Send chunks 1 to ${totalChunks} using upload_chunk, then call upload_commit.`
  };
}

async function uploadChunk(params, adminEmail, su, sk) {
  const { uploadId, chunkIndex, chunkBase64 } = params;
  if (!uploadId || !chunkIndex || !chunkBase64) throw err400('Missing uploadId, chunkIndex, or chunkBase64');

  if (chunkBase64.length > 3.5 * 1024 * 1024) {
    throw err400('Chunk Base64 size exceeds 3.5MB single-request limit. Please send smaller chunks (e.g. 1MB per chunk).');
  }

  let session = uploadSessions.get(uploadId);

  // Fallback to restore session state if container restarted
  if (!session) {
    session = await restoreUploadSessionFromSb(uploadId, su, sk);
  }

  if (!session) {
    throw err400(`Upload session "${uploadId}" not found or expired. Please initialize a new session with upload_init.`);
  }

  if (chunkIndex < 1 || chunkIndex > session.totalChunks) {
    throw err400(`Invalid chunkIndex ${chunkIndex}. Must be between 1 and ${session.totalChunks}.`);
  }

  session.chunks[chunkIndex] = chunkBase64;
  uploadSessions.set(uploadId, session);

  // Persist chunk to Supabase REST admin_action_logs
  await logAction(adminEmail, 'mcp_upload_chunk', { uploadId, chunkIndex, chunkBase64 }, su, sk);

  const receivedIndexes = Object.keys(session.chunks).map(Number).sort((a, b) => a - b);
  const complete = receivedIndexes.length === session.totalChunks;
  const progressPercent = parseFloat(((receivedIndexes.length / session.totalChunks) * 100).toFixed(1));

  return {
    success: true,
    uploadId,
    chunkIndex,
    receivedChunksCount: receivedIndexes.length,
    totalChunks: session.totalChunks,
    complete,
    progressPercent
  };
}

async function uploadCommit(params, adminEmail, githubToken, owner, repo, su, sk) {
  const { uploadId } = params;
  if (!uploadId) throw err400('Missing uploadId');

  let session = uploadSessions.get(uploadId);
  if (!session) {
    session = await restoreUploadSessionFromSb(uploadId, su, sk);
  }

  if (!session) {
    throw err400(`Upload session "${uploadId}" not found or expired.`);
  }

  const missingChunks = [];
  for (let i = 1; i <= session.totalChunks; i++) {
    if (!session.chunks[i]) missingChunks.push(i);
  }

  if (missingChunks.length > 0) {
    throw err400(`Cannot commit upload session "${uploadId}". Missing chunks: [${missingChunks.join(', ')}].`);
  }

  // Reassemble full binary Buffer in numeric chunk order for 100% exact precision
  const bufferChunks = [];
  for (let i = 1; i <= session.totalChunks; i++) {
    bufferChunks.push(Buffer.from(session.chunks[i], 'base64'));
  }
  const fullBuffer = Buffer.concat(bufferChunks);
  const fullBase64 = fullBuffer.toString('base64');

  // Upload complete file using enhanced robust contentUpload
  const uploadResult = await contentUpload(
    { path: session.path, contentBase64: fullBase64, isChunkedCommit: true },
    adminEmail,
    githubToken,
    owner,
    repo,
    su,
    sk
  );

  // Cleanup session
  uploadSessions.delete(uploadId);
  await logAction(adminEmail, 'mcp_upload_commit', { uploadId, path: session.path, totalChunks: session.totalChunks }, su, sk);

  return {
    success: true,
    path: session.path,
    uploadId,
    totalChunks: session.totalChunks,
    totalBase64Length: fullBase64.length,
    sha: uploadResult.sha,
    message: `File "${session.path}" assembled and committed successfully!`
  };
}

async function uploadStatus(params, su, sk) {
  const { uploadId } = params;
  if (!uploadId) throw err400('Missing uploadId');

  let session = uploadSessions.get(uploadId);
  if (!session) {
    session = await restoreUploadSessionFromSb(uploadId, su, sk);
  }

  if (!session) {
    throw err400(`Upload session "${uploadId}" not found or expired.`);
  }

  const receivedIndexes = Object.keys(session.chunks).map(Number).sort((a, b) => a - b);
  const missingChunks = [];
  for (let i = 1; i <= session.totalChunks; i++) {
    if (!session.chunks[i]) missingChunks.push(i);
  }

  return {
    uploadId,
    path: session.path,
    totalChunks: session.totalChunks,
    receivedChunksCount: receivedIndexes.length,
    receivedChunks: receivedIndexes,
    missingChunks,
    complete: missingChunks.length === 0,
    createdAt: session.createdAt
  };
}

async function uploadCancel(params, adminEmail, su, sk) {
  const { uploadId } = params;
  if (!uploadId) throw err400('Missing uploadId');

  uploadSessions.delete(uploadId);
  await logAction(adminEmail, 'mcp_upload_cancel', { uploadId }, su, sk);
  return { success: true, uploadId, message: 'Upload session canceled.' };
}

async function restoreUploadSessionFromSb(uploadId, su, sk) {
  try {
    const res = await fetch(`${su}/rest/v1/activity_logs?details->>uploadId=eq.${uploadId}&order=time.asc`, {
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
    });
    if (!res.ok) return null;
    const logs = await res.json();
    if (!Array.isArray(logs) || logs.length === 0) return null;

    const initLog = logs.find(l => l.action === 'mcp_upload_init');
    if (!initLog) return null;

    const details = initLog.details || {};
    const session = {
      uploadId,
      path: details.path,
      adminEmail: initLog.admin_email,
      totalChunks: details.totalChunks,
      totalSizeBytes: details.totalSizeBytes || 0,
      chunks: {},
      createdAt: initLog.time
    };

    const chunkLogs = logs.filter(l => l.action === 'mcp_upload_chunk');
    chunkLogs.forEach(cl => {
      if (cl.details && cl.details.chunkIndex && cl.details.chunkBase64) {
        session.chunks[cl.details.chunkIndex] = cl.details.chunkBase64;
      }
    });

    uploadSessions.set(uploadId, session);
    return session;
  } catch (e) {
    return null;
  }
}

async function rewardUserForUpload(adminEmail, path, su, sk) {
  if (!su || !sk || !adminEmail) return;
  try {
    const usersRes = await fetch(`${su}/auth/v1/admin/users?per_page=1000`, {
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
    });
    if (usersRes.ok) {
      const { users } = await usersRes.json();
      const u = (users || []).find(x => x.email === adminEmail);
      if (u) {
        const isDoc = (path || '').includes('docs.html');
        const pts = isDoc ? 1 : 2;
        const type = isDoc ? 'docs_update' : 'content_upload';
        await recordContribution(u.id, pts, null, type, su, sk);
      }
    }
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════
// ROBUST DIRECT FILE UPLOAD (Contents API + Git Data API Conflict Retries)
// ═══════════════════════════════════════════════════════════════

async function contentUpload(params, adminEmail, githubToken, owner, repo, su, sk) {
  const { path, isChunkedCommit } = params;
  let contentBase64 = params.contentBase64;

  if (params.contentGzipBase64) {
    try {
      const compressedBuffer = Buffer.from(params.contentGzipBase64, 'base64');
      const decompressedBuffer = zlib.gunzipSync(compressedBuffer);
      contentBase64 = decompressedBuffer.toString('base64');
    } catch (gzipErr) {
      throw err400(`Gzip decompression failed (file corrupted during LLM transfer): ${gzipErr.message}`);
    }
  } else if (params.url) {
    try {
      const fetchRes = await fetch(params.url);
      if (!fetchRes.ok) throw new Error(`Failed to fetch file from URL: ${fetchRes.statusText}`);
      const arrayBuffer = await fetchRes.arrayBuffer();
      contentBase64 = Buffer.from(arrayBuffer).toString('base64');
    } catch (fetchErr) {
      throw err400(`Failed to fetch file from url "${params.url}": ${fetchErr.message}`);
    }
  }

  if (!contentBase64) throw err400('Missing contentBase64, contentGzipBase64, or url');

  const base64Len = contentBase64.length;
  // If called directly (not via chunked commit) and not using url, enforce single-request serverless payload limit
  if (!isChunkedCommit && !params.url && base64Len > 3.5 * 1024 * 1024) {
    throw err400(`Single-request payload too large (${(base64Len / (1024 * 1024)).toFixed(2)}MB). Maximum payload for direct contentBase64 upload is 3.5MB. For larger files, please pass a public 'url' instead to fetch and commit directly without chunking, or use chunked upload tools.`);
  }

  // ATTEMPT 1: GitHub Contents API (Atomic single-call for files < 100MB)
  try {
    let existingSha = null;
    try {
      const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
        headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'MR-CAPSULES-MCP' }
      });
      if (getRes.ok) {
        const fileInfo = await getRes.json();
        existingSha = fileInfo.sha;
      }
    } catch (e) { /* file doesn't exist yet, ok */ }

    const putBody = {
      message: `mcp: upload ${path}`,
      content: contentBase64
    };
    if (existingSha) putBody.sha = existingSha;

    const putRes = await ghApi('PUT', `/contents/${encodeURIComponent(path)}`, putBody, githubToken, owner, repo);
    if (putRes.ok) {
      const putData = await putRes.json();
      await logAction(adminEmail, 'mcp_upload', { path, method: 'contents_api' }, su, sk);
      await rewardUserForUpload(adminEmail, path, su, sk);
      return { success: true, path, sha: putData.content?.sha || putData.commit?.sha };
    }
  } catch (e) {
    console.warn('Contents API direct upload failed, attempting Git Data API fallback:', e.message);
  }

  // ATTEMPT 2: Git Data API with Automatic Exponential Backoff Retries for Fast-Forward Conflicts
  let maxRetries = 4;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const blobRes = await ghApi('POST', '/git/blobs', { content: contentBase64, encoding: 'base64' }, githubToken, owner, repo);
      const blobData = await blobRes.json();
      if (!blobRes.ok) throw new Error(blobData.message || 'Failed to create blob');

      const refRes = await ghApi('GET', '/git/refs/heads/main', null, githubToken, owner, repo);
      const refData = await refRes.json();
      const commitSha = refData.object.sha;

      const commitRes = await ghApi('GET', `/git/commits/${commitSha}`, null, githubToken, owner, repo);
      const commitData = await commitRes.json();

      const treeRes = await ghApi('POST', '/git/trees', {
        base_tree: commitData.tree.sha,
        tree: [{ path, mode: '100644', type: 'blob', sha: blobData.sha }]
      }, githubToken, owner, repo);
      const treeData = await treeRes.json();

      const newCommitRes = await ghApi('POST', '/git/commits', {
        message: `mcp: upload ${path}`,
        tree: treeData.sha,
        parents: [commitSha]
      }, githubToken, owner, repo);
      const newCommit = await newCommitRes.json();

      const patchRes = await ghApi('PATCH', '/git/refs/heads/main', { sha: newCommit.sha }, githubToken, owner, repo);
      if (!patchRes.ok) {
        const patchErr = await patchRes.json();
        throw new Error(patchErr.message || 'Failed to update git ref');
      }

      await logAction(adminEmail, 'mcp_upload', { path, attempt }, su, sk);
      await rewardUserForUpload(adminEmail, path, su, sk);
      return { success: true, path, sha: newCommit.sha };
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, attempt * 500));
      }
    }
  }

  throw new Error(`Failed to upload ${path} after ${maxRetries} attempts: ${lastErr?.message || 'Git conflict'}`);
}

async function contentUploadFromAgentPath(params, auth, reqHost, githubToken, owner, repo) {
  const { agentFilePath, targetPath } = params;

  let existingSha = null;
  if (githubToken && owner && repo) {
    try {
      const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(targetPath)}`, {
        headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'MR-CAPSULES-MCP' }
      });
      if (getRes.ok) {
        const fileInfo = await getRes.json();
        existingSha = fileInfo.sha;
      }
    } catch (e) {}
  }

  const host = reqHost || 'mr-capsules.vercel.app';
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const url = `${protocol}://${host}/api/upload`;
  const token = auth.token || '';

  const ghCurlCmd = `curl -X PUT -H "Authorization: Bearer ${githubToken}" -H "Accept: application/vnd.github+json" -H "User-Agent: MR-CAPSULES-AGENT" "https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(targetPath)}" -d "{\\"message\\":\\"mcp: direct upload ${targetPath}\\",\\"content\\":\\"\$(base64 -w 0 '${agentFilePath}')\\"${existingSha ? `,\\"sha\\":\\"${existingSha}\\"` : ''}}"`;
  const vercelCurlCmd = `curl -X POST -H "Authorization: Bearer ${token}" -F "path=${targetPath}" -F "file=@${agentFilePath}" ${url}`;
  const pyCmd = `python3 -c "import gzip, base64; print(base64.b64encode(gzip.compress(open('${agentFilePath}','rb').read())).decode())"`;

  return `To upload this file reliably, choose the best method for your sandbox container:

METHOD 1 (Recommended if api.github.com is in your container's egress allowlist):
Run this command in your terminal/bash tool to upload directly to GitHub API:
\`\`\`bash
${ghCurlCmd}
\`\`\`

METHOD 2 (If Vercel endpoint is accessible in your terminal):
Run this curl command in your terminal/bash tool:
\`\`\`bash
${vercelCurlCmd}
\`\`\`

METHOD 3 (If ALL network egress is BLOCKED in your terminal):
1. Run this 1-line Python command locally to get the compressed, CRC32-verified Gzip string (80% smaller, zero corruption):
\`\`\`bash
${pyCmd}
\`\`\`
2. Call the tool \`content_upload\` via MCP with:
   - path: "${targetPath}"
   - contentGzipBase64: "<paste the output string from python command>"`;
}

async function contentPullToSandbox(params, githubToken, owner, repo, reqHost = 'mr-capsules.vercel.app') {
  const repoPath = params.path;
  const filename = repoPath.split('/').pop();
  const saveTo = params.saveTo || `/mnt/user-data/outputs/${filename}`;
  const saveDir = saveTo.substring(0, saveTo.lastIndexOf('/'));

  const cleanPath = repoPath.split('/').map(encodeURIComponent).join('/');

  // Verify file exists in repo first using server-side GitHub token (token is never leaked to client)
  const checkRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}`, {
    headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'MR-CAPSULES-MCP' }
  });
  if (!checkRes.ok) throw err404('File not found in repo: ' + repoPath);
  const fileInfo = await checkRes.json();
  const fileSizeKB = fileInfo.size ? (fileInfo.size / 1024).toFixed(1) : '?';

  // Clean public URLs requiring ZERO credentials (prevents Claude safety filters from blocking execution)
  const host = reqHost || 'mr-capsules.vercel.app';
  const publicWebUrl = `https://${host}/${cleanPath}`;
  const githubRawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${cleanPath}`;

  // Method 1: curl from deployed web host (Zero API keys, 100% credential-safe)
  const curlWebCmd = `mkdir -p '${saveDir}' && curl -fsSL "${publicWebUrl}" -o '${saveTo}' && echo "✅ Saved $(wc -c < '${saveTo}') bytes to ${saveTo}"`;

  // Method 2: curl raw GitHub (Zero credentials)
  const curlRawCmd = `mkdir -p '${saveDir}' && curl -fsSL "${githubRawUrl}" -o '${saveTo}' && echo "✅ Saved $(wc -c < '${saveTo}') bytes to ${saveTo}"`;

  // Method 3: Python urllib (Zero credentials)
  const pyCmd = `python3 -c "import urllib.request, os; os.makedirs('${saveDir}', exist_ok=True); urllib.request.urlretrieve('${publicWebUrl}', '${saveTo}'); print('✅ Saved file to ${saveTo}')"`;

  return {
    success: true,
    file: repoPath,
    size_kb: fileSizeKB,
    save_to: saveTo,
    public_url: publicWebUrl,
    instructions: `File "${repoPath}" (${fileSizeKB} KB) is ready. In agent environments with a bash/terminal tool, run method_1_curl. In Claude.ai Web or environments without a terminal, call tool 'content_get' with { path: '${repoPath}', format: 'smart' } to view questions or text directly in chat.`,
    method_1_curl: curlWebCmd,
    method_2_github_raw: curlRawCmd,
    method_3_python: pyCmd,
    auto_command: curlWebCmd
  };
}

async function contentDelete(params, adminEmail, githubToken, owner, repo, su, sk) {
  const paths = Array.isArray(params.paths) ? params.paths : (params.path ? [params.path] : []);
  if (!paths || paths.length === 0) throw err400('Missing params.path or params.paths');
  paths.forEach(validatePath);

  const refRes = await ghApi('GET', '/git/refs/heads/main', null, githubToken, owner, repo);
  const refData = await refRes.json();
  const commitSha = refData.object.sha;
  const commitRes = await ghApi('GET', `/git/commits/${commitSha}`, null, githubToken, owner, repo);
  const commitData = await commitRes.json();

  const treeEntries = paths.map(p => ({ path: p, mode: '100644', type: 'blob', sha: null }));
  const treeRes = await ghApi('POST', '/git/trees', {
    base_tree: commitData.tree.sha,
    tree: treeEntries
  }, githubToken, owner, repo);
  const treeData = await treeRes.json();

  const commitMessage = paths.length === 1 ? `mcp: delete ${paths[0]}` : `mcp: bulk delete ${paths.length} files`;
  const newCommitRes = await ghApi('POST', '/git/commits', {
    message: commitMessage,
    tree: treeData.sha,
    parents: [commitSha]
  }, githubToken, owner, repo);
  const newCommit = await newCommitRes.json();

  await ghApi('PATCH', '/git/refs/heads/main', { sha: newCommit.sha }, githubToken, owner, repo);
  await logAction(adminEmail, 'mcp_delete', { paths }, su, sk);
  return { success: true, deleted: paths, deletedCount: paths.length };
}

async function contentRename(params, adminEmail, githubToken, owner, repo, su, sk) {
  const { path, newPath } = params;
  const treeListRes = await ghApi('GET', '/git/trees/main?recursive=1', null, githubToken, owner, repo);
  const treeListData = await treeListRes.json();
  const fileNode = treeListData.tree.find(t => t.path === path);
  if (!fileNode) throw err404('Original file not found: ' + path);

  const refRes = await ghApi('GET', '/git/refs/heads/main', null, githubToken, owner, repo);
  const refData = await refRes.json();
  const commitSha = refData.object.sha;
  const commitRes = await ghApi('GET', `/git/commits/${commitSha}`, null, githubToken, owner, repo);
  const commitData = await commitRes.json();

  const treeRes = await ghApi('POST', '/git/trees', {
    base_tree: commitData.tree.sha,
    tree: [
      { path, mode: '100644', type: 'blob', sha: null },
      { path: newPath, mode: '100644', type: 'blob', sha: fileNode.sha }
    ]
  }, githubToken, owner, repo);
  const treeData = await treeRes.json();
  const newCommitRes = await ghApi('POST', '/git/commits', {
    message: `mcp: rename ${path} to ${newPath}`,
    tree: treeData.sha,
    parents: [commitSha]
  }, githubToken, owner, repo);
  const newCommit = await newCommitRes.json();
  await ghApi('PATCH', '/git/refs/heads/main', { sha: newCommit.sha }, githubToken, owner, repo);
  await logAction(adminEmail, 'mcp_rename', { path, newPath }, su, sk);
  return { success: true, old_path: path, new_path: newPath };
}

// ═══════════════════════════════════════════════════════════════
// TASKS HANDLERS
// ═══════════════════════════════════════════════════════════════

async function tasksList(paramsOrSu, suOrSk, skOptional) {
  let params = {}, su, sk;
  if (typeof paramsOrSu === 'object' && paramsOrSu !== null) {
    params = paramsOrSu;
    su = suOrSk;
    sk = skOptional;
  } else {
    su = paramsOrSu;
    sk = suOrSk;
  }

  let url = `${su}/rest/v1/content_tasks?select=*&order=created_at.desc`;
  if (params.status) {
    url += `&status=eq.${encodeURIComponent(params.status)}`;
  }
  if (params.priority) {
    url += `&priority=eq.${encodeURIComponent(params.priority)}`;
  }
  if (params.semester) {
    url += `&semester=ilike.*${encodeURIComponent(params.semester)}*`;
  }
  if (params.block) {
    url += `&block=eq.${encodeURIComponent(params.block)}`;
  }
  const limit = Math.min(100, Math.max(1, parseInt(params.limit) || 20));
  url += `&limit=${limit}`;

  if (params.offset) {
    const offset = Math.max(0, parseInt(params.offset) || 0);
    url += `&offset=${offset}`;
  }

  const res = await fetch(url, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (!res.ok) throw new Error(await res.text());
  const tasks = await res.json();

  const isCompact = params.compact !== false;
  if (isCompact) {
    const compactTasks = (tasks || []).map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      semester: t.semester,
      block: t.block,
      category: t.category,
      assigned_to: t.assigned_to,
      created_at: t.created_at
    }));
    return { total: tasks.length, compact: true, tasks: compactTasks, hint: "Pass compact: false for full descriptions" };
  }

  return { total: tasks.length, tasks };
}

async function tasksCreate(params, userId, su, sk) {
  const { title, description, semester, block, category, target_path, priority, assigned_to_email } = params;
  if (!title) throw err400('Missing params.title');
  let assignedToId = null, finalStatus = 'open', assignedAt = null;
  if (assigned_to_email) {
    const usersRes = await fetch(`${su}/auth/v1/admin/users?per_page=1000`, {
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
    });
    if (usersRes.ok) {
      const { users } = await usersRes.json();
      const u = (users || []).find(x => x.email === assigned_to_email);
      if (u) { assignedToId = u.id; finalStatus = 'in_progress'; assignedAt = new Date().toISOString(); }
    }
  }
  const res = await fetch(`${su}/rest/v1/content_tasks`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ title, description, semester, block, category, target_path, priority, status: finalStatus, created_by: userId, assigned_to: assignedToId, assigned_at: assignedAt })
  });
  if (!res.ok) throw new Error(await res.text());
  const [task] = await res.json();
  return { task };
}

async function tasksClaim(taskId, userId, su, sk) {
  const res = await fetch(`${su}/rest/v1/content_tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ assigned_to: userId, status: 'in_progress', assigned_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error(await res.text());
  const [task] = await res.json();

  await fetch(`${su}/rest/v1/task_logs`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, user_id: userId, action: 'claimed', old_status: 'open', new_status: 'in_progress' })
  });

  return { task };
}

async function tasksSubmit(taskId, userId, su, sk) {
  const res = await fetch(`${su}/rest/v1/content_tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ status: 'developed', submitted_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error(await res.text());
  const [task] = await res.json();

  await fetch(`${su}/rest/v1/task_logs`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, user_id: userId, action: 'submitted', old_status: 'in_progress', new_status: 'developed' })
  });

  return { task };
}

async function tasksApprove(taskId, userId, su, sk) {
  const fetchOld = await fetch(`${su}/rest/v1/content_tasks?id=eq.${encodeURIComponent(taskId)}`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  const oldTasks = await fetchOld.json();
  const prevTask = Array.isArray(oldTasks) && oldTasks.length > 0 ? oldTasks[0] : null;

  const res = await fetch(`${su}/rest/v1/content_tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ status: 'done', completed_at: new Date().toISOString(), reviewed_by: userId })
  });
  if (!res.ok) throw new Error(await res.text());
  const [task] = await res.json();

  // Log approval
  await fetch(`${su}/rest/v1/task_logs`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, user_id: userId, action: 'approved', old_status: prevTask?.status || 'in_review', new_status: 'done', note: 'Approved via MCP' })
  });

  // Award reviewer 1 point
  await recordContribution(userId, 1, taskId, 'task_approved', su, sk);

  // Award assigned developer 3 points
  const assigneeId = prevTask?.assigned_to || task?.assigned_to;
  if (assigneeId) {
    await recordContribution(assigneeId, 3, taskId, 'task_completed', su, sk);
  }

  return { task, points_awarded: { reviewer: 1, developer: assigneeId ? 3 : 0 } };
}

async function tasksReject(taskId, note, userId, su, sk) {
  const res = await fetch(`${su}/rest/v1/content_tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ status: 'in_progress' })
  });
  if (!res.ok) throw new Error(await res.text());
  const [task] = await res.json();

  await fetch(`${su}/rest/v1/task_logs`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, user_id: userId, action: 'rejected', old_status: 'in_review', new_status: 'in_progress', note: note || '' })
  });

  return { task };
}

async function tasksGetLogs(taskId, su, sk) {
  const res = await fetch(`${su}/rest/v1/task_logs?task_id=eq.${taskId}&order=created_at.desc`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (!res.ok) throw new Error('Failed to fetch task logs');
  const logs = await res.json();
  return { logs };
}

async function tasksResetPhase(taskId, newStatus, unassign, note, userId, su, sk) {
  const targetStatus = newStatus || 'open';
  const updatePayload = {
    status: targetStatus,
    submitted_at: null,
    review_started_at: null,
    completed_at: null,
    reviewed_by: null
  };
  if (unassign || targetStatus === 'open') {
    updatePayload.assigned_to = null;
    updatePayload.assigned_at = null;
  }
  const res = await fetch(`${su}/rest/v1/content_tasks?id=eq.${taskId}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(updatePayload)
  });
  if (!res.ok) throw new Error('Failed to reset phase: ' + await res.text());
  const [task] = await res.json();

  await fetch(`${su}/rest/v1/task_logs`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, user_id: userId, action: 'phase_reset', new_status: targetStatus, note: note })
  });

  return { success: true, task };
}

async function tasksReReview(taskId, note, userId, su, sk) {
  const res = await fetch(`${su}/rest/v1/content_tasks?id=eq.${encodeURIComponent(taskId)}&status=eq.done`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ status: 'in_review', review_started_at: new Date().toISOString(), reviewed_by: userId, completed_at: null })
  });
  if (!res.ok) throw new Error('Failed to request re-review: ' + await res.text());
  const data = await res.json();
  if (!data || data.length === 0) throw new Error('Task is no longer in done status (409 conflict)');

  await fetch(`${su}/rest/v1/task_logs`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, user_id: userId, action: 're_review_requested', prev_status: 'done', new_status: 'in_review', note: note })
  });

  return { success: true, task: data[0] };
}

async function tasksRetrack(taskId, note, userId, su, sk) {
  const res = await fetch(`${su}/rest/v1/content_tasks?id=eq.${encodeURIComponent(taskId)}&status=eq.done`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({
      status: 'open',
      assigned_to: null,
      assigned_at: null,
      submitted_at: null,
      review_started_at: null,
      reviewed_by: null,
      completed_at: null
    })
  });
  if (!res.ok) throw new Error('Failed to retrack task: ' + await res.text());
  const data = await res.json();
  if (!data || data.length === 0) throw new Error('Task is no longer in done status (409 conflict)');

  await fetch(`${su}/rest/v1/task_logs`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, user_id: userId, action: 'retracked', prev_status: 'done', new_status: 'open', note: note })
  });

  return { success: true, task: data[0] };
}

async function tasksResubmit(taskId, note, userId, su, sk) {
  // Fetch current task to validate status and ownership
  const taskRes = await fetch(`${su}/rest/v1/content_tasks?id=eq.${encodeURIComponent(taskId)}&select=assigned_to,status`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  const taskData = await taskRes.json();
  if (!taskData || taskData.length === 0) throw new Error('Task not found');

  if (taskData[0].status !== 'developed' && taskData[0].status !== 'in_review') {
    throw new Error('Task must be in developed or in_review status to re-submit');
  }

  const prevStatus = taskData[0].status;
  const res = await fetch(`${su}/rest/v1/content_tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({
      status: 'in_progress',
      submitted_at: null,
      review_started_at: null,
      reviewed_by: null
    })
  });
  if (!res.ok) throw new Error('Failed to re-submit task: ' + await res.text());
  const data = await res.json();

  await fetch(`${su}/rest/v1/task_logs`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, user_id: userId, action: 'resubmitted', prev_status: prevStatus, new_status: 'in_progress', note: note })
  });

  return { success: true, task: data[0] };
}

// ═══════════════════════════════════════════════════════════════
// DIVISIONS HANDLERS
// ═══════════════════════════════════════════════════════════════

async function divisionsList(su, sk) {
  const divRes = await fetch(`${su}/rest/v1/divisions?select=*`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  const divs = await divRes.json();

  const sbUsersRes = await fetch(`${su}/auth/v1/admin/users?page=1&per_page=1000`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  let allUsers = [];
  if (sbUsersRes.ok) {
    try {
      const usersData = await sbUsersRes.json();
      allUsers = usersData.users || [];
    } catch(e) {}
  }

  const memResDirect = await fetch(`${su}/rest/v1/division_members?select=division_id,user_id,whatsapp`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  const mems = await memResDirect.json();

  const stats = divs.map(d => {
    const divisionMems = mems.filter(m => m.division_id === d.id);
    const membersList = divisionMems.map(m => {
      const u = allUsers.find(au => au.id === m.user_id);
      const email = u ? u.email : 'Unknown User';
      const username = u?.user_metadata?.username || (u ? u.email.split('@')[0] : 'Unknown');
      return { user_id: m.user_id, email, username, whatsapp: m.whatsapp || '' };
    });
    return {
      ...d,
      member_count: divisionMems.length,
      members: membersList
    };
  });
  return { divisions: stats };
}

async function divisionsGetMembers(divisionId, su, sk) {
  const allDivs = await divisionsList(su, sk);
  if (!divisionId) return allDivs;
  const found = allDivs.divisions.find(d => d.id === divisionId);
  return { division_id: divisionId, members: found ? found.members : [], member_count: found ? found.member_count : 0 };
}

async function divisionsMyDivision(userId, su, sk) {
  const res = await fetch(`${su}/rest/v1/division_members?user_id=eq.${userId}&select=division_id,whatsapp`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  const data = await res.json();
  return { division: data.length > 0 ? data[0] : null };
}

// ═══════════════════════════════════════════════════════════════
// USERS HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleAccountManager(params, auth, roles, su, sk, superadminEmail) {
  const action = (params.action || '').toLowerCase().trim();
  if (!action) throw err400('Missing params.action');

  // Helper to resolve a target user by ID or Email
  async function resolveTargetUser(idInput, emailInput) {
    if (idInput && String(idInput).includes('-')) {
      const getRes = await fetch(`${su}/auth/v1/admin/users/${idInput}`, {
        headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
      });
      if (getRes.ok) {
        return await getRes.json();
      }
    }
    const targetEmail = (emailInput || (typeof idInput === 'string' && idInput.includes('@') ? idInput : '')).trim().toLowerCase();
    if (targetEmail) {
      const listRes = await fetch(`${su}/auth/v1/admin/users?per_page=1000`, {
        headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
      });
      if (listRes.ok) {
        const data = await listRes.json();
        const found = (data.users || []).find(u =>
          (u.email && u.email.toLowerCase() === targetEmail) ||
          (u.user_metadata && u.user_metadata.email && u.user_metadata.email.toLowerCase() === targetEmail) ||
          (u.user_metadata && u.user_metadata.username && u.user_metadata.username.toLowerCase() === targetEmail)
        );
        if (found) return found;
      }
    }
    return null;
  }

  // 1. ACTION: CREATE
  if (action === 'create') {
    if (!roles.isAdmin && !roles.isSuperAdmin) throw err403('Admin or SuperAdmin only');
    const email = (params.email || '').trim().toLowerCase();
    const password = params.password;
    if (!email || !email.includes('@')) throw err400('Valid params.email is required');
    if (!password || password.length < 6) throw err400('params.password must be at least 6 characters');

    const fullName = (params.full_name || params.name || '').trim();
    const username = (params.username || email.split('@')[0]).trim();
    const whatsapp = (params.whatsapp || '').trim();

    // Check if user already exists
    const existing = await resolveTargetUser(null, email);
    if (existing) {
      throw err400(`A user with email "${email}" already exists (ID: ${existing.id})`);
    }

    const createPayload = {
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName || username,
        username: username,
        whatsapp: whatsapp,
        email: email
      },
      app_metadata: {
        provider: 'email',
        providers: ['email'],
        banned: false
      }
    };

    const createRes = await fetch(`${su}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'apikey': sk,
        'Authorization': `Bearer ${sk}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(createPayload)
    });

    if (!createRes.ok) {
      const errBody = await createRes.text();
      throw new Error('Failed to create user: ' + errBody);
    }

    const createdUser = await createRes.json();
    const createdUserId = createdUser.id;

    // Optional division assignment
    let assignedDivision = null;
    if (params.division_id && ['management', 'development', 'review'].includes(params.division_id.toLowerCase())) {
      const divId = params.division_id.toLowerCase();
      await fetch(`${su}/rest/v1/division_members`, {
        method: 'POST',
        headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ user_id: createdUserId, division_id: divId, whatsapp: whatsapp })
      });
      assignedDivision = divId;
    }

    // Optional admin promotion
    let isAdminSet = false;
    if (params.is_admin === true) {
      if (!roles.isSuperAdmin) throw err403('Only SuperAdmin can grant admin privileges during user creation');
      await fetch(`${su}/rest/v1/user_roles`, {
        method: 'POST',
        headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({ identifier: email, role: 'admin' })
      });
      isAdminSet = true;
    }

    await logAction(auth.email, 'mcp_account_create', { targetUserId: createdUserId, email, division: assignedDivision, isAdmin: isAdminSet }, su, sk);

    return {
      success: true,
      message: `Account for ${email} created successfully`,
      user: {
        id: createdUserId,
        email: email,
        full_name: fullName || username,
        username: username,
        whatsapp: whatsapp,
        division: assignedDivision || 'None',
        is_admin: isAdminSet,
        created_at: createdUser.created_at
      }
    };
  }

  // 2. ACTION: GET
  if (action === 'get' || action === 'profile') {
    let target = null;
    if (params.user_id || params.email) {
      target = await resolveTargetUser(params.user_id, params.email);
    } else {
      target = await resolveTargetUser(auth.userId, auth.email);
    }
    if (!target) throw err400('User not found');

    const targetEmail = target.email || '';
    const isSelf = target.id === auth.userId || (targetEmail && targetEmail.toLowerCase() === auth.email?.toLowerCase());
    if (!isSelf && !roles.isAdmin && !roles.isSuperAdmin) {
      throw err403('Admin privileges required to view another user profile');
    }

    // Fetch division
    const divRes = await fetch(`${su}/rest/v1/division_members?user_id=eq.${target.id}&select=division_id,whatsapp`, {
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
    });
    const divRows = divRes.ok ? await divRes.json() : [];
    const divId = divRows && divRows.length > 0 ? divRows[0].division_id : 'None';
    const divWa = divRows && divRows.length > 0 ? divRows[0].whatsapp : (target.user_metadata?.whatsapp || '');

    // Fetch admin role
    const roleRes = await fetch(`${su}/rest/v1/user_roles?identifier=eq.${encodeURIComponent(targetEmail)}&select=role`, {
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
    });
    const roleRows = roleRes.ok ? await roleRes.json() : [];
    const isTargetAdmin = (roleRows && roleRows.some(r => r.role === 'admin')) || (superadminEmail && targetEmail.toLowerCase() === superadminEmail.toLowerCase());
    const isTargetSuperAdmin = superadminEmail && targetEmail.toLowerCase() === superadminEmail.toLowerCase();

    // Fetch contributions
    const contribRes = await fetch(`${su}/rest/v1/contributions?user_id=eq.${target.id}&select=points`, {
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
    });
    const contribRows = contribRes.ok ? await contribRes.json() : [];
    const totalPoints = Array.isArray(contribRows) ? contribRows.reduce((sum, c) => sum + (c.points || 0), 0) : 0;

    return {
      success: true,
      user: {
        id: target.id,
        email: target.email,
        full_name: target.user_metadata?.full_name || target.user_metadata?.name || target.email?.split('@')[0] || '',
        username: target.user_metadata?.username || target.email?.split('@')[0] || '',
        whatsapp: divWa,
        division: divId,
        is_admin: isTargetAdmin,
        is_superadmin: isTargetSuperAdmin,
        banned: !!target.app_metadata?.banned,
        created_at: target.created_at,
        last_sign_in_at: target.last_sign_in_at,
        contribution_points: totalPoints,
        registered_devices_count: Array.isArray(target.user_metadata?.devices) ? target.user_metadata.devices.length : 0
      }
    };
  }

  // 3. ACTION: LIST
  if (action === 'list') {
    if (!roles.isAdmin && !roles.isSuperAdmin) throw err403('Admin or SuperAdmin only');
    const usersRes = await fetch(`${su}/auth/v1/admin/users?per_page=1000`, {
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
    });
    if (!usersRes.ok) throw new Error('Failed to fetch user list');
    const { users } = await usersRes.json();

    const [divsRes, rolesRes] = await Promise.all([
      fetch(`${su}/rest/v1/division_members?select=user_id,division_id,whatsapp`, {
        headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
      }),
      fetch(`${su}/rest/v1/user_roles?select=identifier,role`, {
        headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
      })
    ]);

    const divs = divsRes.ok ? await divsRes.json() : [];
    const roleList = rolesRes.ok ? await rolesRes.json() : [];

    const divMap = new Map((divs || []).map(d => [d.user_id, d]));
    const adminSet = new Set((roleList || []).filter(r => r.role === 'admin').map(r => (r.identifier || '').toLowerCase()));

    const query = (params.query || '').toLowerCase().trim();

    const enriched = (users || []).map(u => {
      const email = (u.email || '').toLowerCase();
      const divInfo = divMap.get(u.id);
      const isUserAdmin = adminSet.has(email) || (superadminEmail && email === superadminEmail.toLowerCase());
      const isSuper = superadminEmail && email === superadminEmail.toLowerCase();
      return {
        id: u.id,
        email: u.email,
        full_name: u.user_metadata?.full_name || u.user_metadata?.name || u.email?.split('@')[0] || '',
        username: u.user_metadata?.username || u.email?.split('@')[0] || '',
        whatsapp: divInfo?.whatsapp || u.user_metadata?.whatsapp || '',
        division: divInfo?.division_id || 'None',
        is_admin: isUserAdmin,
        is_superadmin: isSuper,
        banned: !!u.app_metadata?.banned,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at
      };
    }).filter(u => {
      if (!query) return true;
      return (
        u.email.toLowerCase().includes(query) ||
        u.full_name.toLowerCase().includes(query) ||
        u.username.toLowerCase().includes(query) ||
        u.division.toLowerCase().includes(query)
      );
    });

    return {
      success: true,
      total: enriched.length,
      users: enriched
    };
  }

  // 4. ACTION: SET_PASSWORD / RESET_PASSWORD
  if (action === 'set_password' || action === 'reset_password') {
    const target = await resolveTargetUser(params.user_id, params.email);
    if (!target) throw err400('Target user not found');
    const isSelf = target.id === auth.userId;
    if (!isSelf && !roles.isAdmin && !roles.isSuperAdmin) {
      throw err403('Admin privileges required to reset another user password');
    }
    const newPass = params.password || params.new_password;
    if (!newPass || newPass.length < 6) throw err400('params.password must be at least 6 characters');

    const res = await fetch(`${su}/auth/v1/admin/users/${target.id}`, {
      method: 'PUT',
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPass })
    });
    if (!res.ok) throw new Error(await res.text());
    await logAction(auth.email, 'mcp_account_set_password', { targetUserId: target.id, targetEmail: target.email }, su, sk);
    return { success: true, message: `Password for ${target.email} updated successfully`, user_id: target.id };
  }

  // 5. ACTION: SET_USERNAME / SET_NAME
  if (action === 'set_username' || action === 'set_name') {
    const target = await resolveTargetUser(params.user_id, params.email);
    if (!target) throw err400('Target user not found');
    const isSelf = target.id === auth.userId;
    if (!isSelf && !roles.isAdmin && !roles.isSuperAdmin) {
      throw err403('Admin privileges required to update another user profile');
    }

    const currentMeta = target.user_metadata || {};
    const updatedMeta = { ...currentMeta };
    if (params.username !== undefined) updatedMeta.username = String(params.username).trim();
    if (params.full_name !== undefined || params.name !== undefined) {
      updatedMeta.full_name = String(params.full_name || params.name).trim();
    }
    if (params.whatsapp !== undefined) updatedMeta.whatsapp = String(params.whatsapp).trim();

    const res = await fetch(`${su}/auth/v1/admin/users/${target.id}`, {
      method: 'PUT',
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_metadata: updatedMeta })
    });
    if (!res.ok) throw new Error(await res.text());
    await logAction(auth.email, 'mcp_account_set_username', { targetUserId: target.id, metadata: updatedMeta }, su, sk);
    return { success: true, user_id: target.id, user_metadata: updatedMeta };
  }

  // 6. ACTION: SET_DIVISION
  if (action === 'set_division') {
    const target = await resolveTargetUser(params.user_id, params.email);
    if (!target) throw err400('Target user not found');
    const isSelf = target.id === auth.userId;
    if (!isSelf && !roles.isAdmin && !roles.isSuperAdmin) {
      throw err403('Admin privileges required to change division of another user');
    }

    const divisionId = (params.division_id || '').toLowerCase().trim();
    if (!divisionId) throw err400('params.division_id is required ("management", "development", "review", or "none")');

    if (divisionId === 'none') {
      await fetch(`${su}/rest/v1/division_members?user_id=eq.${target.id}`, {
        method: 'DELETE',
        headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
      });
      await logAction(auth.email, 'mcp_account_remove_division', { targetUserId: target.id }, su, sk);
      return { success: true, user_id: target.id, division: 'None' };
    }

    if (!['management', 'development', 'review'].includes(divisionId)) {
      throw err400('Invalid division_id. Must be "management", "development", "review", or "none"');
    }

    const wa = params.whatsapp || target.user_metadata?.whatsapp || '';
    // Remove previous division and add new one
    await fetch(`${su}/rest/v1/division_members?user_id=eq.${target.id}`, {
      method: 'DELETE',
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
    });
    const addRes = await fetch(`${su}/rest/v1/division_members`, {
      method: 'POST',
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: target.id, division_id: divisionId, whatsapp: wa })
    });
    if (!addRes.ok) throw new Error(await addRes.text());
    await logAction(auth.email, 'mcp_account_set_division', { targetUserId: target.id, divisionId }, su, sk);
    return { success: true, user_id: target.id, division: divisionId };
  }

  // 7. ACTION: SET_ADMIN
  if (action === 'set_admin') {
    if (!roles.isSuperAdmin) throw err403('SuperAdmin only');
    const target = await resolveTargetUser(params.user_id, params.email);
    if (!target) throw err400('Target user not found');
    const targetEmail = (target.email || '').trim().toLowerCase();
    const makeAdmin = params.is_admin === true || params.admin === true;

    if (makeAdmin) {
      await usersAddAdmin(targetEmail, auth.email, su, sk);
    } else {
      await usersRemoveAdmin(targetEmail, auth.email, su, sk);
    }
    return { success: true, email: targetEmail, is_admin: makeAdmin };
  }

  // 8. ACTION: SET_BAN
  if (action === 'set_ban' || action === 'ban') {
    if (!roles.isSuperAdmin) throw err403('SuperAdmin only');
    const target = await resolveTargetUser(params.user_id, params.email);
    if (!target) throw err400('Target user not found');
    const shouldBan = params.banned !== undefined ? !!params.banned : true;
    return usersBan(target.id, shouldBan, auth.email, su, sk);
  }

  // 9. ACTION: DELETE
  if (action === 'delete') {
    if (!roles.isSuperAdmin) throw err403('SuperAdmin only');
    const target = await resolveTargetUser(params.user_id, params.email);
    if (!target) throw err400('Target user not found');
    return usersDelete(target.id, su, sk);
  }

  // 10. ACTION: UPDATE (Composite)
  if (action === 'update') {
    const target = await resolveTargetUser(params.user_id, params.email);
    if (!target) throw err400('Target user not found');
    const isSelf = target.id === auth.userId;
    if (!isSelf && !roles.isAdmin && !roles.isSuperAdmin) {
      throw err403('Admin privileges required to update another user');
    }

    const updates = {};
    const metaUpdates = { ...(target.user_metadata || {}) };
    let hasMetaUpdate = false;

    if (params.password && params.password.length >= 6) {
      updates.password = params.password;
    }
    if (params.username !== undefined) {
      metaUpdates.username = String(params.username).trim();
      hasMetaUpdate = true;
    }
    if (params.full_name !== undefined || params.name !== undefined) {
      metaUpdates.full_name = String(params.full_name || params.name).trim();
      hasMetaUpdate = true;
    }
    if (params.whatsapp !== undefined) {
      metaUpdates.whatsapp = String(params.whatsapp).trim();
      hasMetaUpdate = true;
    }
    if (hasMetaUpdate) updates.user_metadata = metaUpdates;

    if (Object.keys(updates).length > 0) {
      const putRes = await fetch(`${su}/auth/v1/admin/users/${target.id}`, {
        method: 'PUT',
        headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (!putRes.ok) throw new Error(await putRes.text());
    }

    if (params.division_id !== undefined) {
      const divId = (params.division_id || '').toLowerCase().trim();
      if (divId === 'none') {
        await fetch(`${su}/rest/v1/division_members?user_id=eq.${target.id}`, {
          method: 'DELETE',
          headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
        });
      } else if (['management', 'development', 'review'].includes(divId)) {
        await fetch(`${su}/rest/v1/division_members?user_id=eq.${target.id}`, {
          method: 'DELETE',
          headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
        });
        await fetch(`${su}/rest/v1/division_members`, {
          method: 'POST',
          headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: target.id, division_id: divId, whatsapp: metaUpdates.whatsapp || '' })
        });
      }
    }

    if (params.is_admin !== undefined && roles.isSuperAdmin) {
      const targetEmail = (target.email || '').trim().toLowerCase();
      if (params.is_admin === true) {
        await usersAddAdmin(targetEmail, auth.email, su, sk);
      } else {
        await usersRemoveAdmin(targetEmail, auth.email, su, sk);
      }
    }

    if (params.banned !== undefined && roles.isSuperAdmin) {
      await usersBan(target.id, !!params.banned, auth.email, su, sk);
    }

    await logAction(auth.email, 'mcp_account_update', { targetUserId: target.id }, su, sk);
    return { success: true, message: `User ${target.email} updated successfully`, user_id: target.id };
  }

  throw err400(`Unknown action "${action}". Supported actions: create, update, set_password, set_username, set_division, set_admin, set_ban, get, list, delete`);
}

// ═══════════════════════════════════════════════════════════════
// CONFIG HANDLERS
// ═══════════════════════════════════════════════════════════════

async function configGet(su, sk) {
  const res = await fetch(`${su}/rest/v1/app_settings?limit=1`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (!res.ok) throw new Error('Failed to fetch config');
  const [cfg] = await res.json();
  return { allowSignup: cfg.allow_signup, maintenanceMode: cfg.maintenance_mode, bannedDevices: cfg.banned_devices };
}

async function configUpdate(params, adminEmail, su, sk) {
  const getRes = await fetch(`${su}/rest/v1/app_settings?limit=1`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  const [cfg] = await getRes.json();
  const payload = {};
  if (params.allowSignup !== undefined) payload.allow_signup = params.allowSignup;
  if (params.maintenanceMode !== undefined) payload.maintenance_mode = params.maintenanceMode;
  if (params.bannedDevices !== undefined) payload.banned_devices = params.bannedDevices;
  const res = await fetch(`${su}/rest/v1/app_settings?id=eq.${cfg.id}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Config update failed');
  await logAction(adminEmail, 'mcp_update_config', payload, su, sk);
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════
// CONTRIBUTIONS HANDLERS
// ═══════════════════════════════════════════════════════════════

async function recordContribution(userId, points, taskId, type, su, sk) {
  if (!userId) return;
  try {
    const payload = {
      user_id: userId,
      points: Number(points) || 1
    };
    if (taskId) payload.task_id = taskId;
    if (type) payload.type = type;
    await fetch(`${su}/rest/v1/contributions`, {
      method: 'POST',
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.warn('Failed to record contribution in MCP:', err.message);
  }
}

// Couple Contribution Package — DB-backed configuration
async function loadCoupleConfig(su, sk) {
  try {
    const res = await fetch(`${su}/rest/v1/couple_config?id=eq.1&select=*`, {
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Cache-Control': 'no-cache' },
      cache: 'no-store'
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return data[0];
  } catch (e) {
    console.warn('Failed to load couple config:', e.message);
    return null;
  }
}

function isCoupleMember(user, coupleConfig) {
  if (!user || !coupleConfig) return false;
  const email = (user.email || '').toLowerCase();
  const p1Email = (coupleConfig.partner1_email || '').toLowerCase();
  const p2Email = (coupleConfig.partner2_email || '').toLowerCase();
  if (user.id && (user.id === coupleConfig.partner1_user_id || user.id === coupleConfig.partner2_user_id)) return true;
  if (email && (email === p1Email || email === p2Email)) return true;
  return false;
}

async function contributionsLeaderboard(su, sk) {
  const res = await fetch(`${su}/rest/v1/contributions?select=points,user_id`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  const data = await res.json();
  const usersRes = await fetch(`${su}/auth/v1/admin/users?per_page=1000`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  const { users } = await usersRes.json();
  const allUsers = Array.isArray(users) ? users : [];
  const coupleConfig = await loadCoupleConfig(su, sk);

  // Calculate pooled points for couple package
  const coupleUserIds = new Set(allUsers.filter(u => isCoupleMember(u, coupleConfig)).map(u => u.id));
  let coupleTotalPoints = 0;
  (data || []).forEach(c => {
    if (coupleUserIds.has(c.user_id)) {
      coupleTotalPoints += (c.points || 0);
    }
  });

  const scores = {};
  (data || []).forEach(c => {
    const u = allUsers.find(au => au.id === c.user_id);
    const email = u ? u.email : 'Unknown';
    const username = u?.user_metadata?.username || email.split('@')[0];
    const userIsCouple = isCoupleMember(u, coupleConfig);
    if (!userIsCouple) {
      if (!scores[email]) scores[email] = { points: 0, username, is_couple: false };
      scores[email].points += (c.points || 0);
    }
  });

  const list = Object.entries(scores)
    .filter(([email, d]) => d.points > 0)
    .map(([email, d]) => ({ email, username: d.username, points: d.points, is_couple: false }));

  // Add 1 single combined couple entry only if coupleTotalPoints > 0
  if (coupleTotalPoints > 0 && coupleConfig) {
    const coupleUsers = allUsers.filter(u => isCoupleMember(u, coupleConfig));
    const coupleNames = coupleUsers.map(u => u?.user_metadata?.username || u.email.split('@')[0]);
    const coupleUsername = coupleNames.length > 0 ? coupleNames.join(' & ') : `${coupleConfig.partner1_email.split('@')[0]} & ${coupleConfig.partner2_email.split('@')[0]}`;
    list.push({
      email: coupleUsers.map(u => u.email).join(', '),
      username: coupleUsername,
      points: coupleTotalPoints,
      is_couple: true
    });
  }

  const leaderboard = list.sort((a, b) => b.points - a.points);
  return { leaderboard };
}

async function contributionsMy(userId, su, sk) {
  let targetUserIds = [userId];
  const usersRes = await fetch(`${su}/auth/v1/admin/users?per_page=1000`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  let isCoupleUser = false;
  let coupleLabel = null;
  const coupleConfig = await loadCoupleConfig(su, sk);
  if (usersRes.ok) {
    const { users } = await usersRes.json();
    const allUsers = Array.isArray(users) ? users : [];
    const currentUser = allUsers.find(u => u.id === userId);
    if (isCoupleMember(currentUser, coupleConfig)) {
      isCoupleUser = true;
      const coupleUsers = allUsers.filter(u => isCoupleMember(u, coupleConfig));
      if (coupleUsers.length > 0) {
        targetUserIds = Array.from(new Set(coupleUsers.map(u => u.id)));
      }
      // Build dynamic label
      const name1 = coupleUsers[0]?.user_metadata?.username || coupleConfig.partner1_email.split('@')[0];
      const name2 = coupleUsers[1]?.user_metadata?.username || coupleConfig.partner2_email.split('@')[0];
      coupleLabel = `Paket Contribution Couple: ${name1} & ${name2}`;
    }
  }

  const filterParam = targetUserIds.length > 1
    ? `user_id=in.(${targetUserIds.join(',')})`
    : `user_id=eq.${userId}`;

  const res = await fetch(`${su}/rest/v1/contributions?${filterParam}&order=created_at.desc`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  const data = await res.json();
  const list = Array.isArray(data) ? data : [];
  const total = list.reduce((sum, c) => sum + (c.points || 0), 0);
  return {
    total_points: total,
    count: list.length,
    is_couple: isCoupleUser,
    couple_package: coupleLabel,
    contributions: list
  };
}

async function contributionsRecord(params, adminEmail, su, sk) {
  let targetUserId = params.user_id;
  if (!targetUserId && params.user_email) {
    const usersRes = await fetch(`${su}/auth/v1/admin/users?per_page=1000`, {
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
    });
    if (usersRes.ok) {
      const { users } = await usersRes.json();
      const u = (users || []).find(x => x.email === params.user_email);
      if (u) targetUserId = u.id;
    }
  }
  if (!targetUserId) throw err400('Missing or invalid target user (provide valid user_id or user_email)');
  const points = Number(params.points) || 1;
  await recordContribution(targetUserId, points, params.task_id || null, params.type || 'mcp_contribution', su, sk);
  await logAction(adminEmail, 'mcp_record_contribution', { targetUserId, points, type: params.type, taskId: params.task_id }, su, sk);
  return { success: true, user_id: targetUserId, points_awarded: points };
}

// ═══════════════════════════════════════════════════════════════
// REVIEW HANDLERS
// ═══════════════════════════════════════════════════════════════

async function reviewIssuesList(taskId, su, sk) {
  const res = await fetch(`${su}/rest/v1/review_issues?task_id=eq.${taskId}&order=created_at.desc`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  return { issues: await res.json() };
}

async function reviewIssuesReport(params, userId, su, sk) {
  const { task_id, issue_type, question_index, description } = params;
  if (!task_id) throw err400('Missing params.task_id');
  const res = await fetch(`${su}/rest/v1/review_issues`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id, reviewer_id: userId, issue_type, question_index, description, status: 'open' })
  });
  if (!res.ok) throw new Error(await res.text());
  return { success: true };
}

async function reviewIssuesResolve(issueId, su, sk) {
  const res = await fetch(`${su}/rest/v1/review_issues?id=eq.${issueId}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'fixed', resolved_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error(await res.text());
  return { success: true };
}

async function reviewIssuesDelete(issueId, su, sk) {
  const res = await fetch(`${su}/rest/v1/review_issues?id=eq.${issueId}`, {
    method: 'DELETE',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (!res.ok) throw new Error('Failed to delete issue: ' + await res.text());
  return { success: true, issueId };
}

async function usersResetPassword(userId, email, newPassword, adminEmail, su, sk) {
  if (!newPassword || newPassword.length < 6) throw err400('Password must be at least 6 characters');

  // Resolve target user by ID or email
  let targetId = userId;
  let targetEmail = email;
  if (!targetId && email) {
    const listRes = await fetch(`${su}/auth/v1/admin/users?per_page=1000`, {
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
    });
    if (listRes.ok) {
      const data = await listRes.json();
      const found = (data.users || []).find(u =>
        (u.email && u.email.toLowerCase() === email.trim().toLowerCase())
      );
      if (found) { targetId = found.id; targetEmail = found.email; }
    }
  }
  if (!targetId) throw err400('User not found. Provide a valid user_id or email.');

  const res = await fetch(`${su}/auth/v1/admin/users/${targetId}`, {
    method: 'PUT',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: newPassword })
  });
  if (!res.ok) throw new Error('Failed to reset password: ' + await res.text());
  await logAction(adminEmail, 'mcp_reset_user_password', { targetUserId: targetId, targetEmail }, su, sk);
  return { success: true, message: `Password for ${targetEmail || targetId} updated successfully`, user_id: targetId };
}

async function usersList(su, sk) {
  const listRes = await fetch(`${su}/auth/v1/admin/users?per_page=1000`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (!listRes.ok) throw new Error('Failed to list users: ' + await listRes.text());
  const data = await listRes.json();
  const users = (data.users || []).map(u => ({
    id: u.id,
    email: u.email || '',
    full_name: (u.user_metadata && u.user_metadata.full_name) || '',
    username: (u.user_metadata && u.user_metadata.username) || '',
    whatsapp: (u.user_metadata && u.user_metadata.whatsapp) || '',
    banned: !!(u.banned_until || (u.app_metadata && u.app_metadata.banned)),
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at
  }));
  return { success: true, total: users.length, users };
}

async function usersBan(userId, banned, adminEmail, su, sk) {
  if (!userId) throw err400('Missing userId');
  const payload = banned
    ? { banned_until: '2999-12-31T23:59:59Z', app_metadata: { banned: true } }
    : { banned_until: null, app_metadata: { banned: false } };
  const res = await fetch(`${su}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Failed to ' + (banned ? 'ban' : 'unban') + ' user: ' + await res.text());
  await logAction(adminEmail, banned ? 'mcp_ban_user' : 'mcp_unban_user', { targetUserId: userId }, su, sk);
  return { success: true, user_id: userId, banned };
}

async function usersDelete(userId, su, sk) {
  if (!userId) throw err400('Missing userId');
  const res = await fetch(`${su}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (!res.ok) throw new Error('Failed to delete user: ' + await res.text());
  return { success: true, user_id: userId, message: 'User deleted successfully' };
}

async function usersAddAdmin(targetEmail, adminEmail, su, sk) {
  const res = await fetch(`${su}/rest/v1/user_roles`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ identifier: targetEmail.trim(), role: 'admin' })
  });
  if (!res.ok) throw new Error('Failed to add admin: ' + await res.text());
  await logAction(adminEmail, 'mcp_add_admin', { targetEmail }, su, sk);
  return { success: true, email: targetEmail };
}

async function usersRemoveAdmin(targetEmail, adminEmail, su, sk) {
  const encEmail = encodeURIComponent(targetEmail.trim());
  const res = await fetch(`${su}/rest/v1/user_roles?identifier=eq.${encEmail}`, {
    method: 'DELETE',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (!res.ok) throw new Error('Failed to remove admin: ' + await res.text());
  await logAction(adminEmail, 'mcp_remove_admin', { targetEmail }, su, sk);
  return { success: true, email: targetEmail };
}

async function divisionsAddMember(userId, divisionId, whatsapp, adminEmail, su, sk) {
  const res = await fetch(`${su}/rest/v1/division_members`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ user_id: userId, division_id: divisionId, whatsapp })
  });
  if (!res.ok) throw new Error('Failed to add division member: ' + await res.text());
  await logAction(adminEmail, 'mcp_add_division_member', { userId, divisionId }, su, sk);
  return { success: true, userId, divisionId };
}

async function divisionsRemoveMember(userId, divisionId, adminEmail, su, sk) {
  const res = await fetch(`${su}/rest/v1/division_members?user_id=eq.${userId}&division_id=eq.${divisionId}`, {
    method: 'DELETE',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (!res.ok) throw new Error('Failed to remove division member: ' + await res.text());
  await logAction(adminEmail, 'mcp_remove_division_member', { userId, divisionId }, su, sk);
  return { success: true, userId, divisionId };
}

async function contentDeleteFiles(pathsOrParams, adminEmail, githubToken, owner, repo, su, sk) {
  const params = Array.isArray(pathsOrParams) ? { paths: pathsOrParams } : (pathsOrParams.paths ? pathsOrParams : { paths: [pathsOrParams.path] });
  return contentDelete(params, adminEmail, githubToken, owner, repo, su, sk);
}

async function tasksDelete(taskId, adminEmail, su, sk) {
  const res = await fetch(`${su}/rest/v1/content_tasks?id=eq.${taskId}`, {
    method: 'DELETE',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (!res.ok) throw new Error('Failed to delete task: ' + await res.text());
  await logAction(adminEmail, 'mcp_delete_task', { taskId }, su, sk);
  return { success: true, taskId };
}

async function tasksUnclaim(taskId, userId, su, sk) {
  const res = await fetch(`${su}/rest/v1/content_tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'open', assigned_to: null, assigned_at: null })
  });
  if (!res.ok) throw new Error('Failed to unclaim task: ' + await res.text());

  await fetch(`${su}/rest/v1/task_logs`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, user_id: userId, action: 'unclaimed', old_status: 'in_progress', new_status: 'open' })
  });

  return { success: true };
}

async function tasksStartReview(taskId, userId, su, sk) {
  const res = await fetch(`${su}/rest/v1/content_tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'in_review', review_started_at: new Date().toISOString(), reviewed_by: userId })
  });
  if (!res.ok) throw new Error('Failed to start review: ' + await res.text());

  await fetch(`${su}/rest/v1/task_logs`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, user_id: userId, action: 'review_started', old_status: 'developed', new_status: 'in_review' })
  });

  return { success: true };
}

async function tasksAddNote(taskId, userId, note, su, sk) {
  const res = await fetch(`${su}/rest/v1/task_logs`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, user_id: userId, action: 'commented', note: note })
  });
  if (!res.ok) throw new Error('Failed to add note: ' + await res.text());
  return { success: true };
}

async function divisionsJoin(userId, divisionId, whatsapp, su, sk) {
  const res = await fetch(`${su}/rest/v1/division_members`, {
    method: 'POST',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ user_id: userId, division_id: divisionId, whatsapp })
  });
  if (!res.ok) throw new Error('Failed to join division: ' + await res.text());
  return { success: true, divisionId };
}

async function divisionsUpdateWhatsapp(userId, whatsapp, su, sk) {
  const res = await fetch(`${su}/rest/v1/division_members?user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ whatsapp })
  });
  if (!res.ok) throw new Error('Failed to update whatsapp: ' + await res.text());
  return { success: true, whatsapp };
}

// ═══════════════════════════════════════════════════════════════
// COVER & DOCS HANDLERS
// ═══════════════════════════════════════════════════════════════

async function coverList(githubToken, owner, repo) {
  const tree = await contentTree(githubToken, owner, repo);
  const covers = (tree.tree || []).filter(item => item.path.startsWith('cover/'));
  return { covers };
}

async function docsGet(paramsOrGt, gtOrOwner, ownerOrRepo, repoOptional, reqHost = 'mr-capsules.vercel.app') {
  let params = {}, gt, owner, repo;
  if (typeof paramsOrGt === 'object' && paramsOrGt !== null) {
    params = paramsOrGt;
    gt = gtOrOwner;
    owner = ownerOrRepo;
    repo = repoOptional;
  } else {
    gt = paramsOrGt;
    owner = gtOrOwner;
    repo = ownerOrRepo;
  }

  const fileData = await contentGet('docs.html', gt, owner, repo);
  const html = fileData.content;

  if (params.full_html === true) {
    return { path: 'docs.html', html, size_bytes: html.length };
  }

  const rawSections = html.split('<div class="docs-section">');
  const outline = [];

  for (let i = 1; i < rawSections.length; i++) {
    const sec = rawSections[i];
    const endIdx = sec.indexOf('</div>');
    const secBody = endIdx !== -1 ? sec.substring(0, endIdx) : sec;
    const titleMatch = secBody.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Section ${i}`;
    outline.push({ sectionIndex: i, title });
  }

  if (params.sectionIndex !== undefined && params.sectionIndex !== null) {
    const sIdx = parseInt(params.sectionIndex);
    if (sIdx < 1 || sIdx >= rawSections.length) {
      throw err400(`Invalid sectionIndex: ${sIdx}. Valid range is 1 to ${rawSections.length - 1}`);
    }
    const targetSec = rawSections[sIdx];
    const endIdx = targetSec.indexOf('</div>');
    const secBody = endIdx !== -1 ? targetSec.substring(0, endIdx) : targetSec;
    const titleMatch = secBody.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Section ${sIdx}`;

    const cleanText = secBody
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
      .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
      .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '$1\n')
      .replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, ' | $1')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      sectionIndex: sIdx,
      title,
      total_sections: rawSections.length - 1,
      content_text: cleanText,
      content_html: `<div class="docs-section">\n${secBody.trim()}\n</div>`
    };
  }

  return {
    path: 'docs.html',
    total_sections: rawSections.length - 1,
    outline,
    hint: 'To read a specific section, call docs_get with { sectionIndex: <number> }. For full raw HTML, pass { full_html: true }.'
  };
}

function sanitizeDocsHtml(rawHtml) {
  if (!rawHtml) return '';
  let cleaned = rawHtml;
  cleaned = cleaned.replace(/\s*style="[^"]*"/gi, '');
  cleaned = cleaned.replace(/\s*style='[^']*'/gi, '');
  cleaned = cleaned.replace(/<table(?!\s+class=)[^>]*>/gi, '<table class="docs-table">');
  cleaned = cleaned.replace(/<table\s+class="(?![^"]*docs-table)[^"]*"/gi, '<table class="docs-table"');
  return cleaned;
}

async function docsUpdateSection(params, adminEmail, githubToken, owner, repo, su, sk) {
  let { sectionIndex, title, contentHtml } = params;
  if (contentHtml) contentHtml = sanitizeDocsHtml(contentHtml);
  const docsData = await contentGet('docs.html', githubToken, owner, repo);
  let html = docsData.content;

  const sections = html.split('<div class="docs-section">');
  if (sectionIndex < 1 || sectionIndex >= sections.length) {
    throw err400(`Invalid sectionIndex: ${sectionIndex}. Total sections: ${sections.length - 1}`);
  }

  let oldSec = sections[sectionIndex];
  let endIdx = oldSec.indexOf('</div>');
  if (endIdx === -1) endIdx = oldSec.length;

  let newSecContent = '\n';
  if (title) newSecContent += `        <h2>${title}</h2>\n`;
  if (contentHtml) newSecContent += `        ${contentHtml}\n      `;

  sections[sectionIndex] = newSecContent + oldSec.substring(endIdx);
  const updatedHtml = sections.join('<div class="docs-section">');

  const base64Content = Buffer.from(updatedHtml, 'utf-8').toString('base64');
  await contentUpload({ path: 'docs.html', contentBase64: base64Content }, adminEmail, githubToken, owner, repo, su, sk);
  return { success: true, updatedSectionIndex: sectionIndex };
}

async function docsAddSection(params, adminEmail, githubToken, owner, repo, su, sk) {
  let { title, contentHtml, tabId = 'docsGeneral' } = params;
  if (contentHtml) contentHtml = sanitizeDocsHtml(contentHtml);
  const docsData = await contentGet('docs.html', githubToken, owner, repo);
  let html = docsData.content;

  const sectionHtml = `\n      <div class="docs-section">\n        <h2>${title}</h2>\n        ${contentHtml}\n      </div>\n`;

  const containerMarker = `id="${tabId}"`;
  const containerIdx = html.indexOf(containerMarker);
  if (containerIdx === -1) {
    throw new Error(`Target tab container "${tabId}" not found in docs.html`);
  }

  const nextContainerIdx = html.indexOf('<div class="docs-container"', containerIdx + containerMarker.length);
  const scriptIdx = html.indexOf('<script>', containerIdx);
  let limitIdx = html.length;
  if (nextContainerIdx !== -1) limitIdx = Math.min(limitIdx, nextContainerIdx);
  if (scriptIdx !== -1) limitIdx = Math.min(limitIdx, scriptIdx);

  const closeDivIdx = html.lastIndexOf('</div>', limitIdx);
  if (closeDivIdx === -1 || closeDivIdx <= containerIdx) {
    throw new Error(`Could not find closing tag for container "${tabId}"`);
  }

  html = html.substring(0, closeDivIdx) + sectionHtml + html.substring(closeDivIdx);

  const base64Content = Buffer.from(html, 'utf-8').toString('base64');
  await contentUpload({ path: 'docs.html', contentBase64: base64Content }, adminEmail, githubToken, owner, repo, su, sk);
  return { success: true, title, tabId };
}

async function docsAddTab(params, adminEmail, githubToken, owner, repo, su, sk) {
  let { tabId, title, iconSvg, contentHtml = '' } = params;
  if (contentHtml) contentHtml = sanitizeDocsHtml(contentHtml);
  const docsData = await contentGet('docs.html', githubToken, owner, repo);
  let html = docsData.content;

  if (html.includes(`data-target="${tabId}"`) || html.includes(`id="${tabId}"`)) {
    throw new Error(`Tab with ID "${tabId}" already exists.`);
  }

  const defaultIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;
  const icon = iconSvg || defaultIcon;

  const tabButtonHtml = `\n      <div class="tab" data-target="${tabId}">\n        ${icon}\n        ${title}\n      </div>\n    `;
  
  const containerHtml = `\n    <div class="docs-container" id="${tabId}">\n      <div class="docs-title">${title.toUpperCase()}</div>\n      ${contentHtml}\n    </div>\n`;

  const tabsMarker = '<div class="tabs">';
  const tabsIdx = html.indexOf(tabsMarker);
  if (tabsIdx === -1) throw new Error('<div class="tabs"> not found in docs.html');
  const tabsCloseIdx = html.indexOf('</div>', tabsIdx);
  html = html.substring(0, tabsCloseIdx) + tabButtonHtml + html.substring(tabsCloseIdx);

  const scriptIdx = html.indexOf('<script>');
  const lastDivBeforeScript = html.lastIndexOf('</div>', scriptIdx);
  if (lastDivBeforeScript === -1) throw new Error('Closing container div before script not found');

  html = html.substring(0, lastDivBeforeScript) + containerHtml + html.substring(lastDivBeforeScript);

  const base64Content = Buffer.from(html, 'utf-8').toString('base64');
  await contentUpload({ path: 'docs.html', contentBase64: base64Content }, adminEmail, githubToken, owner, repo, su, sk);
  return { success: true, tabId, title };
}

async function docsUpdateTab(params, adminEmail, githubToken, owner, repo, su, sk) {
  let { tabId, title, contentHtml } = params;
  if (contentHtml) contentHtml = sanitizeDocsHtml(contentHtml);
  const docsData = await contentGet('docs.html', githubToken, owner, repo);
  let html = docsData.content;

  if (title) {
    const tabRegex = new RegExp(`(<div class="tab[^"]*" data-target="${tabId}">[\\s\\S]*?<\\/div>)`);
    if (tabRegex.test(html)) {
      html = html.replace(tabRegex, (match) => {
        return match.replace(/>\s*([^<]+)\s*<\/div>/, `> ${title}</div>`);
      });
    }
  }

  if (contentHtml) {
    const containerMarker = `id="${tabId}"`;
    const containerIdx = html.indexOf(containerMarker);
    if (containerIdx === -1) throw new Error(`Tab container "${tabId}" not found`);

    const startIdx = html.indexOf('>', containerIdx) + 1;
    const nextContainerIdx = html.indexOf('<div class="docs-container"', startIdx);
    const scriptIdx = html.indexOf('<script>', startIdx);
    let limitIdx = html.length;
    if (nextContainerIdx !== -1) limitIdx = Math.min(limitIdx, nextContainerIdx);
    if (scriptIdx !== -1) limitIdx = Math.min(limitIdx, scriptIdx);

    const endIdx = html.lastIndexOf('</div>', limitIdx);
    const newInner = `\n      <div class="docs-title">${(title || tabId).toUpperCase()}</div>\n      ${contentHtml}\n    `;
    html = html.substring(0, startIdx) + newInner + html.substring(endIdx);
  }

  const base64Content = Buffer.from(html, 'utf-8').toString('base64');
  await contentUpload({ path: 'docs.html', contentBase64: base64Content }, adminEmail, githubToken, owner, repo, su, sk);
  return { success: true, tabId };
}

async function docsDeleteTab(params, adminEmail, githubToken, owner, repo, su, sk) {
  const { tabId } = params;
  const docsData = await contentGet('docs.html', githubToken, owner, repo);
  let html = docsData.content;

  const tabBtnRegex = new RegExp(`\\s*<div class="tab[^"]*" data-target="${tabId}">[\\s\\S]*?<\\/div>`, 'g');
  html = html.replace(tabBtnRegex, '');

  const containerMarker = `id="${tabId}"`;
  const containerIdx = html.indexOf(containerMarker);
  if (containerIdx !== -1) {
    const divStartIdx = html.lastIndexOf('<div class="docs-container"', containerIdx);
    const startIdx = html.indexOf('>', containerIdx) + 1;
    const nextContainerIdx = html.indexOf('<div class="docs-container"', startIdx);
    const scriptIdx = html.indexOf('<script>', startIdx);
    let limitIdx = html.length;
    if (nextContainerIdx !== -1) limitIdx = Math.min(limitIdx, nextContainerIdx);
    if (scriptIdx !== -1) limitIdx = Math.min(limitIdx, scriptIdx);

    const endDivIdx = html.lastIndexOf('</div>', limitIdx);
    const fullEndIdx = html.indexOf('>', endDivIdx) + 1;
    html = html.substring(0, divStartIdx) + html.substring(fullEndIdx);
  }

  const base64Content = Buffer.from(html, 'utf-8').toString('base64');
  await contentUpload({ path: 'docs.html', contentBase64: base64Content }, adminEmail, githubToken, owner, repo, su, sk);
  return { success: true, tabId };
}

async function usersRemoveDevice(userId, deviceId, adminEmail, su, sk) {
  await fetch(`${su}/rest/v1/user_devices?user_id=eq.${userId}&device_id=eq.${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });

  const getSbRes = await fetch(`${su}/auth/v1/admin/users/${userId}`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (getSbRes.ok) {
    const userData = await getSbRes.json();
    const userMeta = userData.user_metadata || {};
    let devices = Array.isArray(userMeta.devices) ? userMeta.devices : [];
    devices = devices.filter(d => d.id !== deviceId);

    await fetch(`${su}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_metadata: { ...userMeta, devices } })
    });
  }

  await logAction(adminEmail, 'mcp_remove_user_device', { userId, deviceId }, su, sk);
  return { success: true, userId, deviceId };
}

async function usersBlockDevice(deviceId, banned, adminEmail, su, sk) {
  const getRes = await fetch(`${su}/rest/v1/app_settings?limit=1`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  const [cfg] = await getRes.json();
  let bannedDevs = cfg.banned_devices || [];

  if (banned) {
    if (!bannedDevs.includes(deviceId)) bannedDevs.push(deviceId);
  } else {
    bannedDevs = bannedDevs.filter(id => id !== deviceId);
  }

  const res = await fetch(`${su}/rest/v1/app_settings?id=eq.${cfg.id}`, {
    method: 'PATCH',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ banned_devices: bannedDevs })
  });
  if (!res.ok) throw new Error('Failed to block/unblock device');

  await logAction(adminEmail, banned ? 'mcp_block_device' : 'mcp_unblock_device', { deviceId }, su, sk);
  return { success: true, deviceId, banned };
}

async function activityLogsList(limit, su, sk) {
  const res = await fetch(`${su}/rest/v1/activity_logs?select=*&order=time.desc&limit=${limit}`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (!res.ok) throw new Error('Failed to fetch activity logs');
  return { logs: await res.json() };
}

async function systemCleanupGuests(su, sk) {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const getRes = await fetch(`${su}/auth/v1/admin/users?per_page=1000`, {
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (!getRes.ok) throw new Error('Failed to fetch users');
  const { users } = await getRes.json();
  const guestUsers = (users || []).filter(u => u.email && u.email.endsWith('@guest.mr-capsules.local') && u.created_at < cutoff);

  let deletedCount = 0;
  for (const guest of guestUsers) {
    const delRes = await fetch(`${su}/auth/v1/admin/users/${guest.id}`, {
      method: 'DELETE',
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
    });
    if (delRes.ok) deletedCount++;
  }
  return { success: true, deletedGuestsCount: deletedCount };
}

// ═══════════════════════════════════════════════════════════════
// AUDIT LOG HELPER
// ═══════════════════════════════════════════════════════════════

async function logAction(adminEmail, action, details, su, sk) {
  try {
    await fetch(`${su}/rest/v1/activity_logs`, {
      method: 'POST',
      headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_email: adminEmail, action, details })
    });
  } catch(e) { /* Non-fatal */ }
}

// ═══════════════════════════════════════════════════════════════
// STREAMABLE HTTP GET HANDLER
// Handles GET /api/mcp — the initial connection from Claude.ai web
// Per MCP spec 2025-06-18, GET opens an optional SSE stream.
// Tool calls still come in as POST requests.
// ═══════════════════════════════════════════════════════════════

async function handleMcpStreamableGet(req, res, su, sk) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'mr-capsules.vercel.app';
  const acceptHeader = (req.headers.accept || '').toLowerCase();

  // If client expects JSON or standard probe, return JSON server discovery
  if (!acceptHeader.includes('text/event-stream')) {
    return res.status(200).json({
      name: 'mr-capsules',
      version: '1.2.0',
      protocol: 'mcp',
      protocolVersion: '2024-11-05',
      transport: 'Streamable HTTP (MCP 2024-11-05 / 2025-06-18) + OpenAPI Actions',
      endpoints: {
        mcp: `https://${host}/api/mcp`,
        openapi: `https://${host}/api/openapi.json`,
        ai_plugin: `https://${host}/.well-known/ai-plugin.json`
      },
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false }
      },
      status: 'ready'
    });
  }

  const sessionId = `mrc-${Date.now()}`;

  // Return SSE stream per Streamable HTTP / SSE spec
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Mcp-Session-Id', sessionId);

  // Send the server's endpoint event (Streamable HTTP pattern)
  res.write(`event: endpoint\ndata: ${JSON.stringify({
    uri: '/api/mcp',
    name: 'mr-capsules'
  })}\n\n`);

  // Heartbeat to keep Vercel connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch(e) { clearInterval(heartbeat); }
  }, 20000);

  req.on('close', () => clearInterval(heartbeat));
}

function parseMultipart(bodyBuffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = 0;

  while (true) {
    const index = bodyBuffer.indexOf(boundaryBuffer, start);
    if (index === -1) break;
    
    const nextIndex = bodyBuffer.indexOf(boundaryBuffer, index + boundaryBuffer.length);
    if (nextIndex === -1) break;

    const partBuffer = bodyBuffer.slice(index + boundaryBuffer.length, nextIndex);
    parts.push(partBuffer);
    start = nextIndex;
  }

  const result = {};
  for (const part of parts) {
    const doubleCrlf = Buffer.from('\r\n\r\n');
    const headerEnd = part.indexOf(doubleCrlf);
    if (headerEnd === -1) continue;

    const headerStr = part.slice(0, headerEnd).toString('utf-8');
    const bodyVal = part.slice(headerEnd + 4, part.length - 2); // remove trailing \r\n

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    if (filenameMatch) {
      result[name] = {
        filename: filenameMatch[1],
        content: bodyVal
      };
    } else {
      result[name] = bodyVal.toString('utf-8').trim();
    }
  }
  return result;
}

async function handleDirectUpload(req, res, supabaseUrl, sbKey, githubToken, owner, repo, superAdminEmail) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = (req.headers.authorization || '').trim();
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Bearer token required.' });
  }
  const token = authHeader.slice(7).trim();
  const currentReqHost = req.headers['x-forwarded-host'] || req.headers.host || 'mr-capsules.vercel.app';

  let authResult = null;
  if (token.startsWith('mrc_at_')) {
    authResult = await authenticateOAuthAccessToken(token, supabaseUrl, sbKey, currentReqHost);
  } else if (token.startsWith('mrc_')) {
    authResult = await authenticateApiKey(token, supabaseUrl, sbKey);
  } else {
    authResult = await authenticateJWT(token, supabaseUrl, sbKey);
  }

  if (authResult.error) {
    return res.status(401).json({ error: authResult.error });
  }

  const roles = await resolveRoles(authResult.userId, authResult.email, supabaseUrl, sbKey, superAdminEmail);
  if (!roles.hasDivision && !roles.isAdmin) {
    return res.status(403).json({ error: 'Forbidden. Division membership required to upload.' });
  }

  // Parse Multipart Body
  let parsedFields = {};
  try {
    const contentType = req.headers['content-type'] || '';
    const match = contentType.match(/boundary=([^;]+)/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid content type. Multipart boundary required.' });
    }
    const boundary = match[1];

    const rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', err => reject(err));
    });

    parsedFields = parseMultipart(rawBody, boundary);
  } catch (err) {
    return res.status(400).json({ error: 'Failed to parse multipart payload: ' + err.message });
  }

  const { path, file } = parsedFields;
  if (!path) return res.status(400).json({ error: 'Missing path field' });
  if (!file || !file.content) return res.status(400).json({ error: 'Missing file field' });

  // Validate Path traversal
  if (path.includes('..') || path.startsWith('/')) {
    return res.status(400).json({ error: 'Invalid path traversal' });
  }

  const contentBase64 = file.content.toString('base64');
  const sizeBytes = file.content.length;

  // Commit to GitHub
  try {
    let existingSha = null;
    try {
      const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
        headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'MR-CAPSULES-UPLOADER' }
      });
      if (getRes.ok) {
        const fileInfo = await getRes.json();
        existingSha = fileInfo.sha;
      }
    } catch (e) {}

    const putBody = {
      message: `mcp: upload ${path} (API)`,
      content: contentBase64
    };
    if (existingSha) putBody.sha = existingSha;

    const putRes = await ghApi('PUT', `/contents/${encodeURIComponent(path)}`, putBody, githubToken, owner, repo);
    if (!putRes.ok) {
      const errData = await putRes.json();
      throw new Error(errData.message || 'GitHub API error');
    }

    const putData = await putRes.json();
    const sha = putData.content?.sha || putData.commit?.sha || '';

    await logAction(authResult.email, 'mcp_upload_api', { path, sizeBytes }, supabaseUrl, sbKey);

    return res.status(200).json({
      success: true,
      path,
      sha,
      sizeBytes
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to commit to GitHub: ' + err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// DOCTOR TABLET INTEGRATION HELPERS
// ═══════════════════════════════════════════════════════════════

const DOCTORTABLET_API_URL = process.env.DOCTORTABLET_API_URL || 'https://doctortablet.vercel.app/api/notes';
const DOCTORTABLET_GH_OWNER = 'alchemist4real';
const DOCTORTABLET_GH_REPO = 'doctortablet';

async function handleDoctorTabletMethod(m, params, githubToken) {
  if (m === 'doctortablet_list_notes') {
    return doctortabletListNotes(params, githubToken);
  }
  if (m === 'doctortablet_read_note') {
    return doctortabletReadNote(params.slug, githubToken);
  }
  if (m === 'doctortablet_save_note') {
    return doctortabletSaveNote(params, githubToken);
  }
  if (m === 'doctortablet_list_categories') {
    return doctortabletListCategories(githubToken);
  }
  if (m === 'doctortablet_create_category') {
    return doctortabletCreateCategory(params, githubToken);
  }
  if (m === 'doctortablet_search_notes') {
    return doctortabletSearchNotes(params, githubToken);
  }
  if (m === 'doctortablet_delete_note') {
    return doctortabletDeleteNote(params.filePath, githubToken);
  }
  if (m === 'doctortablet_export_merged_document') {
    return doctortabletExportMergedDocument(params, githubToken);
  }
  throw err400(`Unknown DoctorTablet method: ${m}`);
}

async function doctortabletFetchNotes(githubToken) {
  // 1. Try Live API first
  try {
    const res = await fetch(DOCTORTABLET_API_URL, {
      method: 'GET',
      headers: { 'User-Agent': 'MR-CAPSULES-MCP-Gateway' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.success && Array.isArray(data.notes) && data.notes.length > 0) {
        return data;
      }
    }
  } catch (err) {
    console.error('DoctorTablet Live API fetch error:', err);
  }

  // 2. Fallback to GitHub REST Git Tree API if Live API returned empty or failed
  if (githubToken) {
    try {
      const treeUrl = `https://api.github.com/repos/${DOCTORTABLET_GH_OWNER}/${DOCTORTABLET_GH_REPO}/git/trees/main?recursive=1`;
      const ghRes = await fetch(treeUrl, {
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'MR-CAPSULES-MCP-Gateway'
        }
      });

      if (ghRes.ok) {
        const treeData = await ghRes.json();
        const rawTree = treeData.tree || [];
        const notesItems = rawTree.filter(item => item.path.startsWith('notes/'));

        const categoriesMap = new Map();
        const notes = [];

        for (const item of notesItems) {
          const relPath = item.path.replace(/^notes\//, '');
          if (!relPath || relPath === '.gitkeep') continue;

          const parts = relPath.split('/');

          if (item.type === 'tree') {
            const folderName = parts[parts.length - 1];
            const parentId = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
            categoriesMap.set(relPath, {
              id: relPath,
              name: folderName.replace(/-/g, ' '),
              path: relPath,
              parentId: parentId,
              type: 'custom',
              color: '#8A9A7E'
            });
          } else if (item.type === 'blob' && relPath.endsWith('.md')) {
            const filename = parts[parts.length - 1];
            const slug = filename.replace(/\.md$/, '');
            const categoryId = parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';

            if (categoryId !== 'root' && !categoriesMap.has(categoryId)) {
              const catParts = categoryId.split('/');
              const folderName = catParts[catParts.length - 1];
              const parentId = catParts.length > 1 ? catParts.slice(0, -1).join('/') : null;
              categoriesMap.set(categoryId, {
                id: categoryId,
                name: folderName.replace(/-/g, ' '),
                path: categoryId,
                parentId: parentId,
                type: 'custom',
                color: '#8A9A7E'
              });
            }

            notes.push({
              id: `note-${slug}`,
              title: slug.replace(/-/g, ' '),
              categoryId,
              slug,
              filePath: item.path,
              tags: ['#medical'],
              updatedAt: new Date().toISOString().split('T')[0],
              sha: item.sha
            });
          }
        }

        return {
          success: true,
          notes,
          categories: Array.from(categoriesMap.values()),
          source: 'github'
        };
      }
    } catch (err) {
      console.error('DoctorTablet GitHub tree fallback fetch error:', err);
    }
  }

  return { success: false, notes: [], categories: [] };
}

async function doctortabletListNotes(params = {}, githubToken) {
  const data = await doctortabletFetchNotes(githubToken);
  let notes = data.notes || [];
  if (params.categoryId) {
    notes = notes.filter(n => n.categoryId === params.categoryId || n.categoryId.startsWith(params.categoryId + '/'));
  }
  if (params.tag) {
    const cleanTag = params.tag.replace(/^#/, '').toLowerCase();
    notes = notes.filter(n => Array.isArray(n.tags) && n.tags.some(t => String(t).toLowerCase().replace(/^#/, '') === cleanTag));
  }
  return {
    success: true,
    totalCount: notes.length,
    notes: notes.map(n => ({
      id: n.id,
      title: n.title,
      categoryId: n.categoryId,
      filePath: n.filePath,
      tags: n.tags,
      wordCount: n.wordCount,
      updatedAt: n.updatedAt
    })),
    categories: data.categories || [],
    source: data.source || 'live_api'
  };
}

async function doctortabletReadNote(slug, githubToken) {
  if (!slug) throw err400('Missing params.slug');
  const cleanSlug = slug.replace(/\.md$/, '');
  
  const data = await doctortabletFetchNotes(githubToken);
  const notes = data.notes || [];
  const matched = notes.find(n => n.slug === cleanSlug || n.id === `note-${cleanSlug}` || (n.filePath && n.filePath.endsWith(`${cleanSlug}.md`)));

  if (matched && matched.content) {
    return { success: true, note: matched };
  }

  if (githubToken) {
    const filePath = matched ? matched.filePath : `notes/${cleanSlug}.md`;
    try {
      const ghUrl = `https://api.github.com/repos/${DOCTORTABLET_GH_OWNER}/${DOCTORTABLET_GH_REPO}/contents/${filePath}`;
      const ghRes = await fetch(ghUrl, {
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'MR-CAPSULES-MCP-Gateway'
        }
      });
      if (ghRes.ok) {
        const ghData = await ghRes.json();
        const contentStr = Buffer.from(ghData.content, 'base64').toString('utf-8');
        return {
          success: true,
          note: {
            title: matched ? matched.title : cleanSlug.replace(/-/g, ' '),
            slug: cleanSlug,
            categoryId: matched ? matched.categoryId : 'root',
            filePath,
            content: contentStr,
            sha: ghData.sha
          }
        };
      }
    } catch (e) {
      console.error('DoctorTablet GitHub fetch fallback error:', e);
    }
  }

  if (matched) return { success: true, note: matched };
  throw err404(`DoctorTablet note not found: ${slug}`);
}

async function doctortabletSaveNote(params, githubToken) {
  const { title, categoryId, content, tags, author, type } = params;
  if (!title || !content) throw err400('Title and Content are required to save note');

  // Attempt Live API POST first
  try {
    const postRes = await fetch(DOCTORTABLET_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'MR-CAPSULES-MCP-Gateway'
      },
      body: JSON.stringify({
        title,
        categoryId: categoryId || 'root',
        content,
        tags: tags || ['#medical'],
        author: author || 'Claude Assistant',
        type: type || 'md_lecture'
      })
    });

    if (postRes.ok) {
      const postData = await postRes.json();
      if (postData && postData.success) {
        return {
          success: true,
          message: 'Note saved successfully to Doctor Tablet vault & synced!',
          note: postData.note || { title, categoryId, tags }
        };
      }
    }
  } catch (err) {
    console.error('DoctorTablet Live API POST error:', err);
  }

  // Fallback direct commit via GitHub API
  if (githubToken) {
    const folderPath = categoryId && categoryId !== 'root' ? categoryId : '';
    const fileSlug = title.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
    const repoFilePath = folderPath ? `notes/${folderPath}/${fileSlug}.md` : `notes/${fileSlug}.md`;
    
    // Frontmatter wrap if not present
    let finalContent = content;
    if (!content.trim().startsWith('---')) {
      const tagsYaml = Array.isArray(tags) ? tags.map(t => `  - ${t}`).join('\n') : '  - medical';
      finalContent = `---\ntitle: "${title}"\ntags:\n${tagsYaml}\nauthor: "${author || 'Claude Assistant'}"\n---\n\n${content}`;
    }

    const contentBase64 = Buffer.from(finalContent, 'utf-8').toString('base64');
    const apiUrl = `https://api.github.com/repos/${DOCTORTABLET_GH_OWNER}/${DOCTORTABLET_GH_REPO}/contents/${repoFilePath}`;

    // Get existing sha
    let sha;
    const getRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'MR-CAPSULES-MCP-Gateway'
      }
    });
    if (getRes.ok) {
      const existingData = await getRes.json();
      sha = existingData.sha;
    }

    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'MR-CAPSULES-MCP-Gateway'
      },
      body: JSON.stringify({
        message: `feat(note): add/update note "${title}" via MCP Gateway`,
        content: contentBase64,
        sha,
        branch: 'main'
      })
    });

    if (putRes.ok) {
      return {
        success: true,
        message: `Note saved & committed directly to DoctorTablet GitHub repo (${repoFilePath})!`,
        filePath: repoFilePath
      };
    }
  }

  throw err400('Failed to save note to Doctor Tablet (Live API & GitHub fallback failed)');
}

async function doctortabletListCategories(githubToken) {
  const data = await doctortabletFetchNotes(githubToken);
  return {
    success: true,
    totalCategories: (data.categories || []).length,
    categories: data.categories || [],
  };
}

async function doctortabletCreateCategory(params, githubToken) {
  const { name, parentId } = params;
  if (!name) throw err400('Category name is required');

  // Try Live API first
  try {
    const res = await fetch(DOCTORTABLET_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'MR-CAPSULES-MCP-Gateway'
      },
      body: JSON.stringify({
        action: 'create_category',
        name,
        parentId: parentId || null
      })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success) return data;
    }
  } catch (err) {
    console.error('DoctorTablet create_category error:', err);
  }

  // GitHub fallback: create .gitkeep in new folder
  if (githubToken) {
    try {
      const folderSlug = name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
      const folderPath = parentId ? `notes/${parentId}/${folderSlug}` : `notes/${folderSlug}`;
      const gitkeepPath = `${folderPath}/.gitkeep`;
      const contentBase64 = Buffer.from('', 'utf-8').toString('base64');

      const putRes = await fetch(
        `https://api.github.com/repos/${DOCTORTABLET_GH_OWNER}/${DOCTORTABLET_GH_REPO}/contents/${gitkeepPath}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'MR-CAPSULES-MCP-Gateway'
          },
          body: JSON.stringify({
            message: `chore(folder): create ${folderPath} via MCP Gateway`,
            content: contentBase64,
            branch: 'main'
          })
        }
      );
      if (putRes.ok) {
        const catId = parentId ? `${parentId}/${folderSlug}` : folderSlug;
        return {
          success: true,
          message: `Category "${name}" created via GitHub`,
          category: {
            id: catId,
            name,
            path: catId,
            parentId: parentId || null,
            type: 'custom',
            color: '#8A9A7E'
          }
        };
      }
    } catch (e) {
      console.error('DoctorTablet create_category GitHub fallback error:', e);
    }
  }

  return {
    success: true,
    message: `Category "${name}" creation queued/processed`,
    category: { name, parentId: parentId || null }
  };
}

async function doctortabletSearchNotes(params, githubToken) {
  const { query, tag } = params;
  if (!query && !tag) throw err400('Query or tag parameter required for search');
  const data = await doctortabletFetchNotes(githubToken);
  let notes = data.notes || [];

  if (query) {
    const q = query.toLowerCase();
    notes = notes.filter(n => 
      (n.title && n.title.toLowerCase().includes(q)) ||
      (n.content && n.content.toLowerCase().includes(q)) ||
      (n.categoryId && n.categoryId.toLowerCase().includes(q)) ||
      (Array.isArray(n.tags) && n.tags.some(t => String(t).toLowerCase().includes(q)))
    );
  }

  if (tag) {
    const cleanTag = tag.replace(/^#/, '').toLowerCase();
    notes = notes.filter(n => Array.isArray(n.tags) && n.tags.some(t => String(t).toLowerCase().replace(/^#/, '') === cleanTag));
  }

  return {
    success: true,
    query,
    totalMatches: notes.length,
    notes: notes.map(n => ({
      id: n.id,
      title: n.title,
      categoryId: n.categoryId,
      filePath: n.filePath,
      tags: n.tags,
      updatedAt: n.updatedAt
    }))
  };
}

async function doctortabletDeleteNote(filePath, githubToken) {
  if (!filePath) throw err400('filePath is required for deletion');

  // Normalize filePath — ensure it starts with notes/ for GitHub API
  const cleanPath = filePath.replace(/\\/g, '/').replace(/^notes\//, '');
  const repoPath = `notes/${cleanPath}`;

  // Try Live API DELETE first (not POST)
  try {
    const slug = cleanPath.replace(/\.md$/, '').split('/').pop() || '';
    const deleteUrl = `${DOCTORTABLET_API_URL}?slug=${encodeURIComponent(slug)}&filePath=${encodeURIComponent(cleanPath)}`;
    const res = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: {
        'User-Agent': 'MR-CAPSULES-MCP-Gateway'
      }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success) return data;
    }
  } catch (err) {
    console.error('DoctorTablet delete_note error:', err);
  }

  if (githubToken) {
    const apiUrl = `https://api.github.com/repos/${DOCTORTABLET_GH_OWNER}/${DOCTORTABLET_GH_REPO}/contents/${repoPath}`;
    const getRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'MR-CAPSULES-MCP-Gateway'
      }
    });
    if (getRes.ok) {
      const existingData = await getRes.json();
      const delRes = await fetch(apiUrl, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'MR-CAPSULES-MCP-Gateway'
        },
        body: JSON.stringify({
          message: `chore(delete): remove note ${cleanPath} via MCP Gateway`,
          sha: existingData.sha,
          branch: 'main'
        })
      });
      if (delRes.ok) {
        return { success: true, message: `Note ${cleanPath} deleted from DoctorTablet repo` };
      }
    }
  }

  throw err400(`Failed to delete note ${filePath}`);
}

async function doctortabletExportMergedDocument(params = {}, githubToken) {
  const data = await doctortabletFetchNotes(githubToken);
  const categories = data.categories || [];
  let notes = data.notes || [];

  let targetCatName = 'All Doctor Tablet Notes';
  if (params.categoryId) {
    const selectedCat = categories.find(c => c.id === params.categoryId);
    if (selectedCat) targetCatName = selectedCat.name;
    notes = notes.filter(n => n.categoryId === params.categoryId || n.categoryId.startsWith(params.categoryId + '/'));
  }

  const docTitle = params.title || `Merged Document: ${targetCatName}`;
  let merged = `# ${docTitle}\n\n`;
  merged += `> Automatically generated from **${notes.length} notes** in vault.\n\n---\n\n`;

  // Table of contents
  merged += `## Table of Contents\n\n`;
  notes.forEach((note, idx) => {
    const anchorId = `note-${(note.id || idx).toString().replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    merged += `${idx + 1}. [${note.title}](#${anchorId})\n`;
  });
  merged += `\n---\n\n`;

  // Append note contents
  notes.forEach((note, idx) => {
    const anchorId = `note-${(note.id || idx).toString().replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    merged += `<a id="${anchorId}"></a>\n\n`;
    merged += `### ${note.title}\n`;
    merged += `*Category:* \`${note.categoryId || 'root'}\` | *Updated:* ${note.updatedAt || 'N/A'}\n\n`;
    if (Array.isArray(note.tags) && note.tags.length > 0) {
      merged += `*Tags:* ${note.tags.map(t => `\`#${t.replace(/^#/, '')}\``).join(' ')}\n\n`;
    }
    merged += `${note.content || ''}\n\n`;
    merged += `---\n\n`;
  });

  return {
    success: true,
    title: docTitle,
    totalNotesMerged: notes.length,
    mergedContent: merged
  };
}


