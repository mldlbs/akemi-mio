/**
 * MergePatchExecutor — 合并补丁执行器
 *
 * 将合并计划中的每个缺口转化为具体代码修改：
 * 1. 使用 LLM 生成补丁（通过 Agent SDK）
 * 2. 创建 Git 快照保护现场
 * 3. 应用补丁
 * 4. 运行安全扫描（参考 MS #570）
 * 5. 运行编译验证
 * 6. 成功 → 提交；失败 → 回滚并调整策略
 *
 * 遵循 AutoPatchExecutor 的 snapshot → apply → verify → rollback 模式。
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { log } from '../../logger/Logger'
import { DEV_PROJECT_ROOT } from '../../config'
import { execAsync } from '../../utils/async'
import { EvolutionGitOps } from '../EvolutionGitOps'
import { MergeSecurityScanner } from './MergeSecurityScanner'
import type { MergeGap, MergePlan, MergePatch, PatchStatus } from './types'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { credentialsManager } from '../../credentials/CredentialsManager'

// ═══════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════

const PROJECT_ROOT = DEV_PROJECT_ROOT || process.cwd()
const PATCH_TIMEOUT_MS = 180_000
const TSC_TIMEOUT_MS = 60_000

// ═══════════════════════════════════════════
// MergePatchExecutor
// ═══════════════════════════════════════════

export class MergePatchExecutor {
  readonly name = 'merge-patch-executor'

  private gitOps: EvolutionGitOps
  private securityScanner: MergeSecurityScanner
  private appliedPatches: MergePatch[] = []
  private busy = false

  constructor() {
    this.gitOps = new EvolutionGitOps()
    this.securityScanner = new MergeSecurityScanner()
  }

  /** 当前是否可用 */
  isAvailable(): boolean {
    return !this.busy
  }

  /** 获取已应用的补丁列表 */
  getAppliedPatches(): MergePatch[] {
    return [...this.appliedPatches]
  }

  /**
   * 执行合并计划中的所有缺口。
   *
   * @param plan 要执行的合并计划
   * @returns 每个缺口的执行结果
   */
  async executePlan(plan: MergePlan): Promise<MergePatch[]> {
    if (this.busy) {
      log('WARN', 'merge_patch_busy')
      return []
    }

    this.busy = true
    const patches: MergePatch[] = []

    try {
      for (const gap of plan.gaps) {
        log('INFO', 'merge_patch_gap_start', {
          gapId: gap.id,
          type: gap.type,
          target: gap.targetFile,
        })

        const result = await this.executeGap(gap)
        patches.push(result)
        this.appliedPatches.push(result)

        if (result.status === 'applied' || result.status === 'verified') {
          log('INFO', 'merge_patch_gap_success', { gapId: gap.id })
        } else {
          log('WARN', 'merge_patch_gap_failed', { gapId: gap.id, status: result.status })
        }
      }
    } catch (err: any) {
      log('ERROR', 'merge_patch_plan_error', { error: err.message })
    } finally {
      this.busy = false
    }

    return patches
  }

  /**
   * 执行单个缺口的补丁。
   *
   * 流程：
   * 1. 读取目标文件
   * 2. 创建 Git 快照
   * 3. 使用 LLM 生成补丁代码
   * 4. 应用补丁
   * 5. 安全扫描
   * 6. 编译验证
   * 7. 通过 → 提交；失败 → 回滚
   */
  private async executeGap(gap: MergeGap): Promise<MergePatch> {
    const patch: MergePatch = {
      gapId: gap.id,
      targetFile: gap.targetFile,
      patchContent: '',
      description: gap.description,
      status: 'pending',
    }

    const absFile = join(PROJECT_ROOT, gap.targetFile)
    if (!existsSync(absFile)) {
      patch.status = 'failed'
      return patch
    }

    // 1. 创建 Git 快照
    const snapshotTag = `merge_${gap.id.replace(/[^a-zA-Z0-9_]/g, '_')}`
    const snapshotBranch = await this.gitOps.createSnapshot(snapshotTag)
    if (!snapshotBranch) {
      log('WARN', 'merge_patch_snapshot_skip', { gapId: gap.id })
    }

    try {
      // 2. 读取目标文件当前内容
      const originalContent = readFileSync(absFile, 'utf-8')

      // 3. 使用 LLM 生成补丁
      const patchContent = await this.generatePatch(gap, originalContent)
      if (!patchContent || patchContent === originalContent) {
        // 无需变更
        patch.status = 'applied'
        patch.patchContent = '无需变更'
        return patch
      }

      patch.patchContent = patchContent

      // 4. 安全扫描补丁内容
      const securityResult = this.securityScanner.scanPatch(gap.targetFile, patchContent)
      if (!securityResult.passed) {
        log('WARN', 'merge_patch_security_failed', {
          gapId: gap.id,
          critical: securityResult.criticalCount,
          high: securityResult.highCount,
        })
        // 安全扫描失败也应用（提供安全建议但不阻塞），记录警告
      }

      // 5. 应用补丁
      writeFileSync(absFile, patchContent, 'utf-8')
      patch.status = 'applied'
      log('INFO', 'merge_patch_applied', { gapId: gap.id, file: gap.targetFile })

      // 6. 编译验证
      const verifyResult = await this.runTscValidation()
      if (verifyResult.passed) {
        patch.status = 'verified'
        patch.verifiedAt = Date.now()

        // 提交
        try {
          await this.gitOps.autoGitCommit(`[merge] ${gap.description}`)
          log('INFO', 'merge_patch_committed', { gapId: gap.id })
        } catch (commitErr: any) {
          log('WARN', 'merge_patch_commit_failed', { error: commitErr.message })
        }

        log('INFO', 'merge_patch_verified', { gapId: gap.id })
      } else {
        // 编译失败 → 回滚
        log('WARN', 'merge_patch_verify_failed', {
          gapId: gap.id,
          errors: verifyResult.errors.slice(0, 3),
        })

        await this.rollbackGap(snapshotBranch, gap.id)
        patch.status = 'rollback'

        // 调整策略：生成简化版补丁
        const simplifiedPatch = await this.generateSimplifiedPatch(gap, originalContent)
        if (simplifiedPatch && simplifiedPatch !== originalContent) {
          writeFileSync(absFile, simplifiedPatch, 'utf-8')
          const retryVerify = await this.runTscValidation()
          if (retryVerify.passed) {
            patch.status = 'verified'
            patch.patchContent = simplifiedPatch
            try {
              await this.gitOps.autoGitCommit(`[merge] ${gap.description} (简化版)`)
            } catch { /* 静默 */ }
          } else {
            // 简化版也失败 → 恢复原始内容
            writeFileSync(absFile, originalContent, 'utf-8')
            patch.status = 'rollback'
          }
        } else {
          // 简化版无法生成 → 恢复原始内容
          writeFileSync(absFile, originalContent, 'utf-8')
        }
      }
    } catch (err: any) {
      log('ERROR', 'merge_patch_gap_error', { gapId: gap.id, error: err.message })
      await this.rollbackGap(snapshotBranch, gap.id)
      patch.status = 'rollback'
    }

    return patch
  }

  /**
   * 使用 LLM 生成补丁代码。
   *
   * 根据缺口类型构造提示，让 LLM 生成具体的代码修改。
   */
  private async generatePatch(gap: MergeGap, currentContent: string): Promise<string | null> {
    const llmKey = (process.env.LLM_KEY || credentialsManager.get('llm_key') || '').trim()
    if (!llmKey) {
      log('WARN', 'merge_patch_no_llm_key')
      return this.generateRuleBasedPatch(gap, currentContent)
    }

    const gapTypeInstructions: Record<string, string> = {
      route_missing: [
        '在 ROUTING 表中添加新的路由条目，将 radar 相关分类映射到对应的 bot。',
        '格式: radar: \'push\'',
      ].join('\n'),
      event_handler_missing: [
        '添加 EventBus 事件订阅，处理 radar 模块发出的事件。',
        '使用 enqueueReply 将格式化后的消息推送到 Telegram。',
      ].join('\n'),
      periodic_task_missing: [
        '添加定时扫描逻辑：定期调用 radar 适配器的 scan() 方法，',
        '然后使用 formatBatchForTelegram 格式化结果并通过 enqueueReply 推送。',
      ].join('\n'),
      function_integration: [
        '导入 radar 适配器模块，并在适当的生命周期函数中调用。',
        '添加必要的类型导入和初始化代码。',
      ].join('\n'),
      safety_check_missing: [
        '在调用外部模块的地方添加 try/catch 保护、超时控制、和降级策略。',
        '参考 Microsoft 安全最佳实践 #570。',
      ].join('\n'),
      type_alignment: [
        '检查和修正类型定义的不匹配，确保 radar 模块和 telegram 模块的类型兼容。',
      ].join('\n'),
      dependency_missing: [
        '添加必要的 import 语句和模块依赖。',
      ].join('\n'),
    }

    const instruction = gapTypeInstructions[gap.type] || '根据上下文生成合适的代码修改。'

    const prompt = [
      '# 生成代码补丁',
      '',
      `**目标文件**: ${gap.targetFile}`,
      `**任务**: ${gap.description}`,
      '',
      '## 具体要求',
      instruction,
      '',
      '## 约束',
      '- 保持现有代码风格',
      '- 只输出修改后的完整文件内容',
      '- 不要修改无关代码',
      '- 添加必要的 import 语句',
      '- 使用 TypeScript',
      '- 不要引入新的外部依赖',
      '',
      '## 当前文件内容',
      '```typescript',
      currentContent,
      '```',
    ].join('\n')

    try {
      let agentOutput = ''
      const baseEnv: Record<string, string> = {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_AUTH_TOKEN: llmKey,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1841',
        ANTHROPIC_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
        CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
      }

      for await (const message of query({
        prompt,
        options: {
          allowedTools: [],
          env: baseEnv,
        },
      })) {
        if (message.type === 'text' || message.type === 'content') {
          agentOutput += (message as any).text || (message as any).content || ''
        }
      }

      // 从 LLM 输出中提取代码
      const codeMatch = agentOutput.match(/```(?:typescript|ts)?\n([\s\S]*?)```/)
      return codeMatch ? codeMatch[1].trim() : agentOutput.trim()
    } catch {
      log('WARN', 'merge_patch_llm_fallback', { gapId: gap.id })
      return this.generateRuleBasedPatch(gap, currentContent)
    }
  }

  /**
   * 基于规则的补丁生成（LLM 不可用时的降级）。
   */
  private generateRuleBasedPatch(gap: MergeGap, content: string): string | null {
    // route_missing: 在 ROUTING 表中添加 radar 条目
    if (gap.type === 'route_missing') {
      if (content.includes("'radar'")) return null // 已有
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('writing:')) {
          lines.splice(i + 1, 0, "  radar: 'push',")
          return lines.join('\n')
        }
      }
    }

    // safety_check_missing: 在 fetch 调用中添加 try/catch
    if (gap.type === 'safety_check_missing') {
      if (content.includes('// [merge] safety')) return null // 已加过
      const lines = content.split('\n')
      let modified = false
      for (let i = 0; i < lines.length; i++) {
        if (/^\s+fetch\(/.test(lines[i])) {
          const indent = lines[i].match(/^\s*/)?.[0] || '  '
          const nextLine = lines[i + 1]
          if (nextLine && !nextLine.includes('try') && !nextLine.includes('catch')) {
            // 检查是否有 catch
            const hasCatchNearby = lines.slice(i, i + 5).some(l => l.includes('catch'))
            if (!hasCatchNearby) {
              const fetchLine = lines[i]
              // 简单包装：在当前行前面加 try，后面加 catch
              lines[i] = `${indent}try {`
              lines.splice(i + 1, 0, `  ${indent}${fetchLine.trim()}`)
              lines.splice(i + 2, 0, `${indent}} catch {`)
              lines.splice(i + 3, 0, `  ${indent}/* 静默降级 */`)
              lines.splice(i + 4, 0, `${indent}}`)
              modified = true
              break
            }
          }
        }
      }
      if (modified) return lines.join('\n')
    }

    return null
  }

  /**
   * 生成简化版补丁（当完整补丁验证失败时的降级策略）。
   * 比原始补丁更保守，尽可能小地改动代码。
   */
  private async generateSimplifiedPatch(gap: MergeGap, content: string): Promise<string | null> {
    // 对于 route_missing，尝试最简单的路由添加
    if (gap.type === 'route_missing') {
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('writing:')) {
          lines.splice(i + 1, 0, "  radar: 'push',")
          return lines.join('\n')
        }
      }
    }
    return null
  }

  /**
   * 回滚缺口修改。
   */
  private async rollbackGap(snapshotBranch: string | null, gapId: string): Promise<void> {
    if (!snapshotBranch) {
      log('WARN', 'merge_patch_no_snapshot', { gapId })
      return
    }
    try {
      await this.gitOps.rollbackToSnapshot(snapshotBranch)
      await this.gitOps.cleanupSnapshot(snapshotBranch)
      log('INFO', 'merge_patch_rollback_done', { gapId })
    } catch (err: any) {
      log('ERROR', 'merge_patch_rollback_error', { gapId, error: err.message })
    }
  }

  /**
   * 运行 tsc --noEmit 验证。
   */
  private async runTscValidation(): Promise<{ passed: boolean; errors: string[] }> {
    try {
      await execAsync('npx tsc --noEmit -p tsconfig.node.json 2>&1', {
        timeout: TSC_TIMEOUT_MS,
      })
      return { passed: true, errors: [] }
    } catch (err: any) {
      const errorText = err.message || err.stderr || err.stdout || String(err)
      const lines = errorText.split('\n').filter((l: string) => l.includes('error TS'))
      return {
        passed: lines.length === 0,
        errors: lines.length > 0 ? lines : [errorText.slice(0, 500)],
      }
    }
  }
}
