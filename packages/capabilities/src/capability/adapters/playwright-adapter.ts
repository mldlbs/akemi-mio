import type { CapabilityProviderAdapter } from '@akemi-mio/capabilities/capability/types'

/**
 * playwright browser.automation adapter —
 * canonical browser params → playwright tool params
 *
 * Canonical input:
 *   { action: "navigate"|"click"|"extract"|"screenshot",
 *     url?: string,
 *     selector?: string,
 *     text?: string }
 *
 * Playwright tool input:
 *   { action: string, url?: string, selector?: string, text?: string }
 *
 * This adapter is intentionally thin — browser.automation is too coarse
 * (see ADR-015 P1.3b granularity concern D2). For Phase A, we map
 * the canonical action/url/selector interface to playwright params.
 */
export const playwrightAdapter: CapabilityProviderAdapter = (input: unknown, _tool: string): unknown => {
  const raw = input as Record<string, unknown>
  const inferredAction = raw.action ?? (typeof raw.url === 'string' && raw.url.length > 0 ? 'navigate' : undefined)

  // Validate required fields
  if (!inferredAction) {
    throw new Error('browser.automation requires "action" parameter')
  }

  return {
    action: inferredAction,
    url: raw.url ?? undefined,
    selector: raw.selector ?? undefined,
    text: raw.text ?? undefined,
    scrollTo: raw.scrollTo ?? undefined,
    waitFor: raw.waitFor ?? undefined,
  }
}


