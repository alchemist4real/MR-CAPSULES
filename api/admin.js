export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = authHeader.replace('Bearer ', '');
  const supabaseUrl = 'https://hdhvrlkizorscvehttzd.supabase.co';
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkaHZybGtpem9yc2N2ZWh0dHpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNjMwNzIsImV4cCI6MjA5MjgzOTA3Mn0.m6L3oEVAfyp2TjYmBCfDRo_30rdsWLEsGVZzRZIy3MU';

  const githubToken = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_CONTENT_OWNER || process.env.GITHUB_OWNER || 'alchemist4real';
  const repo = process.env.GITHUB_CONTENT_REPO || 'MR-CAPSULES-CONTENT';
  const fallbackRepo = 'MR-CAPSULES';

  // 1. Verify User from Supabase
  const userPromise = fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${token}` }
  });

  const userRes = await userPromise;
  if (!userRes.ok) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const userData = await userRes.json();
  const email = userData.email;

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return res.status(500).json({ error: 'Server config error' });

  const logAdminAction = async (act, details) => {
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!sbKey) return;
    try {
      await fetch(`${supabaseUrl}/rest/v1/admin_action_logs`, {
        method: 'POST',
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_email: email, action: act, details: details })
      });
    } catch(e) {}
  };

  // 2. Check if user is an admin via user_roles table
  const username = userData.user_metadata?.username;
  const encEmail = encodeURIComponent(email);
  const identifierQuery = username ? `or=(identifier.eq.${encEmail},identifier.eq.${encodeURIComponent(username)})` : `identifier=eq.${encEmail}`;
  const roleRes = await fetch(`${supabaseUrl}/rest/v1/user_roles?${identifierQuery}&select=role`, {
    headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
  });
  
  let roleData = [];
  if (roleRes.ok) {
    roleData = await roleRes.json();
  }

  const superAdminEmail = process.env.SUPERADMIN_EMAIL || 'muqorroben@gmail.com';
  const isSuperAdmin = email === superAdminEmail;
  const hasAdminRole = roleData && roleData.length > 0 && roleData[0].role === 'admin';
  
  // Check division
  const divRes = await fetch(`${supabaseUrl}/rest/v1/division_members?user_id=eq.${userData.id}&select=division_id`, {
    headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
  });
  let divData = [];
  if (divRes.ok) divData = await divRes.json();
  const hasDivision = divData && divData.length > 0;
  
  const isAdmin = isSuperAdmin || hasAdminRole;
  const canAccessDashboard = isAdmin || hasDivision;

  const host = req.headers['x-forwarded-host'] || req.headers.host || 'mr-capsules.vercel.app';
  const urlObj = new URL(req.url, `https://${host}`);
  const queryAction = req.query?.action || urlObj.searchParams.get('action');
  const body = (typeof req.body === 'object' && req.body !== null) ? req.body : {};
  const action = body.action || queryAction;
  const rawPath = body.path || body.folder || body.filepath || body.filename || '';
  const { contentBase64, sha } = body;

  if (action === 'check') {
    return res.status(200).json({ success: true, isSuperAdmin, isAdmin, hasDivision, email: email });
  }

  if (!canAccessDashboard) {
    return res.status(403).json({ error: 'Forbidden. Not an admin or team member.' });
  }

  // Destructive operations check
  if (['delete', 'delete_files', 'rename_file', 'rename_folder', 'update_config', 'add_admin', 'remove_admin', 'ban_user', 'cleanup_guests', 'batch_create_users', 'batch_award_points'].includes(action)) {
    if (!isAdmin) {
      return res.status(403).json({ error: 'Forbidden. Admin privileges required.' });
    }
  }

  // Content modification check: allowed for admins and division members
  if (['upload', 'create_file', 'make_file', 'create_folder', 'make_folder'].includes(action)) {
    if (!isAdmin && !hasDivision) {
      return res.status(403).json({ error: 'Forbidden. Admin or division membership required.' });
    }
  }

  let cleanPath = (rawPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleanPath) {
    if (cleanPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid path traversal detected.' });
    }
    if (!cleanPath.startsWith('content/') && !cleanPath.startsWith('cover/')) {
      cleanPath = 'content/' + cleanPath;
    }
  }

  const { newPath } = req.body;
  let cleanNewPath = (newPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleanNewPath) {
    if (cleanNewPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid newPath traversal detected.' });
    }
    if (!cleanNewPath.startsWith('content/') && !cleanNewPath.startsWith('cover/')) {
      cleanNewPath = 'content/' + cleanNewPath;
    }
  }

  let base64 = contentBase64;
  if (!base64 && typeof body.content === 'string') {
    base64 = Buffer.from(body.content, 'utf8').toString('base64');
  }
  if (!base64 && (action === 'create_folder' || action === 'make_folder' || (cleanPath && cleanPath.endsWith('/.gitkeep')))) {
    base64 = Buffer.from(' ', 'utf8').toString('base64');
  }

  if (base64 && base64.length > 10 * 1024 * 1024 * 1.34) { // approx 10MB in base64
    return res.status(400).json({ error: 'Payload too large. Maximum size is 10MB.' });
  }

  // Helper to make GitHub API calls with fallback
  const ghApi = async (method, endpoint, bodyObj, targetRepo = repo) => {
    let res = await fetch(`https://api.github.com/repos/${owner}/${targetRepo}${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'MR-CAPSULES-ADMIN',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'If-None-Match': ''
      },
      body: bodyObj ? JSON.stringify(bodyObj) : undefined
    });

    if (!res.ok && res.status === 404 && targetRepo !== fallbackRepo && method === 'GET') {
      console.warn(`[Admin API] ${targetRepo}${endpoint} returned 404. Falling back to ${fallbackRepo}...`);
      res = await fetch(`https://api.github.com/repos/${owner}/${fallbackRepo}${endpoint}`, {
        method,
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'MR-CAPSULES-ADMIN',
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'If-None-Match': ''
        },
        body: bodyObj ? JSON.stringify(bodyObj) : undefined
      });
    }

    return res;
  };

  // Git Data API Helpers (for bypassing 1MB limits)
  const getBranchRef = async (targetRepo = repo) => {
    const res = await ghApi('GET', '/git/refs/heads/main', undefined, targetRepo);
    const data = await res.json();
    if (!res.ok) throw new Error(`Failed to get main ref: ${JSON.stringify(data)}`);
    return data.object.sha;
  };
  const getCommit = async (commitSha, targetRepo = repo) => {
    const res = await ghApi('GET', `/git/commits/${commitSha}`, undefined, targetRepo);
    const data = await res.json();
    if (!res.ok) throw new Error(`Failed to get commit: ${JSON.stringify(data)}`);
    return data;
  };
  const createTree = async (baseTreeSha, treeItems, targetRepo = repo) => {
    const res = await ghApi('POST', '/git/trees', { base_tree: baseTreeSha, tree: treeItems }, targetRepo);
    const data = await res.json();
    if (!res.ok) throw new Error(`Failed to create tree: ${JSON.stringify(data)}`);
    return data.sha;
  };
  const createCommit = async (message, treeSha, parentCommits, targetRepo = repo) => {
    const res = await ghApi('POST', '/git/commits', { message, tree: treeSha, parents: parentCommits }, targetRepo);
    const data = await res.json();
    if (!res.ok) throw new Error(`Failed to create commit: ${JSON.stringify(data)}`);
    return data.sha;
  };
  const updateRef = async (newCommitSha, targetRepo = repo) => {
    const res = await ghApi('PATCH', '/git/refs/heads/main', { sha: newCommitSha }, targetRepo);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || `Failed to update ref (${res.status})`);
    }
    return res.ok;
  };

  const getMountConfig = async () => {
    try {
      const stateRes = await fetch(`${supabaseUrl}/rest/v1/gitrouter_app_state?id=eq.repo_mount_config&select=state_data`, {
        headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
      });
      if (stateRes.ok) {
        const rows = await stateRes.json();
        if (rows && rows.length > 0 && rows[0].state_data) {
          return rows[0].state_data;
        }
      }
    } catch(e) {}
    return {
      primaryRepo: repo,
      fallbackRepo: fallbackRepo,
      owner: owner,
      branch: 'main',
      activeMount: 'ALL',
      cdnProvider: 'jsdelivr'
    };
  };

  try {
    if (action === 'get_mount_config') {
      const cfg = await getMountConfig();
      return res.status(200).json({ success: true, config: cfg });
    }

    if (action === 'update_mount_config') {
      const currentCfg = await getMountConfig();
      const updatedCfg = {
        ...currentCfg,
        ...(body.config || {}),
        updated_at: new Date().toISOString()
      };
      await fetch(`${supabaseUrl}/rest/v1/gitrouter_app_state`, {
        method: 'POST',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          id: 'repo_mount_config',
          state_data: updatedCfg,
          updated_at: new Date().toISOString()
        })
      });
      await logAdminAction('update_mount_config', { config: updatedCfg });
      return res.status(200).json({ success: true, config: updatedCfg });
    }

    if (action === 'download') {
      const targetPath = cleanPath;
      if (!targetPath) return res.status(400).json({ error: 'Missing path' });
      const encodedPath = targetPath.split('/').map(s => encodeURIComponent(s)).join('/');
      const reqRepo = body.repo || repo;
      
      let fileRes = await ghApi('GET', `/contents/${encodedPath}`, undefined, reqRepo);
      let usedRepo = reqRepo;
      if (!fileRes.ok && reqRepo !== fallbackRepo) {
        fileRes = await ghApi('GET', `/contents/${encodedPath}`, undefined, fallbackRepo);
        if (fileRes.ok) usedRepo = fallbackRepo;
      }

      if (!fileRes.ok) {
        // Fallback directly to Raw GitHub with bearer token
        const rawRes = await fetch(`https://raw.githubusercontent.com/${owner}/${usedRepo}/main/${encodedPath}`, {
          headers: { 'Authorization': `Bearer ${githubToken}`, 'User-Agent': 'MR-CAPSULES-ADMIN' }
        });
        if (rawRes.ok) {
          const rawText = await rawRes.text();
          return res.status(200).json({
            success: true,
            content: rawText,
            contentBase64: Buffer.from(rawText, 'utf8').toString('base64'),
            repo: usedRepo
          });
        }
        return res.status(404).json({ error: 'File not found on GitHub' });
      }

      const fileData = await fileRes.json();
      let utf8Content = '';
      if (fileData.content) {
        utf8Content = Buffer.from(fileData.content.replace(/\s+/g, ''), 'base64').toString('utf8');
      }
      return res.status(200).json({
        success: true,
        content: utf8Content,
        contentBase64: fileData.content,
        sha: fileData.sha,
        repo: usedRepo
      });
    }

    if (action === 'tree') {
      const mountCfg = await getMountConfig();
      const requestedMount = body.mount || mountCfg.activeMount || 'ALL';
      const targetPrimary = mountCfg.primaryRepo || repo;
      const targetFallback = mountCfg.fallbackRepo || fallbackRepo;
      const targetOwner = mountCfg.owner || owner;
      const targetBranch = mountCfg.branch || 'main';

      const getFreshTree = async (repoName) => {
        try {
          let commitSha = targetBranch;
          const cRes = await fetch(`https://api.github.com/repos/${targetOwner}/${repoName}/commits/${targetBranch}?per_page=1&t=${Date.now()}`, {
            headers: {
              'Authorization': `Bearer ${githubToken}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'MR-CAPSULES-ADMIN',
              'If-None-Match': '',
              'Cache-Control': 'no-cache, no-store, must-revalidate'
            }
          });
          if (cRes.ok) {
            const cData = await cRes.json();
            if (cData.sha) commitSha = cData.sha;
          }
          const tRes = await fetch(`https://api.github.com/repos/${targetOwner}/${repoName}/git/trees/${commitSha}?recursive=1`, {
            headers: {
              'Authorization': `Bearer ${githubToken}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'MR-CAPSULES-ADMIN',
              'If-None-Match': '',
              'Cache-Control': 'no-cache, no-store, must-revalidate'
            }
          });
          if (tRes.ok) return await tRes.json();
        } catch(e) {}
        return { tree: [] };
      };

      if (requestedMount === 'ALL') {
        const [primaryTreeRes, fallbackTreeRes] = await Promise.all([
          getFreshTree(targetPrimary),
          getFreshTree(targetFallback)
        ]);

        const mergedMap = new Map();
        (primaryTreeRes.tree || []).forEach(item => {
          mergedMap.set(item.path, {
            ...item,
            _repo: targetPrimary,
            _isPrimary: true
          });
        });

        (fallbackTreeRes.tree || []).forEach(item => {
          if (mergedMap.has(item.path)) {
            const existing = mergedMap.get(item.path);
            existing._synced = true;
          } else {
            mergedMap.set(item.path, {
              ...item,
              _repo: targetFallback,
              _isFallback: true
            });
          }
        });

        const mergedTree = Array.from(mergedMap.values());
        return res.status(200).json({
          success: true,
          tree: mergedTree,
          mount: 'ALL',
          mountConfig: mountCfg
        });
      } else {
        const specificRepo = requestedMount === targetFallback ? targetFallback : targetPrimary;
        const data = await getFreshTree(specificRepo);
        const tree = (data.tree || []).map(i => ({ ...i, _repo: specificRepo }));
        return res.status(200).json({ success: true, tree, mount: specificRepo, mountConfig: mountCfg });
      }
    }

    if (action === 'sync_mount') {
      const mountCfg = await getMountConfig();
      const targetPrimary = mountCfg.primaryRepo || repo;
      const targetFallback = mountCfg.fallbackRepo || fallbackRepo;
      const targetOwner = mountCfg.owner || owner;
      const targetBranch = mountCfg.branch || 'main';

      const getFreshTree = async (repoName) => {
        try {
          let commitSha = targetBranch;
          const cRes = await fetch(`https://api.github.com/repos/${targetOwner}/${repoName}/commits/${targetBranch}?per_page=1&t=${Date.now()}`, {
            headers: {
              'Authorization': `Bearer ${githubToken}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'MR-CAPSULES-ADMIN',
              'If-None-Match': '',
              'Cache-Control': 'no-cache, no-store, must-revalidate'
            }
          });
          if (cRes.ok) {
            const cData = await cRes.json();
            if (cData.sha) commitSha = cData.sha;
          }
          const tRes = await fetch(`https://api.github.com/repos/${targetOwner}/${repoName}/git/trees/${commitSha}?recursive=1`, {
            headers: {
              'Authorization': `Bearer ${githubToken}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'MR-CAPSULES-ADMIN',
              'If-None-Match': '',
              'Cache-Control': 'no-cache, no-store, must-revalidate'
            }
          });
          if (tRes.ok) return await tRes.json();
        } catch(e) {}
        return { tree: [] };
      };

      const [primaryTreeRes, fallbackTreeRes] = await Promise.all([
        getFreshTree(targetPrimary),
        getFreshTree(targetFallback)
      ]);

      const primaryBlobs = new Map((primaryTreeRes.tree || []).filter(i => i.type === 'blob' && (i.path.startsWith('content/') || i.path.startsWith('cover/'))).map(i => [i.path, i.sha]));
      const fallbackBlobs = new Map((fallbackTreeRes.tree || []).filter(i => i.type === 'blob' && (i.path.startsWith('content/') || i.path.startsWith('cover/'))).map(i => [i.path, i.sha]));

      // Only import files from fallback into primary if missing (primary is master content store)
      const missingInPrimary = [];
      for (const [p, sha] of fallbackBlobs) {
        if (!primaryBlobs.has(p) && (p.startsWith('content/') || p.startsWith('cover/'))) {
          missingInPrimary.push({ path: p, sha });
        }
      }

      let syncedToPrimary = 0;
      for (const item of missingInPrimary.slice(0, 10)) {
        try {
          const enc = item.path.split('/').map(s => encodeURIComponent(s)).join('/');
          const fileRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetFallback}/contents/${enc}`, {
            headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'MR-CAPSULES-ADMIN' }
          });
          if (fileRes.ok) {
            const fData = await fileRes.json();
            if (fData.content) {
              const putRes = await fetch(`https://api.github.com/repos/${targetOwner}/${targetPrimary}/contents/${enc}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'MR-CAPSULES-ADMIN', 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: `sync: mirror ${item.path} from ${targetFallback}`, content: fData.content })
              });
              if (putRes.ok) syncedToPrimary++;
            }
          }
        } catch(e) {}
      }

      const nowIso = new Date().toISOString();
      await fetch(`${supabaseUrl}/rest/v1/gitrouter_app_state`, {
        method: 'POST',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          id: 'repo_mount_config',
          state_data: {
            ...mountCfg,
            lastSyncedAt: nowIso,
            totalContentFiles: primaryBlobs.size,
            lastSyncResult: { syncedToPrimary, totalPrimary: primaryBlobs.size, timestamp: nowIso }
          },
          updated_at: nowIso
        })
      });

      await logAdminAction('sync_mount', { syncedToPrimary, totalPrimary: primaryBlobs.size });
      return res.status(200).json({
        success: true,
        syncedToPrimary,
        totalPrimary: primaryBlobs.size,
        message: `Content repository synced (${primaryBlobs.size} items active in ${targetPrimary}${syncedToPrimary > 0 ? `, ${syncedToPrimary} imported` : ''}).`
      });
    }

    if (['upload', 'create_file', 'make_file', 'create_folder', 'make_folder'].includes(action)) {
      let finalPath = cleanPath;
      if (!finalPath) return res.status(400).json({ error: 'Missing path' });

      const mountCfg = await getMountConfig();
      const targetUploadRepo = body.repo || (mountCfg.primaryRepo || repo);

      // If action is create_folder or make_folder, or path ends with '/', ensure it ends with /.gitkeep
      if (action === 'create_folder' || action === 'make_folder' || finalPath.endsWith('/') || body.isFolder) {
        finalPath = finalPath.replace(/\/+$/, '') + '/.gitkeep';
        if (!base64) {
          base64 = Buffer.from(' ', 'utf8').toString('base64');
        }
      }

      if ((action === 'create_file' || action === 'make_file') && !base64) {
        base64 = Buffer.from('<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>New Module</title></head><body><h1>New Module</h1></body></html>\n', 'utf8').toString('base64');
      }

      if (base64 === undefined || base64 === null) {
        base64 = '';
      }

      // Check SHA conflict if sha provided
      if (sha) {
        const encodedPath = finalPath.split('/').map(s => encodeURIComponent(s)).join('/');
        const checkRes = await ghApi('GET', `/contents/${encodedPath}`, undefined, targetUploadRepo);
        if (checkRes.ok) {
          const remoteFile = await checkRes.json();
          if (remoteFile.sha && remoteFile.sha !== sha) {
            return res.status(409).json({ error: '409 Conflict: File has been updated on GitHub by another user. Reload before saving.' });
          }
        }
      }

      // ATTEMPT 1: GitHub Contents API (Atomic single-call, handles parent folder creation automatically)
      try {
        const encodedPath = finalPath.split('/').map(s => encodeURIComponent(s)).join('/');
        let existingSha = sha || null;
        if (!existingSha) {
          try {
            const checkRes = await ghApi('GET', `/contents/${encodedPath}`, undefined, targetUploadRepo);
            if (checkRes.ok) {
              const fileInfo = await checkRes.json();
              existingSha = fileInfo.sha;
            }
          } catch (e) {}
        }

        const putBody = {
          message: `admin: ${action.replace('_', ' ')} ${finalPath}`,
          content: base64
        };
        if (existingSha) putBody.sha = existingSha;

        const putRes = await ghApi('PUT', `/contents/${encodedPath}`, putBody, targetUploadRepo);
        if (putRes.ok) {
          const putData = await putRes.json();
          await logAdminAction(action, { path: finalPath, repo: targetUploadRepo });
          return res.status(200).json({ success: true, path: finalPath, sha: putData.content?.sha || putData.commit?.sha, repo: targetUploadRepo });
        } else {
          const putErr = await putRes.json().catch(() => ({}));
          console.warn(`[Admin API] Contents API upload returned ${putRes.status}:`, putErr.message || putErr);
        }
      } catch (err) {
        console.warn('[Admin API] Contents API error, falling back to Git Data API:', err.message);
      }

      // ATTEMPT 2: Git Data API with Automatic Retries
      let lastErr = null;
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const blobRes = await ghApi('POST', '/git/blobs', { content: base64, encoding: 'base64' }, targetUploadRepo);
          const blobData = await blobRes.json();
          if (!blobRes.ok) throw new Error(blobData.message || 'Failed to create blob');

          const commitSha = await getBranchRef(targetUploadRepo);
          const parentCommit = await getCommit(commitSha, targetUploadRepo);
          const treeItems = [{ path: finalPath, mode: '100644', type: 'blob', sha: blobData.sha }];
          const newTreeSha = await createTree(parentCommit.tree.sha, treeItems, targetUploadRepo);

          const newCommitSha = await createCommit(`admin: ${action.replace('_', ' ')} ${finalPath}`, newTreeSha, [commitSha], targetUploadRepo);
          await updateRef(newCommitSha, targetUploadRepo);

          await logAdminAction(action, { path: finalPath, repo: targetUploadRepo });
          return res.status(200).json({ success: true, path: finalPath, sha: blobData.sha, repo: targetUploadRepo });
        } catch (err) {
          lastErr = err;
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, attempt * 500));
          }
        }
      }

      throw new Error(`Failed to upload ${finalPath} after ${maxRetries} attempts: ${lastErr?.message || 'Git conflict'}`);
    }
    
    if (action === 'delete') {
      const targetPath = cleanPath;
      if (!targetPath) return res.status(400).json({ error: 'Missing path' });

      // Try Contents API delete first if file exists
      try {
        const encodedPath = targetPath.split('/').map(s => encodeURIComponent(s)).join('/');
        let fileSha = sha;
        if (!fileSha) {
          const checkRes = await ghApi('GET', `/contents/${encodedPath}`);
          if (checkRes.ok) {
            const fileData = await checkRes.json();
            fileSha = fileData.sha;
          }
        }
        if (fileSha) {
          const delRes = await ghApi('DELETE', `/contents/${encodedPath}`, {
            message: `admin: delete ${targetPath}`,
            sha: fileSha
          });
          if (delRes.ok) {
            await logAdminAction('delete', { path: targetPath });
            return res.status(200).json({ success: true });
          }
        }
      } catch (err) {
        console.warn('[Admin API] Contents API delete error, falling back to Git Data API:', err.message);
      }

      const treeItems = [{ path: targetPath, mode: '100644', type: 'blob', sha: null }];
      
      const commitSha = await getBranchRef();
      const parentCommit = await getCommit(commitSha);
      const newTreeSha = await createTree(parentCommit.tree.sha, treeItems);
      const newCommitSha = await createCommit(`admin: delete ${targetPath}`, newTreeSha, [commitSha]);
      await updateRef(newCommitSha);
      
      await logAdminAction('delete', { path: targetPath });
      return res.status(200).json({ success: true });
    }

    if (action === 'delete_files') {
      const { files } = req.body; // Array of {path, sha}
      if (!files || !Array.isArray(files)) throw new Error("Missing files array");
      
      const normalizedFiles = [];
      for (const f of files) {
        let p = (f.path || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
        if (p.includes('..')) {
          return res.status(400).json({ error: 'Invalid path traversal detected in bulk delete.' });
        }
        if (!p.startsWith('content/') && !p.startsWith('cover/')) {
          p = 'content/' + p;
        }
        normalizedFiles.push({ path: p, sha: f.sha });
      }
      
      const treeItems = normalizedFiles.map(f => ({ path: f.path, mode: '100644', type: 'blob', sha: null }));
      
      const commitSha = await getBranchRef();
      const parentCommit = await getCommit(commitSha);
      const newTreeSha = await createTree(parentCommit.tree.sha, treeItems);
      const newCommitSha = await createCommit(`admin: bulk delete ${normalizedFiles.length} files`, newTreeSha, [commitSha]);
      await updateRef(newCommitSha);
      
      await logAdminAction('delete_files', { count: normalizedFiles.length, files: normalizedFiles.map(f => f.path) });
      return res.status(200).json({ success: true });
    }

    if (action === 'get_config') {
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
      const getRes = await fetch(`${supabaseUrl}/rest/v1/app_settings?limit=1`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      if (!getRes.ok) throw new Error("Config fetch failed");
      const data = await getRes.json();
      if (!data || data.length === 0) throw new Error("Config not found in db");
      
      const configObj = {
        allowSignup: data[0].allow_signup,
        allowGuest: data[0].allow_guest,
        maintenanceMode: data[0].maintenance_mode,
        bannedDevices: data[0].banned_devices
      };
      // Return a dummy sha to satisfy the frontend code
      return res.status(200).json({ success: true, sha: 'supabase_db', config: configObj });
    }

    if (action === 'update_config') {
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
      const { allowSignup, allowGuest, maintenanceMode, bannedDevices } = req.body;
      
      const payload = {};
      if (allowSignup !== undefined) payload.allow_signup = allowSignup;
      if (allowGuest !== undefined) payload.allow_guest = allowGuest;
      if (maintenanceMode !== undefined) payload.maintenance_mode = maintenanceMode;
      if (bannedDevices !== undefined) payload.banned_devices = bannedDevices;

      const getRes = await fetch(`${supabaseUrl}/rest/v1/app_settings?limit=1`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      const data = await getRes.json();
      if (!data || data.length === 0) throw new Error("Config not found in db");
      const id = data[0].id;

      const updateRes = await fetch(`${supabaseUrl}/rest/v1/app_settings?id=eq.${id}`, {
        method: 'PATCH',
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!updateRes.ok) throw new Error("Config update failed");
      
      await logAdminAction('update_config', payload);
      return res.status(200).json({ success: true, sha: 'supabase_db' });
    }

    if (action === 'rename_file') {
      const srcPath = (rawPath || cleanPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
      const dstPath = (cleanNewPath || req.body.newPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
      if (!srcPath || !dstPath) throw new Error("Missing path or newPath");
      if (srcPath.includes('..') || dstPath.includes('..')) {
        return res.status(400).json({ error: 'Invalid path traversal detected.' });
      }
      if (srcPath === dstPath) return res.status(200).json({ success: true, message: 'Source and destination paths are identical' });

      // Determine which repo holds the source file
      let targetRepo = body.repo;
      const encodedSrc = srcPath.split('/').map(s => encodeURIComponent(s)).join('/');
      let fileRes;

      if (targetRepo) {
        fileRes = await ghApi('GET', `/contents/${encodedSrc}`, undefined, targetRepo);
      } else {
        // Try primary content repo first
        fileRes = await ghApi('GET', `/contents/${encodedSrc}`, undefined, repo);
        if (fileRes.ok) {
          targetRepo = repo;
        } else if (fallbackRepo !== repo) {
          // Fallback to core repo
          const fbRes = await ghApi('GET', `/contents/${encodedSrc}`, undefined, fallbackRepo);
          if (fbRes.ok) {
            fileRes = fbRes;
            targetRepo = fallbackRepo;
          }
        }
      }

      if (!fileRes || !fileRes.ok) {
        throw new Error(`Original file not found on GitHub (${srcPath})`);
      }

      const fileData = await fileRes.json();
      const fileSha = fileData.sha;
      if (!fileSha) throw new Error("Unable to determine file SHA for rename");

      const treeItems = [
        { path: srcPath, mode: '100644', type: 'blob', sha: null },
        { path: dstPath, mode: '100644', type: 'blob', sha: fileSha }
      ];

      const commitSha = await getBranchRef(targetRepo);
      const parentCommit = await getCommit(commitSha, targetRepo);
      const newTreeSha = await createTree(parentCommit.tree.sha, treeItems, targetRepo);
      const newCommitSha = await createCommit(`admin: rename ${srcPath} to ${dstPath}`, newTreeSha, [commitSha], targetRepo);
      await updateRef(newCommitSha, targetRepo);

      await logAdminAction('rename_file', { old: srcPath, new: dstPath, repo: targetRepo });
      return res.status(200).json({ success: true, oldPath: srcPath, newPath: dstPath, repo: targetRepo });
    }

    if (action === 'rename_folder') {
      const srcPath = (req.body.oldPath || cleanPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
      const dstPath = (cleanNewPath || (req.body.newPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, ''));
      if (!srcPath || !dstPath) throw new Error("Missing oldPath or newPath");
      if (srcPath.includes('..') || dstPath.includes('..')) {
        return res.status(400).json({ error: 'Invalid path traversal detected.' });
      }

      let normOld = srcPath.startsWith('content/') || srcPath.startsWith('cover/') ? srcPath : 'content/' + srcPath;
      let normNew = dstPath.startsWith('content/') || dstPath.startsWith('cover/') ? dstPath : 'content/' + dstPath;

      if (!normOld.endsWith('/')) normOld += '/';
      if (!normNew.endsWith('/')) normNew += '/';

      let targetRepo = body.repo;
      if (!targetRepo) {
        // Find which repo contains files in normOld
        targetRepo = repo;
        const commitSha = await getBranchRef(repo);
        const parentCommit = await getCommit(commitSha, repo);
        const resTree = await ghApi('GET', `/git/trees/${parentCommit.tree.sha}?recursive=1`, undefined, repo);
        const fullTree = resTree.ok ? await resTree.json() : { tree: [] };
        const count = (fullTree.tree || []).filter(item => item.type === 'blob' && item.path.startsWith(normOld)).length;
        if (count === 0 && fallbackRepo !== repo) {
          targetRepo = fallbackRepo;
        }
      }

      const commitSha = await getBranchRef(targetRepo);
      const parentCommit = await getCommit(commitSha, targetRepo);
      const resTree = await ghApi('GET', `/git/trees/${parentCommit.tree.sha}?recursive=1`, undefined, targetRepo);
      if (!resTree.ok) throw new Error("Failed to fetch repository tree");
      const fullTree = await resTree.json();

      const affectedFiles = (fullTree.tree || []).filter(item => item.type === 'blob' && item.path.startsWith(normOld));
      if (affectedFiles.length === 0) throw new Error(`No files found in folder ${normOld} to rename`);

      const treeItems = [];
      for (const file of affectedFiles) {
        treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: null });
        const newFilePath = normNew + file.path.slice(normOld.length);
        treeItems.push({ path: newFilePath, mode: '100644', type: 'blob', sha: file.sha });
      }

      const newTreeSha = await createTree(parentCommit.tree.sha, treeItems, targetRepo);
      const newCommitSha = await createCommit(`admin: rename folder ${normOld} to ${normNew}`, newTreeSha, [commitSha], targetRepo);
      await updateRef(newCommitSha, targetRepo);
      await logAdminAction('rename_folder', { old: normOld, new: normNew, count: affectedFiles.length, repo: targetRepo });
      return res.status(200).json({ success: true, repo: targetRepo });
    }

    if (action === 'add_admin' || action === 'remove_admin' || action === 'ban_user') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Only SuperAdmin can manage users' });
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

      if (action === 'add_admin') {
        const { targetUserId, identifier } = req.body;
        const resRole = await fetch(`${supabaseUrl}/rest/v1/user_roles`, {
          method: 'POST',
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates' },
          body: JSON.stringify({ identifier: identifier, role: 'admin' })
        });
        if (!resRole.ok) throw new Error(await resRole.text());
        
        await logAdminAction('add_admin', { target: identifier });
        return res.status(200).json({ success: true });
      }

      if (action === 'remove_admin') {
        const { identifier } = req.body;
        const resRole = await fetch(`${supabaseUrl}/rest/v1/user_roles?identifier=eq.${encodeURIComponent(identifier)}`, {
          method: 'DELETE',
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
        });
        if (!resRole.ok) throw new Error(await resRole.text());
        
        await logAdminAction('remove_admin', { target: identifier });
        return res.status(200).json({ success: true });
      }

      if (action === 'ban_user') {
         const { userId, banned } = req.body;
         const getSbRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
           headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
         });
         const userData = await getSbRes.json();
         const newAppMeta = { ...userData.app_metadata, banned: !!banned };
         
         const sbRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
           method: 'PUT',
           headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
           body: JSON.stringify({ app_metadata: newAppMeta })
         });
         if (!sbRes.ok) throw new Error(await sbRes.text());
         
         await logAdminAction(banned ? 'ban_user' : 'unban_user', { target: userData.email });
         return res.status(200).json({ success: true });
      }
    }

    if (action === 'get_users') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Only SuperAdmin can view users' });
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
      
      const { page = 1, per_page = 1000 } = req.body;
      const sbRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=${per_page}`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      if (!sbRes.ok) throw new Error(await sbRes.text());
      const data = await sbRes.json();

      const rolesRes = await fetch(`${supabaseUrl}/rest/v1/user_roles?select=*`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      let rolesData = [];
      if (rolesRes.ok) rolesData = await rolesRes.json();

      const devicesRes = await fetch(`${supabaseUrl}/rest/v1/user_devices?select=*`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      let devicesData = [];
      if (devicesRes.ok) devicesData = await devicesRes.json();
      
      const divRes = await fetch(`${supabaseUrl}/rest/v1/division_members?select=*`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      let divData = [];
      if (divRes.ok) divData = await divRes.json();

      const usersWithRoles = (data.users || []).map(u => {
        const roleRecord = rolesData.find(r => r.identifier === u.email || r.identifier === (u.user_metadata || {}).username);
        const userDevices = devicesData.filter(d => d.user_id === u.id).map(d => ({
          id: d.device_id,
          added: d.created_at,
          last_seen: d.last_seen,
          name: d.device_name || 'Unknown',
          user_agent: d.user_agent || '',
          browser: d.browser || null,
          os: d.os || null,
          device_type: d.device_type || null,
          country: d.country || null,
          city: d.city || null,
          ip_hash: d.ip_hash || null,
          is_safari: d.is_safari || false,
          fingerprint: d.fingerprint || null
        }));
        const divRecord = divData.find(d => d.user_id === u.id);
        
        // Ensure user_metadata exists
        const user_metadata = u.user_metadata || {};
        user_metadata.devices = userDevices;
        user_metadata.division = divRecord ? divRecord.division_id : null;
        user_metadata.whatsapp = divRecord ? divRecord.whatsapp : null;

        return { ...u, user_metadata, role: roleRecord ? roleRecord.role : 'user' };
      });

      const statsRes = await fetch(`${supabaseUrl}/rest/v1/global_stats?id=eq.1&select=total_uptime`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      let globalStats = { total_uptime: 0 };
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        if (statsData.length > 0) globalStats = statsData[0];
      }

      const search = (req.body.query || req.body.search || '').toLowerCase().trim();
      let filteredUsers = usersWithRoles;
      if (search) {
        filteredUsers = filteredUsers.filter(u =>
          (u.email && u.email.toLowerCase().includes(search)) ||
          (u.user_metadata?.full_name && u.user_metadata.full_name.toLowerCase().includes(search)) ||
          (u.user_metadata?.username && u.user_metadata.username.toLowerCase().includes(search)) ||
          (u.user_metadata?.whatsapp && u.user_metadata.whatsapp.toLowerCase().includes(search)) ||
          (u.user_metadata?.division && u.user_metadata.division.toLowerCase().includes(search))
        );
      }

      return res.status(200).json({ success: true, total: filteredUsers.length, users: filteredUsers, globalStats });
    }

    if (action === 'get_activity_logs') {
      if (!isAdmin && !isSuperAdmin) return res.status(403).json({ error: 'Admin access required' });
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

      try {
        const targetUserId = req.body.user_id || req.body.userId || null;
        const targetUserEmail = req.body.email || req.body.user_email || null;
        const limitCount = Math.min(parseInt(req.body.limit, 10) || 60, 200);

        // Filter user_activity_logs by user if requested (User 360 view)
        let userActivityQuery = `order=created_at.desc&limit=${limitCount}`;
        if (targetUserId) {
          userActivityQuery += `&user_id=eq.${encodeURIComponent(targetUserId)}`;
        } else if (targetUserEmail) {
          userActivityQuery += `&user_email=eq.${encodeURIComponent(targetUserEmail.toLowerCase())}`;
        }

        const [userActivityRes, adminLogsRes, logsRes, devRes, usersRes] = await Promise.all([
          fetch(`${supabaseUrl}/rest/v1/user_activity_logs?${userActivityQuery}`, {
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
          }),
          fetch(`${supabaseUrl}/rest/v1/admin_action_logs?order=created_at.desc&limit=50`, {
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
          }),
          fetch(`${supabaseUrl}/rest/v1/activity_logs?order=time.desc&limit=60`, {
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
          }),
          fetch(`${supabaseUrl}/rest/v1/user_devices?order=last_seen.desc.nullslast&limit=30`, {
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
          }),
          fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=100`, {
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
          })
        ]);

        const [userActivityData, adminLogsData, logsData, devData, usersJson] = await Promise.all([
          userActivityRes.ok ? userActivityRes.json() : [],
          adminLogsRes.ok ? adminLogsRes.json() : [],
          logsRes.ok ? logsRes.json() : [],
          devRes.ok ? devRes.json() : [],
          usersRes.ok ? usersRes.json() : { users: [] }
        ]);
        const userMap = {};
        (usersJson.users || []).forEach(u => {
          userMap[u.id] = {
            email: u.email,
            username: u.user_metadata?.username || u.user_metadata?.full_name || u.email?.split('@')[0],
            last_sign_in: u.last_sign_in_at
          };
        });

        const signups = (usersJson.users || []).filter(u => u.created_at).map(u => {
          const email = (u.email || '').toLowerCase();
          const meta = u.user_metadata || {};
          const username = meta.username || meta.full_name || email.split('@')[0] || 'Unknown';
          const isGuest = meta.is_guest === true || email.startsWith('guest_') || username.startsWith('guest_') || (email.includes('@mrcapsules.com') && email.startsWith('guest'));
          return {
            id: 'signup_' + u.id,
            type: isGuest ? 'guest_signup' : 'signup',
            time: u.created_at,
            user: username,
            email: u.email,
            isGuest
          };
        });

        const signins = (usersJson.users || []).filter(u => u.last_sign_in_at).map(u => {
          const email = (u.email || '').toLowerCase();
          const meta = u.user_metadata || {};
          const username = meta.username || meta.full_name || email.split('@')[0] || 'Unknown';
          const isGuest = meta.is_guest === true || email.startsWith('guest_') || username.startsWith('guest_') || (email.includes('@mrcapsules.com') && email.startsWith('guest'));
          return {
            id: 'login_' + u.id + '_' + new Date(u.last_sign_in_at).getTime(),
            type: 'login',
            time: u.last_sign_in_at,
            user: username,
            email: u.email,
            isGuest
          };
        });

        return res.status(200).json({
          success: true,
          user_activity_logs: userActivityData,
          admin_action_logs: adminLogsData,
          activity_logs: logsData,
          signups,
          signins,
          devices: devData.map(d => ({
            ...d,
            userInfo: userMap[d.user_id] || { email: 'Unknown', username: 'Unknown' }
          }))
        });
      } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch activity logs: ' + err.message });
      }
    }

    if (action === 'log_activity') {
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) return res.status(500).json({ error: 'Server config error' });
      const { type, log_id, user_name, email: logEmail, dev_str } = req.body;
      if (!type) return res.status(400).json({ error: 'Missing log type' });

      try {
        const payload = {
          log_id: log_id || `${type}_${email}_${Date.now()}`,
          type: type,
          time: new Date().toISOString(),
          user_name: user_name || username || email,
          email: logEmail || email,
          dev_str: dev_str || req.headers['user-agent'] || null
        };

        const insertRes = await fetch(`${supabaseUrl}/rest/v1/activity_logs`, {
          method: 'POST',
          headers: {
            'apikey': sbKey,
            'Authorization': `Bearer ${sbKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify(payload)
        });

        if (!insertRes.ok) {
          const errText = await insertRes.text();
          return res.status(500).json({ error: errText });
        }

        return res.status(200).json({ success: true, log: payload });
      } catch (err) {
        return res.status(500).json({ error: 'Failed to log activity: ' + err.message });
      }
    }

    if (action === 'batch_create_users') {
      if (!isAdmin && !isSuperAdmin) return res.status(403).json({ error: 'Admin access required' });
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

      const { users: rawUsers, default_password = '', default_division = null, stop_on_error = false } = req.body;
      if (!Array.isArray(rawUsers) || rawUsers.length === 0) return res.status(400).json({ error: 'Missing or empty users array' });

      const existingRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=1000`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      const existingData = existingRes.ok ? await existingRes.json() : { users: [] };
      const existingEmailSet = new Set((existingData.users || []).map(u => (u.email || '').toLowerCase().trim()));
      const seenInBatch = new Set();

      const created = [];
      const failed = [];

      for (let idx = 0; idx < rawUsers.length; idx++) {
        const u = rawUsers[idx];
        const userEmail = (u.email || '').trim().toLowerCase();
        const userPass = u.password || default_password;
        const fullName = (u.full_name || u.name || '').trim();
        const username = (u.username || (userEmail ? userEmail.split('@')[0] : '')).trim();
        const whatsapp = (u.whatsapp || '').trim();
        const division = (u.division_id || u.division || default_division || '').toLowerCase().trim();
        const grantAdmin = u.is_admin === true;

        if (!userEmail || !userEmail.includes('@')) {
          failed.push({ index: idx, email: userEmail, error: 'Invalid or missing email' });
          if (stop_on_error) break;
          continue;
        }
        if (!userPass || userPass.length < 6) {
          failed.push({ index: idx, email: userEmail, error: 'Password must be at least 6 characters' });
          if (stop_on_error) break;
          continue;
        }
        if (existingEmailSet.has(userEmail) || seenInBatch.has(userEmail)) {
          failed.push({ index: idx, email: userEmail, error: `User with email "${userEmail}" already exists` });
          if (stop_on_error) break;
          continue;
        }
        seenInBatch.add(userEmail);

        try {
          const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
            method: 'POST',
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: userEmail,
              password: userPass,
              email_confirm: true,
              user_metadata: { full_name: fullName || username, username, whatsapp, email: userEmail },
              app_metadata: { provider: 'email', providers: ['email'], banned: false }
            })
          });

          if (!createRes.ok) {
            const errTxt = await createRes.text();
            failed.push({ index: idx, email: userEmail, error: `Supabase Auth error: ${errTxt}` });
            if (stop_on_error) break;
            continue;
          }

          const createdUser = await createRes.json();
          existingEmailSet.add(userEmail);

          let assignedDiv = null;
          if (['management', 'development', 'review'].includes(division)) {
            await fetch(`${supabaseUrl}/rest/v1/division_members`, {
              method: 'POST',
              headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
              body: JSON.stringify({ user_id: createdUser.id, division_id: division, whatsapp })
            });
            assignedDiv = division;
          }

          let adminAssigned = false;
          if (grantAdmin && isSuperAdmin) {
            await fetch(`${supabaseUrl}/rest/v1/user_roles`, {
              method: 'POST',
              headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
              body: JSON.stringify({ identifier: userEmail, role: 'admin' })
            });
            adminAssigned = true;
          }

          created.push({ id: createdUser.id, email: userEmail, username, division: assignedDiv || 'none', is_admin: adminAssigned });
        } catch (err) {
          failed.push({ index: idx, email: userEmail, error: err.message });
          if (stop_on_error) break;
        }
      }

      await logAdminAction('batch_create_users', { createdCount: created.length, failedCount: failed.length });
      return res.status(200).json({ success: true, created_count: created.length, failed_count: failed.length, created, failed });
    }

    if (action === 'batch_award_points') {
      if (!isAdmin && !isSuperAdmin && !hasDivision) return res.status(403).json({ error: 'Team access required' });
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

      const points = Number(req.body.points);
      if (isNaN(points) || points === 0) return res.status(400).json({ error: 'Valid numeric points required' });

      const contribType = req.body.type || 'batch_award';
      const taskId = req.body.task_id || null;
      const excludeBanned = req.body.exclude_banned !== false;
      const divisionId = req.body.division_id ? String(req.body.division_id).toLowerCase().trim() : null;

      let targetUserIds = [];

      if (Array.isArray(req.body.users) && req.body.users.length > 0) {
        const usersRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=1000`, {
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
        });
        if (!usersRes.ok) throw new Error(await usersRes.text());
        const { users } = await usersRes.json();
        const emailMap = new Map((users || []).map(u => [(u.email || '').toLowerCase().trim(), u]));
        const idMap = new Map((users || []).map(u => [u.id, u]));

        for (const uItem of req.body.users) {
          if (typeof uItem === 'string') {
            const matched = idMap.get(uItem.trim()) || emailMap.get(uItem.trim().toLowerCase());
            if (matched) targetUserIds.push({ userId: matched.id, points });
          } else if (typeof uItem === 'object' && uItem !== null) {
            const uid = uItem.user_id || '';
            const uemail = (uItem.user_email || uItem.email || '').trim().toLowerCase();
            const matched = (uid ? idMap.get(uid) : null) || (uemail ? emailMap.get(uemail) : null);
            if (matched) targetUserIds.push({ userId: matched.id, points: Number(uItem.points) || points });
          }
        }
      } else {
        const usersRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=1000`, {
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
        });
        if (!usersRes.ok) throw new Error(await usersRes.text());
        const { users } = await usersRes.json();
        let filteredUsers = users || [];

        if (excludeBanned) {
          filteredUsers = filteredUsers.filter(u => !(u.banned_until || (u.app_metadata && u.app_metadata.banned)));
        }

        if (divisionId) {
          const divRes = await fetch(`${supabaseUrl}/rest/v1/division_members?division_id=eq.${encodeURIComponent(divisionId)}&select=user_id`, {
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
          });
          const divRows = divRes.ok ? await divRes.json() : [];
          const memberSet = new Set((divRows || []).map(d => d.user_id));
          filteredUsers = filteredUsers.filter(u => memberSet.has(u.id));
        }

        targetUserIds = filteredUsers.map(u => ({ userId: u.id, points }));
      }

      if (targetUserIds.length === 0) {
        return res.status(200).json({ success: true, message: 'No users matched', total_users_awarded: 0, total_points_awarded: 0 });
      }

      const records = targetUserIds.map(t => {
        const row = { user_id: t.userId, points: t.points, type: contribType };
        if (taskId) row.task_id = taskId;
        return row;
      });

      const CHUNK_SIZE = 100;
      let insertedCount = 0;
      let totalPoints = 0;

      for (let i = 0; i < records.length; i += CHUNK_SIZE) {
        const chunk = records.slice(i, i + CHUNK_SIZE);
        const insRes = await fetch(`${supabaseUrl}/rest/v1/contributions`, {
          method: 'POST',
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify(chunk)
        });
        if (!insRes.ok) throw new Error(`Bulk insert failed: ${await insRes.text()}`);
        insertedCount += chunk.length;
        totalPoints += chunk.reduce((sum, r) => sum + r.points, 0);
      }

      await logAdminAction('batch_award_points', { count: insertedCount, total_points: totalPoints, points_each: points });
      return res.status(200).json({ success: true, total_users_awarded: insertedCount, total_points_awarded: totalPoints, points_each: points });
    }

    if (action === 'delete_user') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Only SuperAdmin can delete users' });
      const { userId } = req.body;
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
      
      const sbRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      if (!sbRes.ok) throw new Error(await sbRes.text());
      return res.status(200).json({ success: true });
    }

    if (action === 'reset_user_password') {
      if (!isAdmin && !isSuperAdmin) return res.status(403).json({ error: 'Admin access required' });
      const { userId, newPassword } = req.body;
      if (!userId || !newPassword) return res.status(400).json({ error: 'Missing userId or newPassword' });
      if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

      const sbRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
        method: 'PUT',
        headers: {
          'apikey': sbKey,
          'Authorization': `Bearer ${sbKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password: newPassword })
      });

      if (!sbRes.ok) {
        const errText = await sbRes.text();
        return res.status(500).json({ error: 'Failed to reset password: ' + errText });
      }

      await logAdminAction('reset_user_password', { targetUserId: userId });
      return res.status(200).json({ success: true, message: 'Password updated successfully' });
    }

    if (action === 'remove_user_device') {
      const { userId, deviceId } = req.body;
      if (!userId || !deviceId) return res.status(400).json({ error: 'Missing userId or deviceId' });
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

      // Permission check: regular user can delete their own, Admin can delete non-admins, SuperAdmin can delete anyone
      const isSelf = userData && userData.id === userId;
      if (!isSelf && !isAdmin && !isSuperAdmin) {
        return res.status(403).json({ error: 'Permission denied' });
      }

      await fetch(`${supabaseUrl}/rest/v1/user_devices?user_id=eq.${userId}&device_id=eq.${encodeURIComponent(deviceId)}`, {
        method: 'DELETE',
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });

      const getSbRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      if (getSbRes.ok) {
        const targetUserData = await getSbRes.json();
        const userMeta = targetUserData.user_metadata || {};
        let devices = Array.isArray(userMeta.devices) ? userMeta.devices : [];
        devices = devices.filter(d => d.id !== deviceId);

        await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
          method: 'PUT',
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_metadata: { ...userMeta, devices } })
        });
      }

      await logAdminAction('remove_user_device', { targetUserId: userId, deviceId });
      return res.status(200).json({ success: true });
    }

    if (action === 'cleanup_guests') {
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

      const maxAge = (typeof req.body?.max_age_hours === 'number' && req.body.max_age_hours > 0) ? req.body.max_age_hours : 24;
      const cutoff = new Date(Date.now() - maxAge * 60 * 60 * 1000).toISOString();

      // 1. Collect stale guests (paginated)
      const guestUsers = [];
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const usersRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=100`, {
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
        });
        if (!usersRes.ok) {
           const err = await usersRes.text();
           return res.status(500).json({ error: 'Failed to fetch users: ' + err });
        }
        const usersData = await usersRes.json();
        const users = usersData.users || [];
        users.forEach(u => {
          const isGuestEmail = u.email && /^guest_\d+_\d+@mrcapsules\.com$/.test(u.email);
          const isGuestMeta = u.user_metadata && u.user_metadata.is_guest === true;
          const isOldEnough = new Date(u.created_at) <= new Date(cutoff);
          if ((isGuestEmail || isGuestMeta) && isOldEnough) guestUsers.push(u);
        });
        if (users.length < 100) hasMore = false;
        page++;
      }

      let deleted = 0;
      let errors = [];

      if (guestUsers.length > 0) {
        const ids = guestUsers.map(g => g.id);
        const restHeaders = { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' };
        const idFilter = `in.(${ids.join(',')})`;

        // 2. Bulk-delete related rows: one request per table instead of N per guest
        const bulkResults = await Promise.all([
          'division_members', 'user_stats', 'user_devices', 'division_requests',
          'contributions', 'oauth_tokens', 'oauth_codes'
        ].map(t =>
          fetch(`${supabaseUrl}/rest/v1/${t}?user_id=${idFilter}`, { method: 'DELETE', headers: restHeaders })
            .then(r => r.ok ? null : `${t}: ${r.status}`)
            .catch(e => `${t}: ${e.message}`)
        ));
        bulkResults.forEach(e => { if (e) errors.push({ table: e }); });

        const patchRes = await fetch(`${supabaseUrl}/rest/v1/content_tasks?assigned_to=${idFilter}`, {
          method: 'PATCH',
          headers: restHeaders,
          body: JSON.stringify({ assigned_to: null })
        }).catch(e => null);
        if (patchRes && !patchRes.ok) errors.push({ table: `content_tasks: ${patchRes.status}` });

        const identifiers = [];
        guestUsers.forEach(g => {
          if (g.email) identifiers.push(`"${g.email}"`);
          if (g.user_metadata?.username) identifiers.push(`"${g.user_metadata.username}"`);
        });
        if (identifiers.length > 0) {
          const rolesRes = await fetch(`${supabaseUrl}/rest/v1/user_roles?identifier=in.(${identifiers.join(',')})`, {
            method: 'DELETE', headers: restHeaders
          }).catch(e => null);
          if (rolesRes && !rolesRes.ok) errors.push({ table: `user_roles: ${rolesRes.status}` });
        }

        // 3. Delete auth users in parallel batches of 10
        for (let i = 0; i < guestUsers.length; i += 10) {
          const batch = guestUsers.slice(i, i + 10);
          await Promise.all(batch.map(async (guest) => {
            try {
              const delRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${guest.id}`, { method: 'DELETE', headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` } });
              if (delRes.ok) deleted++;
              else errors.push({ email: guest.email, error: (await delRes.text()).slice(0, 300) });
            } catch(e) {
              errors.push({ email: guest.email, error: e.message });
            }
          }));
        }
      }

      await logAdminAction('cleanup_guests', { maxAgeHours: maxAge, totalFound: guestUsers.length, deleted });
      return res.status(200).json({
        success: true,
        max_age_hours: maxAge,
        total_guests_found: guestUsers.length,
        deleted,
        failed: guestUsers.length - deleted,
        errors: errors.length > 0 ? errors.slice(0, 20) : undefined
      });
    }

    if (action === 'report_issue') {
      const { task_id, issue_type, question_index, description } = req.body;
      const resData = await fetch(`${supabaseUrl}/rest/v1/review_issues`, {
        method: 'POST',
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id,
          reviewer_id: userId,
          issue_type,
          question_index,
          description,
          status: 'open'
        })
      });
      if (!resData.ok) throw new Error(await resData.text());
      return res.status(200).json({ success: true });
    }

    if (action === 'get_issues') {
      const task_id = req.body?.task_id || new URL(req.url, `https://${host}`).searchParams.get('task_id');
      const resData = await fetch(`${supabaseUrl}/rest/v1/review_issues?task_id=eq.${task_id}&order=created_at.desc`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      const data = await resData.json();
      return res.status(200).json({ success: true, issues: data });
    }

    if (action === 'resolve_issue') {
      const { issue_id } = req.body;
      const resData = await fetch(`${supabaseUrl}/rest/v1/review_issues?id=eq.${issue_id}`, {
        method: 'PATCH',
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'fixed', resolved_at: new Date().toISOString() })
      });
      if (!resData.ok) throw new Error(await resData.text());
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
