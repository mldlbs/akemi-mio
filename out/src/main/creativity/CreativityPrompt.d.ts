import type { CreativitySource, ExternalSignal } from './types';
/**
 * Creativity System Prompt — 给 LLM 的创造力提示词
 * 定义 AI 作为"概念重组引擎"的角色。
 * 目标是产生真正新颖、可落地的改进方案，而不是泛泛而谈。
 *
 * @param method 本轮注入的创新技法约束（可选 SCAMPER 技法名称）
 */
export declare function buildSystemPrompt(method?: string): string;
/** 旧版常量保留兼容，实际应使用 buildSystemPrompt() */
export declare const CREATIVITY_SYSTEM_PROMPT: string;
/**
 * 构建 Creativity 用户提示词
 * 将来源内容和配对信息格式化为 LLM 输入
 * @param externalSignals 外部信号（Observer 趋势/洞察），不参与配对，作为"外部审视"段注入
 */
export declare function buildCreativityPrompt(sources: CreativitySource[], combos: {
    sources: string[];
    description: string;
}[], externalSignals?: ExternalSignal[]): string;
