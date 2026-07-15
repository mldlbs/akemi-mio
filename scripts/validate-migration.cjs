const fs = require('fs');
const path = require('path');

const schema = JSON.parse(fs.readFileSync('docs/golden/golden-schema.json', 'utf-8'));
const required = new Set(schema.required);

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...walk(path.join(dir, entry.name)));
    else if (entry.name.endsWith('.json') && entry.name !== 'golden-schema.json' && entry.name !== 'manifest.json')
      files.push(path.join(dir, entry.name));
  }
  return files;
}

const files = walk('docs/golden');
let passed = 0, failed = 0;

for (const f of files) {
  const errors = [];
  let data;
  try { data = JSON.parse(fs.readFileSync(f, 'utf-8')); }
  catch (e) { errors.push('parse error'); failed++; console.log('FAIL ' + f + ': ' + e); continue; }

  for (const rf of required) { if (!(rf in data)) errors.push('missing: ' + rf); }
  if ('changelog' in data) errors.push('has changelog');
  if ('level2' in data) errors.push('has level2');

  const rh = data.revisionHistory;
  if (!Array.isArray(rh) || rh.length === 0) errors.push('revisionHistory empty/missing');

  if (errors.length) { failed++; console.log('FAIL ' + f + ': ' + errors.join(', ')); }
  else passed++;
}

console.log('Result: ' + passed + ' passed, ' + failed + ' failed out of ' + files.length + ' files');
