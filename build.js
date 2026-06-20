const fs = require('fs');
const path = require('path');

function build() {
  console.log('Building MR CAPSULES catalog...');
  try {
    const contentDir = path.join(process.cwd(), 'content');
    const coversDir = path.join(process.cwd(), 'cover');
    
    let covers = [];
    if (fs.existsSync(coversDir)) {
      covers = fs.readdirSync(coversDir).filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.gif'));
    }

    const blocks = [];
    if (fs.existsSync(contentDir)) {
      const blockFolders = fs.readdirSync(contentDir, { withFileTypes: true })
                             .filter(dirent => dirent.isDirectory())
                             .map(dirent => dirent.name);
      
      blockFolders.forEach(blockName => {
        const blockPath = path.join(contentDir, blockName);
        const files = fs.readdirSync(blockPath).filter(f => f.endsWith('.html'));
        
        const categoriesMap = {};
        
        files.forEach(file => {
          let category = "Other";
          let name = file.replace('.html', '');
          
          if (file.includes('_')) {
            const parts = file.split('_');
            category = parts[0];
            name = parts.slice(1).join('_').replace('.html', '');
          }
          
          if (!categoriesMap[category]) {
            categoriesMap[category] = [];
          }
          categoriesMap[category].push({
            name: name,
            path: `content/${blockName}/${file}`
          });
        });
        
        const categories = Object.keys(categoriesMap).map(catName => ({
          name: catName,
          files: categoriesMap[catName]
        }));
        
        blocks.push({
          id: blockName,
          title: `Block ${blockName}`,
          categories: categories,
          totalFiles: files.length
        });
      });
    }

    const result = {
      blocks: blocks,
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
