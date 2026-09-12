import type { CapabilityProviderAdapter } from '@akemi-mio/capabilities/capability/types'

/**
 * social-publish adapter — canonical publish params 直传 provider 工具参数
 *
 * publishing 的 canonical 契约即 social_publish 工具的入参
 * （content / platform / title / replyToId / dryRun），转换保持最小。
 */
export const socialPublishAdapter: CapabilityProviderAdapter = (input: unknown, _tool: string): unknown => input


