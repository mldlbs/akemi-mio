/**
 * PersonaDriftControlSystem — 人格漂移控制系统
 *
 * 检测 LLM 输出中的"AI 味"信号，并在超出阈值时注入修正。
 * 所有指标均为纯文本统计（正则+计数），无额外 LLM 调用。
 *
 * 指标维度（Style Entropy）：
 *   sentenceLengthVariance  — 句子长度方差（低方差 = AI 式单调）
 *   abstractionRatio        — 抽象标记密度（高 = 过度解释）
 *   emotionLabelDensity     — 情绪标签密度（高 = 概括性情绪词过多）
 *   summaryMarkerDensity    — 总结性措辞密度（"这体现""象征""反映"）
 *   repetitionPattern       — 句式重复
 *
 * 架构位置：Cognitive System → Persona Drift Control System
 */
export interface StyleEntropyReport {
    entropy: number;
    breakdown: {
        sentenceLengthVariance: number;
        abstractionRatio: number;
        emotionLabelDensity: number;
        summaryMarkerDensity: number;
        repetitionPattern: number;
    };
}
/** 采集风格熵指标 */
export declare function evaluateStyleEntropy(text: string): StyleEntropyReport;
export interface StyleAnchor {
    pattern: string;
    isGood: boolean;
    count: number;
}
/**
 * StyleAnchorMemory — 记录好/坏写作风格样本
 * 用于对比评估当前输出是否漂移
 */
export declare class StyleAnchorMemory {
    private anchors;
    private readonly maxAnchors;
    record(text: string, isGood: boolean): void;
    getTopPatterns(limit?: number): {
        good: string[];
        bad: string[];
    };
    clear(): void;
    private extractPatterns;
    private prune;
}
export interface DriftEvalResult {
    drifted: boolean;
    entropy: number;
    correctionInjected: boolean;
}
/** 评估熵报告，判断是否漂移 */
export declare function evaluateDrift(report: StyleEntropyReport, personaLevel: 'core' | 'hybrid' | 'writer'): {
    drifted: boolean;
    reason: string | null;
};
/** 根据 drift 原因生成修正信号 */
export declare function buildCorrectionSignal(reason: string | null): string | null;
/** 漂移修正 prompt — 注入到 extraModules（system prompt 级别） */
export declare const DRIFT_CORRECTION_PROMPT = "\u3010\u98CE\u683C\u4FEE\u6B63\u3011\n\u68C0\u6D4B\u5230\u8FD1\u671F\u8F93\u51FA\u4E2D\u5B58\u5728 AI \u5316\u503E\u5411\u3002\u8BF7\u7279\u522B\u6CE8\u610F\uFF1A\n- \u7528\u5177\u4F53\u7EC6\u8282\u4EE3\u66FF\u62BD\u8C61\u6982\u62EC\n- \u4E0D\u89E3\u91CA\u542B\u4E49\uFF0C\u53EA\u5448\u73B0\u4E8B\u5B9E\n- \u907F\u514D\"\u4F53\u73B0\u4E86\"\"\u8C61\u5F81\u7740\"\"\u53CD\u6620\u51FA\"\u7B49\u603B\u7ED3\u6027\u63AA\u8F9E\n- \u4E0D\u76F4\u63A5\u6807\u6CE8\u60C5\u7EEA\uFF08\u4E0D\u8BF4\"\u5979\u611F\u5230\u6124\u6012\"\uFF0C\u5199\u5979\u6525\u7D27\u7684\u62F3\u5934\uFF09\n- \u53D8\u5316\u53E5\u5F0F\uFF0C\u4E0D\u8981\u8FDE\u7EED\u4EE5\u76F8\u540C\u8BCD\u5F00\u5934";
export declare class PersonaDriftControlSystem {
    readonly styleAnchorMemory: StyleAnchorMemory;
    private lastDriftLog;
    private consecutiveDriftCount;
    /** 当前是否处于修正注入状态（system prompt 级别） */
    private correctionActive;
    /** 连续无漂移次数，达到后解除修正 */
    private cleanCount;
    /**
     * 在 LLM 输出后调用：评估漂移、更新锚点、返回修正信号
     */
    evaluateOutput(text: string, personaLevel: 'core' | 'hybrid' | 'writer'): {
        messageSignal: string | null;
        evalResult: DriftEvalResult;
    };
    /** 当前是否需要注入修正 prompt（system prompt 级别） */
    needsCorrectionPrompt(): boolean;
    reset(): void;
}
