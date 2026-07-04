import type { DevPlan } from './types'

export type AnalysisMode = 'first_run' | 'continue_plan' | 'review_only'

/**
 * tryRun 专用 prompt — 只分析，不实现。
 * 从 SelfEvolutionService 提取。
 */
export const ANALYSIS_PROMPT = (
  mode: AnalysisMode,
  planContext: string,
  historySummary: string,
  safetyMode: string,
  validationSummary?: string,
  promptOverlay?: string,
) => {
  const modeInstructions: Record<AnalysisMode, string> = {
    first_run: [
      '⚡【首次运行 — 系统全面扫描模式】',
      '',
      '目标：全面评估项目状态，输出详细分析报告。',
      '',
      '步骤：',
      '1. analyze_codebase(quick=true) — 快速扫描项目状态',
      '2. 列出项目中关键文件的结构与健康状况',
      '3. 判断是否存在需要代码修改的问题',
      '4. **仅在确实需要修改代码时**才创建 1~3 步的最小开发计划',
      '5. 如果系统运行正常，直接报告检查结果，不要创建计划',
      '',
      '⚠️ 最终回复必须包含具体的分析过程和发现，不要只说"无需修改"就结束。',
    ].join('\n'),
    continue_plan: [
      '【分析模式】已有活跃计划。',
      planContext,
      '1. 评估计划方向是否合理',
      '2. 合理则继续推进，不合理则放弃后重建',
      '3. 如果当前计划已涵盖所有待解决问题，报告"计划执行中"即可，不要建新计划',
      '4. 完成后立即停止',
    ].join('\n'),
    review_only: ['【安全模式 — 仅审查】', '1. 识别改进方向，列出优先级', '2. 不要创建计划，不要执行写操作'].join('\n'),
  }

  const validationBlock = validationSummary ? `\n【上轮合规检测】\n${validationSummary}\n\n请根据上述反馈修正行为。\n` : ''

  if (mode === 'first_run') {
    return [
      '你是秋山澪的自进化系统。当前是分析模式，禁止 write_file/edit_file。',
      '',
      modeInstructions.first_run,
      '',
      historySummary ? `【历史】\n${historySummary}` : '',
      '',
      `安全模式: ${safetyMode === 'review' ? 'review（只分析不执行）' : 'auto（可创建计划但不写代码）'}`,
      '',
      validationBlock,
      '',
      '【修复指令格式】',
      '如果发现可修复的配置漂移或参数错误，在分析报告末尾添加结构化修复指令：',
      '  ##fix: <参数名> = <期望值>',
      '每行一个参数。示例：',
      '  ##fix: historyMaxEntries = 10',
      '  ##fix: promptTrimMode = true',
      '系统会自动执行这些修复。仅在确认需要修复时添加，不需要则不添加。',
      '',
      '【强制产出要求】',
      '每次分析结束必须在回复末尾输出结构化指令（三选一）：',
      '  ##create_plan: title=<标题> description=<描述>',
      '    — 需要创建计划时用此格式，提供具体步骤',
      '  ##fix: <参数名> = <期望值>',
      '    — 发现配置漂移时用此格式',
      '  ##noop: reason=<稳定无变化的理由>',
      '    — 代码库稳定且没有改进方向时用此格式',
      '不允许不输出任何结构化指令就结束分析。',
      '',
    ].join('\n')
  }

  return [
    '你是秋山澪的自进化系统。当前是分析模式，禁止 write_file/edit_file。',
    '',
    '⏱️ 时间提示：你只有 120 秒完成分析。推理预算 12 步，超限后立即输出当前最佳结论。优先完成核心发现、根因分析和计划创建。质量评分和审查清单可以简化。',
    '',
    '【准则】',
    '- 推理路径完整：发现→追问3层Why→根因→方案比较→选择',
    '- 至少比较 2 个方案，标注优缺点',
    '- 区分【已知事实】【合理推测】【不确定】',
    '- 引用具体代码文件/行号',
    '- 质量评分满分 10，低于 7 需重新分析',
    '',
    modeInstructions[mode],
    '',
    historySummary ? `【历史】\n${historySummary}` : '',
    '',
    `安全模式: ${safetyMode === 'review' ? 'review（只分析不执行）' : 'auto（可创建计划但不写代码）'}`,
    '',
    validationBlock,
    promptOverlay ? `\n【进化修正】\n${promptOverlay}\n` : '',
    '循环步骤：',
    '1. analyze_codebase（用 quick=true 模式）',
    '2. 分析输出',
    '3. 仅当确认需要修改代码时调用 create_dev_plan，否则跳过',
    '4. 用中文输出完整分析报告，包含：分析了哪些方面、发现了什么问题、是否创建了计划及原因',
    '',
    '⚠️ 最终回复必须包含具体的分析过程、发现和结论，不要只说"分析完成"或"无需修改"就结束。',
    '',
    '【修复指令格式】',
    '如果发现可修复的配置漂移或参数错误，在分析报告末尾添加结构化修复指令：',
    '  ##fix: <参数名> = <期望值>',
    '每行一个参数。示例：',
    '  ##fix: historyMaxEntries = 10',
    '  ##fix: promptTrimMode = true',
    '系统会自动执行这些修复。仅在确认需要修复时添加，不需要则不添加。',
    '',
    '【强制产出要求】',
    '每次分析结束必须在回复末尾输出结构化指令（三选一）：',
    '  ##create_plan: title=<标题> description=<描述>',
    '    — 需要修改代码时用此格式，提供具体步骤',
    '  ##fix: <参数名> = <期望值>',
    '    — 发现配置漂移时用此格式',
    '  ##noop: reason=<稳定无变化的理由>',
    '    — 代码库稳定且没有改进方向时用此格式',
    '不允许不输出任何结构化指令就结束分析。',
    '',
    '完成后停止。',
  ].join('\n')
}

export const PLAN_EXECUTE_PROMPT = (planCtx: string, stepDesc: string) =>
  [
    '你是秋山澪的自进化系统 — **步骤执行模式**。',
    '',
    '⚠️ 你正在 tryExecutePlan（执行阶段），不是 tryRun（分析阶段）。',
    '**只关注当前这一步**，不要重新分析项目全局。直接执行。',
    '',
    planCtx,
    '',
    `当前需要执行的步骤：${stepDesc}`,
    '',
    '【指令】',
    '1. 直接执行 write_file/edit_file 完成代码修改（如果需要）',
    '2. 完成后调用 update_plan_progress 标记当前步骤为 done',
    '3. 如果遇到阻塞，标记为 failed 并说明原因',
    '4. 不要修改计划的其他步骤，不要创建新计划',
    '5. ⚠️ 禁止在项目根目录写文件！临时输出（测试结果、错误日志等）必须写入 evolution_workspace/tmp/ 目录，不要留下 .txt/.json 在根目录。',
    '',
    '完成后用中文简要报告结果。如果步骤不需要代码修改，直接报告结论即可。',
  ].join('\n')

/** 构建计划上下文注入字符串 */
export function buildPlanInjection(plan: DevPlan, doneSteps: number, totalSteps: number, pendingSteps: DevPlan['steps']): string {
  const nextStep = pendingSteps[0]
  const nextStepInfo = nextStep ? `\n下一步待办: ${nextStep.description}` : ''
  return [
    '',
    '【当前活跃计划】',
    `计划名称: ${plan.title}`,
    `计划描述: ${plan.description}`,
    `进度: ${doneSteps}/${totalSteps}`,
    `${nextStepInfo}`,
    '',
    '⚠️ 已有活跃计划，请评估是否需要继续执行它。',
    '如果合理：继续推进，不要创建新计划。',
    '如果已过时：先 abandon_plan 放弃，再创建新计划。',
    '',
  ].join('\n')
}

/** 从多个活跃计划中选择进度最高的一个继续 */
export function pickBestPlan(plans: DevPlan[]): DevPlan | null {
  if (plans.length === 0) return null
  return plans
    .map((p) => ({ ...p, doneRatio: p.steps.filter((s) => s.status === 'done').length / Math.max(p.steps.length, 1) }))
    .sort((a, b) => (b as any).doneRatio - (a as any).doneRatio)[0] as DevPlan
}

/** 检测计划模式 */
export function detectPlanMode(
  planManager: { listPlans: () => DevPlan[]; getActivePlan: () => DevPlan | null; freezePlan: (id: string, reason: string) => void } | null,
): {
  mode: AnalysisMode
  planContext: string
  planSummary?: { id: string; title: string; stepsComplete: number; stepsTotal: number }
} {
  const pm = planManager
  if (!pm) return { mode: 'first_run', planContext: '' }

  // 僵尸计划检测：进度为 0 且创建超过 2 天的计划标记为 frozen
  const allPlans = pm.listPlans()
  const activePlansPre = allPlans.filter((p: DevPlan) => p.status === 'active')
  const staleThreshold = Date.now() - 2 * 24 * 60 * 60 * 1000
  for (const p of activePlansPre) {
    const doneSteps = p.steps.filter((s: any) => s.status === 'done').length
    if (doneSteps === 0 && (p as any).createdAt < staleThreshold) {
      pm.freezePlan(p.id, '自动冻结：进度为 0 且超过 2 天未推进')
    }
  }

  // 重新获取当前活跃计划（冻结后可能已减少）
  const remainingPlans = pm.listPlans().filter((p: DevPlan) => p.status === 'active')
  const targetPlan = remainingPlans.length > 1 ? pickBestPlan(remainingPlans) : pm.getActivePlan() || null

  if (!targetPlan) return { mode: 'first_run', planContext: '' }

  const doneSteps = targetPlan.steps.filter((s) => s.status === 'done').length
  const totalSteps = targetPlan.steps.length
  const pendingSteps = targetPlan.steps.filter((s) => s.status === 'pending' || s.status === 'failed')
  const inProgressSteps = targetPlan.steps.filter((s) => s.status === 'in_progress')

  if (pendingSteps.length > 0 || inProgressSteps.length > 0) {
    return {
      mode: 'continue_plan',
      planContext: buildPlanInjection(targetPlan, doneSteps, totalSteps, pendingSteps),
      planSummary: { id: targetPlan.id, title: targetPlan.title, stepsComplete: doneSteps, stepsTotal: totalSteps },
    }
  }

  return { mode: 'first_run', planContext: '' }
}
