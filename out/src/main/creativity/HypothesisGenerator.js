import { CREATIVITY_SYSTEM_PROMPT, buildCreativityPrompt } from './CreativityPrompt';
import { TemplateLibrary } from './TemplateLibrary';
import { LocalModelService } from './LocalModelService';
import { resolveRandom } from '../utils/random';
import { log } from '../logger/Logger';
/**
 * HypothesisGenerator — 将概念组合转化为可验证的假设
 *
 * 四级生成链（逐级降级）：
 *   远程 LLM → 本地模型 (transformers.js) → TemplateLibrary (30+ 模式) → 原始模板兜底
 */
export class HypothesisGenerator {
    constructor(chatJson, seed) {
        this.idCounter = 0;
        this.chatJson = chatJson;
        this.rng = resolveRandom(seed);
        this.templateLib = new TemplateLibrary(seed);
        this.localModel = new LocalModelService();
    }
    /**
     * 从概念组合生成假设 — 远程 LLM → 本地模型 → TemplateLibrary → 模板兜底
     *
     * 四级 fallback 链：
     *   1. 远程 LLM           (高质，但 30s 超时、网络依赖)
     *   2. 本地 transformers.js (进程内，~1s，无网络依赖)
     *   3. TemplateLibrary    (30+ 模式，类型感知，零延迟)
     *   4. 原始模板           (5 个硬编码，终极兜底)
     */
    async generate(combos, sources, 
    /** 梦境模式使用更高温度 */
    dreamMode = false, 
    /** 外部信号 — 不参与配对，作为审视视角注入 LLM */
    externalSignals = []) {
        if (combos.length === 0)
            return [];
        // 第一级：远程 LLM 驱动生成
        const llmResults = await this.tryLLM(sources, combos, dreamMode, externalSignals);
        if (llmResults.length > 0) {
            return llmResults.map((r) => ({
                id: `hyp_${Date.now()}_${++this.idCounter}_${this.rng().toString(36).slice(2, 4)}`,
                title: r.title,
                idea: r.idea,
                expectedBenefit: r.expectedBenefit,
                risk: r.risk,
                sourceLabels: r.sourceLabels,
                novelty: Math.max(10, Math.min(100, r.novelty)),
                feasibility: Math.max(10, Math.min(100, r.feasibility)),
                impact: Math.max(10, Math.min(100, r.impact)),
                status: 'draft',
                createdAt: Date.now(),
            }));
        }
        // 第二级：本地 transformers.js 模型
        if (this.localModel.isEnabled) {
            log('INFO', 'hypothesis_fallback_local', { count: combos.length });
            const localResults = await this.tryLocalModel(sources, combos, dreamMode);
            if (localResults.length > 0) {
                return localResults.map((r) => ({
                    id: `hyp_local_${Date.now()}_${++this.idCounter}_${this.rng().toString(36).slice(2, 4)}`,
                    title: r.title,
                    idea: r.idea,
                    expectedBenefit: r.expectedBenefit,
                    risk: r.risk,
                    sourceLabels: r.sourceLabels,
                    novelty: Math.max(10, Math.min(100, r.novelty)),
                    feasibility: Math.max(10, Math.min(100, r.feasibility)),
                    impact: Math.max(10, Math.min(100, r.impact)),
                    status: 'draft',
                    createdAt: Date.now(),
                }));
            }
        }
        // 第二/三级失败 → 记录日志
        log('INFO', 'hypothesis_fallback_templates', { count: combos.length });
        // 第三级：TemplateLibrary (30+ 类型感知模板)
        const tplResults = [];
        for (const combo of combos) {
            const h = this.templateLib.generate(combo, sources);
            if (h)
                tplResults.push(h);
        }
        if (tplResults.length > 0) {
            return tplResults;
        }
        // 第四级：原始模板兜底
        log('WARN', 'hypothesis_fallback_legacy', { count: combos.length });
        return combos.map((combo) => this.templateFallback(combo));
    }
    /**
     * 调 LLM 生成创意
     */
    async tryLLM(sources, combos, dreamMode, externalSignals = []) {
        // 限制输入量，避免超 token
        const topCombos = combos.slice(0, dreamMode ? 5 : 3);
        const comboInfo = topCombos.map((c) => ({
            sources: c.sources,
            description: c.description,
        }));
        const prompt = buildCreativityPrompt(sources, comboInfo, externalSignals);
        try {
            const result = await this.chatJson(prompt, {
                system: CREATIVITY_SYSTEM_PROMPT,
                temperature: dreamMode ? 1.0 : 0.8,
                timeoutMs: 60000,
            });
            if (result.error) {
                log('WARN', 'hypothesis_llm_error', { error: result.error });
                return [];
            }
            const ideas = Array.isArray(result.data) ? result.data : [];
            // 验证基本格式
            return ideas.filter((i) => typeof i.title === 'string' && typeof i.idea === 'string' && Array.isArray(i.sourceLabels) && typeof i.novelty === 'number');
        }
        catch (err) {
            log('ERROR', 'hypothesis_llm_exception', { error: String(err) });
            return [];
        }
    }
    /**
     * 调本地 transformers.js 模型生成创意
     */
    async tryLocalModel(sources, combos, dreamMode) {
        const topCombos = combos.slice(0, dreamMode ? 3 : 2);
        const comboInfo = topCombos.map((c) => ({
            sources: c.sources,
            description: c.description,
        }));
        const prompt = buildCreativityPrompt(sources, comboInfo);
        const result = await this.localModel.generate(prompt, {
            system: CREATIVITY_SYSTEM_PROMPT,
            temperature: dreamMode ? 0.8 : 0.6,
            maxTokens: dreamMode ? 1024 : 768,
        });
        if (result.error) {
            log('WARN', 'hypothesis_local_error', { error: result.error });
            return [];
        }
        const ideas = Array.isArray(result.data) ? result.data : [];
        return ideas.filter((i) => typeof i.title === 'string' && typeof i.idea === 'string' && Array.isArray(i.sourceLabels) && typeof i.novelty === 'number');
    }
    /**
     * 模板 fallback — 从旧实现保留
     */
    templateFallback(combo) {
        const [a, b] = combo.sources;
        const hash = this.stableHash(a, b);
        const idx = hash % TEMPLATES.length;
        const t = TEMPLATES[idx];
        return {
            id: `hyp_fb_${Date.now()}_${++this.idCounter}_${this.rng().toString(36).slice(2, 4)}`,
            title: t.title(a, b),
            idea: t.idea(a, b),
            expectedBenefit: t.expectedBenefit,
            risk: t.risk,
            sourceLabels: [a, b],
            novelty: 50 + Math.round(this.rng() * 30),
            feasibility: 40 + Math.round(this.rng() * 30),
            impact: 50 + Math.round(this.rng() * 25),
            status: 'draft',
            createdAt: Date.now(),
        };
    }
    stableHash(a, b) {
        let h = 0;
        const s = a + '|' + b;
        for (let i = 0; i < s.length; i++) {
            h = (h << 5) - h + s.charCodeAt(i);
            h = h & h;
        }
        return Math.abs(h);
    }
}
const TEMPLATES = [
    {
        title: (a, b) => `${a} 驱动的 ${b}`,
        idea: (a, b) => `将「${a}」的核心机制作为「${b}」的新输入维度`,
        expectedBenefit: '解锁之前被忽视的新能力组合',
        risk: '组合可能引入不必要的复杂度',
    },
    {
        title: (a, b) => `基于 ${a} 的 ${b} 增强`,
        idea: (a, b) => `让「${a}」和「${b}」通过一个共享接口互相增强`,
        expectedBenefit: '系统灵活性提升，涌现新的行为模式',
        risk: '两个概念耦合后难以单独演进',
    },
    {
        title: (a, b) => `${a} × ${b} 混合系统`,
        idea: (a, b) => `借鉴「${a}」的设计哲学重新思考「${b}」的实现`,
        expectedBenefit: '减少重复逻辑，提升模块间信息复用',
        risk: '可能存在隐含的语义冲突',
    },
    {
        title: (a, b) => `从 ${a} 到 ${b} 的抽象跳跃`,
        idea: (a, b) => `在「${a}」的基础上构建「${b}」的新抽象层`,
        expectedBenefit: '降低认知负载，统一概念模型',
        risk: '抽象层过多影响 runtime 性能',
    },
    {
        title: (a, b) => `${a} 视角下的 ${b} 重构`,
        idea: (a, b) => `将「${a}」的某一种能力移植到「${b}」的上下文中`,
        expectedBenefit: '架构更优雅，扩展点增加',
        risk: '预期收益不确定，需要实验验证',
    },
];
// 保留旧文件中的 PATTERN_LIBRARY 作为参考，但不再使用
