// Run TypeScript check programmatically
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const program = ts.createProgram(['src/main/asr/multipath/types.ts', 'src/main/asr/multipath/DecoderInstance.ts', 'src/main/asr/multipath/FusionEngine.ts', 'src/main/asr/multipath/MultiPathDecoderManager.ts', 'src/main/asr/multipath/index.ts', 'src/main/asr/AsrService.ts'], {
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  allowSyntheticDefaultImports: true,
});

const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length === 0) {
  console.log('✅ No TypeScript errors found.');
} else {
  for (const d of diagnostics) {
    const file = d.file ? d.file.fileName : 'unknown';
    const pos = d.file ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, char: 0 };
    console.log(`❌ ${file}(${pos.line + 1},${pos.char + 1}): ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
  }
}
