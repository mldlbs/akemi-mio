const { execSync } = require('child_process');
const result = execSync('npx tsc --noEmit -p tsconfig.node.json', {
  cwd: 'D:/work/code/akemi-mio',
  stdio: ['pipe', 'pipe', 'pipe'],
  encoding: 'utf-8',
  timeout: 120000,
  windowsHide: true
});
console.log(result.stdout || result.stderr || 'OK');
