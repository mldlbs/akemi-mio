import { describe, expect, it } from 'vitest'
import { resolveRouteExecutionPolicy } from '@akemi-mio/intelligence/agent/routing/routePolicy'
import type { IntentRouteDecision } from '@akemi-mio/intelligence/agent/routing/types'

describe('resolveRouteExecutionPolicy', () => {
  it('keeps non-destructive tools available for chat_only so misclassification cannot block execution', () => {
    expect(resolveRouteExecutionPolicy({ route: 'chat_only', confidence: 1, reason: 'casual' })).toEqual({
      toolChoiceMode: 'auto',
      allowedToolNames: ['web_search', 'web_fetch', 'list_files', 'read_file', 'grep', 'analyze_codebase', 'list_plans'],
    })
  })

  it('does not expose destructive tools in chat_only', () => {
    const { allowedToolNames } = resolveRouteExecutionPolicy({ route: 'chat_only', confidence: 1, reason: 'casual' })
    expect(allowedToolNames).toEqual(
      expect.not.arrayContaining(['run_command', 'write_file', 'edit_file', 'delete_file', 'cicd_build', 'blog_publish']),
    )
  })

  it('limits observe_first to read-only tools and requires a call', () => {
    expect(resolveRouteExecutionPolicy({ route: 'observe_first', confidence: 0.8, reason: 'inspect' })).toEqual({
      toolChoiceMode: 'required',
      allowedToolNames: ['list_files', 'read_file', 'grep', 'analyze_codebase'],
    })
  })

  it.each(['tool_first', 'tool_required'] as const)('requires tools without an allowlist for %s', (route) => {
    const decision: IntentRouteDecision = { route, confidence: 0.9, reason: 'task' }

    expect(resolveRouteExecutionPolicy(decision)).toEqual({
      toolChoiceMode: 'required',
      allowedToolNames: undefined,
    })
  })
})
