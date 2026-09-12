import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { type PluginAPI } from './types'
import { toolRegistry } from './registry'

function getStorageDir(): string {
  const dir = join(app.getPath('userData'), 'plugin-storage')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function getStoragePath(pluginName: string): string {
  const safeName = pluginName.replace(/[^a-zA-Z0-9._@-]/g, '_')
  return join(getStorageDir(), `${safeName}.json`)
}

function loadPersistentStore(pluginName: string): Record<string, any> {
  const path = getStoragePath(pluginName)
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'))
    }
  } catch {
    // 存储文件损坏时重新开始
  }
  return {}
}

function savePersistentStore(pluginName: string, data: Record<string, any>): void {
  try {
    writeFileSync(getStoragePath(pluginName), JSON.stringify(data, null, 2), 'utf-8')
  } catch (err) {
    console.error(`[PluginStorage] 保存 ${pluginName} 存储失败:`, err)
  }
}

export function createPluginAPI(pluginName: string): PluginAPI {
  const persistentData = loadPersistentStore(pluginName)

  // 自动保存：定期 flush，但使用简单的同步保存策略
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      savePersistentStore(pluginName, persistentData)
      saveTimer = null
    }, 2000)
  }

  return {
    getToolRegistry: () => toolRegistry,

    storage: {
      get(key: string): any {
        return persistentData[key]
      },
      set(key: string, value: any): void {
        persistentData[key] = value
        scheduleSave()
      },
      delete(key: string): void {
        delete persistentData[key]
        scheduleSave()
      },
    },

    logger: {
      info(event: string, data?: Record<string, any>): void {
        console.log(JSON.stringify({ level: 'INFO', plugin: pluginName, event, ...data }))
      },
      warn(event: string, data?: Record<string, any>): void {
        console.warn(JSON.stringify({ level: 'WARN', plugin: pluginName, event, ...data }))
      },
      error(event: string, data?: Record<string, any>): void {
        console.error(JSON.stringify({ level: 'ERROR', plugin: pluginName, event, ...data }))
      },
    },

    http: {
      async get(url: string, options?: Record<string, any>): Promise<{ status: number; data: any }> {
        const res = await fetch(url, { method: 'GET', ...options })
        return { status: res.status, data: await res.json() }
      },
      async post(url: string, body: any, options?: Record<string, any>): Promise<{ status: number; data: any }> {
        const res = await fetch(url, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
          ...options,
        })
        return { status: res.status, data: await res.json() }
      },
    },
  }
}
