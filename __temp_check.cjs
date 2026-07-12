require('./node_modules/typescript/lib/typescript.js');
const ts = require('typescript');
const program = ts.createProgram(['--noEmit', '-p', 'tsconfig.node.json'], {
  noEmit: true,
  project: 'tsconfig.node.json'
});
const diagnostics = ts.getPreEmitDiagnostics(program);
for (const d of diagnostics) {
  const file = d.file;
  const loc = file ? ts.formatDiagnosticsHost.getCanonicalFileName(file.fileName) : '';
  const { line, character } = file ? file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
  const category = ts.DiagnosticCategory[d.category];
  const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  console.log(`${loc}(${line + 1},${character + 1}): ${category} TS${d.code}: ${message}`);
}
console.log(`\nTotal diagnostics: ${diagnostics.length}`);
process.exit(diagnostics.length > 0 ? 1 : 0);
