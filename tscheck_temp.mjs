// Quick type check for modified files
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const files = [
  'src/main/plugin/registry/types.ts',
  'src/main/wallpaper/plugin/types.ts',
  'src/main/wallpaper/plugin/WallpaperPluginRegistry.ts',
  'src/main/wallpaper/plugin/UserBehaviorPluginAdapter.ts',
  'src/main/agent/wallpaper/plugins/SleepCyclePlugin.ts',
  'src/main/agent/wallpaper/plugins/ContentClassifierPlugin.ts',
];

const program = ts.createProgram(files, {
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  allowSyntheticDefaultImports: true,
  baseUrl: '.',
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
