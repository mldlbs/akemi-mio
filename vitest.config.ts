import { defineConfig, type Plugin } from 'vitest/config'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { resolve, relative, isAbsolute } from 'path'

const aliases = {
  '@akemi-mio/audit': resolve(__dirname, './packages/audit/src'),
  '@akemi-mio/anti-mcp': resolve(__dirname, './packages/anti-mcp/src'),
  '@akemi-mio/anti-memory': resolve(__dirname, './packages/anti-memory/src'),
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
  '@akemi-mio/constitution': resolve(__dirname, './packages/evolution/src/constitution'),
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

// ════════════════════════════════════════════════════════════════
// 旧路径垫片（legacy resolver）
//
// 背景：包被拆分过。`GoalGuardrail` 现在住在
// packages/evolution-governance/src/，但源码里仍有大量
// `@akemi-mio/evolution/governance/GoalGuardrail` 这种**拆分前的旧写法**。
// 这些 import 在生产构建里不会暴露（它们不在 entry 构建图上），
// 却让 100+ 个测试文件在 import 阶段直接死掉 —— 测试根本没跑起来。
//
// 迁移规律（已抽样验证 12/12 命中）：
//   @akemi-mio/<group>/<SubDir>/<File> → packages/<group>-<subdir>/src/<File>
//   @akemi-mio/<group>/<File>          → packages/<group>-core/src/<File>
//
// 为什么是"垫片"而不是直接改源码里的 import：
// 那笔迁移涉及几十个文件，且部分文件正被其它会话改动，此刻批量改风险高、
// 也无法在本次任务内验证完。垫片让测试立刻可跑，同时**每条命中都打印告警**，
// 漂移不会被掩盖 —— 真正的修复是照告警把 import 改掉，然后删掉本插件。
// 本插件只存在于 vitest 配置，**不进入生产构建**。
// ════════════════════════════════════════════════════════════════
const legacyHits = new Map<string, string>()

function legacyPackageResolver(): Plugin {
  const groupPkgs = new Map<string, string[]>()
  const packagesFor = (group: string): string[] => {
    const cached = groupPkgs.get(group)
    if (cached) return cached
    const found = readdirSync(packagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(`${group}-`))
      .map((e) => e.name)
    groupPkgs.set(group, found)
    return found
  }
  const resolveFile = (base: string): string | null => {
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (existsSync(cand) && !statSync(cand).isDirectory()) return cand
    }
    return null
  }

  /**
   * 定位旧路径的新家。**规则按置信度从高到低排列，低置信度规则只在
   * 高置信度规则全部落空时才用。**
   *
   * 这个顺序是被 bug 逼出来的：最初一上来就按包名遍历 + 匹配"最后一段文件名"，
   * 结果 `@akemi-mio/evolution/constitution/types` 被解析到了
   * evolution-asr 包的 src/types.ts —— 注意 `types` 这种通用名在
   * 各个 evolution- 前缀的包里有十几份，按字母序先撞上谁就是谁。
   * 这比解析不到更糟：静默指向错误模块，
   * 表现为 `isKernelPath is not a function` 这种完全看不出根因的报错。
   */
  const probe = (group: string, restRaw: string, source: string): string | null => {
    const segs = restRaw.split(/[\\/]/).filter(Boolean)
    if (segs.length === 0) return null

    // 规则 1（精确）：整个子目录被独立成包
    //   @akemi-mio/evolution/goals → packages/evolution-goals/src/index.ts
    if (segs.length === 1) {
      const exact = resolve(packagesDir, `${group}-${segs[0]}`, 'src', 'index.ts')
      if (existsSync(exact)) return record(source, exact, 'exact')
    }

    // 规则 2（精确）：用路径前缀拼出包名，剩下的作为包内路径
    //   evolution/constitution/types → evolution-constitution/src/types
    //   intelligence/memory/MemoryService → intelligence-memory/src/MemoryService
    for (let k = segs.length - 1; k >= 1; k--) {
      const pkgName = `${group}-${segs.slice(0, k).join('-')}`
      const found = resolveFile(resolve(packagesDir, pkgName, 'src', segs.slice(k).join('/')))
      if (found) return record(source, found, 'exact')
    }

    // 规则 3（精确）：没有子目录 → 落在 <group>-core
    //   evolution/SandboxValidator → evolution-core/src/SandboxValidator
    if (segs.length === 1) {
      const found = resolveFile(resolve(packagesDir, `${group}-core`, 'src', segs[0]))
      if (found) return record(source, found, 'exact')
    }

    // 规则 4（低置信度）：同 group 任意包下的同名文件。
    // 只有在**整个 group 内唯一**时才敢用 —— 有歧义就宁可不解析，
    // 让测试明确报"找不到"，也不要猜一个错的。
    const leaf = segs[segs.length - 1]
    const candidates: string[] = []
    for (const pkg of packagesFor(group)) {
      const found = resolveFile(resolve(packagesDir, pkg, 'src', leaf))
      if (found) candidates.push(found)
    }
    if (candidates.length === 1) return record(source, candidates[0], 'fuzzy')
    if (candidates.length > 1) {
      console.warn(
        `[legacy-alias] ${source} 有 ${candidates.length} 个同名候选，拒绝猜测（请显式改 import）`,
      )
    }
    return null
  }

  /** 记录一次兜底命中并首次告警，让漂移可见而不是被静默消化 */
  const record = (source: string, target: string, confidence: 'exact' | 'fuzzy'): string => {
    if (!legacyHits.has(source)) {
      legacyHits.set(source, target)
      const tag = confidence === 'fuzzy' ? '低置信度' : '精确'
      console.warn(
        `[legacy-alias] ${source} -> ${relative(process.cwd(), target)}（${tag}；旧 import，应改为新包路径）`,
      )
    }
    return target
  }

  return {
    name: 'akemi-mio-legacy-package-resolver',
    async resolveId(source, importer) {
      // 注意：alias 是纯字符串前缀替换，不校验目标是否存在。
      // @akemi-mio/evolution/SandboxValidator 会被 alias 替换成
      // packages/evolution/src/SandboxValidator（该文件早已随包拆分搬走），
      // this.resolve 依然返回非 null —— 直接采信就会把这个"存在但打不开"的
      // 路径当结果，兜底逻辑永远没机会跑。所以必须自己验一次存在性。
      let normal: { id: string } | null = null
      try {
        // 只传 skipSelf：透传 options 会带上 Vite 内部字段，在部分版本里会让
        // this.resolve 直接抛错，而插件抛错不会显式报出来 —— 表现为"兜底没生效"。
        normal = await this.resolve(source, importer, { skipSelf: true })
      } catch {
        normal = null
      }
      if (normal && resolveFile(normal.id.split('?')[0])) return normal

      // 情形 A：原始说明符仍是 @akemi-mio/<group>/<rest>
      const m = /^@akemi-mio\/([a-z0-9-]+)\/(.+)$/.exec(source)
      if (m) {
        const hit = probe(m[1], m[2], source)
        if (hit) return hit
      }

      // 情形 B：已被 alias 替换成绝对路径，但目标文件不存在。
      // 这是实际命中的路径 —— Vite 的 alias 插件优先级最高且**不校验目标存在性**，
      // 它把 @akemi-mio/evolution/SandboxValidator 替换成
      // packages/evolution/src/SandboxValidator 后直接返回，后续插件看到的
      // 已经是这个打不开的绝对路径，原始说明符再也看不到了。
      const abs = source.split('?')[0]
      if (isAbsolute(abs) && !resolveFile(abs) && !abs.includes('node_modules')) {
        const mm = /[\\/]packages[\\/]([a-z0-9-]+)[\\/]src[\\/](.+)$/.exec(abs)
        if (mm) {
          const group = mm[1].split('-')[0]
          const hit = probe(group, mm[2], source)
          if (hit) return hit
        }
      }
      return null
    },
  }
}

process.on('exit', () => {
  if (legacyHits.size > 0) {
    console.warn(`[legacy-alias] 共 ${legacyHits.size} 处旧 import 由垫片兜底解析（见上方逐条清单）`)
  }
})

export default defineConfig({
  // MIO_LEGACY_RESOLVER=0 可只保留派生 alias、关掉旧路径垫片
  // （垫片会让此前跑不起来的测试真正运行，若暂时不想看到那些失败就用它）
  plugins: process.env.MIO_LEGACY_RESOLVER === '0' ? [] : [legacyPackageResolver()],
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
