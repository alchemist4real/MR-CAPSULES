import fs from 'fs';
import path from 'path';

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach(childItemName => {
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else if (exists) {
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(src, dest);
  }
}

function walkDir(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      walkDir(filePath, fileList);
    } else if (file.endsWith('.html')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

function copyStaticAssets(publicDir) {
  const rootFiles = fs.readdirSync(process.cwd());
  rootFiles.forEach(file => {
    if (
      file === 'node_modules' ||
      file.startsWith('.git') ||
      file.startsWith('.env') ||
      file === '.vercel' ||
      file === 'api' ||
      file === 'public' ||
      file === 'graphify-out' ||
      file === '.agents' ||
      file === 'scratch' ||
      file === 'content' ||
      file === 'cover' ||
      file === 'supabase' ||
      file === 'build.js'
    ) {
      return;
    }
    const srcPath = path.join(process.cwd(), file);
    const destPath = path.join(publicDir, file);
    copyRecursiveSync(srcPath, destPath);
  });
}

function build() {
  console.log('Building Mr. Capsules catalog and public static files...');
  try {
    const publicDir = path.join(process.cwd(), 'public');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }

    const adjacentContentRoot = path.join(process.cwd(), '..', 'MR-CAPSULES-CONTENT');
    let contentDir = null;
    let coversDir = null;

    if (fs.existsSync(path.join(adjacentContentRoot, 'content'))) {
      contentDir = path.join(adjacentContentRoot, 'content');
      console.log('Detected mounted content repository at:', contentDir);
    } else if (fs.existsSync(path.join(process.cwd(), 'content'))) {
      contentDir = path.join(process.cwd(), 'content');
      console.log('Using local content directory at:', contentDir);
    }

    if (fs.existsSync(path.join(adjacentContentRoot, 'cover'))) {
      coversDir = path.join(adjacentContentRoot, 'cover');
    } else if (fs.existsSync(path.join(process.cwd(), 'cover'))) {
      coversDir = path.join(process.cwd(), 'cover');
    }

    // If neither local nor adjacent content exists (e.g. cloud build container without mounted repo)
    if (!contentDir) {
      console.log('No local content directory found (operating in decoupled mode).');
      const existingDataJs = path.join(process.cwd(), 'data.js');
      if (fs.existsSync(existingDataJs)) {
        console.log('Preserving existing committed data.js catalog for production build.');
        fs.copyFileSync(existingDataJs, path.join(publicDir, 'data.js'));
        copyStaticAssets(publicDir);
        console.log('Build complete (decoupled mode).');
        return;
      }
    }

    let covers = [];
    if (coversDir && fs.existsSync(coversDir)) {
      const maxCoverBytes = 1.5 * 1024 * 1024; // 1.5 MB threshold to ensure fast, stutter-free loading
      covers = fs.readdirSync(coversDir).filter(f => {
        const isImg = f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.gif');
        if (!isImg) return false;
        try {
          const sz = fs.statSync(path.join(coversDir, f)).size;
          return sz <= maxCoverBytes;
        } catch(e) {
          return false;
        }
      });
      console.log(`Included ${covers.length} lightweight web-optimized covers (<1.5MB) from pool.`);
    }

    const allHtmlPaths = contentDir && fs.existsSync(contentDir) ? walkDir(contentDir) : [];
    
    const semMap = {};
    const flatFiles = [];

    allHtmlPaths.forEach(filePath => {
      const relToContent = path.relative(contentDir, filePath).replace(/\\/g, '/');
      const relativePath = `content/${relToContent}`;
      const fileName = path.basename(filePath);
      
      const parts = relativePath.split('/');
      let semesterName = "Other Semesters";
      let blockName = "Other Blocks";
      
      if (parts.length >= 4) {
        semesterName = parts[1];
        blockName = parts[2];
      } else if (parts.length === 3) {
        blockName = parts[1];
      }

      let category = "Other";
      let name = fileName.replace('.html', '').trim();
      
      if (fileName.includes('_')) {
        const fileParts = fileName.split('_');
        category = fileParts[0].trim();
        name = fileParts.slice(1).join('_').replace('.html', '').trim();
      }

      flatFiles.push({
        id: fileName,
        title: name,
        type: 'file',
        path: relativePath,
        category: category,
        blockName: blockName,
        semesterName: semesterName
      });

      if (!semMap[semesterName]) semMap[semesterName] = {};
      if (!semMap[semesterName][blockName]) semMap[semesterName][blockName] = {};
      if (!semMap[semesterName][blockName][category]) semMap[semesterName][blockName][category] = [];
      
      semMap[semesterName][blockName][category].push({
        name: name,
        path: relativePath
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

    const result = {
      semesters: semesters,
      files: flatFiles,
      covers: covers.map(c => `cover/${c}`),
      contentCdn: process.env.CONTENT_CDN || 'https://cdn.jsdelivr.net/gh/alchemist4real/MR-CAPSULES-CONTENT@main',
      mountedRepo: process.env.GITHUB_CONTENT_REPO || 'MR-CAPSULES-CONTENT',
      fallbackRepo: 'MR-CAPSULES'
    };

    const jsContent = `window.appData = ${JSON.stringify(result)};`;
    fs.writeFileSync(path.join(process.cwd(), 'data.js'), jsContent);
    fs.writeFileSync(path.join(publicDir, 'data.js'), jsContent);

    copyStaticAssets(publicDir);

    // Inject build timestamp into public/app.html data.js script tag for guaranteed cache busting
    const publicAppHtml = path.join(publicDir, 'app.html');
    if (fs.existsSync(publicAppHtml)) {
      let appHtmlContent = fs.readFileSync(publicAppHtml, 'utf8');
      appHtmlContent = appHtmlContent.replace(
        /<script src="data\.js[^"]*"><\/script>/g,
        `<script src="data.js?v=${Date.now()}"></script>`
      );
      fs.writeFileSync(publicAppHtml, appHtmlContent);
    }

    console.log(`Successfully generated catalog (${flatFiles.length} files) and copied all static assets to public/`);
  } catch (err) {
    console.error('Error generating catalog:', err);
    process.exit(1);
  }
}

build();
