// api/openapi.js
// Dynamic OpenAPI 3.0.3 Specification Generator for ChatGPT Custom GPT Actions & Connectors
// Exposes MR-CAPSULES and DoctorTablet MCP tools as standard REST Action endpoints

import { getMcpToolsList } from './mcp.js';

function isAllowedOrigin(origin) {
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

const CATEGORY_PRESETS = {
  doctortablet: [
    'system_health',
    'doctortablet_list_notes',
    'doctortablet_read_note',
    'doctortablet_save_note',
    'doctortablet_list_categories',
    'doctortablet_create_category',
    'doctortablet_search_notes',
    'doctortablet_delete_note',
    'doctortablet_export_merged_document'
  ],
  content: [
    'system_health',
    'content_list',
    'content_search',
    'content_get',
    'content_tree',
    'content_upload',
    'content_upload_from_agent_path',
    'upload_init',
    'upload_chunk',
    'upload_commit',
    'upload_status',
    'upload_cancel',
    'content_delete',
    'content_rename',
    'content_delete_files',
    'cover_list',
    'cover_upload',
    'cover_delete'
  ],
  tasks: [
    'system_health',
    'tasks_list',
    'tasks_create',
    'tasks_claim',
    'tasks_submit',
    'tasks_approve',
    'tasks_reject',
    'tasks_logs',
    'tasks_unclaim',
    'tasks_start_review',
    'tasks_add_note',
    'tasks_reset_phase',
    'tasks_re_review',
    'tasks_retrack',
    'tasks_resubmit',
    'tasks_delete',
    'review_issues',
    'review_report',
    'review_resolve',
    'review_delete_issue'
  ],
  admin: [
    'system_health',
    'account_manager',
    'users_create',
    'users_create_batch',
    'users_list',
    'users_ban',
    'users_reset_password',
    'users_add_admin',
    'users_remove_admin',
    'users_delete',
    'users_remove_device',
    'users_block_device',
    'divisions_list',
    'divisions_my',
    'divisions_add_member',
    'divisions_remove_member',
    'divisions_join',
    'divisions_update_whatsapp',
    'divisions_get_members',
    'config_get',
    'config_update',
    'contributions_award_batch',
    'activity_logs',
    'system_cleanup_guests',
    'apikeys_list',
    'apikeys_create',
    'apikeys_revoke',
    'oauth_tokens_list',
    'oauth_tokens_revoke'
  ],
  essential: [
    'system_health',
    'account_manager',
    'users_create_batch',
    'doctortablet_list_notes',
    'doctortablet_read_note',
    'doctortablet_save_note',
    'doctortablet_list_categories',
    'doctortablet_create_category',
    'doctortablet_search_notes',
    'doctortablet_export_merged_document',
    'content_list',
    'content_search',
    'content_get',
    'content_tree',
    'content_upload',
    'tasks_list',
    'tasks_create',
    'tasks_claim',
    'tasks_submit',
    'tasks_approve',
    'tasks_reject',
    'tasks_logs',
    'tasks_add_note',
    'contributions_leaderboard',
    'contributions_my',
    'contributions_award_batch',
    'divisions_list',
    'docs_get'
  ]
};

// Simple JSON to YAML converter for OpenAPI schemas
function jsonToYaml(obj, indent = 0) {
  const pad = ' '.repeat(indent);
  if (obj === null || obj === undefined) return `${pad}null\n`;
  if (typeof obj === 'boolean' || typeof obj === 'number') return `${pad}${obj}\n`;
  if (typeof obj === 'string') {
    if (obj.includes('\n')) {
      const lines = obj.split('\n').map(l => `${pad}  ${l}`).join('\n');
      return `${pad}|\n${lines}\n`;
    }
    if (obj.includes(': ') || obj.includes('#') || obj.startsWith('@') || obj.startsWith('`') || obj === '') {
      return `${pad}"${obj.replace(/"/g, '\\"')}"\n`;
    }
    return `${pad}${obj}\n`;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return `${pad}[]\n`;
    let out = '';
    for (const item of obj) {
      if (typeof item === 'object' && item !== null) {
        const itemYaml = jsonToYaml(item, indent + 2);
        const trimmed = itemYaml.trimStart();
        out += `${pad}- ${trimmed}`;
      } else {
        out += `${pad}- ${jsonToYaml(item, 0).trimStart()}`;
      }
    }
    return out;
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return `${pad}{}\n`;
    let out = '';
    for (const key of keys) {
      const val = obj[key];
      if (val === undefined) continue;
      const formattedKey = key.includes(' ') || key.includes('/') ? `"${key}"` : key;
      if (typeof val === 'object' && val !== null && (Array.isArray(val) ? val.length > 0 : Object.keys(val).length > 0)) {
        out += `${pad}${formattedKey}:\n${jsonToYaml(val, indent + 2)}`;
      } else if (typeof val === 'object' && val !== null) {
        out += `${pad}${formattedKey}: ${Array.isArray(val) ? '[]' : '{}'}\n`;
      } else {
        out += `${pad}${formattedKey}: ${jsonToYaml(val, 0).trimStart()}`;
      }
    }
    return out;
  }
  return `${pad}${String(obj)}\n`;
}

function cleanInputSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const clean = {
    type: 'object',
    properties: {}
  };
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [propName, propDef] of Object.entries(schema.properties)) {
      if (!propDef || typeof propDef !== 'object') continue;
      const cleanProp = {
        type: propDef.type || 'string',
        description: propDef.description || propName
      };
      if (propDef.enum) cleanProp.enum = propDef.enum;
      if (propDef.items) cleanProp.items = propDef.items;
      if (propDef.properties) cleanProp.properties = propDef.properties;
      clean.properties[propName] = cleanProp;
    }
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    clean.required = schema.required;
  }
  return clean;
}

export default async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'mr-capsules.vercel.app';
  const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https';
  const baseUrl = `${protocol}://${host}`;

  const origin = req.headers.origin || '';
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, x-api-key, api-key, openai-gpt-id, openai-organization-id, openai-account-id, openai-conversation-id');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = new URL(req.url, baseUrl);

  // Serve OpenAI ChatGPT Plugin manifest (/.well-known/ai-plugin.json)
  if (url.pathname.includes('ai-plugin') || url.searchParams.get('type') === 'plugin') {
    const manifest = {
      schema_version: 'v1',
      name_for_human: 'mr capsules',
      name_for_model: 'mr_capsules',
      description_for_human: 'MR-CAPSULES medical education platform, DoctorTablet clinical note vault, and Kanban tasks.',
      description_for_model: 'Plugin for accessing MR-CAPSULES medical materials, DoctorTablet clinical reasoning notes, and Kanban tasks.',
      auth: {
        type: 'oauth',
        client_url: `${baseUrl}/authorize`,
        scope: 'mcp',
        authorization_url: `${baseUrl}/token`,
        authorization_content_type: 'application/json'
      },
      api: {
        type: 'openapi',
        url: `${baseUrl}/api/openapi.json`
      },
      logo_url: `${baseUrl}/logo.png`,
      contact_email: 'muqorroben@gmail.com',
      legal_info_url: `${baseUrl}/docs#privacy`
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json(manifest);
  }

  const category = (url.searchParams.get('category') || 'essential').toLowerCase();
  const requestedToolsParam = url.searchParams.get('tools') || '';
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const shouldDownload = url.searchParams.get('download') === 'true' || url.searchParams.get('download') === '1';

  // Retrieve base static tools from mcp.js
  let allTools = [];
  try {
    allTools = getMcpToolsList();
  } catch (e) {
    console.error('Failed to get MCP tools list:', e);
  }

  // Filter tools based on category or specific tool selection
  let selectedTools = allTools;
  if (requestedToolsParam) {
    const list = requestedToolsParam.split(',').map(s => s.trim().replace(/\./g, '_')).filter(Boolean);
    selectedTools = allTools.filter(t => list.includes(t.name.replace(/\./g, '_')));
  } else if (category !== 'all' && CATEGORY_PRESETS[category]) {
    const preset = CATEGORY_PRESETS[category];
    selectedTools = allTools.filter(t => preset.includes(t.name.replace(/\./g, '_')));
  }

  // Build paths dictionary for OpenAPI
  const paths = {};

  // 1. Tool-specific paths: /api/actions/{tool_name}
  for (const tool of selectedTools) {
    const cleanName = tool.name.replace(/\./g, '_');
    const pathKey = `/api/actions/${cleanName}`;
    const inputSchema = cleanInputSchema(tool.inputSchema);
    const hasRequired = Array.isArray(inputSchema.required) && inputSchema.required.length > 0;
    const hasProperties = inputSchema.properties && Object.keys(inputSchema.properties).length > 0;

    let summary = tool.description.split('.')[0] || cleanName;
    if (summary.length > 80) summary = summary.substring(0, 77) + '...';

    paths[pathKey] = {
      post: {
        operationId: cleanName,
        summary: summary,
        description: tool.description,
        requestBody: {
          description: `Parameters for ${cleanName}`,
          required: hasRequired || hasProperties,
          content: {
            'application/json': {
              schema: inputSchema
            }
          }
        },
        responses: {
          '200': {
            description: 'Operation completed successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', description: 'Execution status' },
                    result: { type: 'object', description: 'Output data' }
                  }
                }
              }
            }
          },
          '400': {
            description: 'Bad request or missing required parameters',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: false },
                    error: { type: 'string' }
                  }
                }
              }
            }
          },
          '401': {
            description: 'Unauthorized - API key or OAuth Bearer token missing/invalid',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: false },
                    error: { type: 'string' }
                  }
                }
              }
            }
          },
          '403': {
            description: 'Forbidden - Insufficient permissions for role',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: false },
                    error: { type: 'string' }
                  }
                }
              }
            }
          },
          '500': {
            description: 'Internal server error',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: false },
                    error: { type: 'string' }
                  }
                }
              }
            }
          }
        },
        security: [
          { BearerAuth: [] },
          { ApiKeyAuth: [] },
          { OAuth2: ['mcp'] }
        ]
      }
    };
  }

  // 2. Unified Execute Operation: /api/actions/execute
  paths['/api/actions/execute'] = {
    post: {
      operationId: 'execute_tool',
      summary: 'Dynamically execute any MR-CAPSULES / DoctorTablet tool',
      description: 'Unified action endpoint capable of invoking any tool dynamically by specifying the tool name and argument object. Ideal for Custom GPTs when managing multiple tools.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                tool: {
                  type: 'string',
                  description: 'Name of the tool to invoke (e.g. doctortablet_save_note, content_list, tasks_create)'
                },
                parameters: {
                  type: 'object',
                  description: 'JSON dictionary of parameters for the specified tool'
                }
              },
              required: ['tool']
            }
          }
        }
      },
      responses: {
        '200': {
          description: 'Tool execution result',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  result: { type: 'object' }
                }
              }
            }
          }
        }
      },
      security: [
        { BearerAuth: [] },
        { ApiKeyAuth: [] },
        { OAuth2: ['mcp'] }
      ]
    }
  };

  // Build complete OpenAPI 3.0.3 document
  const openApiDoc = {
    openapi: '3.0.3',
    info: {
      title: 'MR-CAPSULES & DoctorTablet API Gateway',
      version: '1.2.0',
      description: `OpenAPI specification for MR-CAPSULES medical education platform and DoctorTablet clinical knowledge vault.\n\nConnected AI assistants (ChatGPT Custom GPTs, Claude Web MCP, Agentic Frameworks) can search and edit content, manage Kanban tasks, execute atomic git commits, and synthesize high-density clinical notes.\n\nActive preset: **${category}** (${Object.keys(paths).length} operations).`,
      contact: {
        name: 'MR-CAPSULES Platform Support',
        url: `${baseUrl}/docs`,
        email: 'muqorroben@gmail.com'
      }
    },
    servers: [
      {
        url: baseUrl,
        description: 'MR-CAPSULES Serverless Production Gateway'
      }
    ],
    paths: paths,
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Bearer token authentication. Enter your MR-CAPSULES API Key (mrc_...) or OAuth Access Token (mrc_at_...).'
        },
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'API key authentication via x-api-key header.'
        },
        OAuth2: {
          type: 'oauth2',
          description: 'OAuth 2.0 Authorization Code Flow with PKCE for Custom GPTs and Connectors.',
          flows: {
            authorizationCode: {
              authorizationUrl: `${baseUrl}/authorize`,
              tokenUrl: `${baseUrl}/token`,
              scopes: {
                mcp: 'Full access to MR-CAPSULES and DoctorTablet tools',
                openid: 'OpenID Connect identity',
                profile: 'User profile details',
                email: 'User email access'
              }
            }
          }
        }
      }
    }
  };

  if (format === 'yaml' || format === 'yml') {
    const yamlString = jsonToYaml(openApiDoc);
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    if (shouldDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="mr-capsules-openapi-${category}.yaml"`);
    }
    return res.status(200).send(yamlString);
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (shouldDownload) {
    res.setHeader('Content-Disposition', `attachment; filename="mr-capsules-openapi-${category}.json"`);
  }
  return res.status(200).json(openApiDoc);
}
