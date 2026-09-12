const fs = require('fs')
const path = require('path')

function walk(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      files.push(...walk(path.join(dir, entry.name)))
    } else if (entry.name.endsWith('.json') && entry.name !== 'golden-schema.json' && entry.name !== 'manifest.json') {
      files.push(path.join(dir, entry.name))
    }
  }
  return files
}

// Restore Q01 if missing
const q01 = 'docs/golden/analysis/Q01.json'
if (!fs.existsSync(q01)) {
  const bak = fs.readdirSync('docs/golden/analysis').find(f => f.includes('Q01') && f !== 'Q01.json')
  if (bak) {
    const src = path.join('docs/golden/analysis', bak)
    fs.copyFileSync(src, q01)
    console.log('Restored Q01 from', bak)
  } else {
    console.log('ERROR: No backup for Q01 found')
    process.exit(1)
  }
}

// Regenerate manifest
const files = walk('docs/golden')
const cases = files.map(f => {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'))
  return { caseId: d.caseId, category: path.basename(path.dirname(f)) }
})
const m = {
  schemaVersion: '0.1',
  goldenVersion: '0.1.0',
  total: cases.length,
  byCategory: { analysis: 0, decision: 0, planning: 0, creation: 0 },
  generatedAt: new Date().toISOString(),
  cases,
}
for (const c of cases) m.byCategory[c.category]++
fs.writeFileSync('docs/golden/manifest.json', JSON.stringify(m, null, 2) + '\n', 'utf8')
console.log('Manifest total=' + m.total)
