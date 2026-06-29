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
const PATTERNS = [
    {
        category: 'writing',
        patterns: [
            /写.*故事|写.*小说|创作.*故事/,
            /小说|故事|剧情|角色|章节|情节/,
            /文笔|润色|改写|描写|修辞/,
            /氛围|气氛|画面感|灵感|细节|描写/,
            /写作|著书|文稿|手稿|连载|番外|同人|小说创作/,
        ],
    },
    {
        category: 'image_gen',
        patterns: [
            /画|绘制|生成.*图|生成.*画|作图|绘图/,
            /图片|照片|图像|插图|插画/,
            /设计.*图|设计.*海报|设计.*封面/,
            /FLUX|CogView|ComfyUI/,
            /生图|AI.*图|AI.*画|文生图|图生图/,
        ],
    },
    {
        category: 'evolution',
        patterns: [
            /进化|自我改进|自我优化|self.evolve|self.improv/i,
            /优化.*系统|改进.*能力|提升.*性能|升级.*功能/,
            /分析.*代码|重构.*架构|重构.*代码|代码.*审查/,
            /性能.*优化|内存.*泄漏|bug.*修复|自动化.*测试/,
        ],
    },
    {
        category: 'creativity',
        patterns: [
            /创意|灵感|点子|头脑风暴|brainstorm/i,
            /创新|新颖|独特.*想法|出主意/,
            /有什么.*想法|你觉得.*怎么样|有没有.*思路/,
            /设计方案|产品.*构思|新功能.*建议/,
        ],
    },
    {
        category: 'dream',
        patterns: [/梦境|梦到|做梦|梦见|潜意识|催眠/i, /dream|subconscious|REM/i, /解梦|弗洛伊德|荣格|释梦/],
    },
];
/** 检测用户消息的内容类型，默认 chat */
export function classifyContent(text) {
    if (!text)
        return 'chat';
    for (const { category, patterns } of PATTERNS) {
        for (const p of patterns) {
            if (p.test(text))
                return category;
        }
    }
    return 'chat';
}
/** 所有分类的中文标签和图标 */
export const CATEGORY_META = {
    chat: { label: '聊天', icon: 'ri-chat-1-line' },
    writing: { label: '写作', icon: 'ri-quill-pen-line' },
    image_gen: { label: '生图', icon: 'ri-image-ai-line' },
    evolution: { label: '进化', icon: 'ri-robot-2-line' },
    creativity: { label: '创造力', icon: 'ri-lightbulb-line' },
    dream: { label: '梦境', icon: 'ri-moon-line' },
};
