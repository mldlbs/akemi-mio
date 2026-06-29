import type { Hypothesis, ConceptCombo, CreativitySource, ExternalSignal } from './types';
/**
 * HypothesisGenerator — 将概念组合转化为可验证的假设
 *
 * 四级生成链（逐级降级）：
 *   远程 LLM → 本地模型 (transformers.js) → TemplateLibrary (30+ 模式) → 原始模板兜底
 */
export declare class HypothesisGenerator {
    private idCounter;
    private rng;
    private chatJson;
    private templateLib;
    private localModel;
    constructor(chatJson: (userText: string, options?: {
        system?: string;
        temperature?: number;
        timeoutMs?: number;
        requestId?: string;
    }) => Promise<{
        data?: any;
        error?: string;
    }>, seed?: number);
    /**
     * 从概念组合生成假设 — 远程 LLM → 本地模型 → TemplateLibrary → 模板兜底
     *
     * 四级 fallback 链：
     *   1. 远程 LLM           (高质，但 30s 超时、网络依赖)
     *   2. 本地 transformers.js (进程内，~1s，无网络依赖)
     *   3. TemplateLibrary    (30+ 模式，类型感知，零延迟)
     *   4. 原始模板           (5 个硬编码，终极兜底)
     */
    generate(combos: ConceptCombo[], sources: CreativitySource[], 
    /** 梦境模式使用更高温度 */
    dreamMode?: boolean, 
    /** 外部信号 — 不参与配对，作为审视视角注入 LLM */
    externalSignals?: ExternalSignal[]): Promise<Hypothesis[]>;
    /**
     * 调 LLM 生成创意
     */
    private tryLLM;
    /**
     * 调本地 transformers.js 模型生成创意
     */
    private tryLocalModel;
    /**
     * 模板 fallback — 从旧实现保留
     */
    private templateFallback;
    private stableHash;
}
