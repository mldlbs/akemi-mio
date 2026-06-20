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
          eventBus.emit('plugin.error', { name: entry.name, error: String(err), phase: 'load_file' })
        }
      }
    }
  }

  private async loadPlugin(plugin: Plugin): Promise<void> {
    if (this.loaded.has(plugin.manifest.name)) return

    const api = createPluginAPI(plugin.manifest.name)
    const pluginPermissions = expandPermissions(plugin.manifest.permissions || [])

    let toolCount = 0
    for (const schema of plugin.tools) {
      const registration: ToolRegistration = {
        ...schema,
        handler: (args) => plugin.handle(schema.name, args),
        pluginName: plugin.manifest.name,
        requiredPermissions: pluginPermissions,
      }
      toolRegistry.register(registration)
      toolCount++
    }

    if (plugin.onLoad) {
      try {
        await plugin.onLoad(api)
      } catch (err) {
        log('WARN', 'plugin_onload_failed', { name: plugin.manifest.name, error: String(err) })
        eventBus.emit('plugin.error', { name: plugin.manifest.name, error: String(err), phase: 'onLoad' })
      }
    }

    this.loaded.set(plugin.manifest.name, plugin)
    eventBus.emit('plugin.registered', {
      name: plugin.manifest.name,
      version: plugin.manifest.version,
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
            const pluginModule = await import(pathToFileURL(pluginPath).href)
            const plugin: Plugin = pluginModule.default || pluginModule
            if (plugin && plugin.manifest && typeof plugin.handle === 'function') {
              await this.loadPlugin(plugin)
            }
          } catch (err) {
            log('WARN', 'plugin_hot_load_failed', { path: filename, error: String(err) })
            eventBus.emit('plugin.error', { name: filename, error: String(err), phase: 'hot_load' })
          }
        }
        return
      }

      if (eventType === 'change') {
        const existing = Array.from(this.loaded.entries()).find(([_, p]) => p.manifest.name === filename)
        if (existing) {
          await this.unload(existing[0])
        }
        try {
          const pluginPath = join(this.pluginsDir, filename)
          if (!existsSync(pluginPath)) return
          const pluginUrl = pathToFileURL(pluginPath).href + '?t=' + Date.now()
          const pluginModule = await import(pluginUrl)
          const plugin: Plugin = pluginModule.default || pluginModule
          if (plugin && plugin.manifest && typeof plugin.handle === 'function') {
            await this.loadPlugin(plugin)
          }
        } catch (err) {
          log('WARN', 'plugin_reload_failed', { path: filename, error: String(err) })
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
