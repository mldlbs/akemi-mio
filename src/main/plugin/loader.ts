import { pathToFileURL } from 'url'
import { watch, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { Plugin } from './types'
import { toolRegistry, ToolRegistration, expandPermissions } from './registry'
import { builtinPlugins } from './builtin'
import { createPluginAPI } from './context'
import { verifyPlugin } from './verifier'
import { eventBus } from '../core/EventBus'
import { log } from '../logger/Logger'
import { pluginHealthGuard } from './PluginHealthGuard'

export class PluginLoader {
  private pluginsDir: string
  private loaded = new Map<string, Plugin>()
  private watcher: ReturnType<typeof watch> | null = null

  constructor() {
    const userData = app.getPath('userData')
    this.pluginsDir = join(userData, 'plugins')
    if (!existsSync(this.pluginsDir)) {
      mkdirSync(this.pluginsDir, { recursive: true })
    }
  }

  getLoadedPlugins(): string[] {
    return Array.from(this.loaded.keys())
  }

  async loadAll(): Promise<void> {
    for (const plugin of builtinPlugins) {
      await this.loadPlugin(plugin)
    }

    const entries = readdirSync(this.pluginsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.plugin.js'))) {
        try {
          const pluginPath = join(this.pluginsDir, entry.name)
          if (!verifyPlugin(pluginPath, entry.name)) continue
          const pluginModule = await import(pathToFileURL(pluginPath).href)
          const plugin: Plugin = pluginModule.default || pluginModule
          if (plugin && plugin.manifest && typeof plugin.handle === 'function') {
            await this.loadPlugin(plugin)
          }
        } catch (err) {
          log('WARN', 'plugin_load_failed', { path: entry.name, error: String(err) })
          pluginHealthGuard.reportFailure(entry.name, String(err), 'load_file')
          eventBus.emit('plugin.error', { name: entry.name, error: String(err), phase: 'load_file' })
        }
      }
    }
  }

  private async loadPlugin(plugin: Plugin): Promise<void> {
    const { name, version } = plugin.manifest

    if (this.loaded.has(name)) return

    // === 免疫检查: 抗原检测 ===
    const antigenCheck = pluginHealthGuard.checkAntigen(name)
    if (!antigenCheck.allowed) {
      log('WARN', 'plugin_blocked_by_immune', { name, reason: antigenCheck.reason })
      eventBus.emit('plugin.error', { name, error: antigenCheck.reason ?? 'Blocked by immune system', phase: 'immune_check' })
      return
    }

    const api = createPluginAPI(name)
    const pluginPermissions = expandPermissions(plugin.manifest.permissions || [])

    let toolCount = 0
    for (const schema of plugin.tools) {
      // === 工具 handler 包装: 适应度追踪 ===
      const rawHandler = (args: Record<string, any>) => plugin.handle(schema.name, args)
      const wrappedHandler = async (args: Record<string, any>): Promise<string> => {
        try {
          const result = await rawHandler(args)
          pluginHealthGuard.reportSuccess(name)
          return result
        } catch (err) {
          pluginHealthGuard.recordCallResult(name, false)
          throw err
        }
      }

      const registration: ToolRegistration = {
        ...schema,
        handler: wrappedHandler,
        pluginName: name,
        requiredPermissions: pluginPermissions,
      }
      toolRegistry.register(registration)
      toolCount++
    }

    if (plugin.onLoad) {
      try {
        await plugin.onLoad(api)
      } catch (err) {
        log('WARN', 'plugin_onload_failed', { name, error: String(err) })
        pluginHealthGuard.reportFailure(name, String(err), 'onLoad')
        eventBus.emit('plugin.error', { name, error: String(err), phase: 'onLoad' })
        // onLoad 失败不阻止注册，但标记为 degraded
      }
    }

    // === 注册细胞 (免疫记忆) ===
    const previous = this.loaded.get(name)
    pluginHealthGuard.registerCell(name, version, previous?.manifest?.version)

    this.loaded.set(name, plugin)
    eventBus.emit('plugin.registered', {
      name,
      version,
      toolCount,
    })
  }

  async unload(name: string): Promise<boolean> {
    const plugin = this.loaded.get(name)
    if (!plugin) return false

    try {
      plugin.onUnload?.()
    } catch (err) {
      log('WARN', 'plugin_onunload_failed', { name, error: String(err) })
    }

    toolRegistry.unregisterAll(name)
    this.loaded.delete(name)
    eventBus.emit('plugin.unregistered', { name })
    return true
  }

  unloadAll(): void {
    const names = Array.from(this.loaded.keys())
    for (const name of names) {
      this.unload(name)
    }
  }

  startWatching(): void {
    this.watcher = watch(this.pluginsDir, async (eventType, filename) => {
      if (!filename || !filename.endsWith('.js')) return

      if (eventType === 'rename') {
        const pluginPath = join(this.pluginsDir, filename)
        if (existsSync(pluginPath) && !Array.from(this.loaded.keys()).some((k) => k === filename)) {
          try {
            // === 免疫检查: 新文件尝试加载时验证 ===
            if (!verifyPlugin(pluginPath, filename)) {
              pluginHealthGuard.reportFailure(filename, '簽名驗證失敗，非信任插件', 'verify')
              return
            }
            const pluginModule = await import(pathToFileURL(pluginPath).href)
            const plugin: Plugin = pluginModule.default || pluginModule
            if (plugin && plugin.manifest && typeof plugin.handle === 'function') {
              await this.loadPlugin(plugin)
            }
          } catch (err) {
            log('WARN', 'plugin_hot_load_failed', { path: filename, error: String(err) })
            pluginHealthGuard.reportFailure(filename, String(err), 'hot_load')
            eventBus.emit('plugin.error', { name: filename, error: String(err), phase: 'hot_load' })
          }
        }
        return
      }

      if (eventType === 'change') {
        const existing = Array.from(this.loaded.entries()).find(([_, p]) => p.manifest.name === filename)
        const oldVersion = existing?.[1]?.manifest?.version

        if (existing) {
          await this.unload(existing[0])
        }
        try {
          const pluginPath = join(this.pluginsDir, filename)
          if (!existsSync(pluginPath)) return

          // === 进化论: 突变风险评估 ===
          if (existing && oldVersion) {
            const mutationRisk = pluginHealthGuard.trackMutation(filename, 'unknown', oldVersion)
            if (mutationRisk.risky) {
              log('WARN', 'plugin_risky_mutation', { name: filename, warning: mutationRisk.warning })
            }
          }

          const pluginUrl = pathToFileURL(pluginPath).href + '?t=' + Date.now()
          const pluginModule = await import(pluginUrl)
          const plugin: Plugin = pluginModule.default || pluginModule
          if (plugin && plugin.manifest && typeof plugin.handle === 'function') {
            await this.loadPlugin(plugin)
          }
        } catch (err) {
          log('WARN', 'plugin_reload_failed', { path: filename, error: String(err) })
          pluginHealthGuard.reportFailure(filename, String(err), 'hot_reload')
          eventBus.emit('plugin.error', { name: filename, error: String(err), phase: 'hot_reload' })
        }
      }
    })
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }
}
