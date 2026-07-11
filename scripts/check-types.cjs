const ts = require('typescript')
const path = require('path')
const fs = require('fs')

const configPath = path.resolve(__dirname, '..', 'tsconfig.node.json')
const configText = fs.readFileSync(configPath, 'utf-8')
const config = JSON.parse(configText)

const program = ts.createProgram({
  rootNames: ['src/main/learning/HybridTypes.ts', 'src/main/learning/HybridArbitrator.ts', 'src/main/learning/HybridPlanPipeline.ts'],
  options: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: '.',
    paths: {
      '@/*': ['./src/*']
    }
  }
})

const diagnostics = ts.getPreEmitDiagnostics(program)

if (diagnostics.length === 0) {
  console.log('✅ No errors found in hybrid pipeline files')
  process.exit(0)
}

for (const d of diagnostics) {
  const file = d.file ? path.relative(process.cwd(), d.file.fileName) : 'unknown'
  const pos = d.file ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 }
  console.log(`${file}(${pos.line + 1},${pos.character + 1}): ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
}

process.exit(diagnostics.length > 0 ? 1 : 0)
