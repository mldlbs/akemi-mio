/**
 * SpeechPluginRegistry — 语音插件运行时加载器（ServiceLoader 模式）
 *
 * 职责：
 *   1. 维护 AsrPlugin / TtsPlugin 注册表
 *   2. 提供按能力（capability）发现插件的查询接口
 *   3. 管理插件的生命周期（initialize / onUnload）
 *
 * 设计意图：
 *   - 单例，全局唯一
 *   - 插件注册后由 registry 统一管理，AsrService / TtsService 不直接持有插件引用
 *   - 新增引擎只需注册对应插件，无需修改核心服务
 *
 * 使用方式：
 *   const registry = SpeechPluginRegistry.getInstance()
 *   registry.registerAsr(new WhisperGpuAsrPlugin(gpuEngine))
 *   registry.registerTts(new PiperTtsPlugin())
 *   await registry.loadAll()
 *   const asrPlugins = registry.getAsrPlugins()
 *   const ttsPlugins = registry.getTtsPlugins()
 *
 * 统一抽象层（src/main/plugin/registry/）：
 *   本类通过 .asr / .tts 属性暴露 IPluginRegistry 接口，
 *   调用方可通过统一接口操作用户语音插件，无需区分 ASR/TTS 具体类型。
 *
 *   示例：
 *     const registry = SpeechPluginRegistry.getInstance()
 *     // 通过统一接口操作 ASR 插件
 *     const asrRegistry = registry.asr
 *     asrRegistry.register(whisperPlugin)
 *     console.log(asrRegistry.count)
 *
 * 对照 EvolutionPlugin 的 PluginServiceLoader，本类使用相同的 ServiceLoader 模式，
 * 但独立演化，专注于语音领域。
 */

import { log } from '../logger/Logger'
import type {
  AsrPlugin,
  TtsPlugin,
  SpeechPluginManifest,
} from './types'
import type { IPluginRegistry } from '../plugin/registry/types'

// ════════════════════════════════════════════════════════════════
//  内部适配器：将 SpeechPluginRegistry 的 ASR/TTS 子集
//  暴露为 IPluginRegistry 统一接口
//
//  注意：适配器不能直接引用 SpeechPluginRegistry 的 private 字段，
//  因此通过回调闭包间接操作内部状态。
// ════════════════════════════════════════════════════════════════

/**
 * 创建 ASR 插件注册表适配器。
 * 通过闭包引用内部 Map，避免适配器直接访问 private 字段。
 */
function createAsrRegistryAdapter(
  getPlugins: () => AsrPlugin[],
  getPlugin: (name: string) => AsrPlugin | undefined,
  hasPlugin: (name: string) => boolean,
  registerPlugin: (plugin: AsrPlugin) => void,
  unloadPlugin: (name: string) => Promise<boolean>,
  loadAllPlugins: () => Promise<void>,
  unloadAllPlugins: () => Promise<void>,
  clearPlugins: () => void,
): IPluginRegistry<AsrPlugin> {
  return {
    get count(): number {
      return getPlugins().length
    },
    getAll: () => getPlugins(),
    get: (name: string) => getPlugin(name),
    has: (name: string) => hasPlugin(name),
    getStats: () => {
      const plugins = getPlugins().map((p) => p.manifest)
      return { total: plugins.length, plugins }
    },
    register: (plugin: AsrPlugin) => registerPlugin(plugin),
    unregister: (name: string) => {
      unloadPlugin(name).catch((err) => {
        log('WARN', 'asr_registry_adapter_unload_failed', { name, error: String(err) })
      })
      return !hasPlugin(name)
    },
    loadAll: () => loadAllPlugins(),
    unloadAll: () => unloadAllPlugins(),
    clear: () => clearPlugins(),
  }
}

/**
 * 创建 TTS 插件注册表适配器。
 * 通过闭包引用内部 Map，避免适配器直接访问 private 字段。
 */
function createTtsRegistryAdapter(
  getPlugins: () => TtsPlugin[],
  getPlugin: (name: string) => TtsPlugin | undefined,
  hasPlugin: (name: string) => boolean,
  registerPlugin: (plugin: TtsPlugin) => void,
  unloadPlugin: (name: string) => Promise<boolean>,
  loadAllPlugins: () => Promise<void>,
  unloadAllPlugins: () => Promise<void>,
  clearPlugins: () => void,
): IPluginRegistry<TtsPlugin> {
  return {
    get count(): number {
      return getPlugins().length
    },
    getAll: () => getPlugins(),
    get: (name: string) => getPlugin(name),
    has: (name: string) => hasPlugin(name),
    getStats: () => {
      const plugins = getPlugins().map((p) => p.manifest)
      return { total: plugins.length, plugins }
    },
    register: (plugin: TtsPlugin) => registerPlugin(plugin),
    unregister: (name: string) => {
      unloadPlugin(name).catch((err) => {
        log('WARN', 'tts_registry_adapter_unload_failed', { name, error: String(err) })
      })
      return !hasPlugin(name)
    },
    loadAll: () => loadAllPlugins(),
    unloadAll: () => unloadAllPlugins(),
    clear: () => clearPlugins(),
  }
}

// ════════════════════════════════════════════════════════════════
//  SpeechPluginRegistry
// ════════════════════════════════════════════════════════════════

export class SpeechPluginRegistry {
  private static instance: SpeechPluginRegistry

  /** 已注册的 ASR 插件（manifest.name → AsrPlugin） */
  private asrPlugins = new Map<string, AsrPlugin>()

  /** 已注册的 TTS 插件（manifest.name → TtsPlugin） */
  private ttsPlugins = new Map<string, TtsPlugin>()

  /** 是否已执行 loadAll */
  private loaded = false

  /** 懒初始化的 ASR 适配器 */
  private _asrAdapter: IPluginRegistry<AsrPlugin> | null = null
  /** 懒初始化的 TTS 适配器 */
  private _ttsAdapter: IPluginRegistry<TtsPlugin> | null = null

  private constructor() {
    // 单例，不允许外部 new
  }

  static getInstance(): SpeechPluginRegistry {
    if (!SpeechPluginRegistry.instance) {
      SpeechPluginRegistry.instance = new SpeechPluginRegistry()
    }
    return SpeechPluginRegistry.instance
  }

  /**
   * 获取 ASR 插件注册表的统一接口视图。
   * 实现 IPluginRegistry<AsrPlugin>，可通过统一抽象层操作。
   */
  get asr(): IPluginRegistry<AsrPlugin> {
    if (!this._asrAdapter) {
      this._asrAdapter = createAsrRegistryAdapter(
        () => this.getAsrPlugins(),
        (name) => this.getAsrPlugin(name),
        (name) => this.hasAsrPlugin(name),
        (plugin) => this.registerAsr(plugin),
        (name) => this.unloadAsr(name),
        () => this.loadAll(),
        () => this.unloadAll(),
        () => { this.asrPlugins.clear() },
      )
    }
    return this._asrAdapter
  }

  /**
   * 获取 TTS 插件注册表的统一接口视图。
   * 实现 IPluginRegistry<TtsPlugin>，可通过统一抽象层操作。
   */
  get tts(): IPluginRegistry<TtsPlugin> {
    if (!this._ttsAdapter) {
      this._ttsAdapter = createTtsRegistryAdapter(
        () => this.getTtsPlugins(),
        (name) => this.getTtsPlugin(name),
        (name) => this.hasTtsPlugin(name),
        (plugin) => this.registerTts(plugin),
        (name) => this.unloadTts(name),
        () => this.loadAll(),
        () => this.unloadAll(),
        () => { this.ttsPlugins.clear() },
      )
    }
    return this._ttsAdapter
  }

  // ==================== 注册 ====================

  /**
   * 注册一个 ASR 插件。
   * 同名插件只能注册一次，重复注册会打印警告并跳过。
   */
  registerAsr(plugin: AsrPlugin): void {
    const name = plugin.manifest.name
    if (this.asrPlugins.has(name)) {
      log('WARN', 'speech_plugin_asr_already_registered', { name })
      return
    }
    this.asrPlugins.set(name, plugin)
    log('INFO', 'speech_plugin_asr_registered', {
      name,
      version: plugin.manifest.version,
      priority: plugin.manifest.priority ?? 0,
    })
  }

  /**
   * 注册一个 TTS 插件。
   * 同名插件只能注册一次，重复注册会打印警告并跳过。
   */
  registerTts(plugin: TtsPlugin): void {
    const name = plugin.manifest.name
    if (this.ttsPlugins.has(name)) {
      log('WARN', 'speech_plugin_tts_already_registered', { name })
      return
    }
    this.ttsPlugins.set(name, plugin)
    log('INFO', 'speech_plugin_tts_registered', {
      name,
      version: plugin.manifest.version,
      priority: plugin.manifest.priority ?? 0,
    })
  }

  // ==================== 发现 ====================

  /**
   * 获取所有已注册的 ASR 插件，按优先级降序排列。
   */
  getAsrPlugins(): AsrPlugin[] {
    return Array.from(this.asrPlugins.values()).sort(
      (a, b) => (b.manifest.priority ?? 0) - (a.manifest.priority ?? 0),
    )
  }

  /**
   * 获取指定名称的 ASR 插件。
   */
  getAsrPlugin(name: string): AsrPlugin | undefined {
    return this.asrPlugins.get(name)
  }

  /**
   * 获取所有已注册的 TTS 插件，按优先级降序排列。
   */
  getTtsPlugins(): TtsPlugin[] {
    return Array.from(this.ttsPlugins.values()).sort(
      (a, b) => (b.manifest.priority ?? 0) - (a.manifest.priority ?? 0),
    )
  }

  /**
   * 获取指定名称的 TTS 插件。
   */
  getTtsPlugin(name: string): TtsPlugin | undefined {
    return this.ttsPlugins.get(name)
  }

  /**
   * 获取第一个可用的 ASR 插件（loaded = true）。
   * 用于快速获取主引擎。
   */
  getFirstAvailableAsr(): AsrPlugin | undefined {
    return this.getAsrPlugins().find((p) => p.getStatus().loaded)
  }

  /**
   * 获取第一个可用的 TTS 插件。
   */
  getFirstAvailableTts(): TtsPlugin | undefined {
    return this.getTtsPlugins().find((p) => p.getStatus().available)
  }

  /**
   * 检查指定名称的 ASR 插件是否已注册。
   */
  hasAsrPlugin(name: string): boolean {
    return this.asrPlugins.has(name)
  }

  /**
   * 检查指定名称的 TTS 插件是否已注册。
   */
  hasTtsPlugin(name: string): boolean {
    return this.ttsPlugins.has(name)
  }

  /**
   * 获取按能力分类的插件统计信息。
   */
  getStats(): {
    asrCount: number
    ttsCount: number
    asrPlugins: SpeechPluginManifest[]
    ttsPlugins: SpeechPluginManifest[]
  } {
    return {
      asrCount: this.asrPlugins.size,
      ttsCount: this.ttsPlugins.size,
      asrPlugins: Array.from(this.asrPlugins.values()).map((p) => p.manifest),
      ttsPlugins: Array.from(this.ttsPlugins.values()).map((p) => p.manifest),
    }
  }

  // ==================== 生命周期 ====================

  /**
   * 初始化所有已注册的插件。
   * 遍历调用每个插件的 initialize() 钩子。
   * 单个插件初始化失败不影响其他插件。
   */
  async loadAll(): Promise<void> {
    if (this.loaded) {
      log('WARN', 'speech_plugins_already_loaded')
      return
    }

    let asrSuccess = 0
    let asrFail = 0
    let ttsSuccess = 0
    let ttsFail = 0

    // 初始化所有 ASR 插件
    for (const [name, plugin] of this.asrPlugins) {
      if (typeof plugin.initialize === 'function') {
        try {
          await plugin.initialize()
          asrSuccess++
        } catch (err) {
          asrFail++
          log('WARN', 'speech_plugin_asr_init_failed', {
            name,
            error: String(err),
          })
        }
      } else {
        asrSuccess++
      }
    }

    // 初始化所有 TTS 插件
    for (const [name, plugin] of this.ttsPlugins) {
      if (typeof plugin.initialize === 'function') {
        try {
          await plugin.initialize()
          ttsSuccess++
        } catch (err) {
          ttsFail++
          log('WARN', 'speech_plugin_tts_init_failed', {
            name,
            error: String(err),
          })
        }
      } else {
        ttsSuccess++
      }
    }

    this.loaded = true
    log('INFO', 'speech_plugins_loaded', {
      asr: { total: this.asrPlugins.size, success: asrSuccess, failed: asrFail },
      tts: { total: this.ttsPlugins.size, success: ttsSuccess, failed: ttsFail },
    })
  }

  /**
   * 卸载所有插件。
   */
  async unloadAll(): Promise<void> {
    for (const [name, plugin] of this.asrPlugins) {
      try {
        await plugin.onUnload?.()
      } catch (err) {
        log('WARN', 'speech_plugin_asr_unload_failed', {
          name,
          error: String(err),
        })
      }
    }
    for (const [name, plugin] of this.ttsPlugins) {
      try {
        await plugin.onUnload?.()
      } catch (err) {
        log('WARN', 'speech_plugin_tts_unload_failed', {
          name,
          error: String(err),
        })
      }
    }
    this.asrPlugins.clear()
    this.ttsPlugins.clear()
    this.loaded = false
    log('INFO', 'speech_plugins_unloaded')
  }

  /**
   * 卸载指定 ASR 插件。
   */
  async unloadAsr(name: string): Promise<boolean> {
    const plugin = this.asrPlugins.get(name)
    if (!plugin) return false
    try {
      await plugin.onUnload?.()
    } catch (err) {
      log('WARN', 'speech_plugin_asr_unload_failed', {
        name,
        error: String(err),
      })
    }
    this.asrPlugins.delete(name)
    log('INFO', 'speech_plugin_asr_unloaded', { name })
    return true
  }

  /**
   * 卸载指定 TTS 插件。
   */
  async unloadTts(name: string): Promise<boolean> {
    const plugin = this.ttsPlugins.get(name)
    if (!plugin) return false
    try {
      await plugin.onUnload?.()
    } catch (err) {
      log('WARN', 'speech_plugin_tts_unload_failed', {
        name,
        error: String(err),
      })
    }
    this.ttsPlugins.delete(name)
    log('INFO', 'speech_plugin_tts_unloaded', { name })
    return true
  }
}
