import { describe, it, expect } from 'vitest'
import { collectEvidence } from '@akemi-mio/evolution/goals/EvidenceCollector'
import type { ToolCallInfo } from '@akemi-mio/intelligence/llm/LlmService'
import type { ToolResult } from '@akemi-mio/intelligence/agent/ToolScheduler'

function call(name: string, id = 'c-1'): ToolCallInfo {
  return { id, name, arguments: '{}' } as ToolCallInfo
}

function result(name: string, success: boolean, content = '', id = 'c-1'): ToolResult {
  return { id, name, success, content, latencyMs: 1 }
}

describe('EvidenceCollector (M6.1 deterministic)', () => {
  it('classifies run_command test output as test_result passed', () => {
    const evidence = collectEvidence([call('run_command')], [result('run_command', true, 'Tests passed: 12')], 0)
    expect(evidence).toEqual([
      expect.objectContaining({ type: 'test_result', value: 'passed', tool: 'run_command', step: 0, success: true }),
    ])
  })

  it('classifies run_command failure output as test_result failed', () => {
    const evidence = collectEvidence([call('run_command')], [result('run_command', true, '3 failures, 5 passed')], 1)
    expect(evidence[0]).toMatchObject({ type: 'test_result', value: 'failed' })
  })

  it('classifies file-change tools as file_changed', () => {
    for (const name of ['write_file', 'edit_file', 'move_file', 'copy_file', 'delete_file']) {
      const evidence = collectEvidence([call(name)], [result(name, true, 'ok')], 0)
      expect(evidence[0]).toMatchObject({ type: 'file_changed', value: 'changed', tool: name })
    }
  })

  it('classifies artifact tools as artifact_created', () => {
    const evidence = collectEvidence([call('generate_image')], [result('generate_image', true, 'image saved')], 0)
    expect(evidence[0]).toMatchObject({ type: 'artifact_created', value: 'created' })
  })

  it('classifies run_command with artifact markers as artifact_created', () => {
    const evidence = collectEvidence([call('run_command')], [result('run_command', true, 'output saved to dist/app.exe')], 0)
    expect(evidence[0]).toMatchObject({ type: 'artifact_created', value: 'created' })
  })

  it('records failed commands as command_failure with success=false', () => {
    const evidence = collectEvidence([call('run_command')], [result('run_command', false, '', 'c-1')], 0)
    expect(evidence[0]).toMatchObject({ type: 'command_failure', success: false, value: 'failed' })
  })

  it('records generic successful tools as command_success', () => {
    const evidence = collectEvidence([call('start_workflow')], [result('start_workflow', true, 'started')], 0)
    expect(evidence[0]).toMatchObject({ type: 'command_success', value: 'ok', success: true })
  })

  it('skips read-only observation tools', () => {
    const evidence = collectEvidence(
      [call('read_file'), call('grep')],
      [result('read_file', true, 'content'), result('grep', true, 'match')],
      0,
    )
    expect(evidence).toEqual([])
  })
})
