const fs = require('fs');
const path = require('path');

console.log('=== Schema Migration v1 ===\n');

// ── Helper: read, migrate and verify golden JSON files ──
const goldenDir = 'docs/golden';
function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...walk(path.join(dir, entry.name)));
    else if (entry.name.endsWith('.json') && entry.name !== 'golden-schema.json' && entry.name !== 'manifest.json')
      files.push(path.join(dir, entry.name));
  }
  return files;
}

// ── 1. golden-schema.json: read, modify JSON in memory, write ──
const schemaPath = 'docs/golden/golden-schema.json';
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
schema.required = ['caseId', 'caseRef', 'level1', 'revisionHistory', 'createdAt', 'updatedAt'];
delete schema.properties.level2;
const changelogDef = schema.properties.changelog;
delete schema.properties.changelog;
schema.properties.revisionHistory = changelogDef;
fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2) + '\n', 'utf8');
console.log('1. golden-schema.json updated');

// ── 2. types.ts: read, modify text, write ──
const typesPath = 'src/main/reasoning/golden/types.ts';
let types = fs.readFileSync(typesPath, 'utf8');

// Update header
types = types.replace(
  /Two-level design:[\s\S]*?Level 2 \(future\): non-deterministic LLM response — approximate match/,
  'Level 1-only design (v0.1): deterministic ReasoningDirective snapshot — exact match'
);
types = types.replace('Level 2 diff governed by RegressionPolicy.', 'Level 2 governed by future RegressionPolicy.');

// Remove Level 2 section
types = types.replace(
  /\n\/\/ ═══════════════════════════════════════════════════════\n\/\/  Level 2: LLM Response Snapshot \(non-deterministic, future\)[\s\S]*?\/\/ ═══════════════════════════════════════════════════════\n\n/,
  '\n'
);

// Remove GoldenResponseSnapshot interface
types = types.replace(
  /\/\*\* @future[\s\S]*?export interface GoldenResponseSnapshot \{[\s\S]*?\n\}\n\n/,
  ''
);

// Rename changelog → revisionHistory in type name and field
types = types.replace(/GoldenChangelogEntry/g, 'GoldenRevisionEntry');
types = types.replace(/All changelog updates/, 'All revisionHistory entries');
types = types.replace(/changelog: GoldenRevisionEntry\[\]/, 'revisionHistory: GoldenRevisionEntry[]');

// Remove level2 from GoldenCase
types = types.replace(
    /  \/\*\*\n   \* Level 2: LLM response\.\n   \* @future — null in v0\.[\s\S]*?level2: (GoldenResponseSnapshot \| null)\n\n/,
    ''
);

// Remove .golden from file comment
types = types.replace('.golden.json', '.json');

// Check: no remaining references to removed types
const remaining = (types.match(/GoldenResponseSnapshot/g) || []).length;
if (remaining > 0) {
  console.log(`   WARNING: ${remaining} GoldenResponseSnapshot references remain`);
}
const remainingLevel2 = (types.match(/\blevel2\b/g) || []).length;
if (remainingLevel2 > 0) {
  console.log(`   WARNING: ${remainingLevel2} level2 references remain`);
}

fs.writeFileSync(typesPath, types, 'utf8');
console.log('2. types.ts updated');

// ── 3. index.ts ──
const indexPath = 'src/main/reasoning/golden/index.ts';
const indexContent = `export type {
  GoldenCase,
  GoldenDirectiveSnapshot,
  GoldenRevisionEntry,
  GoldenSchemaVersion,
} from './types'
`;
fs.writeFileSync(indexPath, indexContent, 'utf8');
console.log('3. index.ts updated');

// ── 4. Migrate 44 JSON files ──
const files = walk(goldenDir);

// Snapshot content before migration
const before = {};
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const data = JSON.parse(raw);
  before[f] = JSON.stringify(data.level1);
}

// Migrate
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (data.changelog) { data.revisionHistory = data.changelog; delete data.changelog; }
  delete data.level2;
  const ordered = [];
  for (const key of ['caseId', 'caseRef', 'level1', 'revisionHistory', 'createdAt', 'updatedAt']) {
    if (key in data) ordered.push([key, data[key]]);
  }
  fs.writeFileSync(f, JSON.stringify(Object.fromEntries(ordered), null, 2) + '\n', 'utf8');
}
console.log('4. ' + files.length + ' golden files migrated');

// Verify content preserved
let changed = false;
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  const after = JSON.stringify(data.level1);
  if (after !== before[f]) { console.log('   CONTENT CHANGED: ' + f); changed = true; }
}
if (changed) { console.log('   ERROR: directive content changed!'); process.exit(1); }
console.log('   All directive content preserved');

// Verify schema
const schemaData = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const req = new Set(schemaData.required);
let passed = 0, failed = 0;
for (const f of files) {
  const errs = [];
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { errs.push('parse'); }
  if (d) {
    for (const r of req) { if (!(r in d)) errs.push('missing:' + r); }
    if ('changelog' in d) errs.push('has-changelog');
    if ('level2' in d) errs.push('has-level2');
    const rh = d.revisionHistory;
    if (!Array.isArray(rh) || rh.length === 0) errs.push('empty-revisionHistory');
  }
  if (errs.length) { failed++; console.log('   FAIL: ' + f + ' -> ' + errs.join(', ')); }
  else passed++;
}
if (failed > 0) { console.log('Schema: ' + passed + ' passed, ' + failed + ' FAILED'); process.exit(1); }
console.log('5. Schema: ' + passed + ' passed, ' + failed + ' failed');

console.log('\n=== Migration Complete ===');
