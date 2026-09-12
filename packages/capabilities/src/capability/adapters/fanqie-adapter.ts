import type { CapabilityProviderAdapter } from '@akemi-mio/capabilities/capability/types'

/**
 * fanqie-publish adapter — canonical publish params → fanqie tool params
 *
 * Canonical input:
 *   { title: string, content: string, platform?: string }
 *
 * Fanqie tool input:
 *   { novelName: string, content: string, category?: string }
 */
export const fanqiePublishAdapter: CapabilityProviderAdapter = (input: unknown, _tool: string): unknown => {
  const raw = input as Record<string, unknown>

  return {
    novelName: raw.title ?? raw.novelName ?? '',
    content: raw.content ?? '',
    category: raw.platform ?? raw.category ?? undefined,
  }
}


