import fs from 'fs';
const sourcePath = fs.existsSync('src/index.ts') ? 'src/index.ts' : 'src/index.ts.broken.ts';
const s = fs.readFileSync(sourcePath, 'utf8');
const re = /server\.tool\(\s*['"]([^'"]+)['"]/g;
const set = new Set();
let m;
while ((m = re.exec(s))) set.add(m[1]);
console.log([...set].sort().join('\n'));
