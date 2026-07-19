/**
 * PlanStepMapper — 进化计划步骤 → CI/CD MCP 工具映射器
 *
 * 将 Evolution 计划步骤的描述文本与 CI/CD 操作关键词匹配，
 * 自动映射到对应的 MCP CI/CD 工具调用。
 *
 * 匹配规则：
 * - 优先匹配 explicit 工具名（如 "[typecheck]"）
 * - 其次匹配关键词
 * - 不匹配时返回 'unknown'
 */

import type { CicdAction, StepMapping } from './types'

// ==============================================================================
// 默认映射表
// ==============================================================================

const DEFAULT_MAPPINGS: StepMapping[] = [
  {
    keywords: ['tsc', 'typecheck', 'type-check', 'type check', '编译检查', '类型检查', '编译验证'],
    action: 'typecheck',
    toolName: 'cicd_typecheck',
    description: 'TypeScript 编译检查',
  },
  {
    keywords: ['eslint', 'lint', '代码规范', 'lint检查', 'eslint检查', '代码质量检查'],
    action: 'lint',
    toolName: 'cicd_lint',
    description: 'ESLint 代码规范检查',
  },
  {
    keywords: ['test', '测试', '单元测试', 'vitest', 'ut', '跑测试', '运行测试'],
    action: 'test',
    toolName: 'cicd_test',
    description: '测试运行',
  },
  {
    keywords: ['build', '构建', '编译', '打包', 'npm run build', 'vite build'],
    action: 'build',
    toolName: 'cicd_build',
    description: '项目构建',
  },
  {
    keywords: ['文档', 'docs', 'documentation', 'typedoc', '文档构建', 'api文档'],
    action: 'build_docs',
    toolName: 'cicd_build_docs',
    description: '文档构建',
  },
  {
    keywords: ['deploy', '部署', '发布', '预览', 'preview', '自动发布', '上线'],
    action: 'deploy_preview',
    toolName: 'cicd_deploy_preview',
    description: '预览部署',
  },
  {
    keywords: ['quality', 'gate', '门禁', '质量门禁', '质量检查', '综合检查', '全量检查', '全部检查'],
    action: 'quality_gate',
    toolName: 'cicd_quality_gate',
    description: '综合质量门禁',
  },
]

// ==============================================================================
// PlanStepMapper
// ==============================================================================

export class PlanStepMapper {
  private mappings: StepMapping[]

  constructor(mappings?: StepMapping[]) {
    this.mappings = mappings || DEFAULT_MAPPINGS
  }

  /**
   * 根据步骤描述匹配 CI/CD 操作
   */
  map(stepDescription: string): { action: CicdAction; toolName: string; description: string } {
    const lower = stepDescription.toLowerCase()

    // 1. 尝试匹配 explicit 标记 [toolname]
    const explicitMatch = lower.match(/\[(typecheck|lint|test|build|build_docs|deploy_preview|quality_gate)\]/)
    if (explicitMatch) {
      const action = explicitMatch[1] as CicdAction
      const mapping = this.mappings.find((m) => m.action === action)
      if (mapping) {
        return { action: mapping.action, toolName: mapping.toolName, description: mapping.description }
      }
    }

    // 2. 关键词匹配
    for (const mapping of this.mappings) {
      if (mapping.keywords.some((kw) => lower.includes(kw))) {
        return { action: mapping.action, toolName: mapping.toolName, description: mapping.description }
      }
    }

    // 3. 不匹配
    return { action: 'unknown', toolName: '', description: '' }
  }

  /**
   * 判断步骤是否可映射为 CI/CD 操作
   */
  isMappable(stepDescription: string): boolean {
    return this.map(stepDescription).action !== 'unknown'
  }

  /**
   * 获取所有支持的映射
   */
  getMappings(): StepMapping[] {
    return this.mappings
  }

  /**
   * 添加自定义映射
   */
  addMapping(mapping: StepMapping): void {
    this.mappings.push(mapping)
  }
}

/** 全局单例 */
export const planStepMapper = new PlanStepMapper()
