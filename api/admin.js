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

  // 1. Prepare concurrent requests to Supabase and GitHub
  const userPromise = fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${token}` }
  });

  const now = Date.now();
  const useCache = global.cachedAdmins && global.cachedAdminsTime && (now - global.cachedAdminsTime < 5 * 60 * 1000);
  let adminsPromise = null;
  
  if (!useCache) {
    adminsPromise = fetch(`https://api.github.com/repos/${owner}/${repo}/contents/admins.json`, {
      headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github.v3+json' }
    });
  }

  // 2. Execute concurrently
  const [userRes, adminsRes] = await Promise.all([userPromise, adminsPromise]);

  if (!userRes.ok) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const userData = await userRes.json();
  const email = userData.email;
  const username = userData.user_metadata?.username;

  let adminsList = [];
  let adminsSha = null;

  if (useCache) {
    adminsList = global.cachedAdmins;
    adminsSha = global.cachedAdminsSha;
  } else {
    if (!adminsRes.ok) {
      return res.status(500).json({ error: 'Failed to read admins.json from repository' });
    }
    const adminsData = await adminsRes.json();
    adminsSha = adminsData.sha;
    const adminsJsonStr = Buffer.from(adminsData.content, 'base64').toString('utf8');
    try {
      adminsList = JSON.parse(adminsJsonStr);
      global.cachedAdmins = adminsList;
      global.cachedAdminsSha = adminsSha;
      global.cachedAdminsTime = now;
    } catch(e) {}
  }

  const superAdminEmail = process.env.SUPERADMIN_EMAIL || 'muqorroben@gmail.com';
  const superAdminUsername = process.env.SUPERADMIN_USERNAME || 'alchemist4real';
  const isSuperAdminRaw = email === superAdminEmail || username === superAdminUsername;
  const isAdmin = isSuperAdminRaw || adminsList.includes(email) || adminsList.includes(username);
  const isSuperAdmin = isAdmin;

  if (!isAdmin) {
    return res.status(403).json({ error: 'Forbidden. Not an admin.' });
  }

  const { action, path, contentBase64, sha, newAdmin } = req.body;

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

  try {
    if (action === 'check') {
      return res.status(200).json({ success: true, isSuperAdmin, admins: adminsList });
    }

    if (action === 'tree') {
      const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Vercel-Proxy'
        }
      });
      if (!ghRes.ok) throw new Error(`GitHub API Error: ${await ghRes.text()}`);
      const data = await ghRes.json();
      return res.status(200).json({ success: true, tree: data.tree });
    }

    if (action === 'upload') {
      const body = {
        message: `admin: upload ${path}`,
        content: contentBase64
      };
      if (sha) body.sha = sha;
      const resGit = await ghApi('PUT', `/contents/${path}`, body);
      const data = await resGit.json();
      if (!resGit.ok) throw new Error(data.message || JSON.stringify(data));
      return res.status(200).json({ success: true, data });
    }
    
    if (action === 'delete') {
      const body = {
        message: `admin: delete ${path}`,
        sha: sha
      };
      const resGit = await ghApi('DELETE', `/contents/${path}`, body);
      if (!resGit.ok) {
        const data = await resGit.json();
        throw new Error(data.message || JSON.stringify(data));
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'delete_files') {
      const { files } = req.body; // Array of {path, sha}
      if (!files || !Array.isArray(files)) throw new Error("Missing files array");
      
      const deletePromises = files.map(f => 
        ghApi('DELETE', `/contents/${f.path}`, { message: `admin: bulk delete ${f.path}`, sha: f.sha })
      );
      
      await Promise.all(deletePromises);
      return res.status(200).json({ success: true });
    }

    if (action === 'get_config') {
      const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/config.json?t=${Date.now()}`, {
        headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github.v3+json' }
      });
      if (!getRes.ok) throw new Error("Config file not found");
      const fileData = await getRes.json();
      const configObj = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf8'));
      return res.status(200).json({ success: true, sha: fileData.sha, config: configObj });
    }

    if (action === 'rename_file') {
      const { newPath } = req.body;
      if (!newPath || !path) throw new Error("Missing path or newPath");
      
      // 1. Get original file content
      const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
        headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github.v3+json' }
      });
      if (!getRes.ok) throw new Error("Original file not found");
      const fileData = await getRes.json();
      
      // 2. Create new file with same content
      const putRes = await ghApi('PUT', `/contents/${newPath}`, {
        message: `admin: rename ${path} to ${newPath}`,
        content: fileData.content.replace(/\n/g, '') // GitHub requires continuous base64 without newlines
      });
      if (!putRes.ok) throw new Error("Failed to create renamed file");
      
      // 3. Delete old file
      await ghApi('DELETE', `/contents/${path}`, {
        message: `admin: clean up old file ${path} after rename`,
        sha: fileData.sha
      });
      
      return res.status(200).json({ success: true });
    }

    if (action === 'add_admin') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Only SuperAdmin can add admins' });
      if (!adminsList.includes(newAdmin)) {
        adminsList.push(newAdmin);
        const body = {
          message: `admin: add admin ${newAdmin}`,
          content: Buffer.from(JSON.stringify(adminsList, null, 2)).toString('base64'),
          sha: adminsSha
        };
        const resGit = await ghApi('PUT', `/contents/admins.json`, body);
        const data = await resGit.json();
        if (!resGit.ok) throw new Error(data.message || JSON.stringify(data));
        // Clear cache
        global.cachedAdminsTime = 0;
        return res.status(200).json({ success: true, admins: adminsList });
      }
      return res.status(200).json({ success: true, message: 'Already an admin', admins: adminsList });
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

      let globalStats = null;
      try {
        const statsRes = await fetch(`${supabaseUrl}/rest/v1/global_stats?id=eq.1&select=total_uptime`, {
           headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
        });
        if (statsRes.ok) {
           const statsData = await statsRes.json();
           if (statsData && statsData.length > 0) {
              globalStats = statsData[0];
           }
        }
      } catch(e) {}

      return res.status(200).json({ success: true, users: data.users || [], globalStats });
    }

    if (action === 'ban_user') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Only SuperAdmin can ban users' });
      const { userId, user_metadata } = req.body;
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
      
      const sbRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
        method: 'PUT',
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_metadata })
      });
      if (!sbRes.ok) throw new Error(await sbRes.text());
      return res.status(200).json({ success: true });
    }

    if (action === 'remove_admin') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Only SuperAdmin can remove admins' });
      const { targetAdmin } = req.body;
      if (adminsList.includes(targetAdmin)) {
        adminsList = adminsList.filter(a => a !== targetAdmin);
        const body = {
          message: `admin: remove admin ${targetAdmin}`,
          content: Buffer.from(JSON.stringify(adminsList, null, 2)).toString('base64'),
          sha: adminsSha
        };
        const resGit = await ghApi('PUT', `/contents/admins.json`, body);
        const data = await resGit.json();
        if (!resGit.ok) throw new Error(data.message || JSON.stringify(data));
        // Clear cache
        global.cachedAdminsTime = 0;
      }
      return res.status(200).json({ success: true, admins: adminsList });
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
