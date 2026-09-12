import type { ToolCallInfo } from '@akemi-mio/intelligence/llm/LlmService'
import type { ToolResult } from '@akemi-mio/intelligence/agent/ToolScheduler'
import type { Evidence } from './types'

/** 只读观察工具：不产生执行证据 */
const READ_ONLY_TOOLS = new Set(['list_files', 'read_file', 'grep', 'analyze_codebase', 'search_files', 'file_info'])

/** 文件变更工具 */
const FILE_CHANGE_TOOLS = new Set(['write_file', 'edit_file', 'move_file', 'copy_file', 'delete_file', 'apply_patch'])

/** 产物/发布工具 */
const ARTIFACT_TOOLS = new Set([
  'generate_image',
  'card_generator',
  'generate_podcast',
  'social_publish',
  'fanqie_publish_novel',
  'blog_publish',
])

/** 命令执行工具 */
const COMMAND_TOOLS = new Set(['run_command', 'execute_command', 'centos_exec'])

const TEST_FAIL_RE = /\b(failed|failing|[1-9]\d* failures?|[1-9]\d* errors?|tests? failed|exit code [1-9])\b/i
const TEST_PASS_RE = /\b(passed|passing|all tests? pass(ed)?|0 failures?|0 errors?)\b/i
const ARTIFACT_MARKER_RE = /\b(created|saved|generated|wrote|written|published|exported)\b/i

/**
 * 收集并分类工具执行结果，生成确定性证据。
 * M6.1 支持 test_result / file_changed / artifact_created / command_success|failure
 * 命令工具中 success=false 会交给 GoalEvaluator 判 blocked。
 */
export function collectEvidence(toolCalls: ToolCallInfo[], toolResults: ToolResult[], step: number): Evidence[] {
  const evidence: Evidence[] = []
  const now = Date.now()
  for (const tr of toolResults) {
    const call = toolCalls.find((tc) => tc.id === tr.id)
    const toolName = tr.name || call?.name || ''
    if (!toolName || READ_ONLY_TOOLS.has(toolName)) continue

    const base = { tool: toolName, step, success: tr.success, createdAt: now }
    const content = tr.content || ''

    if (COMMAND_TOOLS.has(toolName)) {
      const testResult = classifyTestResult(content)
      if (testResult) {
        evidence.push({ ...base, type: 'test_result', value: testResult, detail: content.slice(0, 200) })
        continue
      }
      if (tr.success && ARTIFACT_MARKER_RE.test(content)) {
        evidence.push({ ...base, type: 'artifact_created', value: 'created', detail: content.slice(0, 200) })
        continue
      }
      evidence.push({
        ...base,
        type: tr.success ? 'command_success' : 'command_failure',
        value: tr.success ? 'ok' : 'failed',
        detail: tr.error || content.slice(0, 200),
      })
      continue
    }

    if (FILE_CHANGE_TOOLS.has(toolName)) {
      evidence.push({ ...base, type: 'file_changed', value: tr.success ? 'changed' : 'failed' })
      continue
    }

    if (ARTIFACT_TOOLS.has(toolName)) {
      evidence.push({ ...base, type: 'artifact_created', value: tr.success ? 'created' : 'failed' })
      continue
    }

    // 其他工具按成功/失败归类
    evidence.push({
      ...base,
      type: tr.success ? 'command_success' : 'command_failure',
      value: tr.success ? 'ok' : 'failed',
    })
  }
  return evidence
}

function classifyTestResult(content: string): 'passed' | 'failed' | null {
  if (!content) return null
  if (TEST_FAIL_RE.test(content)) return 'failed'
  if (TEST_PASS_RE.test(content)) return 'passed'
  return null
}
