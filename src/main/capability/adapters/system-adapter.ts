import type { CapabilityProviderAdapter } from '../types'

/**
 * system.execution adapter — canonical → tool-specific params
 *
 * Canonical input:
 *   { command: string,
 *     args?: string[],
 *     language?: "bash"|"python" }
 *
 * Provider tools:
 *   run_command    → { command }
 *   bash_execute   → { command }
 *   execute_python → { code: command }
 */
export const systemAdapter: CapabilityProviderAdapter = (input: unknown, tool: string): unknown => {
  const raw = input as Record<string, unknown>

  switch (tool) {
    case 'run_command':
    case 'bash_execute':
      return { command: raw.command ?? '' }

    case 'execute_python':
      return { code: raw.command ?? '' }

    default:
      return input
  }
}
