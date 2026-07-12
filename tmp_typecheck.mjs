import { execSync } from 'child_process';
const result = execSync('node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.node.json', { encoding: 'utf8', stdio: 'pipe' });
console.log(result);
