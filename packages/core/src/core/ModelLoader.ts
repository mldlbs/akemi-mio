import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { env as transformersEnv } from '@xenova/transformers'
import { log } from '@akemi-mio/core/logger/Logger'

/** userData 优先，回退安装目录 */
function resolveFirst(...paths: [string, string]): string {
  return existsSync(paths[0]) ? paths[0] : paths[1]
}

export function loadEnvFile(): void {
  try {
    const envPath = resolveFirst(join(app.getPath('userData'), '.env'), join(app.getAppPath(), '.env'))
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const eq = line.indexOf('=')
        if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
      }
    }
  } catch {
    /* .env optional */
  }
}

export function setupTransformers(): void {
  transformersEnv.useFSCache = true
  const modelsDir = resolveFirst(join(app.getPath('userData'), 'models'), join(app.getAppPath(), 'models'))
  transformersEnv.localModelPath = modelsDir
  transformersEnv.allowRemoteModels = true

  try {
    const onnxBackend = require('@xenova/transformers/src/backends/onnx.js')
    if (onnxBackend.executionProviders) {
      onnxBackend.executionProviders.unshift('dml')
      log('INFO', 'gpu_enable', { provider: 'dml', providers: onnxBackend.executionProviders })
    }
  } catch (err) {
    log('WARN', 'gpu_config_failed', { error: String(err) })
  }
}