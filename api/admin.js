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
  if (['delete', 'delete_files', 'rename_file', 'rename_folder', 'update_config', 'add_admin', 'remove_admin', 'ban_user', 'cleanup_guests'].includes(action)) {
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
        'Content-Type': 'application/json'
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
          'Content-Type': 'application/json'
        },
        body: bodyObj ? JSON.stringify(bodyObj) : undefined
      });
    }

    return res;
  };

  // Git Data API Helpers (for bypassing 1MB limits)
  const getBranchRef = async () => {
    const res = await ghApi('GET', '/git/refs/heads/main');
    const data = await res.json();
    if (!res.ok) throw new Error(`Failed to get main ref: ${JSON.stringify(data)}`);
    return data.object.sha;
  };
  const getCommit = async (commitSha) => {
    const res = await ghApi('GET', `/git/commits/${commitSha}`);
    const data = await res.json();
    if (!res.ok) throw new Error(`Failed to get commit: ${JSON.stringify(data)}`);
    return data;
  };
  const createTree = async (baseTreeSha, treeItems) => {
    const res = await ghApi('POST', '/git/trees', { base_tree: baseTreeSha, tree: treeItems });
    const data = await res.json();
    if (!res.ok) throw new Error(`Failed to create tree: ${JSON.stringify(data)}`);
    return data.sha;
  };
  const createCommit = async (message, treeSha, parentCommits) => {
    const res = await ghApi('POST', '/git/commits', { message, tree: treeSha, parents: parentCommits });
    const data = await res.json();
    if (!res.ok) throw new Error(`Failed to create commit: ${JSON.stringify(data)}`);
    return data.sha;
  };
  const updateRef = async (newCommitSha) => {
    const res = await ghApi('PATCH', '/git/refs/heads/main', { sha: newCommitSha });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || `Failed to update ref (${res.status})`);
    }
    return res.ok;
  };

  try {
    if (action === 'download') {
      const targetPath = cleanPath;
      if (!targetPath) return res.status(400).json({ error: 'Missing path' });
      const encodedPath = targetPath.split('/').map(s => encodeURIComponent(s)).join('/');
      const fileRes = await ghApi('GET', `/contents/${encodedPath}`);
      if (!fileRes.ok) return res.status(404).json({ error: 'File not found on GitHub' });
      const fileData = await fileRes.json();
      return res.status(200).json({ success: true, contentBase64: fileData.content, sha: fileData.sha });
    }

    if (action === 'tree') {
      const ghRes = await ghApi('GET', `/git/trees/main?recursive=1`);
      if (!ghRes.ok) throw new Error(`GitHub API Error: ${await ghRes.text()}`);
      const data = await ghRes.json();
      return res.status(200).json({ success: true, tree: data.tree });
    }

    if (['upload', 'create_file', 'make_file', 'create_folder', 'make_folder'].includes(action)) {
      let finalPath = cleanPath;
      if (!finalPath) return res.status(400).json({ error: 'Missing path' });

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
        const checkRes = await ghApi('GET', `/contents/${encodedPath}`);
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
            const checkRes = await ghApi('GET', `/contents/${encodedPath}`);
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

        const putRes = await ghApi('PUT', `/contents/${encodedPath}`, putBody);
        if (putRes.ok) {
          const putData = await putRes.json();
          await logAdminAction(action, { path: finalPath });
          return res.status(200).json({ success: true, path: finalPath, sha: putData.content?.sha || putData.commit?.sha });
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
          const blobRes = await ghApi('POST', '/git/blobs', { content: base64, encoding: 'base64' });
          const blobData = await blobRes.json();
          if (!blobRes.ok) throw new Error(blobData.message || 'Failed to create blob');

          const commitSha = await getBranchRef();
          const parentCommit = await getCommit(commitSha);
          const treeItems = [{ path: finalPath, mode: '100644', type: 'blob', sha: blobData.sha }];
          const newTreeSha = await createTree(parentCommit.tree.sha, treeItems);

          const newCommitSha = await createCommit(`admin: ${action.replace('_', ' ')} ${finalPath}`, newTreeSha, [commitSha]);
          await updateRef(newCommitSha);

          await logAdminAction(action, { path: finalPath });
          return res.status(200).json({ success: true, path: finalPath, sha: blobData.sha });
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
      const { newPath } = req.body;
      if (!newPath || !path) throw new Error("Missing path or newPath");
      
      const encodedPath = path.split('/').map(s => encodeURIComponent(s)).join('/');
      const fileRes = await ghApi('GET', `/contents/${encodedPath}`);
      if (!fileRes.ok) throw new Error("Original file not found on GitHub");
      const fileData = await fileRes.json();
      const fileSha = fileData.sha;
      
      const treeItems = [
        { path: path, mode: '100644', type: 'blob', sha: null },
        { path: newPath, mode: '100644', type: 'blob', sha: fileSha }
      ];

      const commitSha = await getBranchRef();
      const parentCommit = await getCommit(commitSha);
      const newTreeSha = await createTree(parentCommit.tree.sha, treeItems);
      const newCommitSha = await createCommit(`admin: rename ${path} to ${newPath}`, newTreeSha, [commitSha]);
      await updateRef(newCommitSha);
      
      await logAdminAction('rename_file', { old: path, new: newPath });
      return res.status(200).json({ success: true });
    }

    if (action === 'rename_folder') {
      const srcPath = (req.body.oldPath || cleanPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
      const dstPath = (cleanNewPath || (req.body.newPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, ''));
      if (!srcPath || !dstPath) throw new Error("Missing oldPath or newPath");
      if (srcPath.includes('..') || dstPath.includes('..')) {
        return res.status(400).json({ error: 'Invalid path traversal detected.' });
      }

      const commitSha = await getBranchRef();
      const parentCommit = await getCommit(commitSha);
      const resTree = await ghApi('GET', `/git/trees/${parentCommit.tree.sha}?recursive=1`);
      if (!resTree.ok) throw new Error("Failed to fetch repository tree");
      const fullTree = await resTree.json();

      let normOld = srcPath.startsWith('content/') || srcPath.startsWith('cover/') ? srcPath : 'content/' + srcPath;
      let normNew = dstPath.startsWith('content/') || dstPath.startsWith('cover/') ? dstPath : 'content/' + dstPath;

      if (!normOld.endsWith('/')) normOld += '/';
      if (!normNew.endsWith('/')) normNew += '/';

      const affectedFiles = (fullTree.tree || []).filter(item => item.type === 'blob' && item.path.startsWith(normOld));
      if (affectedFiles.length === 0) throw new Error("No files found in folder to rename");

      const treeItems = [];
      for (const file of affectedFiles) {
        treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: null });
        const newFilePath = normNew + file.path.slice(normOld.length);
        treeItems.push({ path: newFilePath, mode: '100644', type: 'blob', sha: file.sha });
      }

      const newTreeSha = await createTree(parentCommit.tree.sha, treeItems);
      const newCommitSha = await createCommit(`admin: rename folder ${normOld} to ${normNew}`, newTreeSha, [commitSha]);
      await updateRef(newCommitSha);
      await logAdminAction('rename_folder', { old: normOld, new: normNew, count: affectedFiles.length });
      return res.status(200).json({ success: true });
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
        const userDevices = devicesData.filter(d => d.user_id === u.id).map(d => ({ id: d.device_id, added: d.created_at, last_seen: d.last_seen, name: d.device_name || 'Unknown', user_agent: d.user_agent || '' }));
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

      return res.status(200).json({ success: true, users: usersWithRoles, globalStats });
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
