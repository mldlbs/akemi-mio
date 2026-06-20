import { existsSync } from 'fs'
import { resolve, join } from 'path'
import { log } from '../logger/Logger'
import { SkillDef, TIER_STAGES } from './skills/types'
import { skill as architectSkill } from './skills/00-architect'
import { skill as plannerSkill } from './skills/01-planner'
import { skill as developerSkill } from './skills/02-developer'
import { skill as testerSkill } from './skills/03-tester'
import { skill as reviewerSkill } from './skills/04-reviewer'
import { skill as brainstormingSkill } from './skills/05-brainstorming'
import { skill as writingPlansSkill } from './skills/06-writing-plans'
import { skill as tddSkill } from './skills/07-test-driven-development'
import { skill as codeReviewSkill } from './skills/08-requesting-code-review'
import { skill as debuggingSkill } from './skills/09-systematic-debugging'
import { skill as subagentSkill } from './skills/10-subagent-driven-development'
import { skill as gitWorktreeSkill } from './skills/11-using-git-worktrees'
import { skill as refactoringSkill } from './skills/12-refactoring'
import { skill as migrationSkill } from './skills/13-migration'
import { skill as documentationSkill } from './skills/14-documentation'
import { skill as performanceProfilingSkill } from './skills/15-performance-profiling'
import { skill as integrationTestingSkill } from './skills/16-integration-testing'

// ---- All Skills Registry ----

const ALL_SKILLS: SkillDef[] = [
  architectSkill,
  plannerSkill,
  developerSkill,
  testerSkill,
  reviewerSkill,
  brainstormingSkill,
  writingPlansSkill,
  tddSkill,
  codeReviewSkill,
  debuggingSkill,
  subagentSkill,
  gitWorktreeSkill,
  refactoringSkill,
  migrationSkill,
  documentationSkill,
  performanceProfilingSkill,
  integrationTestingSkill,
]

const STAGE_SKILLS = ALL_SKILLS.filter((s) => s.isStage)
const STANDALONE_SKILLS = ALL_SKILLS.filter((s) => !s.isStage)

// ---- Tier Pipeline Composition ----

export { TIER_STAGES } from './skills/types'

export function getPipeline(tier: 'simple' | 'medium' | 'large'): SkillDef[] {
  const names = TIER_STAGES[tier]
  if (!names) return []
  return names.map((n) => STAGE_SKILLS.find((s) => s.name === n)).filter(Boolean) as SkillDef[]
}

export function getPipelineModule(tier: 'simple' | 'medium' | 'large'): string {
  const skills = getPipeline(tier)
  const stageNames = skills.map((s) => s.name).join(' → ')
  const modules = skills.map((s) => s.promptModule)
  return `## 🎯 ${tier === 'simple' ? '简单' : tier === 'medium' ? '中等' : '大型'}任务 Pipeline（已激活）
Pipeline: ${stageNames}

${modules.join('\n\n')}`
}

// ---- Standalone Skill Matching ----

const STANDALONE_TRIGGERS: Array<{ name: string; patterns: RegExp[] }> = [
  {
    name: 'brainstorming',
    patterns: [/头脑风暴/i, / brainstorm/i, /讨论方案/i, /选型/i, /方案对比/i, /怎么选/i, /用哪个/i],
  },
  {
    name: 'test-driven-development',
    patterns: [/tdd/i, /测试驱动/i, /先写测试/i, /red.green/i, /红绿/i],
  },
  {
    name: 'requesting-code-review',
    patterns: [/code.?review/i, /代码审查/i, /review/i, /审查代码/i, /审一下/i, /看看代码/i],
  },
  {
    name: 'systematic-debugging',
    patterns: [/debug/i, /调试/i, /报错/i, /打不开/i, /启动不了/i, /不行/i, /坏了/i, /异常/i, /出错了/i, /bug/i],
  },
  {
    name: 'writing-plans',
    patterns: [/计划/i, /plan/i, /规划/i, /怎么实现/i, /怎么做/i],
  },
  {
    name: 'subagent-driven-development',
    patterns: [/子任务/i, /拆分/i, /并行/i, /sub.?agent/i, /大任务/i, /步骤太多/i],
  },
  {
    name: 'using-git-worktrees',
    patterns: [/worktree/i, /分支隔离/i, /并行分支/i, /git.?worktree/i],
  },
  {
    name: 'refactoring',
    patterns: [/重构/i, /提取/i, /抽取/i, /拆分文件/i, /refactor/i, /重命名/i],
  },
  {
    name: 'migration',
    patterns: [/迁移/i, /migrat/i, /升级.*(?:方案|工具|库)/i, /从.*转到/i, /替换.*方案/i],
  },
  {
    name: 'documentation',
    patterns: [/文档/i, /readme/i, /changelog/i, /api文档/i, /注释/i, /doc/i],
  },
  {
    name: 'performance-profiling',
    patterns: [/性能/i, /优化/i, /慢/i, /卡顿/i, /cpu.*高/i, /内存.*泄漏/i, /profiling/i],
  },
  {
    name: 'integration-testing',
    patterns: [/集成测试/i, /e2e/i, /端到端/i, /integration.?test/i, /全链路/i, /联调/i],
  },
]

export function matchStandaloneSkills(taskDescription: string): SkillDef[] {
  const matched: SkillDef[] = []
  for (const trigger of STANDALONE_TRIGGERS) {
    if (trigger.patterns.some((p) => p.test(taskDescription))) {
      const skill = STANDALONE_SKILLS.find((s) => s.name === trigger.name)
      if (skill) matched.push(skill)
    }
  }
  return matched
}

// ---- Complexity Analysis ----

export type TaskTier = 'simple' | 'medium' | 'large'

const SIMPLE_PATTERNS = [
  /改(n?[文文案样式]|样式|文案|bug|Bug|bugzilla)/i,
  /增[加]?[个字一]?字段/i,
  /修[改复]?[一个]?bug/i,
  /改[变]?颜色/i,
  /修[改变更]?样式/i,
]

const LARGE_PATTERNS = [/新系统/i, /架构[升升级改造]/i, /技术栈[迁迁徙更变]/i, /从.*迁移到/i, /重写/i, /全新[模块系统]/i, /系统设计/i]

export function analyzeComplexity(taskDescription: string): { tier: TaskTier; reason: string } {
  for (const p of LARGE_PATTERNS) {
    if (p.test(taskDescription)) return { tier: 'large', reason: '检测到架构级变更关键词' }
  }
  for (const p of SIMPLE_PATTERNS) {
    if (p.test(taskDescription)) return { tier: 'simple', reason: '检测到简单修改关键词' }
  }
  const len = taskDescription.length
  if (len > 80) return { tier: 'medium', reason: '描述较长，需要规划' }
  if (len > 30) return { tier: 'medium', reason: '中等复杂度任务' }
  return { tier: 'simple', reason: '简短指令，直接执行' }
}

// ---- Cold Start / Incremental ----

const ASSET_FILES = ['architecture.md', 'coding-rules.md', 'domain-model.md', 'test-strategy.md']

/** 检查项目是否已有初始化知识资产 */
export function checkColdStart(projectDir: string): { isColdStart: boolean; existing: string[] } {
  const kbDir = resolve(projectDir, 'knowledge-base')
  if (!existsSync(kbDir)) return { isColdStart: true, existing: [] }
  const existing = ASSET_FILES.filter((f) => existsSync(join(kbDir, f)))
  return { isColdStart: existing.length < ASSET_FILES.length, existing }
}

export function getColdStartPrompt(): string {
  return `## ❄️ Cold Start 模式（首次开发）

这是第一次开发该项目，必须先建立基础工程资产。

请依次创建以下文件到 evolution_workspace/knowledge-base/：
1. **architecture.md** — 系统架构设计（模块划分、数据流、技术选型）
2. **coding-rules.md** — 编码规范（命名、结构、约定）
3. **domain-model.md** — 领域模型（核心实体和关系）
4. **test-strategy.md** — 测试策略（测试范围、工具、覆盖率目标）

完成以上资产创建后，继续按任务对应的 pipeline 执行。`
}

export function getIncrementalPrompt(kbDir: string, existing: string[]): string {
  const files = existing.map((f) => `- knowledge-base/${f}`).join('\n')
  return `## 📖 Incremental 模式

已有知识资产。请先 read_file 读取以下文件了解项目上下文：
${files}

理解后，按任务对应的 pipeline 执行。`
}

// ---- List ----

export function listWorkflows(): string {
  return ALL_SKILLS.map((s) => {
    const tag = s.isStage ? '[Pipeline阶段]' : '[独立技能]'
    return `- ${s.name} ${tag}: ${s.description}`
  }).join('\n')
}

export function getAllSkills(): SkillDef[] {
  return ALL_SKILLS
}
