/**
 * ContentClassifier — 基于用户文本检测消息内容类型
 *
 * 6 种分类：
 *   chat       — 默认，日常对话
 *   writing    — 小说/故事/创作
 *   image_gen  — 图片生成
 *   evolution  — 自我进化
 *   creativity — 创意/灵感
 *   dream      — 梦境/潜意识
 */
export type MessageCategory = 'chat' | 'writing' | 'image_gen' | 'evolution' | 'creativity' | 'dream';
/** 检测用户消息的内容类型，默认 chat */
export declare function classifyContent(text: string): MessageCategory;
/** 所有分类的中文标签和图标 */
export declare const CATEGORY_META: Record<MessageCategory, {
    label: string;
    icon: string;
}>;
