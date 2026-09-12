/**
 * LearningTools — 学习系统 MCP 工具定义
 *
 * 提供：
 * - learning_query: 语音查询 → 学习知识点匹配
 * - oral_code_generate: 自然语言 → TypeScript 代码生成
 * - learning_summary: 学习进度概述
 *
 * 这些工具供 VoiceToolOrchestrator 在语音意图匹配后调用。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { buildTool, formatToolResult, formatToolError, type Tool } from '@akemi-mio/capabilities/tool/types'

// ── 学习查询工具 ──

export const learningQueryTool = buildTool({
  name: 'learning_query',
  description: '将语音转写的文本匹配到 TypeScript 学习知识点，返回知识点信息和解释',
  inputJSONSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'ASR 转写文本或用户查询',
      },
    },
    required: ['query'],
  },
  handler: async (args: { query: string }) => {
    try {
      const { learningAsrBridge } = await import('@akemi-mio/intelligence-learning/LearningAsrBridge')
      const result = learningAsrBridge.matchQuery(args.query)

      if (!result.matched) {
        return formatToolResult(`未找到匹配的知识点。${result.explanation || '你可以尝试说：什么是条件类型、解释映射类型。'}`)
      }

      // 格式化输出
      const lines: string[] = [`找到 ${result.items.length} 个匹配的 TypeScript 知识点：`]
      for (const item of result.items.slice(0, 5)) {
        lines.push(`- ${item.name} (${item.category}, 掌握度 ${Math.round(item.mastery * 100)}%)`)
      }
      lines.push('')
      lines.push(result.explanation)

      return formatToolResult(lines.join('\n'))
    } catch (err) {
      log('ERROR', 'learning_query_tool_failed', { error: String(err) })
      return formatToolError(String(err))
    }
  },
})

// ── 口述代码生成工具 ──

export const oralCodeGenerateTool = buildTool({
  name: 'oral_code_generate',
  description: '根据自然语言描述生成 TypeScript 类型代码模板，支持泛型、条件类型、映射类型等',
  inputJSONSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: '自然语言类型描述，例如"一个泛型函数接受T返回T"或"条件类型 IsString"',
      },
    },
    required: ['description'],
  },
  handler: async (args: { description: string }) => {
    try {
      const { oralCodeService } = await import('@akemi-mio/intelligence-learning/OralCodeService')
      const result = oralCodeService.process({ description: args.description })

      if (!result.success) {
        return formatToolResult(result.explanation || '无法生成代码，请重新描述')
      }

      const output = [
        `模式: ${result.label}`,
        `验证: ${result.verification === 'passed' ? '✓ 通过' : '✗ 失败'}`,
        result.verificationError ? `错误: ${result.verificationError}` : '',
        '',
        '```typescript',
        result.code,
        '```',
        '',
        result.explanation,
      ]
        .filter(Boolean)
        .join('\n')

      return formatToolResult(output)
    } catch (err) {
      log('ERROR', 'oral_code_tool_failed', { error: String(err) })
      return formatToolError(String(err))
    }
  },
})

// ── 学习总结工具 ──

export const learningSummaryTool = buildTool({
  name: 'learning_summary',
  description: '获取 TypeScript 学习计划的总体进度和当前关注焦点',
  inputJSONSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const { learningAsrBridge } = await import('@akemi-mio/intelligence-learning/LearningAsrBridge')
      const summary = learningAsrBridge.getLearningSummary()
      return formatToolResult(summary)
    } catch (err) {
      log('ERROR', 'learning_summary_tool_failed', { error: String(err) })
      return formatToolError(String(err))
    }
  },
})

// ── 类型挑战生成工具 ──

export const typeChallengeNewTool = buildTool({
  name: 'type_challenge_new',
  description: '生成一个 TypeScript 高级类型挑战题。可根据知识点名称生成对应挑战，不指定则随机选择',
  inputJSONSchema: {
    type: 'object',
    properties: {
      concept: {
        type: 'string',
        description: '可选，知识点名称（如 "Conditional Types"、"Generic Functions"、"Mapped Types"）。不指定则自动从当前薄弱知识点中选择',
      },
    },
    required: [],
  },
  handler: async (args: { concept?: string }) => {
    try {
      const { typeChallengeGenerator } = await import('@akemi-mio/intelligence-learning/TypeChallengeGenerator')
      const { learningVocabularyManager } = await import('@akemi-mio/intelligence-learning/LearningVocabularyManager')

      // 确保学习词表已初始化
      learningVocabularyManager.initialize()

      let challenge = typeChallengeGenerator.generateChallenge(args.concept)

      // 如果指定了概念但没找到匹配模板，从薄弱知识点中选一个
      if (!challenge && !args.concept) {
        // 尝试从薄弱知识点生成挑战
        const unmastered = learningVocabularyManager.getUnmasteredItems()
        for (const item of unmastered) {
          challenge = typeChallengeGenerator.generateChallenge(item.name)
          if (challenge) break
        }
      }

      // 最后保底：随机
      if (!challenge) {
        challenge = typeChallengeGenerator.generateChallenge()
      }

      if (!challenge) {
        return formatToolResult('暂无可用挑战题')
      }

      // 存储挑战数据供后续提交/查看答案
      const { challengeStore } = await import('./LearningToolsStore')
      challengeStore.set({
        challengeId: challenge.id,
        conceptName: challenge.conceptName,
        starterCode: challenge.starterCode,
        verifierCode: challenge.verifierCode,
        solution: challenge.solution,
        explanation: challenge.explanation,
        hint: challenge.hint,
        label: challenge.label,
        createdAt: Date.now(),
      })

      const lines = [
        `## 🎯 类型挑战: ${challenge.label}`,
        `知识点: ${challenge.conceptName}（${challenge.difficulty === 'easy' ? '简单' : challenge.difficulty === 'medium' ? '中等' : '困难'}）`,
        '',
        challenge.prompt,
        '',
        '```typescript',
        challenge.starterCode,
        '```',
        '',
        `💡 提示: ${challenge.hint}`,
        '',
        `挑战ID: \`${challenge.id}\``,
        '',
        '请完成代码后，使用 `type_challenge_submit` 工具提交你的答案。',
      ]

      return formatToolResult(lines.join('\n'))
    } catch (err) {
      log('ERROR', 'type_challenge_new_tool_failed', { error: String(err) })
      return formatToolError(String(err))
    }
  },
})

// ── 类型挑战提交工具 ──

export const typeChallengeSubmitTool = buildTool({
  name: 'type_challenge_submit',
  description: '提交类型挑战的答案，由本地 TypeScript 编译器验证是否正确',
  inputJSONSchema: {
    type: 'object',
    properties: {
      challengeId: {
        type: 'string',
        description: '挑战 ID（从 type_challenge_new 返回）',
      },
      code: {
        type: 'string',
        description: '你完成的 TypeScript 代码。如果是填空类型，填写占位符的内容；如果是修正类型，提交完整的修正后代码',
      },
    },
    required: ['challengeId', 'code'],
  },
  handler: async (args: { challengeId: string; code: string }) => {
    try {
      const { typeChallengeGenerator } = await import('@akemi-mio/intelligence-learning/TypeChallengeGenerator')
      const { typeScriptCompilerService } = await import('@akemi-mio/intelligence-learning/TypeScriptCompilerService')
      const { learningVocabularyManager } = await import('@akemi-mio/intelligence-learning/LearningVocabularyManager')

      // 从 challengeId 解析（简化：存储到内存中）
      const { challengeStore } = await import('./LearningToolsStore')
      const stored = challengeStore.get(args.challengeId)
      if (!stored) {
        return formatToolError(`挑战 ${args.challengeId} 不存在或已过期。请重新使用 type_challenge_new 生成挑战。`)
      }

      // 构建完整代码
      const fullCode = typeChallengeGenerator.buildFullCode(stored.starterCode, args.code, stored.verifierCode)

      // 编译检查
      const result = typeScriptCompilerService.compile(fullCode)

      if (result.success) {
        // 编译通过 → 更新掌握度
        learningVocabularyManager.recordInteraction(stored.conceptName, true)

        const lines = [
          '## ✅ 通过！答案正确！',
          '',
          '编译通过，无类型错误。',
          '',
          '---',
          stored.explanation,
          '',
          '```typescript',
          stored.solution,
          '```',
        ]

        return formatToolResult(lines.join('\n'))
      } else {
        // 编译失败 → 记录错误
        learningVocabularyManager.recordInteraction(stored.conceptName, false)

        const diagText = typeScriptCompilerService
          .formatDiagnostics(result.diagnostics)
          .split('\n')
          .slice(0, 8) // 最多显示 8 条错误
          .join('\n')

        const lines = [
          '## ❌ 类型错误',
          '',
          '```',
          diagText || result.rawOutput.slice(0, 500),
          '```',
          '',
          `💡 提示: ${stored.hint}`,
          '',
          '你可以修改代码后重新提交。如果想看答案，使用 `type_challenge_solution` 工具。',
        ]

        return formatToolResult(lines.join('\n'))
      }
    } catch (err) {
      log('ERROR', 'type_challenge_submit_tool_failed', { error: String(err) })
      return formatToolError(String(err))
    }
  },
})

// ── 类型挑战答案工具 ──

export const typeChallengeSolutionTool = buildTool({
  name: 'type_challenge_solution',
  description: '查看当前挑战的参考答案和解释。跳过本题不会有掌握度变化',
  inputJSONSchema: {
    type: 'object',
    properties: {
      challengeId: {
        type: 'string',
        description: '挑战 ID（从 type_challenge_new 返回）',
      },
    },
    required: ['challengeId'],
  },
  handler: async (args: { challengeId: string }) => {
    try {
      const { challengeStore } = await import('./LearningToolsStore')
      const stored = challengeStore.get(args.challengeId)
      if (!stored) {
        return formatToolError(`挑战 ${args.challengeId} 不存在或已过期。`)
      }

      const lines = [`## 📖 答案: ${stored.label}`, '', '```typescript', stored.solution, '```', '', '---', stored.explanation]

      return formatToolResult(lines.join('\n'))
    } catch (err) {
      log('ERROR', 'type_challenge_solution_tool_failed', { error: String(err) })
      return formatToolError(String(err))
    }
  },
})

