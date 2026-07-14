/**
 * memory_save — 保存Agent经验性学习到记忆系统
 *
 * 专为 Agent 自主调用设计的经验存储工具，与通用 store_memory 不同：
 * - 自动标记为"经验"类型（source=agent_learning），供 memory_load 检索
 * - 自动从当前上下文提取话题标签
 * - 支持分类存储（learned_preference / lesson_learned / observation / self_reflection）
 * - 附带时间戳和置信度，便于后续压缩和清理
 *
 * 使用场景：
 * 1. Agent 发现用户的隐性偏好（如"用户喜欢用表格展示数据"）
 * 2. Agent 从错误中学到教训（如"该 API 需要先获取 token"）
 * 3. Agent 记录观察到的用户行为模式（如"用户通常下午处理代码任务"）
 * 4. Agent 自我反思存储（如"我在代码审查方面可以更仔细"）
 *
 * 风险控制：
 * - 不允许存储永久层条目（防止误用）
 * - 自动去重：内容相似的已存在经验不会重复存储
 * - 默认置信度采用谨慎值 0.55
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import { getMemoryService } from '../deps'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export type ExperienceType =
  | 'learned_preference'   // 学到的用户偏好
  | 'lesson_learned'       // 从错误中学到的教训
  | 'observation'          // 观察到的模式
  | 'self_reflection'      // 自我反思
  | 'workflow_insight'     // 工作流洞察

const EXPERIENCE_LABELS: Record<ExperienceType, string> = {
  learned_preference: '【偏好经验】',
  lesson_learned: '【教训】',
  observation: '【观察】',
  self_reflection: '【自我反思】',
  workflow_insight: '【工作流洞察】',
}

// 允许存储的最大层级
const ALLOWED_TIERS: Array<'ephemeral' | 'semi'> = ['ephemeral', 'semi']

// ══════════════════════════════════════════
//  工具定义
// ══════════════════════════════════════════

export const memorySaveTool = buildTool({
  name: 'memory_save',
  description:
    '保存 Agent 经验性学习到记忆系统。用于 Agent 自主记录学到的用户偏好、错误教训、' +
    '行为观察和自我反思。自动分类和去重，经验内容可通过 memory_load 工具批量检索。' +
    '比 store_memory 更适合 Agent 自主记录学习成果。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: '经验内容。清晰描述学到了什么或观察到了什么。例如："用户偏好使用表格形式展示数据"',
      },
      type: {
        type: 'string',
        enum: ['learned_preference', 'lesson_learned', 'observation', 'self_reflection', 'workflow_insight'],
        description: '经验类型。learned_preference=用户偏好, lesson_learned=错误教训, observation=模式观察, self_reflection=自我反思, workflow_insight=工作流洞察',
      },
      confidence: {
        type: 'number',
        description: '确信度 0-1，默认 0.55（谨慎值）。在经过多次验证后可提高。',
      },
      topics: {
        type: 'array',
        items: { type: 'string' },
        description: '可选的话题标签列表。例如：["代码审查", "API设计"]。留空则自动从内容提取。',
      },
      tier: {
        type: 'string',
        enum: ['ephemeral', 'semi'],
        description: '存储层级。ephemeral=临时（默认，适合单次观察），semi=半永久（适合已验证的偏好）',
      },
    },
    required: ['content', 'type'],
  },
  handler: async (args: {
    content: string
    type: ExperienceType
    confidence?: number
    topics?: string[]
    tier?: 'ephemeral' | 'semi'
  }) => {
    try {
      const ms = getMemoryService()
      if (!ms) return formatToolError('记忆服务暂不可用')

      const content = String(args.content).trim()
      if (!content) return formatToolError('经验内容不能为空')

      const experienceType: ExperienceType = args.type || 'observation'
      const confidence = typeof args.confidence === 'number'
        ? Math.max(0.1, Math.min(1.0, args.confidence))
        : 0.55
      const tier = args.tier && ALLOWED_TIERS.includes(args.tier) ? args.tier : 'ephemeral'

      // 1. 去重检查：对同一类型下的相似内容做精确匹配
      const allEntries = ms.getEntries()
      const normalized = content.toLowerCase().trim()
      const isDuplicate = allEntries.some(
        (e) =>
          e.type === 'user_fact' &&
          e.content.toLowerCase().includes(normalized.slice(0, 30)) &&
          (e.structuredData?.includes('agent_learning') || e.content.startsWith('【经验】') || e.content.startsWith('【观察】')),
      )

      if (isDuplicate) {
        return formatToolResult(`已存在相似的经验记录，跳过重复存储。内容: ${content.slice(0, 60)}`)
      }

      // 2. 提取话题标签
      const userTopics = args.topics || []
      const extractedTopics = userTopics.length > 0
        ? userTopics
        : extractTopicsFromContent(content)

      // 3. 构建前缀标记
      const prefix = EXPERIENCE_LABELS[experienceType] || '【观察】'

      // 4. 构建结构化数据
      const structuredData = JSON.stringify({
        source: 'agent_learning',
        experienceType,
        confidence,
        tags: [...extractedTopics, 'learning'],
        savedAt: Date.now(),
      })

      // 5. 存储到记忆系统
      ms.addEntry(
        'user_fact',
        `${prefix} ${content}`,
        confidence,
        {
          tier,
          structuredData,
        },
      )

      // 标记话题到内容（通过 structuredData 已包含 topics，但 addEntry 的 topics 字段需要后续更新）
      // 利用已有的行为强化接口设置话题关联
      ms.reinforceByBehaviorPattern(extractedTopics, content, 0.05)

      ms.flush()

      return formatToolResult(
        `已保存${EXPERIENCE_LABELS[experienceType] || '经验'}: ${content.slice(0, 120)}` +
        ` | 类型=${experienceType}, 层级=${tier}, 置信度=${confidence.toFixed(2)}` +
        (extractedTopics.length > 0 ? `, 话题=${extractedTopics.join(',')}` : ''),
      )
    } catch (err: any) {
      return formatToolError(err.message)
    }
  },
  isReadOnly: false,
})

/**
 * 从经验内容中提取话题标签。
 * 使用与 MemoryService.extractTopics 类似的模式匹配逻辑。
 */
function extractTopicsFromContent(text: string): string[] {
  const topics: string[] = []
  const lower = text.toLowerCase()

  const topicPatterns: Array<{ regex: RegExp; label: string }> = [
    { regex: /代码|编程|重构|review|code|typescript|javascript|python|rust|java/, label: '编程' },
    { regex: /api|接口|请求|响应|http|endpoint|rest|graphql/, label: 'API' },
    { regex: /数据库|sql|query|迁移|schema|表/, label: '数据库' },
    { regex: /部署|ci|cd|docker|k8s|发布|release/, label: '部署' },
    { regex: /测试|test|unit|e2e|集成测试|mock/, label: '测试' },
    { regex: /架构|设计模式|架构决策|模块化|分层/, label: '架构' },
    { regex: /安全|认证|权限|auth|token|加密/, label: '安全' },
    { regex: /性能|优化|缓存|lazy|memo|debounce|throttle/, label: '性能' },
    { regex: /ui|ux|样式|组件|布局|响应式|界面/, label: '前端' },
    { regex: /写作|故事|小说|角色|剧情|描写/, label: '写作' },
    { regex: /偏好|习惯|喜欢|偏好|常用/, label: '用户偏好' },
    { regex: /错误|失败|教训|bug|regression|回退/, label: '错误处理' },
    { regex: /学习|学到|理解|掌握|技能/, label: '学习' },
    { regex: /工作流|自动化|pipeline|流程/, label: '工作流' },
    { regex: /文档|文档|readme|注释|doc/, label: '文档' },
    { regex: /电报|telegram|推送|消息/, label: 'Telegram' },
    { regex: /进化|优化|自改进|self.?improve/, label: '自进化' },
  ]

  for (const { regex, label } of topicPatterns) {
    if (regex.test(lower)) topics.push(label)
  }

  return [...new Set(topics)].slice(0, 5)
}
