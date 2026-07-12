const { execSync } = require('child_process')
try {
  const out = execSync('npx.cmd tsc --noEmit --project tsconfig.node.json', {
    cwd: 'D:\\work\\code\\akemi-mio',
    encoding: 'utf-8',
    timeout: 120000,
  })
  console.log('OK: tsc passed')
} catch (e) {
  console.log('STDOUT:', e.stdout)
  console.log('STDERR:', e.stderr?.slice(0, 5000))
  console.log('Exit:', e.status)
}
