import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const workspaceRoot = process.cwd()
const appRuntimePath = join(workspaceRoot, 'packages', 'main', 'src', 'bootstrap', 'AppRuntime.ts')

describe('AppRuntime LLM config source wiring', () => {
  it('uses credentials store for packaged builds and env bootstrap for development', () => {
    const source = readFileSync(appRuntimePath, 'utf8')

    expect(source).toMatch(/if\s*\(\s*app\.isPackaged\s*\)\s*\{/)
    expect(source).toMatch(/else\s+if\s*\(\s*llmKey\s*\)\s*\{/)
    expect(source).toMatch(/llmService\.setConfig\(llmKey,\s*llmCodeKey\s*\|\|\s*llmKey\)/)
    expect(source).toMatch(/llmService\.refreshFromCredentials\(\(key\)\s*=>\s*credentialsManager\.get\(key\)\)/)
  })

  /**
   * 回归：打包版启动卡死。
   *
   * 曾在这里直接写 `logModelConfig(app.isPackaged ? credentialsManager.get('llm_key') : llmKey)`。
   * 打包时这条分支必走，而 DB 要到后面的 `await initDatabase()` 才初始化，
   * credentialsManager.get() → getRawDb() 抛 "Database not initialized"，
   * 整个 start() 被拒绝 —— 进程活着、日志静默、窗口永远不出。
   * dev 下 app.isPackaged 为 false，走不到这条分支，所以只有实跑 exe 才测得出来。
   */
  it('不在 initDatabase() 之前裸读凭据库', () => {
    const source = readFileSync(appRuntimePath, 'utf8')

    // 1. 不能再有把这行当表达式直接传进 logModelConfig 的写法
    expect(source).not.toMatch(
      /logModelConfig\(\s*app\.isPackaged\s*\?\s*credentialsManager\.get/,
    )

    // 2. 早期那次读取必须包在 try/catch 里（DB 未就绪时抛错也要能继续启动）
    const guarded = source.match(
      /try\s*\{[\s\S]{0,200}?credentialsManager\.get\([\s\S]{0,400}?\}\s*catch/,
    )
    expect(guarded).not.toBeNull()

    // 3. logModelConfig 的调用点必须早于 initDatabase（顺序不变，靠容错兜底）
    const idxLogModelConfig = source.indexOf('this.logModelConfig(')
    const idxInitDatabase = source.indexOf('await initDatabase()')
    expect(idxLogModelConfig).toBeGreaterThan(-1)
    expect(idxInitDatabase).toBeGreaterThan(-1)
    expect(idxLogModelConfig).toBeLessThan(idxInitDatabase)
  })
})
