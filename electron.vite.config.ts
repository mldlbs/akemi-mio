import { existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const packagesDir = resolve(__dirname, 'packages')

// 构建期别名必须与 tsconfig.node.json 的 compilerOptions.paths 保持一致。
// node_modules/@akemi-mio 并不存在（workspace 链接未建立），因此这里是
// @akemi-mio/* 的唯一解析来源 —— 手写列表一旦漏项，构建会直接以
// "Rollup failed to resolve import" 失败。改为从 packages/ 目录派生，杜绝漂移。
//
// 派生规则与 tsconfig.node.json 的 include（packages/*/src/**/*.ts）保持同构：
// 只为真正存在 src/ 的包生成别名。evolution-learning / evolution-safety /
// evolution-scheduler / evolution-strategy / experience-memory / runtime-contracts /
// runtime-foundation 这 7 个包入口是包根 index.js（CJS，由 mio-cli 消费），
// 没有 src/，对 TS 构建贡献 0 个文件，因此不生成别名。
const workspaceAliases: Record<string, string> = {}
const packagesWithoutSrc: string[] = []
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  if (entry.name.startsWith('.')) continue
  // mio-cli 是独立 CLI，包名为 mio-agent-runtime，不参与 @akemi-mio/* 命名空间
  if (entry.name === 'mio-cli') continue
  const srcDir = resolve(packagesDir, entry.name, 'src')
  if (!existsSync(srcDir)) {
    packagesWithoutSrc.push(entry.name)
    continue
  }
  workspaceAliases[`@akemi-mio/${entry.name}`] = srcDir
}

const aliases: Record<string, string> = {
  ...workspaceAliases,
  // 没有对应的 packages/<name> 目录，属于包内子目录别名，故手动补充
  '@akemi-mio/agent': resolve(packagesDir, 'intelligence/src/agent'),
}

// 说明性输出：显式列出未生成别名的包，避免"以为覆盖了其实没有"。
// 这些包若被构建图引用，Rollup 会直接报 unresolved import —— 比别名静默指向
// 空目录更早、更清楚地暴露问题。
if (packagesWithoutSrc.length > 0) {
  console.warn(
    `[akemi-mio] ${packagesWithoutSrc.length} 个包无 src/，未生成 alias: ${packagesWithoutSrc.join(', ')}`,
  )
}

// 悬空别名守卫：目标目录不存在时立即告警。
// 历史踩坑：@akemi-mio/constitution、@akemi-mio/intelligence/shared 曾长期指向
// 不存在的目录，直到做路径审计才发现。让漂移在构建时就可见。
for (const [key, target] of Object.entries(aliases)) {
  if (!existsSync(target)) {
    console.warn(`[akemi-mio] 悬空 alias: ${key} -> ${target} (目录不存在)`)
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: aliases },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'packages/main/src/index.ts'),
          'workers/memory-indexer-worker': resolve(__dirname, 'packages/core/src/core/workers/memory-indexer-worker.ts'),
          'workers/verification-worker': resolve(__dirname, 'packages/core/src/core/workers/verification-worker.ts'),
          'workers/observer-worker': resolve(__dirname, 'packages/core/src/core/workers/observer-worker.ts'),
        },
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: aliases },
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          agent: resolve(__dirname, 'src/renderer/agent.html'),
        },
      },
    },
    plugins: [react()],
  },
})
