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
    
    // 1. Try primary repo raw
    let rawRes = await fetch(`https://raw.githubusercontent.com/${owner}/${contentRepo}/${branch}/${encPath}`, {
      headers: { ...(token ? { 'Authorization': `Bearer ${token}` } : {}), 'User-Agent': 'Vercel-Proxy' }
    });
    // 2. Try fallback repo raw
    if (!rawRes.ok && contentRepo !== fallbackRepo) {
      rawRes = await fetch(`https://raw.githubusercontent.com/${owner}/${fallbackRepo}/${branch}/${encPath}`, {
        headers: { ...(token ? { 'Authorization': `Bearer ${token}` } : {}), 'User-Agent': 'Vercel-Proxy' }
      });
    }
    if (rawRes.ok) {
      const htmlText = await rawRes.text();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
      return res.status(200).send(htmlText);
    }
    return res.status(404).send('Module not found on GitHub');
  }

  try {
    let ghRes = await fetch(`https://api.github.com/repos/${owner}/${contentRepo}/git/trees/${branch}?recursive=1`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Vercel-Proxy'
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
        const fbRes = await fetch(`https://api.github.com/repos/${owner}/${fallbackRepo}/git/trees/${branch}?recursive=1`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'Vercel-Proxy'
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
      ghRes = await fetch(`https://api.github.com/repos/${owner}/${fallbackRepo}/git/trees/${branch}?recursive=1`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Vercel-Proxy'
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

    const coversFiles = data.tree.filter(item => 
      item.type === 'blob' && 
      item.path.startsWith('cover/') && 
      (item.path.endsWith('.png') || item.path.endsWith('.jpg') || item.path.endsWith('.jpeg') || item.path.endsWith('.gif'))
    );
    const covers = coversFiles.map(c => c.path);

    const result = {
      semesters: semesters,
      files: flatFiles,
      covers: covers,
      contentCdn: process.env.CONTENT_CDN || `https://cdn.jsdelivr.net/gh/${owner}/${contentRepo}@main`
    };

    // Cache for 5 minutes to reduce GitHub API rate limit consumption
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
