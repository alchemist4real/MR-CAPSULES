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
  const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkaHZybGtpem9yc2N2ZWh0dHpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNjMwNzIsImV4cCI6MjA5MjgzOTA3Mn0.m6L3oEVAfyp2TjYmBCfDRo_30rdsWLEsGVZzRZIy3MU';

  const githubToken = process.env.GITHUB_TOKEN;
  const owner = 'alchemist4real';
  const repo = 'MR-CAPSULES';

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

  // 2. Check if user is an admin via user_roles table
  const roleRes = await fetch(`${supabaseUrl}/rest/v1/user_roles?user_id=eq.${userData.id}&select=role`, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${token}` }
  });
  
  let roleData = [];
  if (roleRes.ok) {
    roleData = await roleRes.json();
  }

  const superAdminEmail = process.env.SUPERADMIN_EMAIL || 'muqorroben@gmail.com';
  const isSuperAdmin = email === superAdminEmail;
  const hasAdminRole = roleData && roleData.length > 0 && roleData[0].role === 'admin';
  const isAdmin = isSuperAdmin || hasAdminRole;

  if (!isAdmin) {
    return res.status(403).json({ error: 'Forbidden. Not an admin.' });
  }

  const { action, path, contentBase64, sha } = req.body;

  // Helper to make GitHub API calls
  const ghApi = async (method, endpoint, bodyObj) => {
    return fetch(`https://api.github.com/repos/${owner}/${repo}${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: bodyObj ? JSON.stringify(bodyObj) : undefined
    });
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
    if (!res.ok) throw new Error(`Failed to update ref`);
    return res.ok;
  };

  try {
    if (action === 'check') {
      return res.status(200).json({ success: true, isSuperAdmin, email: email });
    }

    if (action === 'tree') {
      const ghRes = await ghApi('GET', `/git/trees/main?recursive=1`);
      if (!ghRes.ok) throw new Error(`GitHub API Error: ${await ghRes.text()}`);
      const data = await ghRes.json();
      return res.status(200).json({ success: true, tree: data.tree });
    }

    if (action === 'upload') {
      // 1. Create Blob
      const blobRes = await ghApi('POST', '/git/blobs', { content: contentBase64, encoding: 'base64' });
      const blobData = await blobRes.json();
      if (!blobRes.ok) throw new Error(blobData.message);
      
      // 2. Update Tree
      const treeItems = [{ path: path, mode: '100644', type: 'blob', sha: blobData.sha }];
      const commitSha = await getBranchRef();
      const parentCommit = await getCommit(commitSha);
      const newTreeSha = await createTree(parentCommit.tree.sha, treeItems);
      
      // 3. Commit
      const newCommitSha = await createCommit(`admin: upload ${path}`, newTreeSha, [commitSha]);
      await updateRef(newCommitSha);
      
      return res.status(200).json({ success: true });
    }
    
    if (action === 'delete') {
      const treeItems = [{ path: path, mode: '100644', type: 'blob', sha: null }];
      
      const commitSha = await getBranchRef();
      const parentCommit = await getCommit(commitSha);
      const newTreeSha = await createTree(parentCommit.tree.sha, treeItems);
      const newCommitSha = await createCommit(`admin: delete ${path}`, newTreeSha, [commitSha]);
      await updateRef(newCommitSha);
      
      return res.status(200).json({ success: true });
    }

    if (action === 'delete_files') {
      const { files } = req.body; // Array of {path, sha}
      if (!files || !Array.isArray(files)) throw new Error("Missing files array");
      
      const treeItems = files.map(f => ({ path: f.path, mode: '100644', type: 'blob', sha: null }));
      
      const commitSha = await getBranchRef();
      const parentCommit = await getCommit(commitSha);
      const newTreeSha = await createTree(parentCommit.tree.sha, treeItems);
      const newCommitSha = await createCommit(`admin: bulk delete ${files.length} files`, newTreeSha, [commitSha]);
      await updateRef(newCommitSha);
      
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
        maintenanceMode: data[0].maintenance_mode,
        bannedDevices: data[0].banned_devices
      };
      // Return a dummy sha to satisfy the frontend code
      return res.status(200).json({ success: true, sha: 'supabase_db', config: configObj });
    }

    if (action === 'update_config') {
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
      const { allowSignup, maintenanceMode, bannedDevices } = req.body;
      
      const payload = {};
      if (allowSignup !== undefined) payload.allow_signup = allowSignup;
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
      return res.status(200).json({ success: true, sha: 'supabase_db' });
    }

    if (action === 'rename_file') {
      const { newPath } = req.body;
      if (!newPath || !path) throw new Error("Missing path or newPath");
      
      const ghRes = await ghApi('GET', `/git/trees/main?recursive=1`);
      const data = await ghRes.json();
      if (!ghRes.ok) throw new Error(`Failed to read tree: ${JSON.stringify(data)}`);
      
      const fileNode = data.tree.find(t => t.path === path);
      if (!fileNode) throw new Error("Original file not found in tree");
      
      const treeItems = [
        { path: path, mode: '100644', type: 'blob', sha: null },
        { path: newPath, mode: '100644', type: 'blob', sha: fileNode.sha }
      ];

      const commitSha = await getBranchRef();
      const parentCommit = await getCommit(commitSha);
      const newTreeSha = await createTree(parentCommit.tree.sha, treeItems);
      const newCommitSha = await createCommit(`admin: rename ${path} to ${newPath}`, newTreeSha, [commitSha]);
      await updateRef(newCommitSha);
      
      return res.status(200).json({ success: true });
    }

    if (action === 'add_admin' || action === 'remove_admin' || action === 'ban_user') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Only SuperAdmin can manage users' });
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

      if (action === 'add_admin') {
        const { targetUserId } = req.body;
        const resRole = await fetch(`${supabaseUrl}/rest/v1/user_roles`, {
          method: 'POST',
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: targetUserId, role: 'admin' })
        });
        if (!resRole.ok) throw new Error(await resRole.text());
        return res.status(200).json({ success: true });
      }

      if (action === 'remove_admin') {
        const { targetUserId } = req.body;
        const resRole = await fetch(`${supabaseUrl}/rest/v1/user_roles?user_id=eq.${targetUserId}`, {
          method: 'DELETE',
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
        });
        if (!resRole.ok) throw new Error(await resRole.text());
        return res.status(200).json({ success: true });
      }

      if (action === 'ban_user') {
         const { userId, user_metadata } = req.body;
         const sbRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
           method: 'PUT',
           headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
           body: JSON.stringify({ user_metadata })
         });
         if (!sbRes.ok) throw new Error(await sbRes.text());
         return res.status(200).json({ success: true });
      }
    }

    if (action === 'get_users') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Only SuperAdmin can view users' });
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
      
      const sbRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      if (!sbRes.ok) throw new Error(await sbRes.text());
      const data = await sbRes.json();

      const rolesRes = await fetch(`${supabaseUrl}/rest/v1/user_roles?select=*`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      let rolesData = [];
      if (rolesRes.ok) rolesData = await rolesRes.json();

      const usersWithRoles = (data.users || []).map(u => {
        const roleRecord = rolesData.find(r => r.user_id === u.id);
        return { ...u, role: roleRecord ? roleRecord.role : 'user' };
      });

      return res.status(200).json({ success: true, users: usersWithRoles });
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

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
