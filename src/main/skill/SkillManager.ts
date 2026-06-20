import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { pathToFileURL } from 'url'
import { app } from 'electron'
import { toolRegistry } from '../plugin/registry'
import { Plugin } from '../plugin/types'
import { eventBus } from '../core/EventBus'
import { log } from '../logger/Logger'

export interface SkillManifest {
  name: string
  version: string
  description: string
  author?: string
  triggers?: string[]
  tools?: string[]
  requires?: string[]
  enabled?: boolean
}

export interface InstalledSkill {
  manifest: SkillManifest
  enabled: boolean
  promptModule: string | null
  toolsLoaded: boolean
}

const SKILLS_DIR = join(app.getPath('userData'), 'skills')

export class SkillManager {
  private promptCache = new Map<string, string>()
  private loadedTools = new Set<string>()
  private skills = new Map<string, SkillManifest>()

  async initialize(): Promise<void> {
    if (!existsSync(SKILLS_DIR)) {
      mkdirSync(SKILLS_DIR, { recursive: true })
      log('INFO', 'skill_manager_ready', { skills: 0 })
      return
    }

    this.scanDirectory()
    await this.loadEnabled()
    log('INFO', 'skill_manager_ready', { skills: this.skills.size })
  }

  getAllSkills(): InstalledSkill[] {
    const list: InstalledSkill[] = []
    for (const [, manifest] of this.skills) {
      list.push({
        manifest,
        enabled: manifest.enabled !== false,
        promptModule: this.promptCache.get(manifest.name) ?? null,
        toolsLoaded: this.loadedTools.has(manifest.name),
      })
    }
    return list
  }

  getEnabledPromptModules(): string[] {
    const modules: string[] = []
    for (const [name, manifest] of this.skills) {
      if (manifest.enabled === false) continue
      const cached = this.promptCache.get(name)
      if (cached) modules.push(cached)
    }
    return modules
  }

  async enableSkill(name: string): Promise<string> {
    const manifest = this.skills.get(name)
    if (!manifest) throw new Error(`技能「${name}」未安装`)
    if (manifest.enabled !== false) return `技能「${name}」已经处于启用状态`

    manifest.enabled = true
    this.saveManifest(manifest)

    const promptPath = join(SKILLS_DIR, name, 'prompt.md')
    if (existsSync(promptPath)) this.promptCache.set(name, readFileSync(promptPath, 'utf-8'))

    await this.loadSkillTools(name)
    eventBus.emit('skill.enabled', { name })
    return `技能「${name}」已启用`
  }

  async disableSkill(name: string): Promise<string> {
    const manifest = this.skills.get(name)
    if (!manifest) throw new Error(`技能「${name}」未安装`)
    if (manifest.enabled === false) return `技能「${name}」已经处于禁用状态`

    manifest.enabled = false
    this.saveManifest(manifest)

    if (this.loadedTools.has(name)) {
      toolRegistry.unregisterAll(`@skill/${name}`)
      this.loadedTools.delete(name)
    }

    eventBus.emit('skill.disabled', { name })
    return `技能「${name}」已禁用`
  }

  private scanDirectory(): void {
    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dirPath = join(SKILLS_DIR, entry.name)
      const manifestPath = join(dirPath, 'manifest.json')
      let manifest: SkillManifest | null = null

      if (existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
          if (!manifest.name) manifest.name = entry.name
        } catch (err) {
          log('WARN', 'skill_manifest_parse_failed', { dir: entry.name, error: String(err) })
        }
      }

      // 无 manifest 但存在 SKILL.md → 自动生成 manifest
      const skillMdPath = join(dirPath, 'SKILL.md')
      if (!manifest && existsSync(skillMdPath)) {
        manifest = { name: entry.name, version: '1.0.0', description: '本地技能' }
      }

      if (manifest) {
        this.skills.set(manifest.name, manifest)
      }
    }
  }

  private async loadEnabled(): Promise<void> {
    for (const [, manifest] of this.skills) {
      if (manifest.enabled === false) continue
      const name = manifest.name
      const promptPath = join(SKILLS_DIR, name, 'prompt.md')
      const skillMdPath = join(SKILLS_DIR, name, 'SKILL.md')
      const promptFile = existsSync(promptPath) ? promptPath : existsSync(skillMdPath) ? skillMdPath : null
      if (promptFile) this.promptCache.set(name, readFileSync(promptFile, 'utf-8'))
      try {
        await this.loadSkillTools(name)
      } catch (err) {
        log('WARN', 'skill_tools_load_failed', { name, error: String(err) })
      }
    }
  }

  private saveManifest(manifest: SkillManifest): void {
    const dir = join(SKILLS_DIR, manifest.name)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  }

  private async loadSkillTools(name: string): Promise<void> {
    if (this.loadedTools.has(name)) return
    const toolsPath = join(SKILLS_DIR, name, 'tools.plugin.js')
    if (!existsSync(toolsPath)) return
    const pluginUrl = pathToFileURL(toolsPath).href + '?t=' + Date.now()
    const mod = await import(pluginUrl)
    const plugin: Plugin = mod.default || mod
    if (!plugin || !plugin.manifest || typeof plugin.handle !== 'function') {
      log('WARN', 'skill_tools_invalid', { name })
      return
    }
    const pluginName = `@skill/${name}`
    for (const schema of plugin.tools) {
      toolRegistry.register({
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
        required: schema.required || [],
        handler: (args) => plugin.handle(schema.name, args),
        pluginName,
      })
    }
    this.loadedTools.add(name)
    log('INFO', 'skill_tools_loaded', { skill: name, tools: plugin.tools.length })
  }
}

let _skillManager: SkillManager | null = null

export function setSkillManager(sm: SkillManager | null): void {
  _skillManager = sm
}

export function getSkillManager(): SkillManager | null {
  return _skillManager
}
