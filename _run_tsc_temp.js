const execSync = require('child_process').execSync;
const tscPath = require('path').join(__dirname, 'node_modules', 'typescript', 'bin', 'tsc');
try {
  const result = execSync('node "' + tscPath + '" --noEmit -p tsconfig.node.json', { cwd: __dirname, encoding: 'utf-8', timeout: 120000 });
  console.log('TYPECHECK PASSED');
  if (result.trim()) console.log(result);
} catch (e) {
  console.log('TYPECHECK FAILED');
  if (e.stdout) console.log(e.stdout);
  if (e.stderr) console.error(e.stderr);
  if (e.message) console.error(e.message);
  process.exit(1);
}
