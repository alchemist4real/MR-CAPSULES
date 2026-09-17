export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_CONTENT_OWNER || process.env.GITHUB_OWNER || 'alchemist4real';
  const contentRepo = process.env.GITHUB_CONTENT_REPO || 'MR-CAPSULES-CONTENT';
  const fallbackRepo = 'MR-CAPSULES';

  try {
    let ghRes = await fetch(`https://api.github.com/repos/${owner}/${contentRepo}/git/trees/main?recursive=1`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Vercel-Proxy'
      }
    });

    if (!ghRes.ok && contentRepo !== fallbackRepo) {
      console.warn(`[Content API] Content repo ${contentRepo} returned ${ghRes.status}. Falling back to ${fallbackRepo}...`);
      ghRes = await fetch(`https://api.github.com/repos/${owner}/${fallbackRepo}/git/trees/main?recursive=1`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Vercel-Proxy'
        }
      });
    }

    if (!ghRes.ok) throw new Error(`GitHub API Error: ${await ghRes.text()}`);
    
    const data = await ghRes.json();
    
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
      contentCdn: process.env.CONTENT_CDN || ''
    };

    // Cache for 5 minutes to reduce GitHub API rate limit consumption
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
