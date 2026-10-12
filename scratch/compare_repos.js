import fs from 'fs';
import path from 'path';

function walk(dir) {
  let res = [];
  if (!fs.existsSync(dir)) return res;
  fs.readdirSync(dir).forEach(f => {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) res = res.concat(walk(full));
    else res.push(full);
  });
  return res;
}

const mainRoot = process.cwd();
const contentRoot = path.resolve(process.cwd(), '..', 'MR-CAPSULES-CONTENT');

console.log('--- AUDITING CONTENT & COVER ---');
const mainContentFiles = walk(path.join(mainRoot, 'content')).map(f => path.relative(path.join(mainRoot, 'content'), f));
const contentContentFiles = walk(path.join(contentRoot, 'content')).map(f => path.relative(path.join(contentRoot, 'content'), f));

const mainCovers = walk(path.join(mainRoot, 'cover')).map(f => path.relative(path.join(mainRoot, 'cover'), f));
const contentCovers = walk(path.join(contentRoot, 'cover')).map(f => path.relative(path.join(contentRoot, 'cover'), f));

console.log(`Content files in main: ${mainContentFiles.length}, in content repo: ${contentContentFiles.length}`);
console.log(`Cover files in main: ${mainCovers.length}, in content repo: ${contentCovers.length}`);

const missingInContentRepo = mainContentFiles.filter(f => !contentContentFiles.includes(f));
console.log('Files missing in MR-CAPSULES-CONTENT/content:', missingInContentRepo);

const missingCovers = mainCovers.filter(f => !contentCovers.includes(f));
console.log('Covers missing in MR-CAPSULES-CONTENT/cover:', missingCovers);

console.log('\n--- SCANNING RELATIVE REFS IN ALL CONTENT HTML ---');
const allHtml = walk(path.join(contentRoot, 'content')).filter(f => f.endsWith('.html'));
const relativeRefs = new Set();
allHtml.forEach(f => {
  const content = fs.readFileSync(f, 'utf8');
  const matches = content.match(/(?:src|href)=["']([^"']+)["']/g) || [];
  matches.forEach(m => {
    const val = m.replace(/^(?:src|href)=["']|["']$/g, '');
    if (!val.startsWith('http') && !val.startsWith('data:') && !val.startsWith('#') && !val.startsWith('javascript:')) {
      relativeRefs.add({ ref: val, foundIn: path.basename(f) });
    }
  });
});

console.log(`Found ${relativeRefs.size} relative references in HTML modules:`);
for (const r of relativeRefs) {
  console.log(`  [${r.foundIn}] -> ${r.ref}`);
}
