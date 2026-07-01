/**
 * ContaminationDetector — 副作用泄露检测（Dimension 7）
 *
 * v0 基于能力元数据做启发式判定：
 * - 无声明依赖 + 长工具链 → 中等风险
 * - 无声明依赖 + 无前置条件 + experimental → 高风险（不通过）
 * - 无声明依赖 + code executor → 中等风险
 */

import { log } from '../../logger/Logger'
import type { Capability } from '../CapabilityRegistry'

// —── Types ──────────────────────────────────────────────

export interface ContaminationResult {
  passed: boolean
  risk: 'low' | 'medium' | 'high'
  suspiciousPaths: string[]
  detail: string
}

// —── ContaminationDetector ──────────────────────────────

export class ContaminationDetector {
  evaluate(capability: Capability): ContaminationResult {
    const hasDeps = capability.dependencies.length > 0
    const hasPreconditions = capability.preconditions.length > 0
    const isToolchain = capability.executor.type === 'toolchain'
    const isCode = capability.executor.type === 'code'
    const isExperimental = capability.tier === 'experimental'
    const isDerived = capability.tier === 'derived'

    const suspiciousPaths: string[] = []

    // 规则 1: 无依赖 + 工具链 > 3 → 中等风险
    if (!hasDeps && isToolchain) {
      const toolCount = capability.executor.body.split('→').filter((s) => s.trim()).length
      if (toolCount > 3) {
        suspiciousPaths.push('executor.body (多步骤工具链，无依赖声明)')
        log('WARN', 'contamination_medium_risk', {
          id: capability.id,
          reason: 'toolchain with no deps',
          toolCount,
        })
        return {
          passed: true,
          risk: 'medium',
          suspiciousPaths,
          detail: `多步骤工具链 (${toolCount} 步) 无依赖声明，存在副作用泄露风险`,
        }
      }
    }

    // 规则 2: 无依赖 + 无前置条件 + experimental → 高风险
    if (!hasDeps && !hasPreconditions && isExperimental) {
      suspiciousPaths.push('declared scope (无任何边界声明)')
      log('WARN', 'contamination_high_risk', {
        id: capability.id,
        reason: 'experimental with no boundaries',
      })
      return {
        passed: false,
        risk: 'high',
        suspiciousPaths,
        detail: 'Experimental 能力无任何依赖/前置条件声明，无法保证边界安全',
      }
    }

    // 规则 3: 无依赖 + 代码执行器 → 中等风险
    if (!hasDeps && isCode) {
      suspiciousPaths.push('executor.body (代码执行器，无依赖声明)')
      return {
        passed: true,
        risk: 'medium',
        suspiciousPaths,
        detail: '代码执行器无依赖声明，无法确认无副作用',
      }
    }

    // 规则 4: derived 无前置条件 → 低风险警告
    if (!hasPreconditions && isDerived) {
      return {
        passed: true,
        risk: 'low',
        suspiciousPaths: [],
        detail: 'Derived 能力无前置条件，建议补充',
      }
    }

    return {
      passed: true,
      risk: 'low',
      suspiciousPaths: [],
      detail: '能力有完整的依赖和前置条件声明，无污染风险',
    }
  }
}
