/**
 * SelfEvolutionPrompt — 自进化模式专属精简系统提示。
 *
 * 相比完整用户对话提示（context.ts 的 BASE_PROMPT），移除了以下模块：
 * - TTS 朗读规则（进化模式不会输出给 TTS）
 * - 小说创作模式（写作系统指令）
 * - 凭据管理
 * - 插件系统
 * - emoji/颜文字规则
 * - 口语化要求（进化分析产生书面报告）
 *
 * 上下文体积减少约 60-70%，降低 LLM 在无关上下文中迷失导致超时的风险。
 */
export declare function buildEvolutionSystemPrompt(memoryContext?: string, promptOverlay?: string): string;
/** 估算精简提示的 token 数（用于对比验证）*/
export declare function getEvolutionPromptTokens(): number;
