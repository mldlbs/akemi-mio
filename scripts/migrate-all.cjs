const fs = require('fs');
const path = require('path');

// 1. golden-schema.json
const s = JSON.parse(fs.readFileSync('docs/golden/golden-schema.json', 'utf8'));
s.required = ['caseId', 'caseRef', 'level1', 'revisionHistory', 'createdAt', 'updatedAt'];
delete s.properties.level2;
const cl = s.properties.changelog;
delete s.properties.changelog;
s.properties.revisionHistory = cl;
fs.writeFileSync('docs/golden/golden-schema.json', JSON.stringify(s, null, 2) + '\n', 'utf8');
console.log('1. golden-schema.json OK');

// 2. types.ts
const typesPath = 'src/main/reasoning/golden/types.ts';
const types = [
'/**',
' * Golden Schema - M4.3 Frozen Data Contract',
' *',
' * Level 1-only design (v0.1): deterministic ReasoningDirective snapshot - exact match.',
' * Level 2 is reserved for future use and is NOT part of v0.1.',
' *',
' * Invariants:',
' *  1. GoldenCase is a snapshot. Updates produce new version entries.',
' *  2. One active GoldenCase per BenchmarkCase at any point in time.',
' *  3. Level 1 diff = failure. Level 2 governed by future RegressionPolicy.',
' *  4. All revisionHistory entries must carry a human-readable reason.',
' */',
'',
"import type { ReasoningDirective, BenchmarkCaseId } from '../types'",
'',
'/** Schema version. Incremented when the shape of GoldenCase changes. */',
"export type GoldenSchemaVersion = '0.1'",
'',
'/** Level 1 - the expected ReasoningDirective for a given input. */',
'export interface GoldenDirectiveSnapshot {',
'  schemaVersion: GoldenSchemaVersion',
'  directive: ReasoningDirective',
'}',
'',
'/** One atomic revision entry. Every update appends, never in-place overwrite. */',
'export interface GoldenRevisionEntry {',
'  date: string',
'  reason: string',
'  author: string',
"  level: 'l1' | 'l2'",
'  previousDirectiveHash?: string',
'}',
'',
'/**',
' * Complete golden record for one benchmark case.',
' * Stored as one JSON file per case: {caseId}.json',
' */',
'export interface GoldenCase {',
'  /** Benchmark case identifier, e.g. "Q01", "D-D05" */',
'  caseId: BenchmarkCaseId',
'  /** Snapshot of the benchmark input (decoupled from benchmark markdown) */',
'  caseRef: { text: string; expectations: string[] }',
'  /** Level 1: deterministic ReasoningDirective. Implemented in v0.1. */',
'  level1: GoldenDirectiveSnapshot',
'  /** Append-only revision log. Length = version number. */',
'  revisionHistory: GoldenRevisionEntry[]',
'  createdAt: string',
'  updatedAt: string',
'}',
''
].join('\n');
fs.writeFileSync(typesPath, types, 'utf8');
console.log('2. types.ts OK');

// 3. index.ts
fs.writeFileSync(
  'src/main/reasoning/golden/index.ts',
  "export type {\n  GoldenCase,\n  GoldenDirectiveSnapshot,\n  GoldenRevisionEntry,\n  GoldenSchemaVersion,\n} from './types'\n",
  'utf8'
);
console.log('3. index.ts OK');

// 4. Migrate golden JSON files
function walk(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) files.push(...walk(path.join(dir, e.name)));
    else if (e.name.endsWith('.json') && e.name !== 'golden-schema.json' && e.name !== 'manifest.json')
      files.push(path.join(dir, e.name));
  }
  return files;
}

const files = walk('docs/golden');
const before = {};
for (const f of files) {
  before[f] = JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8')).level1);
}
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (d.changelog) { d.revisionHistory = d.changelog; delete d.changelog; }
  delete d.level2;
  const o = {};
  for (const k of ['caseId','caseRef','level1','revisionHistory','createdAt','updatedAt']) {
    if (k in d) o[k] = d[k];
  }
  fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n', 'utf8');
}
// Verify
let ok = 0;
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (JSON.stringify(d.level1) !== before[f]) { console.log('CONTENT CHANGED: ' + f); process.exit(1); }
  if (d.changelog) { console.log('STILL HAS changelog: ' + f); process.exit(1); }
  if ('level2' in d) { console.log('STILL HAS level2: ' + f); process.exit(1); }
  ok++;
}
console.log('4. ' + ok + ' golden JSON files OK');

console.log('\nMigration complete');
