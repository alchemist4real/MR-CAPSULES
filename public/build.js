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

function build() {
  console.log('Building Mr. Capsules catalog and public static files...');
  try {
    const contentDir = path.join(process.cwd(), 'content');
    const coversDir = path.join(process.cwd(), 'cover');
    const publicDir = path.join(process.cwd(), 'public');

    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }

    let covers = [];
    if (fs.existsSync(coversDir)) {
      covers = fs.readdirSync(coversDir).filter(f => 
        f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.gif')
      );
    }

    const allHtmlPaths = fs.existsSync(contentDir) ? walkDir(contentDir) : [];
    
    const semMap = {};
    const flatFiles = [];

    allHtmlPaths.forEach(filePath => {
      const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
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
      contentCdn: process.env.CONTENT_CDN || ''
    };

    const jsContent = `window.appData = ${JSON.stringify(result)};`;
    fs.writeFileSync(path.join(process.cwd(), 'data.js'), jsContent);
    fs.writeFileSync(path.join(publicDir, 'data.js'), jsContent);

    // Copy all static web assets to public/ directory for Vercel CDN deployment
    // (content/ and cover/ are excluded as they are hosted on the separate content repository/CDN)
    const rootFiles = fs.readdirSync(process.cwd());
    rootFiles.forEach(file => {
      if (
        file === 'node_modules' ||
        file === '.git' ||
        file === '.vercel' ||
        file === 'api' ||
        file === 'public' ||
        file === 'graphify-out' ||
        file === '.agents' ||
        file === 'scratch' ||
        file === 'content' ||
        file === 'cover'
      ) {
        return;
      }
      const srcPath = path.join(process.cwd(), file);
      const destPath = path.join(publicDir, file);
      copyRecursiveSync(srcPath, destPath);
    });

    console.log('Successfully generated catalog and copied all static assets to public/');
  } catch (err) {
    console.error('Error generating catalog:', err);
    process.exit(1);
  }
}

build();
