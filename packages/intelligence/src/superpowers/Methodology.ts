/**
 * Methodology 一键接层（M6.2 Superpowers Layer 的最小可行实现）
 *
 * 职责：Goal → 选择解决问题的方法论 → 将方法论提示注入 toolLoop。
 * 不创建新的执行引擎，不取代 ToolLoop；仅管理“怎么做”的方法论提示。
 * 与执行层证据（Evidence / GoalEvaluator）保持独立。
 */
export interface Methodology {
  id: string
  name: string
  description: string
  /** 注入 toolLoop 的 system_hint 内容 */
  hint: string
  /** 匹配优先级，数字越小越优先（第一个命中即返回） */
  priority: number
  /** 触发关键词（支持多语言，结合 objective + successCriteria 进行匹配） */
  matches: RegExp
}

export interface MethodologySelectionInput {
  objective: string
  successCriteria: string[]
  /** 路由决策，可选，未来可用于更细的方法论匹配 */
  route?: string
}

const METHODOLOGIES: Methodology[] = [
  {
    id: 'systematic_debugging',
    name: '系统化调试',
    description: '先复现并定位根因，再最小修复，最后验证',
    hint: '【方法论：系统化调试】先复现问题并定位根因，做最小修复，运行验证后再继续；不要盲目重试。',
    priority: 1,
    matches: /(bug|error|exception|报错|异常|崩溃|无法|排查|调试|debug)/i,
  },
  {
    id: 'test_driven_development',
    name: '测试驱动开发',
    description: '先写失败测试，再实现最小修复，通过后收尾',
    hint: '【方法论：测试驱动开发】先写/跑失败测试，再实现最小修复或功能，测试通过后收尾。',
    priority: 2,
    matches: /(测试|回归|test|tdd)/i,
  },
  {
    id: 'writing_plan',
    name: '先写计划',
    description: '先产出结构化计划，再按步骤执行',
    hint: '【方法论：先写计划】先给出结构化计划（步骤、验收标准、依赖），再按计划逐步执行。',
    priority: 3,
    matches: /(计划|方案|规划|拆解|设计|plan|architecture)/i,
  },
  {
    id: 'brainstorming',
    name: '需求头脑风暴',
    description: '先澄清目标与约束，再提出可选方案',
    hint: '【方法论：需求头脑风暴】先澄清目标、约束与验收标准，提出可选方案，再进入执行。',
    priority: 4,
    matches: /(创意|灵感|点子|头脑风暴|新功能|需求|brainstorm)/i,
  },
  {
    id: 'verification_before_completion',
    name: '完成前验证',
    description: '宣称完成前必须运行验证并确认输出',
    hint: '【方法论：完成前验证】宣称完成前必须运行验证命令并确认输出，证据优先。',
    priority: 5,
    matches: /(验收|确认|检查|验证|review)/i,
  },
  {
    id: 'executing_plan',
    name: '分步执行',
    description: '将目标拆成可验证步骤，逐步执行并收集证据',
    hint: '【方法论：分步执行】将目标拆成可验证步骤，逐步执行并收集证据，完成后汇报。',
    priority: 100,
    matches: /.*/,
  },
]

export function selectMethodology(input: MethodologySelectionInput): Methodology {
  const text = `${input.objective}\n${input.successCriteria.join('\n')}`
  const ordered = [...METHODOLOGIES].sort((a, b) => a.priority - b.priority)
  for (const methodology of ordered) {
    if (methodology.matches.test(text)) return methodology
  }
  return METHODOLOGIES.find((m) => m.id === 'executing_plan')!
}

export function buildMethodologyHint(methodology: Methodology): string {
  return methodology.hint
}

export function getMethodologyById(id: string): Methodology | null {
  return METHODOLOGIES.find((m) => m.id === id) ?? null
}
