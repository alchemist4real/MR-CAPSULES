export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const token = process.env.GITHUB_TOKEN;
  let owner = process.env.GITHUB_CONTENT_OWNER || process.env.GITHUB_OWNER || 'alchemist4real';
  let contentRepo = process.env.GITHUB_CONTENT_REPO || 'MR-CAPSULES-CONTENT';
  let fallbackRepo = 'MR-CAPSULES';
  let branch = 'main';
  let activeMount = 'ALL';

  const supabaseUrl = process.env.SUPABASE_URL || 'https://hdhvrlkizorscvehttzd.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (serviceKey) {
    try {
      const stateRes = await fetch(`${supabaseUrl}/rest/v1/gitrouter_app_state?id=eq.repo_mount_config&select=state_data`, {
        headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
      });
      if (stateRes.ok) {
        const rows = await stateRes.json();
        if (rows && rows[0]?.state_data) {
          const cfg = rows[0].state_data;
          if (cfg.primaryRepo) contentRepo = cfg.primaryRepo;
          if (cfg.fallbackRepo) fallbackRepo = cfg.fallbackRepo;
          if (cfg.owner) owner = cfg.owner;
          if (cfg.branch) branch = cfg.branch;
          if (cfg.activeMount) activeMount = cfg.activeMount;
        }
      }
    } catch(e) {}
  }

  // Raw file proxy endpoint (resilient fallback for iframe display)
  const reqFile = req.query.file || req.query.path;
  if (reqFile) {
    const cleanPath = reqFile.replace(/^\/+/, '').replace(/\.\./g, '');
    const encPath = cleanPath.split('/').map(s => encodeURIComponent(s)).join('/');
    
    // 1. Try primary repo raw with cache busting
    let rawRes = await fetch(`https://raw.githubusercontent.com/${owner}/${contentRepo}/${branch}/${encPath}?t=${Date.now()}`, {
      headers: { ...(token ? { 'Authorization': `Bearer ${token}` } : {}), 'User-Agent': 'Vercel-Proxy', 'Cache-Control': 'no-cache' }
    });
    // 2. Try fallback repo raw
    if (!rawRes.ok && contentRepo !== fallbackRepo) {
      rawRes = await fetch(`https://raw.githubusercontent.com/${owner}/${fallbackRepo}/${branch}/${encPath}?t=${Date.now()}`, {
        headers: { ...(token ? { 'Authorization': `Bearer ${token}` } : {}), 'User-Agent': 'Vercel-Proxy', 'Cache-Control': 'no-cache' }
      });
    }
    if (rawRes.ok) {
      const htmlText = await rawRes.text();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
      return res.status(200).send(htmlText);
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(404).send('Module not found on GitHub');
  }

  try {
    // Fetch latest commit SHA to guarantee 100% tree freshness without GitHub edge caching
    const getRepoCommitSha = async (repoName) => {
      try {
        const cRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/commits/${branch}?per_page=1&t=${Date.now()}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'Vercel-Proxy',
            'If-None-Match': '',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          }
        });
        if (cRes.ok) {
          const cData = await cRes.json();
          if (cData.sha) return cData.sha;
        }
      } catch(e) {}
      return branch;
    };

    const targetSha = await getRepoCommitSha(contentRepo);
    let ghRes = await fetch(`https://api.github.com/repos/${owner}/${contentRepo}/git/trees/${targetSha}?recursive=1`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Vercel-Proxy',
        'If-None-Match': '',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });

    let treeData = [];
    if (ghRes.ok) {
      const data = await ghRes.json();
      treeData = data.tree || [];
    }

    // If activeMount is ALL, also merge tree from fallbackRepo
    if (activeMount === 'ALL' && contentRepo !== fallbackRepo) {
      try {
        const fbSha = await getRepoCommitSha(fallbackRepo);
        const fbRes = await fetch(`https://api.github.com/repos/${owner}/${fallbackRepo}/git/trees/${fbSha}?recursive=1`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'Vercel-Proxy',
            'If-None-Match': '',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          }
        });
        if (fbRes.ok) {
          const fbData = await fbRes.json();
          const treeMap = new Map(treeData.map(i => [i.path, i]));
          (fbData.tree || []).forEach(item => {
            if (!treeMap.has(item.path)) {
              treeMap.set(item.path, item);
            }
          });
          treeData = Array.from(treeMap.values());
        }
      } catch(e) {}
    } else if (!ghRes.ok && contentRepo !== fallbackRepo) {
      console.warn(`[Content API] Content repo ${contentRepo} returned ${ghRes.status}. Falling back to ${fallbackRepo}...`);
      const fbSha = await getRepoCommitSha(fallbackRepo);
      ghRes = await fetch(`https://api.github.com/repos/${owner}/${fallbackRepo}/git/trees/${fbSha}?recursive=1`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Vercel-Proxy',
          'If-None-Match': '',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      });
      if (ghRes.ok) {
        const data = await ghRes.json();
        treeData = data.tree || [];
      }
    }

    if (treeData.length === 0 && !ghRes.ok) {
      throw new Error(`GitHub API Error: ${await ghRes.text()}`);
    }
    
    const data = { tree: treeData };
    
    const contentFiles = data.tree.filter(item => 
      item.type === 'blob' && 
      item.path.startsWith('content/') && 
      item.path.endsWith('.html')
    );

    const semMap = {};
    const flatFiles = [];

    contentFiles.forEach(item => {
      const parts = item.path.split('/');
      let semesterName = 'Other Semesters';
      let blockName = 'Other Blocks';
      const fileName = parts.pop();
      
      if (parts.length >= 3) {
        semesterName = parts[1];
        blockName = parts[2];
      } else if (parts.length === 2) {
        blockName = parts[1];
      }

      let category = 'Other';
      let name = fileName.replace('.html', '');
      
      if (fileName.includes('_')) {
        const fileParts = fileName.split('_');
        category = fileParts[0];
        name = fileParts.slice(1).join('_').replace('.html', '');
      }

      flatFiles.push({
        id: fileName,
        title: name,
        type: 'file',
        path: item.path,
        category: category,
        blockName: blockName,
        semesterName: semesterName
      });

      if (!semMap[semesterName]) semMap[semesterName] = {};
      if (!semMap[semesterName][blockName]) semMap[semesterName][blockName] = {};
      if (!semMap[semesterName][blockName][category]) semMap[semesterName][blockName][category] = [];
      
      semMap[semesterName][blockName][category].push({
        name: name,
        path: item.path
      });
    });

    const semesters = Object.keys(semMap).map(semName => {
      const blocksObj = semMap[semName];
      let semFilesCount = 0;
      
      const blocksArr = Object.keys(blocksObj).map(blockName => {
        const catsObj = blocksObj[blockName];
        let blockFilesCount = 0;
        
        const catsArr = Object.keys(catsObj).map(catName => {
          const filesArr = catsObj[catName];
          blockFilesCount += filesArr.length;
          return {
            id: catName,
            title: catName,
            type: 'category',
            totalFiles: filesArr.length,
            files: filesArr.map(f => ({
              id: f.name,
              title: f.name,
              type: 'file',
              path: f.path
            }))
          };
        });
        
        semFilesCount += blockFilesCount;
        
        return {
          id: blockName,
          title: `Block ${blockName}`,
          type: 'block',
          totalFiles: blockFilesCount,
          categories: catsArr
        };
      });
      
      return {
        id: semName,
        title: semName.toUpperCase(),
        type: 'semester',
        totalFiles: semFilesCount,
        blocks: blocksArr
      };
    });

    const maxCoverBytes = 1.5 * 1024 * 1024;
    const coversFiles = (treeData || []).filter(item => 
      item.type === 'blob' && 
      item.path.startsWith('cover/') && 
      (item.path.endsWith('.png') || item.path.endsWith('.jpg') || item.path.endsWith('.jpeg') || item.path.endsWith('.gif')) &&
      (!item.size || item.size <= maxCoverBytes)
    );
    const covers = coversFiles.map(c => c.path);

    const result = {
      semesters: semesters,
      files: flatFiles,
      covers: covers,
      contentCdn: process.env.CONTENT_CDN || `https://cdn.jsdelivr.net/gh/${owner}/${contentRepo}@main`
    };

    // Cache for 10 seconds or bypass if refresh requested
    const isRefreshReq = req.query.t || req.query.refresh || req.headers['cache-control']?.includes('no-cache');
    if (isRefreshReq) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
    }
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
