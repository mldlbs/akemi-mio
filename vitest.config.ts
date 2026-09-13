import { defineConfig } from 'vitest/config'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'

const aliases = {
  '@akemi-mio/audit': resolve(__dirname, './packages/audit/src'),
  '@akemi-mio/blog': resolve(__dirname, './packages/blog/src'),
  '@akemi-mio/blog-publish': resolve(__dirname, './packages/blog-publish/src'),
  '@akemi-mio/capabilities': resolve(__dirname, './packages/capabilities/src'),
  '@akemi-mio/platform': resolve(__dirname, './packages/platform/src'),
  '@akemi-mio/intelligence': resolve(__dirname, './packages/intelligence/src'),
  '@akemi-mio/core': resolve(__dirname, './packages/core/src'),
  '@akemi-mio/creativity': resolve(__dirname, './packages/creativity/src'),
  '@akemi-mio/audio': resolve(__dirname, './packages/audio/src'),
  '@akemi-mio/evolution': resolve(__dirname, './packages/evolution/src'),
  '@akemi-mio/engine': resolve(__dirname, './packages/engine/src'),
  '@akemi-mio/image': resolve(__dirname, './packages/image/src'),
  '@akemi-mio/main': resolve(__dirname, './packages/main/src'),
  '@akemi-mio/messaging': resolve(__dirname, './packages/messaging/src'),
  '@akemi-mio/monitoring': resolve(__dirname, './packages/monitoring/src'),
  '@akemi-mio/reasoning': resolve(__dirname, './packages/reasoning/src'),
  '@akemi-mio/updater': resolve(__dirname, './packages/updater/src'),
  '@akemi-mio/voicenote': resolve(__dirname, './packages/voicenote/src'),
  '@akemi-mio/asr': resolve(__dirname, './packages/audio/src'),
  '@akemi-mio/agent': resolve(__dirname, './packages/intelligence/src/agent'),
}

// ════════════════════════════════════════════════════════════════
// 补全：从 packages/*/package.json 的 name 派生其余别名
//
// 上面的手写表长期未与 packages/ 同步，漏掉了约 40 个包（evolution-core、
// intelligence-mcp、intelligence-memory、observer、insight……），
// 症状是 102 个测试文件报 `Cannot find package '@akemi-mio/*'`
// —— 注意 node_modules/@akemi-mio 并不存在，这些名字只能靠 alias 解析。
//
// 与 electron.vite.config.ts 的派生保持同构：只为真正有 src/ 的包生成，
// 且**手写表优先**（historical 例外如 @akemi-mio/asr → audio 不能被覆盖）。
// 派生时机在测试启动时，新增包自动生效，不需要再有人记得改这张表。
// ════════════════════════════════════════════════════════════════
const packagesDir = resolve(__dirname, 'packages')
const derived: string[] = []
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue
  const pkgDir = resolve(packagesDir, entry.name)
  const pkgJsonPath = resolve(pkgDir, 'package.json')
  if (!existsSync(pkgJsonPath)) continue
  let name: string | undefined
  try {
    // Windows 编辑器可能写 BOM，JSON.parse 会直接抛
    name = JSON.parse(readFileSync(pkgJsonPath, 'utf-8').replace(/^\uFEFF/, '')).name
  } catch {
    continue
  }
  if (!name || typeof name !== 'string') continue
  const srcDir = resolve(pkgDir, 'src')
  if (!existsSync(srcDir)) continue
  if (name in aliases) continue // 手写表优先
  aliases[name] = srcDir
  derived.push(name)
}

// 悬空守卫：手写表里指向不存在目录的别名，静默指向空气比直接报错更难查
const dangling = Object.entries(aliases).filter(([, target]) => !existsSync(target))
if (dangling.length > 0) {
  console.warn(`[vitest] ${dangling.length} 个悬空 alias: ${dangling.map(([k]) => k).join(', ')}`)
}


export default defineConfig({
  resolve: { alias: aliases },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/main/**/*.test.{ts,js}'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['tests/**', 'packages/*/src/**/*.test.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 30,
        functions: 25,
        branches: 20,
        statements: 30,
      },
    },
  },
})
