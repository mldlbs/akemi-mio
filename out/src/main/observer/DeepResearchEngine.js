import { log } from '../logger/Logger';
const PHASE_ORDER = ['expansion', 'structural_modeling', 'conflict_analysis'];
/**
 * DeepResearchEngine — 三阶段深度研究（带分层 fallback）
 *
 * 升级点：
 * - 每阶段失败后自动降级（reduce_depth）
 * - Level 0: 完整三阶段
 * - Level 1: expansion + conflict（跳过 structural）
 * - Level 2: 仅 expansion
 * - Level 3: LLM 直接生成 summary
 */
export class DeepResearchEngine {
    constructor(llm, store) {
        this.llm = llm;
        this.store = store;
    }
    async research(topic, relatedObs) {
        const topicId = `research_${Date.now()}`;
        const obsText = relatedObs.slice(0, 30).join('\n');
        const phases = [];
        // Phase 1: Expansion
        log('INFO', 'research_phase_start', { phase: 'expansion', topic: topic.topic });
        phases.push({ phase: 'expansion', startedAt: new Date().toISOString() });
        const expanded = await this.runPhase('expansion', topic.topic, obsText);
        const p1 = phases[0];
        if (expanded) {
            p1.completedAt = new Date().toISOString();
            p1.output = expanded;
        }
        else {
            p1.error = 'LLM returned empty';
        }
        // Phase 2: Structural Modeling (fallback-able)
        log('INFO', 'research_phase_start', { phase: 'structural_modeling', topic: topic.topic });
        phases.push({ phase: 'structural_modeling', startedAt: new Date().toISOString() });
        let structured = null;
        if (expanded) {
            structured = await this.runPhase('structural_modeling', topic.topic, expanded);
        }
        const p2 = phases[1];
        if (structured) {
            p2.completedAt = new Date().toISOString();
            p2.output = structured;
        }
        else {
            p2.error = 'LLM returned empty';
        }
        // Phase 3: Conflict Analysis (fallback-able)
        log('INFO', 'research_phase_start', { phase: 'conflict_analysis', topic: topic.topic });
        phases.push({ phase: 'conflict_analysis', startedAt: new Date().toISOString() });
        const context = structured ?? expanded ?? obsText;
        const conflictResult = context ? await this.runPhase('conflict_analysis', topic.topic, context) : null;
        const p3 = phases[2];
        if (conflictResult) {
            p3.completedAt = new Date().toISOString();
            p3.output = conflictResult;
        }
        else {
            p3.error = 'LLM returned empty';
        }
        // 如果所有 phase 都失败，LLM 直接生成 summary
        const allFailed = phases.every((p) => p.error);
        if (allFailed) {
            log('WARN', 'research_all_phases_failed_fallback_summary', { topic: topic.topic });
            const summary = await this.generateFallbackSummary(topic.topic, obsText);
            if (summary) {
                p1.output = summary;
                p1.error = undefined;
                p1.completedAt = new Date().toISOString();
            }
        }
        const result = this.assemble(topicId, phases);
        this.store.saveResearchResult(topicId, result);
        const completed = phases.filter((p) => !p.error).length;
        log('INFO', 'research_completed', { topicId, topic: topic.topic, phases: `${completed}/3` });
        return result;
    }
    // ── private ──────────────────────────────────────────────
    async generateFallbackSummary(topic, context) {
        const prompt = `主题：「${topic}」

相关数据：
${context ? context.slice(0, 1000) : '（无直接相关数据）'}

请用一段话概括这个主题的核心内容。不需要分析，只需要列举已知的关键信息。`;
        const result = await this.llm.generate(prompt, { temperature: 0.5, maxTokens: 2048 });
        return result.data ?? null;
    }
    async runPhase(phase, topic, context) {
        const prompt = this.buildPhasePrompt(phase, topic, context);
        const temp = phase === 'structural_modeling' ? 0.3 : phase === 'conflict_analysis' ? 0.5 : 0.7;
        const result = await this.llm.generate(prompt, { temperature: temp, maxTokens: 4096 });
        if (result.error) {
            log('WARN', `research_${phase}_failed`, { topic, error: result.error });
            return null;
        }
        return result.data ?? null;
    }
    buildPhasePrompt(phase, topic, context) {
        switch (phase) {
            case 'expansion':
                return `主题：「${topic}」

已知相关信息：
${context || '（无直接相关数据）'}

请从所有已知信息中，列举关于这个主题的重要事实。注意：
- 区分「确认的事实」和「推测/传言」
- 标注每条信息的时间线（如果可推断）
- 指出哪些信息源互相矛盾

列举即可，不需要段落。`;
            case 'structural_modeling':
                return `主题：「${topic}」

研究笔记：
${context}

请提取结构化数据。只输出 JSON：
{
  "facts": ["确认的事实1", "事实2"],
  "timeline": [{"time": "时间", "event": "事件"}],
  "causalLinks": [{"cause": "原因", "effect": "结果", "confidence": 0.8}],
  "perspectives": [{"viewpoint": "观点描述", "source": "来源"}]
}`;
            case 'conflict_analysis':
                return `主题：「${topic}」

结构化信息：
${context}

基于以上信息，分析：
1. 不同利益方之间的矛盾
2. 事实之间的不一致
3. 数据与主流叙事之间的张力

只输出 JSON：
{
  "conflicts": [
    {"partyA": "方A", "partyB": "方B", "nature": "冲突性质", "evidence": "具体证据"}
  ]
}`;
        }
    }
    assemble(topicId, phases) {
        let facts = [];
        let timeline = [];
        let causalLinks = [];
        let perspectives = [];
        let conflicts = [];
        const structural = phases.find((p) => p.phase === 'structural_modeling' && p.output);
        if (structural?.output) {
            const parsed = this.tryParseJson(structural.output);
            if (parsed) {
                facts = parsed.facts ?? [];
                timeline = parsed.timeline ?? [];
                causalLinks = parsed.causalLinks ?? [];
                perspectives = parsed.perspectives ?? [];
            }
        }
        const conflict = phases.find((p) => p.phase === 'conflict_analysis' && p.output);
        if (conflict?.output) {
            const parsed = this.tryParseJson(conflict.output);
            if (parsed?.conflicts)
                conflicts = parsed.conflicts;
        }
        if (facts.length === 0) {
            const expansion = phases.find((p) => p.phase === 'expansion' && p.output);
            if (expansion?.output) {
                facts = expansion.output
                    .split('\n')
                    .map((l) => l.replace(/^[-•*]\s*/, '').trim())
                    .filter((l) => l.length > 5 && !l.startsWith('{'));
            }
        }
        return { topicId, phases, facts, timeline, causalLinks, perspectives, conflicts };
    }
    tryParseJson(text) {
        try {
            return JSON.parse(text);
        }
        catch { }
        const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (m) {
            try {
                return JSON.parse(m[1].trim());
            }
            catch { }
        }
        return null;
    }
}
