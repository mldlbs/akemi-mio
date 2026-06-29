/**
 * IdentityModule — Agent OS 自模型
 *
 * 功能：
 * - 从 CONSTITUTION.md 冷启动解析核心身份
 * - DB 持久化核心身份、演化特质、增长指标
 * - 每轮引导后更新特质（目标对齐度、工具效率等）
 * - 提供 getFormattedContext() 供 system prompt 注入
 *
 * 设计约束（遵循 GoalEngine 模式）：
 * - 使用 getRawDb() 直接操作 SQLite
 * - 使用 log() 记录关键操作
 * - rowTo* 映射函数放在 IdentitySchema.ts 中
 */
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { log } from '../logger/Logger';
import { getRawDb } from '../db/connection';
import { buildIdentityPrompt } from './prompts';
import { rowToCoreIdentity, rowToEvolvedTrait, rowToGrowthMetrics, DEFAULT_TRAITS, } from './IdentitySchema';
export class IdentityModule {
    constructor() {
        this.core = null;
        this.traits = [];
        this.metrics = null;
    }
    // ───── 初始化 ─────
    /**
     * 从 CONSTITUTION.md 初始化/更新身份。
     * 首次运行：解析文件 → 写入 DB → 加载到内存
     * 后续运行：计算 hash → 比对 DB → 若有变化则重新解析，否则从 DB 直接加载
     */
    async initialize(constitutionPath) {
        try {
            const content = readFileSync(constitutionPath, 'utf-8');
            const hash = this.hashContent(content);
            // 尝试从 DB 加载
            const existing = this.loadFromDb();
            if (existing && existing.constitutionHash === hash) {
                // Hash 一致，说明 CONSTITUTION.md 未变更，直接使用 DB 数据
                this.core = existing;
                this.traits = this.loadTraits();
                this.metrics = this.loadMetrics();
                log('INFO', 'identity_loaded_from_db', {
                    name: this.core.name,
                    traits: this.traits.length,
                    hash: hash.slice(0, 8),
                });
                return;
            }
            // Hash 不一致或首次启动：重新解析
            const parsed = this.parseConstitution(content, hash);
            this.upsertCore(parsed);
            this.upsertMetrics(parsed);
            // 默认 trait 由 migration v15 插入，只加载
            this.traits = this.loadTraits();
            this.core = this.loadFromDb();
            this.metrics = this.loadMetrics();
            log('INFO', 'identity_initialized_from_constitution', {
                name: parsed.name,
                capabilities: parsed.capabilities.length,
                hash: hash.slice(0, 8),
            });
        }
        catch (err) {
            log('ERROR', 'identity_init_failed', { error: String(err) });
            // 兜底：使用默认核心身份（从 DB 或硬编码）
            this.core = this.loadFromDb();
            this.traits = this.loadTraits();
            this.metrics = this.loadMetrics();
        }
    }
    // ───── 公开查询 ─────
    /** 构建可注入 system prompt 的自我认知段落 */
    getFormattedContext() {
        if (!this.core)
            return '';
        return buildIdentityPrompt(this.core, this.metrics ?? this.emptyMetrics(), this.traits);
    }
    getCoreIdentity() {
        return this.core;
    }
    getTraits() {
        return [...this.traits];
    }
    getMetrics() {
        return this.metrics ? { ...this.metrics } : null;
    }
    /** 完整的身份快照（用于外部查询、MetricsCollector、API 暴露） */
    getSnapshot() {
        return {
            core: this.core ? { ...this.core } : null,
            traits: this.traits.map((t) => ({ ...t })),
            metrics: this.metrics ? { ...this.metrics } : null,
        };
    }
    // ───── 特质演化 ─────
    /**
     * 根据本次回合的反馈更新特质。
     * 使用指数移动平均 (EMA) 平滑更新。
     */
    updateTraits(input) {
        const traitIndex = this.traits.findIndex((t) => t.name === this.reasonToTrait(input.reason));
        if (traitIndex < 0)
            return;
        const trait = this.traits[traitIndex];
        const alpha = 0.3; // EMA 系数
        const newValue = trait.value * (1 - alpha) + input.score * alpha;
        const clamped = Math.max(0, Math.min(1, newValue));
        trait.value = Math.round(clamped * 100) / 100;
        trait.sampleCount++;
        trait.updatedAt = Date.now();
        trait.trend = this.computeTrend(trait);
        this.persistTrait(trait);
        log('INFO', 'identity_trait_updated', { name: trait.name, value: trait.value, trend: trait.trend });
    }
    // ───── 会话 / 指标记录 ─────
    /** 记录一次完整会话结束 */
    recordSession(type, averageScore) {
        this.ensureMetricsLoaded();
        if (!this.metrics)
            return;
        this.metrics.sessionsCompleted++;
        this.metrics.avgScore = this.metrics.avgScore * 0.7 + averageScore * 0.3;
        this.metrics.lastUpdated = Date.now();
        this.persistMetrics();
    }
    /** 记录一次工具调用 */
    recordToolCall() {
        this.ensureMetricsLoaded();
        if (!this.metrics)
            return;
        this.metrics.toolsUsed++;
        this.metrics.lastUpdated = Date.now();
        this.persistMetrics();
    }
    /** 记录目标漂移事件 */
    recordGoalDrift() {
        this.ensureMetricsLoaded();
        if (!this.metrics)
            return;
        this.metrics.goalsDrifted++;
        this.metrics.lastUpdated = Date.now();
        this.persistMetrics();
    }
    // ───── 内部方法 ─────
    reasonToTrait(reason) {
        const map = {
            tool_success: 'tool_efficiency',
            tool_failure: 'tool_efficiency',
            goal_drift_positive: 'goal_alignment',
            goal_drift_negative: 'goal_alignment',
            session_positive: 'response_quality',
            session_negative: 'response_quality',
        };
        return map[reason] || 'response_quality';
    }
    computeTrend(trait) {
        if (trait.sampleCount < 5)
            return 'stable';
        if (trait.value > 0.65)
            return 'growing';
        if (trait.value < 0.35)
            return 'declining';
        return 'stable';
    }
    // ───── 文件解析 ─────
    parseConstitution(content, hash) {
        const sections = this.splitSections(content);
        const name = this.parseYamlField(sections.get('Core Identity') || '', 'name') || '秋山澪';
        const role = this.parseYamlField(sections.get('Core Identity') || '', 'role') || 'AI 伙伴';
        const capabilities = this.parseBulletList(sections.get('Capabilities') || '');
        const personality = this.parseBulletList(sections.get('Personality') || '');
        const constraints = this.parseBulletList(sections.get('Constraints') || '');
        return {
            name,
            role,
            constitutionHash: hash,
            personality,
            capabilities,
            constraints,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
    }
    splitSections(content) {
        const sections = new Map();
        let currentSection = '';
        let currentLines = [];
        for (const line of content.split('\n')) {
            const h2Match = line.match(/^##\s+(.+)/);
            if (h2Match) {
                if (currentSection) {
                    sections.set(currentSection, currentLines.join('\n').trim());
                }
                currentSection = h2Match[1].trim();
                currentLines = [];
            }
            else if (currentSection) {
                currentLines.push(line);
            }
        }
        if (currentSection) {
            sections.set(currentSection, currentLines.join('\n').trim());
        }
        return sections;
    }
    parseYamlField(section, field) {
        const re = new RegExp(`^\\s*-\\s*${field}:\\s*(.+)$`, 'm');
        const match = section.match(re);
        return match ? match[1].trim() : null;
    }
    parseBulletList(section) {
        const items = [];
        for (const line of section.split('\n')) {
            const match = line.match(/^\s*-\s*(.+?)(?:\s*—\s*(.+))?$/);
            if (match) {
                items.push(match[1].trim());
            }
        }
        return items;
    }
    hashContent(content) {
        return createHash('sha256').update(content, 'utf-8').digest('hex');
    }
    // ───── DB 操作 ─────
    loadFromDb() {
        try {
            const db = getRawDb();
            const rows = db.exec("SELECT * FROM identity_core WHERE id = 'singleton'");
            if (!rows[0] || !rows[0].values.length)
                return null;
            return rowToCoreIdentity(this.rowToMap(rows[0].columns, rows[0].values[0]));
        }
        catch {
            return null;
        }
    }
    loadTraits() {
        try {
            const db = getRawDb();
            const rows = db.exec('SELECT * FROM identity_traits ORDER BY name');
            if (!rows[0])
                return DEFAULT_TRAITS.map((t) => ({ ...t }));
            return rows[0].values.map((v) => rowToEvolvedTrait(this.rowToMap(rows[0].columns, v)));
        }
        catch {
            return DEFAULT_TRAITS.map((t) => ({ ...t }));
        }
    }
    loadMetrics() {
        try {
            const db = getRawDb();
            const rows = db.exec("SELECT * FROM identity_metrics WHERE id = 'singleton'");
            if (!rows[0] || !rows[0].values.length)
                return null;
            return rowToGrowthMetrics(this.rowToMap(rows[0].columns, rows[0].values[0]));
        }
        catch {
            return null;
        }
    }
    upsertCore(core) {
        const db = getRawDb();
        db.run(`INSERT INTO identity_core (id, constitution_hash, name, role, personality, capabilities, constraints, created_at, updated_at)
       VALUES ('singleton', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         constitution_hash = excluded.constitution_hash,
         name = excluded.name,
         role = excluded.role,
         personality = excluded.personality,
         capabilities = excluded.capabilities,
         constraints = excluded.constraints,
         updated_at = excluded.updated_at`, [
            core.constitutionHash,
            core.name,
            core.role,
            JSON.stringify(core.personality),
            JSON.stringify(core.capabilities),
            JSON.stringify(core.constraints),
            core.createdAt,
            core.updatedAt,
        ]);
    }
    upsertMetrics(core) {
        const db = getRawDb();
        // 仅在 metrics 行不存在时插入
        const existing = db.exec("SELECT id FROM identity_metrics WHERE id = 'singleton'");
        if (existing[0]?.values.length)
            return;
        db.run(`INSERT INTO identity_metrics (id, sessions_completed, tools_used, goals_completed, goals_drifted, avg_score, constitution_checksum, last_updated)
       VALUES ('singleton', 0, 0, 0, 0, 1.0, ?, ?)`, [core.constitutionHash, Date.now()]);
    }
    persistTrait(trait) {
        const db = getRawDb();
        db.run(`INSERT INTO identity_traits (name, value, trend, sample_count, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         value = excluded.value,
         trend = excluded.trend,
         sample_count = excluded.sample_count,
         updated_at = excluded.updated_at`, [trait.name, trait.value, trait.trend, trait.sampleCount, trait.updatedAt]);
    }
    persistMetrics() {
        if (!this.metrics)
            return;
        const db = getRawDb();
        db.run(`UPDATE identity_metrics SET
        sessions_completed = ?, tools_used = ?, goals_completed = ?,
        goals_drifted = ?, avg_score = ?, last_updated = ?
       WHERE id = 'singleton'`, [
            this.metrics.sessionsCompleted,
            this.metrics.toolsUsed,
            this.metrics.goalsCompleted,
            this.metrics.goalsDrifted,
            this.metrics.avgScore,
            this.metrics.lastUpdated,
        ]);
    }
    ensureMetricsLoaded() {
        if (this.metrics)
            return;
        this.metrics = this.loadMetrics() ?? this.emptyMetrics();
    }
    emptyMetrics() {
        return {
            sessionsCompleted: 0,
            toolsUsed: 0,
            goalsCompleted: 0,
            goalsDrifted: 0,
            avgScore: 1.0,
            constitutionChecksum: this.core?.constitutionHash ?? '',
            lastUpdated: Date.now(),
        };
    }
    rowToMap(columns, values) {
        const obj = {};
        for (let i = 0; i < columns.length; i++)
            obj[columns[i]] = values[i];
        return obj;
    }
}
