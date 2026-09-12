import { describe, it, expect, vi } from 'vitest'
import { MCPRegistry } from '@akemi-mio/intelligence/mcp/MCPRegistry'
import { CapabilityCatalog } from '@akemi-mio/capabilities/capability/CapabilityCatalog'
import { CapabilityResolver } from '@akemi-mio/capabilities/capability/CapabilityResolver'
import { CapabilityServiceImpl } from '@akemi-mio/capabilities/capability/CapabilityServiceImpl'
import { socialPublishAdapter } from '@akemi-mio/capabilities/capability/adapters/social-publish-adapter'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import type { MCPServerManifest } from '@akemi-mio/intelligence/mcp/types'

const PUBLISHING_SCHEMA = {
  type: 'object' as const,
  properties: {
    content: { type: 'string', description: '正文内容，必填' },
    platform: { type: 'string', description: '目标平台: telegram/x/weibo/zhihu/douyin/xiaohongshu/wechat_mp，必填' },
    title: { type: 'string', description: '标题（公众号等平台需要）' },
    replyToId: { type: 'string', description: '回复目标 postId（可选）' },
    dryRun: { type: 'boolean', description: '演练模式：只校验不真实发布（默认 false）' },
  },
  required: ['content', 'platform'],
}

const SOCIAL_PUBLISH_MANIFEST: MCPServerManifest = {
  id: 'social-publish',
  name: 'Social Media Publishing',
  version: '1.0.0',
  runtime: { command: 'node', args: [] },
  capabilities: ['publishing'],
  capabilitySchemas: { publishing: PUBLISHING_SCHEMA },
  dependencies: [{ capability: 'publishing', tool: 'social_publish' }],
  permissions: ['network.http'],
}

const FANQIE_PUBLISH_MANIFEST: MCPServerManifest = {
  id: 'fanqie-publish',
  name: 'Fanqie Novel Publishing',
  version: '1.0.0',
  runtime: { command: 'node', args: [] },
  capabilities: ['publishing'],
  capabilitySchemas: { publishing: PUBLISHING_SCHEMA },
  dependencies: [{ capability: 'publishing', tool: 'fanqie_publish_novel' }],
  permissions: ['network.http'],
}

function buildFixture(): { resolver: CapabilityResolver; catalog: CapabilityCatalog } {
  const registry = new MCPRegistry()
  // 注册顺序与 AppRuntime 一致：social-publish 先于 fanqie-publish
  registry.register(SOCIAL_PUBLISH_MANIFEST)
  registry.register(FANQIE_PUBLISH_MANIFEST)
  const catalog = new CapabilityCatalog(registry)
  catalog.rebuild()
  return { resolver: new CapabilityResolver(catalog), catalog }
}

describe('SocialPublish capability（Phase 1）', () => {
  const { resolver, catalog } = buildFixture()

  it('publishing 在 catalog 中带非空 canonical inputSchema（C-8）', () => {
    const def = catalog.get('publishing')
    expect(def).toBeDefined()
    const props = def!.inputSchema.properties
    expect(Object.keys(props).sort()).toEqual(['content', 'dryRun', 'platform', 'replyToId', 'title'])
    expect(def!.inputSchema.required).toEqual(['content', 'platform'])
  })

  it('resolve(publishing) 无 toolHint 时解析到 social-publish（G1）', () => {
    const result = resolver.resolve('publishing')
    expect(result).toBeDefined()
    expect(result!.provider.mcpServerId).toBe('social-publish')
    expect(result!.provider.tool).toBe('social_publish')
  })

  it('resolve(publishing, fanqie_publish_novel) 可回到 fanqie provider', () => {
    const result = resolver.resolve('publishing', 'fanqie_publish_novel')
    expect(result).toBeDefined()
    expect(result!.provider.mcpServerId).toBe('fanqie-publish')
    expect(result!.provider.tool).toBe('fanqie_publish_novel')
  })

  it('resolveByTool(social_publish) 反解回 publishing', () => {
    const result = resolver.resolveByTool('social_publish')
    expect(result).toBeDefined()
    expect(result!.capabilityId).toBe('publishing')
  })

  it('socialPublishAdapter 为直传（canonical 契约即工具参数）', () => {
    const input = { platform: 'telegram', content: 'hi', title: 't', dryRun: false }
    expect(socialPublishAdapter(input, 'social_publish')).toEqual(input)
  })

  it('invoke 经 adapter 直传并在事件总线产生 capability 调用记录（G3 事件证据）', async () => {
    const { resolver } = buildFixture()
    const callTool = vi.fn().mockResolvedValue('tool-result')
    const serverManager = { callTool, getAllSchemas: vi.fn().mockReturnValue([]) } as any
    const service = new CapabilityServiceImpl(resolver, serverManager)
    service.setAdapter('social-publish', 'social_publish', socialPublishAdapter)

    const invoked: any[] = []
    const completed: any[] = []
    const onInvoked = (p: any) => invoked.push(p)
    const onCompleted = (p: any) => completed.push(p)
    eventBus.on('capability.invoked', onInvoked)
    eventBus.on('capability.completed', onCompleted)
    try {
      const binding = await service.resolve('publishing')
      expect(binding?.tool).toBe('social_publish')

      const input = { platform: 'telegram', content: 'hi', dryRun: true }
      const result = await service.invoke(binding!, input)

      expect(result).toBe('tool-result')
      expect(callTool).toHaveBeenCalledWith('social_publish', input)
      expect(invoked.some((p) => p.capability === 'publishing' && p.tool === 'social_publish')).toBe(true)
      expect(completed.some((p) => p.capability === 'publishing' && p.success === true)).toBe(true)
    } finally {
      eventBus.off('capability.invoked', onInvoked)
      eventBus.off('capability.completed', onCompleted)
    }
  })
})
