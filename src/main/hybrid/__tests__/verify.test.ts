/**
 * MCP-Agent Hybrid Pipeline — 简单类型验证
 */
import { describe, it, expect } from 'vitest'

// 验证所有类型导出完整性
describe('McpAgentHybridPipeline exports', () => {
  it('should export all types', async () => {
    const mod = await import('../index')
    expect(mod.McpAgentHybridPipeline).toBeDefined()
    expect(mod.McpAgentArbitrator).toBeDefined()
    expect(mod.DEFAULT_HYBRID_CONFIG).toBeDefined()
  })
})
