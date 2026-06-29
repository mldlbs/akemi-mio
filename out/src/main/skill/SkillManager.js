import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { app } from 'electron';
import { toolRegistry } from '../plugin/registry';
import { eventBus } from '../core/EventBus';
import { log } from '../logger/Logger';
import { SkillMatcher } from './SkillMatcher';
import { skillAgentRegistry } from './SkillAgentRegistry';
const SKILLS_DIR = join(app.getPath('userData'), 'skills');
export class SkillManager {
    constructor() {
        this.promptCache = new Map();
        this.loadedTools = new Set();
        this.skills = new Map();
        this.matcher = new SkillMatcher();
    }
    async initialize() {
        if (!existsSync(SKILLS_DIR)) {
            mkdirSync(SKILLS_DIR, { recursive: true });
            log('INFO', 'skill_manager_ready', { skills: 0 });
            return;
        }
        this.scanDirectory();
        await this.loadEnabled();
        log('INFO', 'skill_manager_ready', { skills: this.skills.size });
    }
    getAllSkills() {
        const list = [];
        for (const [, manifest] of this.skills) {
            list.push({
                manifest,
                enabled: manifest.enabled !== false,
                promptModule: this.promptCache.get(manifest.name) ?? null,
                toolsLoaded: this.loadedTools.has(manifest.name),
            });
        }
        return list;
    }
    /** 返回所有已启用技能的 prompt（全量注入） */
    getEnabledPromptModules() {
        const modules = [];
        for (const [name, manifest] of this.skills) {
            if (manifest.enabled === false)
                continue;
            const cached = this.promptCache.get(name);
            if (cached)
                modules.push(cached);
        }
        return modules;
    }
    /**
     * 根据用户输入返回匹配的已启用技能 prompt（按需注入）
     * 仅返回 knowledge 类型 + 匹配到的技能 prompt
     */
    getMatchedPromptModules(userInput) {
        if (!userInput || this.skills.size === 0)
            return [];
        const allEnabled = Array.from(this.skills.values()).filter((m) => m.enabled !== false);
        const matched = this.matcher.match(userInput, allEnabled);
        if (matched.length === 0)
            return [];
        const modules = [];
        const seen = new Set();
        for (const m of matched) {
            if (seen.has(m.manifest.name))
                continue;
            seen.add(m.manifest.name);
            // knowledge 类型：注入 prompt
            if (m.manifest.type !== 'executor') {
                const cached = this.promptCache.get(m.manifest.name);
                if (cached)
                    modules.push(cached);
            }
        }
        return modules;
    }
    /** 用输入匹配所有已启用技能，返回匹配到的 manifest 列表 */
    matchSkills(input) {
        if (!input || this.skills.size === 0)
            return [];
        const allEnabled = Array.from(this.skills.values()).filter((m) => m.enabled !== false);
        return this.matcher.match(input, allEnabled).map((m) => m.manifest);
    }
    async enableSkill(name) {
        const manifest = this.skills.get(name);
        if (!manifest)
            throw new Error(`技能「${name}」未安装`);
        if (manifest.enabled !== false)
            return `技能「${name}」已经处于启用状态`;
        manifest.enabled = true;
        this.saveManifest(manifest);
        const promptPath = join(SKILLS_DIR, name, 'prompt.md');
        if (existsSync(promptPath))
            this.promptCache.set(name, readFileSync(promptPath, 'utf-8'));
        await this.loadSkillTools(name);
        eventBus.emit('skill.enabled', { name });
        return `技能「${name}」已启用`;
    }
    async disableSkill(name) {
        const manifest = this.skills.get(name);
        if (!manifest)
            throw new Error(`技能「${name}」未安装`);
        if (manifest.enabled === false)
            return `技能「${name}」已经处于禁用状态`;
        manifest.enabled = false;
        this.saveManifest(manifest);
        if (this.loadedTools.has(name)) {
            toolRegistry.unregisterAll(`@skill/${name}`);
            this.loadedTools.delete(name);
            skillAgentRegistry.unregister(name);
        }
        eventBus.emit('skill.disabled', { name });
        return `技能「${name}」已禁用`;
    }
    scanDirectory() {
        const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const dirPath = join(SKILLS_DIR, entry.name);
            const manifestPath = join(dirPath, 'manifest.json');
            let manifest = null;
            if (existsSync(manifestPath)) {
                try {
                    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
                    if (!manifest.name)
                        manifest.name = entry.name;
                }
                catch (err) {
                    log('WARN', 'skill_manifest_parse_failed', { dir: entry.name, error: String(err) });
                }
            }
            // 无 manifest 但存在 SKILL.md → 自动生成 manifest
            const skillMdPath = join(dirPath, 'SKILL.md');
            if (!manifest && existsSync(skillMdPath)) {
                manifest = { name: entry.name, version: '1.0.0', description: '本地技能' };
            }
            if (manifest) {
                this.skills.set(manifest.name, manifest);
            }
        }
    }
    async loadEnabled() {
        for (const [, manifest] of this.skills) {
            if (manifest.enabled === false)
                continue;
            const name = manifest.name;
            const promptPath = join(SKILLS_DIR, name, 'prompt.md');
            const skillMdPath = join(SKILLS_DIR, name, 'SKILL.md');
            const promptFile = existsSync(promptPath) ? promptPath : existsSync(skillMdPath) ? skillMdPath : null;
            if (promptFile)
                this.promptCache.set(name, readFileSync(promptFile, 'utf-8'));
            try {
                await this.loadSkillTools(name);
            }
            catch (err) {
                log('WARN', 'skill_tools_load_failed', { name, error: String(err) });
            }
        }
    }
    saveManifest(manifest) {
        const dir = join(SKILLS_DIR, manifest.name);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    }
    async loadSkillTools(name) {
        if (this.loadedTools.has(name))
            return;
        const toolsPath = join(SKILLS_DIR, name, 'tools.plugin.js');
        if (!existsSync(toolsPath))
            return;
        const pluginUrl = pathToFileURL(toolsPath).href + '?t=' + Date.now();
        const mod = await import(pluginUrl);
        const plugin = mod.default || mod;
        if (!plugin || !plugin.manifest || typeof plugin.handle !== 'function') {
            log('WARN', 'skill_tools_invalid', { name });
            return;
        }
        const pluginName = `@skill/${name}`;
        const toolNames = [];
        for (const schema of plugin.tools) {
            toolRegistry.register({
                name: schema.name,
                description: schema.description,
                parameters: schema.parameters,
                required: schema.required || [],
                handler: (args) => plugin.handle(schema.name, args),
                pluginName,
            });
            toolNames.push(schema.name);
        }
        this.loadedTools.add(name);
        // 有 tools.plugin.js → 自动归类为 executor 并注册到技能 Agent 表
        const manifest = this.skills.get(name);
        if (manifest) {
            manifest.type = 'executor';
            skillAgentRegistry.register(manifest, toolNames, SKILLS_DIR);
        }
        log('INFO', 'skill_tools_loaded', { skill: name, tools: plugin.tools.length });
    }
}
let _skillManager = null;
export function setSkillManager(sm) {
    _skillManager = sm;
}
export function getSkillManager() {
    return _skillManager;
}
