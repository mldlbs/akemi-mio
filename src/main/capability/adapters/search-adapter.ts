import type { CapabilityProviderAdapter } from '../types'

/**
 * search.retrieval adapter — canonical → tool-specific params
 *
 * Canonical input:
 *   { query: string,
 *     scope?: string,
 *     source?: "code"|"web"|"files" }
 *
 * Provider tools:
 *   grep_search  → { pattern: query, path: scope }
 *   glob_find    → { pattern: query, path: scope }
 *   web_search   → { query }
 *   web_fetch    → { url: query }
 */
export const searchAdapter: CapabilityProviderAdapter = (input: unknown, tool: string): unknown => {
  const raw = input as Record<string, unknown>

  switch (tool) {
    case 'grep_search':
    case 'glob_find':
      return {
        pattern: raw.query ?? '',
        path: raw.scope ?? undefined,
      }

    case 'web_search':
      return { query: raw.query ?? '' }

    case 'web_fetch':
      return { url: raw.query ?? '' }

    default:
      return input
  }
}
