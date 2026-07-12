const { execSync } = require('child_process')
try {
  const result = execSync('node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json', {
    cwd: 'D:/work/code/akemi-mio',
    timeout: 120000,
    encoding: 'utf-8',
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 10
  })
  console.log('TSC OUTPUT:', result || '(no output = success)')
} catch (e) {
  console.log('STDOUT:', e.stdout)
  console.log('STDERR:', e.stderr)
  console.log('ERROR:', e.message)
}
