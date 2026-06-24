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

  // 1. Verify user via Supabase REST API
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${token}`
    }
  });

  if (!userRes.ok) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const userData = await userRes.json();
  const email = userData.email;
  const username = userData.user_metadata?.username;

  // 2. Fetch admins.json from GitHub to check permissions
  const githubToken = process.env.GITHUB_TOKEN;
  const owner = 'alchemist4real';
  const repo = 'MR-CAPSULES';

  const adminsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/admins.json`, {
    headers: { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github.v3+json' }
  });

  if (!adminsRes.ok) {
    return res.status(500).json({ error: 'Failed to read admins.json from repository' });
  }

  const adminsData = await adminsRes.json();
  const adminsJsonStr = Buffer.from(adminsData.content, 'base64').toString('utf8');
  let adminsList = [];
  try {
    adminsList = JSON.parse(adminsJsonStr);
  } catch(e) {}

  const isSuperAdmin = email === 'muqorroben@gmail.com' || username === 'alchemist4real';
  const isAdmin = isSuperAdmin || adminsList.includes(email) || adminsList.includes(username);

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

    if (action === 'add_admin') {
      if (!isSuperAdmin) return res.status(403).json({ error: 'Only SuperAdmin can add admins' });
      if (!adminsList.includes(newAdmin)) {
        adminsList.push(newAdmin);
        const body = {
          message: `admin: add admin ${newAdmin}`,
          content: Buffer.from(JSON.stringify(adminsList, null, 2)).toString('base64'),
          sha: adminsData.sha
        };
        const resGit = await ghApi('PUT', `/contents/admins.json`, body);
        const data = await resGit.json();
        if (!resGit.ok) throw new Error(data.message || JSON.stringify(data));
        return res.status(200).json({ success: true, admins: adminsList });
      }
      return res.status(200).json({ success: true, message: 'Already an admin', admins: adminsList });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
