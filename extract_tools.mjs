import fs from 'fs';
const s = fs.readFileSync('src/index.ts.broken.ts', 'utf8');
const re = /server\.tool\(\s*['"]([^'"]+)['"]/g;
const set = new Set();
let m;
while ((m = re.exec(s))) set.add(m[1]);
console.log([...set].sort().join('\n'));
