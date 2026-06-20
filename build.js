const fs = require('fs');
const path = require('path');

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
  console.log('Building MR CAPSULES catalog...');
  try {
    const contentDir = path.join(process.cwd(), 'content');
    const coversDir = path.join(process.cwd(), 'cover');
    
    let covers = [];
    if (fs.existsSync(coversDir)) {
      covers = fs.readdirSync(coversDir).filter(f => 
        f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.gif')
      );
    }

    const allHtmlPaths = fs.existsSync(contentDir) ? walkDir(contentDir) : [];
    
    // For Folder Mode
    const semMap = {};
    // For Flat Mode
    const flatFiles = [];

    allHtmlPaths.forEach(filePath => {
      // Normalize path for web
      const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
      const fileName = path.basename(filePath);
      
      const parts = relativePath.split('/');
      // Expected structure: content / semester / block / file.html
      // If it's just content / block / file.html, we pad it with a default semester
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

      // Add to Flat Mode
      flatFiles.push({
        id: fileName,
        title: name,
        type: 'file',
        path: relativePath,
        category: category,
        blockName: blockName,
        semesterName: semesterName
      });

      // Add to Folder Mode Map
      if (!semMap[semesterName]) semMap[semesterName] = {};
      if (!semMap[semesterName][blockName]) semMap[semesterName][blockName] = {};
      if (!semMap[semesterName][blockName][category]) semMap[semesterName][blockName][category] = [];
      
      semMap[semesterName][blockName][category].push({
        name: name,
        path: relativePath
      });
    });

    // Build semesters array
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
      covers: covers.map(c => `cover/${c}`)
    };

    const jsContent = `window.appData = ${JSON.stringify(result)};`;
    fs.writeFileSync(path.join(process.cwd(), 'data.js'), jsContent);
    console.log('Successfully generated data.js');
  } catch (err) {
    console.error('Error generating catalog:', err);
    process.exit(1);
  }
}

build();
