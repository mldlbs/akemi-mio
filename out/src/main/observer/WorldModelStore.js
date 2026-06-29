import { log } from '../logger/Logger';
/**
 * WorldModelStore — 世界模型 / 记忆图谱（增强版）
 *
 * 升级点：
 * - 新增 uncertainties 跟踪（来自 conflict 分析中的不确定性）
 * - 新增 relations 显式实体关系图
 * - conflict 分析输出映射为 uncertainties + relations
 */
export class WorldModelStore {
    constructor(llm, store) {
        this.llm = llm;
        this.storeRef = store;
    }
    async update(result, insight) {
        const snapshot = this.storeRef.readWorldModel();
        const { entities, events, trends, narratives } = snapshot;
        const uncertainties = snapshot.uncertainties ?? [];
        const relations = snapshot.relations ?? [];
        // 1. 实体提取
        const newEntities = await this.extractEntities(result);
        for (const ne of newEntities) {
            const existing = entities.find((e) => e.name === ne.name || e.aliases.includes(ne.name));
            if (existing) {
                existing.lastSeen = new Date().toISOString();
                existing.occurrences++;
                for (const a of ne.aliases) {
                    if (!existing.aliases.includes(a))
                        existing.aliases.push(a);
                }
            }
            else {
                entities.push(ne);
            }
        }
        // 2. 事件记录
        const event = {
            id: `evt_${Date.now()}`,
            title: insight.topic,
            entityIds: newEntities.map((e) => e.id),
            timestamp: new Date().toISOString(),
            summary: result.facts.slice(0, 3).join('；') || insight.topic,
            significance: insight.metadata.confidence,
        };
        events.push(event);
        // 3. 趋势更新
        this.updateTrends(trends, event, newEntities);
        // 4. 叙事更新
        await this.updateNarratives(narratives, event, entities, result);
        // 5. 不确定性提取
        this.extractUncertainties(result, uncertainties);
        // 6. 实体关系提取
        this.extractRelations(result, relations, newEntities, entities);
        this.storeRef.saveWorldModel({ entities, events, trends, narratives, uncertainties, relations });
        log('INFO', 'world_model_updated', {
            entities: entities.length,
            events: events.length,
            trends: trends.length,
            narratives: narratives.length,
            uncertainties: uncertainties.length,
            relations: relations.length,
        });
    }
    // ── private ──────────────────────────────────────────────
    async extractEntities(result) {
        const text = [
            ...result.facts.slice(0, 10),
            ...result.perspectives.map((p) => p.viewpoint),
            ...result.conflicts.map((c) => `${c.partyA}, ${c.partyB}`),
        ].join('\n');
        if (!text.trim())
            return [];
        const prompt = `从以下文本中提取重要实体（人物、组织、概念、技术等）。每个实体给出名称和类型。

文本：
${text}

只输出 JSON 数组：
[{"name": "xxx", "type": "person|organization|concept|event|technology", "aliases": ["别名1"]}]`;
        const result_ = await this.llm.generateJson(prompt, {
            temperature: 0.1,
            maxTokens: 2048,
        });
        if (result_.error || !result_.data)
            return [];
        const now = new Date().toISOString();
        return result_.data
            .filter((e) => e.name && e.name.length > 1)
            .map((e) => ({
            id: `ent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: e.name.trim(),
            type: e.type || 'concept',
            firstSeen: now,
            lastSeen: now,
            occurrences: 1,
            aliases: e.aliases ?? [],
            properties: {},
        }));
    }
    updateTrends(trends, event, newEntities) {
        for (const entity of newEntities) {
            const existing = trends.find((t) => t.name === entity.name);
            if (existing) {
                existing.momentum = parseFloat((existing.momentum * 0.7 + 0.5 * 0.3).toFixed(3));
                existing.direction = existing.momentum > 0.6 ? 'rising' : existing.momentum < 0.3 ? 'falling' : 'stable';
                if (!existing.relatedEventIds.includes(event.id))
                    existing.relatedEventIds.push(event.id);
                if (!existing.relatedEntityIds.includes(entity.id))
                    existing.relatedEntityIds.push(entity.id);
            }
            else {
                trends.push({
                    id: `tr_${Date.now()}`,
                    name: entity.name,
                    direction: 'rising',
                    momentum: 0.5,
                    relatedEventIds: [event.id],
                    relatedEntityIds: [entity.id],
                });
            }
        }
        const hitNames = new Set(newEntities.map((e) => e.name));
        for (const t of trends) {
            if (!hitNames.has(t.name)) {
                t.momentum = parseFloat(Math.max(0, t.momentum - 0.05).toFixed(3));
                t.direction = t.momentum > 0.6 ? 'rising' : t.momentum < 0.3 ? 'falling' : 'stable';
            }
        }
        const alive = trends.filter((t) => t.momentum > 0);
        trends.length = 0;
        trends.push(...alive);
    }
    async updateNarratives(narratives, event, entities, result) {
        if (narratives.length === 0) {
            narratives.push(this.createNarrative(event, entities, result));
            return;
        }
        const desc = narratives.map((n) => `叙事「${n.title}」: ${n.eventIds.length} 个事件，置信度 ${n.confidence}`).join('\n');
        const prompt = `新事件：「${event.title}」

已有叙事：
${desc}

这个事件应该归入哪个已有叙事？输出叙事标题（精确匹配），都不适合输出 "NEW"。只输出一个名字。`;
        const result_ = await this.llm.generate(prompt, { temperature: 0.1, maxTokens: 256 });
        const matchedTitle = result_.data?.trim();
        if (matchedTitle && matchedTitle !== 'NEW') {
            const narrative = narratives.find((n) => n.title === matchedTitle);
            if (narrative) {
                if (!narrative.eventIds.includes(event.id))
                    narrative.eventIds.push(event.id);
                for (const e of entities) {
                    if (!narrative.entityIds.includes(e.id))
                        narrative.entityIds.push(e.id);
                }
                narrative.confidence = parseFloat(Math.min(0.95, narrative.confidence + 0.05).toFixed(2));
                narrative.lastUpdated = new Date().toISOString();
                narrative.evolution.push({ at: new Date().toISOString(), summary: `新事件: ${event.title}` });
                return;
            }
        }
        narratives.push(this.createNarrative(event, entities, result));
    }
    createNarrative(event, entities, result) {
        return {
            id: `narr_${Date.now()}`,
            title: event.title,
            eventIds: [event.id],
            entityIds: entities.map((e) => e.id),
            confidence: 0.3,
            lastUpdated: new Date().toISOString(),
            evolution: [{ at: new Date().toISOString(), summary: result.facts.slice(0, 2).join('；') || event.title }],
        };
    }
    extractUncertainties(result, uncertainties) {
        for (const conflict of result.conflicts) {
            if (conflict.evidence.includes('不确定') || conflict.evidence.includes('可能') || conflict.evidence.includes('未经证实')) {
                uncertainties.push({
                    id: `unc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    topic: `${conflict.partyA} vs ${conflict.partyB}`,
                    description: conflict.nature,
                    confidence: 0.3,
                    source: 'conflict_analysis',
                    createdAt: new Date().toISOString(),
                });
            }
        }
        const recent = uncertainties.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 50);
        uncertainties.length = 0;
        uncertainties.push(...recent);
    }
    extractRelations(result, relations, newEntities, allEntities) {
        for (const link of result.causalLinks) {
            const fromEntity = newEntities.find((e) => link.cause.includes(e.name)) ?? allEntities.find((e) => link.cause.includes(e.name));
            const toEntity = newEntities.find((e) => link.effect.includes(e.name)) ?? allEntities.find((e) => link.effect.includes(e.name));
            if (fromEntity && toEntity && fromEntity.id !== toEntity.id) {
                relations.push({ from: fromEntity.id, to: toEntity.id, type: 'causes', weight: link.confidence });
            }
        }
        for (const conflict of result.conflicts) {
            const entityA = newEntities.find((e) => conflict.partyA.includes(e.name));
            const entityB = newEntities.find((e) => conflict.partyB.includes(e.name));
            if (entityA && entityB) {
                relations.push({ from: entityA.id, to: entityB.id, type: 'conflict', weight: 0.7 });
            }
        }
        const seen = new Set();
        const unique = relations.filter((r) => {
            const key = `${r.from}:${r.to}:${r.type}`;
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
        relations.length = 0;
        relations.push(...unique);
    }
}
