/**
 * GeneratePodcastTool — 博客音频播客生成工具
 *
 * 将博客 Markdown 内容通过 Piper TTS 合成为音频播客（MP3）。
 *
 * 功能流程：
 * 1. 将 Markdown 拆分为语义段落
 * 2. 根据内容类型和标题关键词匹配合适的语音模型
 *    （教程→花颜·女声、故事→玲玲·温柔女声、总结→马提·沉稳男声）
 * 3. 通过 PiperTTS 逐段合成语音
 * 4. 拼接音频段落，添加淡入淡出效果
 * 5. 输出 MP3 文件
 *
 * 与前端集成：
 * - 可通过 IPC 监听 'podcast:generated' 事件获取结果
 *
 * 与 BlogToolbox 的关系：
 * - 作为 BlogToolbox 的扩展，可在 blog_toolbox_pipeline 中集成
 * - 是博客发布工作流中的"生成音频版本"步骤
 */

import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { log } from '@akemi-mio/core/logger/Logger'
import { blogAudioService } from '@akemi-mio/audio/BlogAudioService'
import { markdownSegmenter } from '@akemi-mio/audio/MarkdownSegmenter'
import { contentVoiceMapper } from '@akemi-mio/audio/ContentVoiceMapper'
import { PIPER_MODEL_CATALOG } from '@akemi-mio/audio/PiperOrchestrator'
import { BrowserWindow } from 'electron'

// ══════════════════════════════════════════
//  IPC 事件通知
// ══════════════════════════════════════════

/** 发送播客生成事件到渲染进程 */
function emitPodcastEvent(eventType: string, data: Record<string, any>): void {
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send('podcast:event', { type: eventType, ...data })
  }
}

// ══════════════════════════════════════════
//  MCP 工具: blog_generate_podcast
// ══════════════════════════════════════════

export const generatePodcastTool = buildTool({
  name: 'blog_generate_podcast',
  description:
    '【BlogToolbox】将博客 Markdown 内容自动合成为音频播客（MP3 格式）。' +
    '流程：拆分段落 → 按内容匹配语音模型(教程/故事/总结各有不同音色) → 本地 PiperTTS 逐段合成 → 拼接并添加淡入淡出。' +
    '所有处理在本地完成，保障隐私。输出 MP3 文件路径。' +
    '适合在博客发布前调用，生成音频版与文章一起发布。',

  inputJSONSchema: {
    type: 'object',
    properties: {
      markdown: {
        type: 'string',
        description: '博客正文（Markdown 格式），将自动拆分为段落并合成语音。',
      },
      output_path: {
        type: 'string',
        description: '可选，输出 MP3 文件路径。默认为临时目录。建议指定到博客资源目录以便嵌入。' + '如: D:\\blog\\audio\\my-post.mp3',
      },
      speed: {
        type: 'number',
        description: '全局语速覆盖（0.5-2.0）。1.0=正常，0.8=较慢（适合教程），1.2=较快（适合资讯）。' + '不指定则每个段落使用模型推荐值。',
      },
      pitch: {
        type: 'number',
        description: '全局音调覆盖（0.5-2.0）。1.0=正常，>1=偏高（活泼），<1=偏低（沉稳）。' + '不指定则每个段落使用模型推荐值。',
      },
      fade_in: {
        type: 'number',
        description: '可选，淡入时长（秒），默认 1.5。',
      },
      fade_out: {
        type: 'number',
        description: '可选，淡出时长（秒），默认 2.0。',
      },
      bitrate: {
        type: 'number',
        description: '可选，MP3 比特率（kbps），默认 128。',
      },
    },
    required: ['markdown'],
  },

  handler: async (args: {
    markdown: string
    output_path?: string
    speed?: number
    pitch?: number
    fade_in?: number
    fade_out?: number
    bitrate?: number
  }) => {
    const t0 = Date.now()
    const markdown = String(args.markdown || '').trim()

    if (!markdown) {
      return formatToolError('Markdown 内容不能为空')
    }

    if (markdown.length < 10) {
      return formatToolError('Markdown 内容太短，至少需要 10 个字符')
    }

    // 验证参数范围
    if (args.speed !== undefined && (args.speed < 0.5 || args.speed > 2.0)) {
      return formatToolError(`语速超出范围: ${args.speed}，应在 0.5-2.0 之间`)
    }
    if (args.pitch !== undefined && (args.pitch < 0.5 || args.pitch > 2.0)) {
      return formatToolError(`音调超出范围: ${args.pitch}，应在 0.5-2.0 之间`)
    }

    log('INFO', 'blog_podcast_tool_invoke', {
      markdown_len: markdown.length,
      output_path: args.output_path || '(tmp)',
      speed: args.speed,
      pitch: args.pitch,
    })

    // 发送开始事件
    emitPodcastEvent('started', { textLength: markdown.length })

    const result = await blogAudioService.generatePodcast(markdown, {
      outputPath: args.output_path,
      speedOverride: args.speed,
      pitchOverride: args.pitch,
      fadeInSec: args.fade_in,
      fadeOutSec: args.fade_out,
      bitrateKbps: args.bitrate,
    })

    if (!result.success) {
      log('ERROR', 'blog_podcast_tool_failed', {
        error: result.error,
        duration_ms: Date.now() - t0,
      })

      emitPodcastEvent('failed', {
        error: result.error,
        segmentDetails: result.segmentDetails,
      })

      return formatToolError(
        `播客生成失败: ${result.error}` +
          (result.segmentDetails
            ? `\n段落统计: ${result.successSegments}/${result.totalSegments} 成功, ${result.failedSegments} 失败`
            : ''),
      )
    }

    // 格式化输出
    const lines: string[] = [
      '🎙️ 博客音频播客生成成功',
      '',
      `📄 文章标题: ${result.title}`,
      `📝 段落数: ${result.totalSegments} (成功 ${result.successSegments}, 失败 ${result.failedSegments})`,
      `⏱️ 总时长: ${result.totalDurationSec ? formatDuration(result.totalDurationSec) : '未知'}`,
      `💾 文件大小: ${result.fileSizeBytes ? formatFileSize(result.fileSizeBytes) : '未知'}`,
      `📁 输出路径: ${result.outputPath}`,
      `⚡ 耗时: ${((Date.now() - t0) / 1000).toFixed(1)} 秒`,
      '',
    ]

    // 段落明细
    if (result.segmentDetails && result.segmentDetails.length > 0) {
      lines.push('📋 段落明细:')
      for (const detail of result.segmentDetails) {
        const icon = detail.success ? '✅' : '❌'
        const snippet = detail.textSnippet.length > 50 ? detail.textSnippet.slice(0, 50) + '...' : detail.textSnippet
        lines.push(`  ${icon} [${detail.model}] ${snippet}`)
      }
      lines.push('')
    }

    lines.push('💡 提示: 可通过 blog_toolbox_pipeline 将此工具集成到博客发布流水线中')

    // 发送完成事件
    emitPodcastEvent('completed', {
      outputPath: result.outputPath,
      totalDurationSec: result.totalDurationSec,
      fileSizeBytes: result.fileSizeBytes,
      title: result.title,
    })

    return formatToolResult(lines.join('\n'))
  },

  isReadOnly: true,
})

// ══════════════════════════════════════════
//  测试工具: blog_generate_podcast_preview
// ══════════════════════════════════════════

export const generatePodcastPreviewTool = buildTool({
  name: 'blog_generate_podcast_preview',
  description:
    '【BlogToolbox】预览博客音频播客的段落拆分和语音模型分配结果（不实际合成）。' +
    '快速查看哪些段落会使用哪个语音模型，方便调整后再正式生成。',

  inputJSONSchema: {
    type: 'object',
    properties: {
      markdown: {
        type: 'string',
        description: '博客正文（Markdown 格式）',
      },
    },
    required: ['markdown'],
  },

  handler: async (args: { markdown: string }) => {
    const markdown = String(args.markdown || '').trim()
    if (!markdown) return formatToolError('Markdown 内容不能为空')

    const { segments, metadata } = markdownSegmenter.segment(markdown)
    const assignments = contentVoiceMapper.assignAll(segments)

    const lines: string[] = [
      '🎙️ 博客音频播客预览',
      '='.repeat(40),
      '',
      `📄 标题: ${metadata.title}`,
      `📝 段落数: ${segments.length}`,
      `📏 总字符数: ${metadata.totalChars}`,
      `⏱️ 预计时长: ${metadata.estimatedDurationSec} 秒 (~${Math.ceil(metadata.estimatedDurationSec / 60)} 分钟)`,
      `🌐 语言: ${metadata.language === 'zh' ? '中文' : metadata.language === 'en' ? '英文' : '中英混合'}`,
      '',
      '📋 段落分配:',
      '',
    ]

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const voice = assignments[i]
      const modelName = PIPER_MODEL_CATALOG[voice.model]?.displayName || voice.model
      const snippet = seg.text.length > 80 ? seg.text.slice(0, 80) + '...' : seg.text

      lines.push(`  ${String(i + 1).padStart(3)}. [${modelName}] ${voice.reason}`)
      lines.push(`     语速: ${voice.speed}x, 音调: ${voice.pitch}x, 停顿: ${voice.pauseAfterMs}ms`)
      if (seg.contentType === 'title' || seg.contentType === 'heading') {
        lines.push(`     📌 ${'#'.repeat(seg.headingLevel)} ${seg.text}`)
      } else {
        lines.push(`     ${snippet}`)
      }
      lines.push('')
    }

    lines.push(
      `--- 共 ${segments.length} 段，${assignments.filter((a) => a.model === 'zh_CN-ling_ling-medium').length} 段使用玲玲·温柔女声, ${assignments.filter((a) => a.model === 'zh_CN-tx_mati-medium').length} 段使用马提·沉稳男声, 其余使用花颜·女声 ---`,
    )

    return formatToolResult(lines.join('\n'))
  },

  isReadOnly: true,
})

// ══════════════════════════════════════════
//  辅助方法
// ══════════════════════════════════════════

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.round(totalSeconds % 60)

  if (hours > 0) return `${hours} 时 ${minutes} 分 ${seconds} 秒`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

