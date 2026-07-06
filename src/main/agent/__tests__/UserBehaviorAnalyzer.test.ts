/**
 * UserBehaviorAnalyzer 测试
 *
 * 覆盖：
 * 1. 工具调用频率分析
 * 2. 话题模式提取（中文 + 英文）
 * 3. 提示片段生成
 * 4. 用户反馈机制（suppress/confirm）
 * 5. 边界情况：空数据、冷启动、超窗口数据
 */

import { UserBehaviorAnalyzer, userBehaviorAnalyzer } from '../UserBehaviorAnalyzer'

describe('UserBehaviorAnalyzer', () => {
  let analyzer: UserBehaviorAnalyzer

  beforeEach(() => {
    analyzer = new UserBehaviorAnalyzer()
  })

  // ── 工具调用频率分析 ──

  describe('tool frequency analysis', () => {
    it('应该检测到高频工具（超过阈值 3 次）', () => {
      // 模拟：read_file 被调用 5 次，grep 3 次，write_file 1 次
      for (let i = 0; i < 5; i++) analyzer.recordToolCall('read_file')
      for (let i = 0; i < 3; i++) analyzer.recordToolCall('grep')
      analyzer.recordToolCall('write_file')

      const result = analyzer.analyze({ windowSize: 16, highFreqThreshold: 3 })

      expect(result.highFrequencyTools).toContain('read_file')
      expect(result.highFrequencyTools).toContain('grep')
      expect(result.highFrequencyTools).not.toContain('write_file')
      expect(result.toolCallCounts['read_file']).toBe(5)
      expect(result.toolCallCounts['grep']).toBe(3)
    })

    it('高频工具应该按调用次数降序排列', () => {
      for (let i = 0; i < 7; i++) analyzer.recordToolCall('edit_file')
      for (let i = 0; i < 4; i++) analyzer.recordToolCall('read_file')
      for (let i = 0; i < 3; i++) analyzer.recordToolCall('grep')

      const result = analyzer.analyze()

      expect(result.highFrequencyTools[0]).toBe('edit_file')
      expect(result.highFrequencyTools[1]).toBe('read_file')
      expect(result.highFrequencyTools[2]).toBe('grep')
    })

    it('没有高频工具时应返回空数组', () => {
      analyzer.recordToolCall('read_file') // 只有 1 次，低于阈值
      analyzer.recordToolCall('grep')

      const result = analyzer.analyze()

      expect(result.highFrequencyTools).toHaveLength(0)
    })

    it('应该只分析窗口内的数据', () => {
      // 先填满旧数据
      for (let i = 0; i < 20; i++) analyzer.recordToolCall('read_file')
      // 然后添加新数据（在窗口内只有 2 次，低于阈值）
      analyzer.recordToolCall('grep')
      analyzer.recordToolCall('grep')

      const result = analyzer.analyze({ windowSize: 5 })

      // read_file 在窗口内只有 2 个，低于阈值
      expect(result.highFrequencyTools).not.toContain('read_file')
      expect(result.highFrequencyTools).toHaveLength(0)
    })
  })

  // ── 话题模式提取 ──

  describe('topic pattern extraction', () => {
    it('应该从中文消息中提取话题关键词', () => {
      analyzer.recordUserMessage('帮我写一个天气查询的功能代码')
      analyzer.recordUserMessage('这个代码有个 bug 需要调试修复')
      analyzer.recordUserMessage('再帮我写一个部署脚本')

      const result = analyzer.analyze()

      expect(result.recentTopics).toContain('软件开发')
      expect(result.recentTopics).toContain('调试修复')
    })

    it('应该从英文消息中提取话题', () => {
      analyzer.recordUserMessage('please help me debug this issue')
      analyzer.recordUserMessage('can you refactor this code')
      analyzer.recordUserMessage('found a bug in the authentication module')
      analyzer.recordUserMessage('need to fix the error in production')

      const result = analyzer.analyze()

      // debug/bug/error → 调试修复
      expect(result.recentTopics).toContain('调试修复')
      // refactor → 代码重构
      expect(result.recentTopics).toContain('代码重构')
    })

    it('应该从工具调用推断话题', () => {
      for (let i = 0; i < 4; i++) analyzer.recordToolCall('read_file')
      for (let i = 0; i < 3; i++) analyzer.recordToolCall('auto_schedule_workflow')

      const result = analyzer.analyze()

      expect(result.recentTopics).toContain('代码阅读')
      expect(result.recentTopics).toContain('工作流自动化')
    })

    it('空消息时不应提取话题', () => {
      const result = analyzer.analyze()

      expect(result.recentTopics).toHaveLength(0)
    })

    it('话题应该按出现次数降序排列', () => {
      for (let i = 0; i < 5; i++) {
        analyzer.recordUserMessage('帮我写代码实现功能开发')
      }
      for (let i = 0; i < 2; i++) {
        analyzer.recordUserMessage('这个需要调试修复一下 bug')
      }

      const result = analyzer.analyze()

      expect(result.recentTopics[0]).toBe('软件开发')
      expect(result.recentTopics[1]).toBe('调试修复')
    })
  })

  // ── 提示片段生成 ──

  describe('tool hints generation', () => {
    it('检测到高频工具时应生成工具优先级提示', () => {
      for (let i = 0; i < 4; i++) analyzer.recordToolCall('read_file')
      for (let i = 0; i < 3; i++) analyzer.recordToolCall('grep')
      analyzer.recordUserMessage('测试消息')

      const result = analyzer.analyze()

      expect(result.suggestedToolHints.length).toBeGreaterThan(0)
      const toolHint = result.suggestedToolHints.find((h) => h.includes('工具优先级'))
      expect(toolHint).toBeDefined()
      expect(toolHint!).toContain('read_file')
      expect(toolHint!).toContain('grep')
    })

    it('检测到话题时应生成话题感知提示', () => {
      for (let i = 0; i < 3; i++) analyzer.recordUserMessage('今天天气怎么样')
      for (let i = 0; i < 3; i++) analyzer.recordUserMessage('天气预报准确吗')

      const result = analyzer.analyze()

      const topicHint = result.suggestedToolHints.find((h) => h.includes('话题感知'))
      expect(topicHint).toBeDefined()
    })

    it('同时有工具和话题时应生成主动服务提示', () => {
      for (let i = 0; i < 4; i++) analyzer.recordToolCall('read_file')
      for (let i = 0; i < 3; i++) analyzer.recordUserMessage('帮我写代码')

      const result = analyzer.analyze()

      const proactiveHint = result.suggestedToolHints.find((h) => h.includes('主动服务'))
      expect(proactiveHint).toBeDefined()
    })

    it('数据不足时不应生成提示', () => {
      analyzer.recordUserMessage('hi') // 仅 1 条数据

      const result = analyzer.analyze()

      expect(result.hasSufficientData).toBe(false)
    })
  })

  // ── 用户反馈机制 ──

  describe('user feedback', () => {
    it('抑制的工具不应出现在高频列表中', () => {
      for (let i = 0; i < 5; i++) analyzer.recordToolCall('read_file')
      for (let i = 0; i < 3; i++) analyzer.recordToolCall('grep')

      analyzer.suppressTool('read_file')

      const result = analyzer.analyze()

      expect(result.highFrequencyTools).not.toContain('read_file')
      expect(result.highFrequencyTools).toContain('grep')
    })

    it('确认的工具应该排在前面', () => {
      for (let i = 0; i < 3; i++) analyzer.recordToolCall('read_file') // 3 次
      for (let i = 0; i < 5; i++) analyzer.recordToolCall('grep') // 5 次

      analyzer.confirmTool('read_file')

      const result = analyzer.analyze()

      // read_file 虽调用次数少，但被确认后应排在前面
      expect(result.highFrequencyTools[0]).toBe('read_file')
    })

    it('unsuppress 后工具应恢复', () => {
      for (let i = 0; i < 5; i++) analyzer.recordToolCall('read_file')

      analyzer.suppressTool('read_file')
      let result = analyzer.analyze()
      expect(result.highFrequencyTools).not.toContain('read_file')

      analyzer.unsuppressTool('read_file')
      result = analyzer.analyze()
      expect(result.highFrequencyTools).toContain('read_file')
    })

    it('resetFeedback 应清除所有反馈', () => {
      analyzer.suppressTool('grep')
      analyzer.confirmTool('read_file')

      analyzer.resetFeedback()

      expect(analyzer.getSuppressedTools()).toHaveLength(0)
      expect(analyzer.getConfirmedTools()).toHaveLength(0)
    })
  })

  // ── 状态管理 ──

  describe('state management', () => {
    it('clear 应清空运行时数据但保留反馈', () => {
      for (let i = 0; i < 5; i++) analyzer.recordToolCall('read_file')
      analyzer.recordUserMessage('test message')
      analyzer.confirmTool('read_file')

      analyzer.clear()

      const result = analyzer.analyze()
      expect(result.totalInteractions).toBe(0)
      expect(result.highFrequencyTools).toHaveLength(0)
      // 确认的工具应该保留
      expect(analyzer.getConfirmedTools()).toContain('read_file')
    })

    it('reset 应清空所有数据', () => {
      analyzer.recordToolCall('read_file')
      analyzer.recordUserMessage('test')
      analyzer.confirmTool('read_file')

      analyzer.reset()

      const result = analyzer.analyze()
      expect(result.totalInteractions).toBe(0)
      expect(analyzer.getConfirmedTools()).toHaveLength(0)
    })

    it('应限制内存记录数', () => {
      const smallAnalyzer = new UserBehaviorAnalyzer(10)

      for (let i = 0; i < 20; i++) {
        smallAnalyzer.recordToolCall('read_file')
      }

      // 内部最多保留 maxRecords 条
      // analyze 取 windowSize=5 条，应该都能拿到
      const result = smallAnalyzer.analyze({ windowSize: 5 })
      expect(result.highFrequencyTools).toContain('read_file')
      expect(result.toolCallCounts['read_file']).toBe(5)
    })
  })

  // ── 边界情况 ──

  describe('edge cases', () => {
    it('空用户消息不应被记录', () => {
      analyzer.recordUserMessage('')
      analyzer.recordUserMessage('   ')
      analyzer.recordUserMessage('\n')

      const result = analyzer.analyze()

      expect(result.totalInteractions).toBe(0)
    })

    it('自定义阈值应生效', () => {
      for (let i = 0; i < 2; i++) analyzer.recordToolCall('read_file')

      const defaultResult = analyzer.analyze()
      expect(defaultResult.highFrequencyTools).not.toContain('read_file')

      const customResult = analyzer.analyze({ highFreqThreshold: 2 })
      expect(customResult.highFrequencyTools).toContain('read_file')
    })

    it('未知工具不应出现在话题列表中', () => {
      for (let i = 0; i < 5; i++) analyzer.recordToolCall('unknown_tool_xyz')

      const result = analyzer.analyze()

      // 未知工具没有话题映射，不应出现在话题中
      expect(result.recentTopics).not.toContain('unknown_tool_xyz')
    })
  })

  // ── 全局单例 ──

  describe('global singleton', () => {
    it('userBehaviorAnalyzer 应可正常使用', () => {
      // 重置避免其他测试污染
      userBehaviorAnalyzer.reset()

      userBehaviorAnalyzer.recordUserMessage('测试消息')
      userBehaviorAnalyzer.recordToolCall('read_file')

      const result = userBehaviorAnalyzer.analyze()

      expect(result.totalInteractions).toBeGreaterThanOrEqual(1)
    })
  })
})
