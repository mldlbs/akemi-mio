import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import type { MCPToolResult } from '@akemi-mio/intelligence-mcp/types'
import { WORKSPACE } from '@akemi-mio/core/config'
import { getCredentialsManager } from '@akemi-mio/capabilities/tool/deps'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { ComfyUIManager } from '@akemi-mio/image/ComfyUIManager'

// 可选依赖：ComfyUI 本地生图（由 AppRuntime 注入）
let _comfyUI: ComfyUIManager | null = null

export function setComfyUIManager(mgr: ComfyUIManager | null): void {
  _comfyUI = mgr
}

export const generateImageTool = buildTool({
  name: 'generate_image',
  description: '使用 FLUX.1-schnell（本地 ComfyUI）或 CogView-3-Flash（智谱AI）根据提示词生成图片。返回图片的本地路径和在线URL',
  inputJSONSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '图片描述提示词（支持中文），如"一只可爱的橘猫坐在钢琴上，夕阳背景，唯美风格"',
      },
      negativePrompt: {
        type: 'string',
        description: '反向提示词（仅 ComfyUI），描述不想看到的内容',
      },
      size: {
        type: 'string',
        description: '图片尺寸，可选 1024x1024（默认）、1024x1792、1792x1024',
      },
      imageCount: {
        type: 'number',
        description: '生成图片数量，可选 1-4，默认 1。仅在 CogView fallback 时有效',
      },
      useComfyUI: {
        type: 'boolean',
        description: '强制使用 ComfyUI 本地生图（默认：ComfyUI 可用则用）',
      },
      refImage: {
        type: 'string',
        description: 'ComfyUI input/ 目录下的参考图文件名，用于 PuLID 换场景保持角色身份一致',
      },
    },
    required: ['prompt'],
  },
  handler: async (args: {
    prompt: string
    negativePrompt?: string
    size?: string
    imageCount?: number
    useComfyUI?: boolean
    refImage?: string
  }) => {
    const prompt = String(args.prompt).trim()
    if (!prompt) return formatToolError('prompt 不能为空')

    // ComfyUI 可用 → 优先本地生图
    if (_comfyUI?.isReady) {
      return generateWithComfyUI(prompt, args.size, args.negativePrompt, args.refImage)
    }

    // CogView fallback
    return generateWithCogView(prompt, args)
  },
  isReadOnly: false,
})

// ─── ComfyUI 本地生图 ───

async function generateWithComfyUI(prompt: string, size?: string, negativePrompt?: string, refImage?: string): Promise<MCPToolResult> {
  const [width, height] = parseSize(size) ?? [1024, 1024]

  try {
    const result = await _comfyUI!.generate({ prompt, negativePrompt, width, height, refImage })
    return formatToolResult(
      [
        `✨ 本地生图完成（FLUX.1-schnell + PuLID）`,
        `文件: ${result.imagePath}`,
        `种子: ${result.seed}`,
        `耗时: ${(result.elapsedMs / 1000).toFixed(1)}s`,
      ].join('\n'),
    )
  } catch (err: any) {
    return formatToolError(`ComfyUI 生成失败：${err.message}`)
  }
}

// ─── CogView 在线 API（fallback） ───

async function generateWithCogView(prompt: string, args: any): Promise<MCPToolResult> {
  const creds = getCredentialsManager()
  const apiKey = creds?.get('llm_image_key') || process.env.LLM_IMAGE_KEY || ''
  const imageUrl =
    creds?.get('llm_image_api_url') || process.env.LLM_IMAGE_API_URL || 'https://open.bigmodel.cn/api/paas/v4/images/generations'
  const imageModel = creds?.get('llm_image_model') || process.env.LLM_IMAGE_MODEL || 'cogview-3-flash'
  if (!apiKey) {
    return formatToolError('未配置图片生成的 API Key。请在设置中填写或设置 LLM_IMAGE_KEY 环境变量')
  }

  const size = args.size || '1024x1024'
  const n = Math.min(Math.max(args.imageCount || 1, 1), 4)

  try {
    const res = await fetch(imageUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: imageModel, prompt, size, n }),
      signal: AbortSignal.timeout(120000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return formatToolError(`CogView API 错误 (${res.status}): ${body.slice(0, 500)}`)
    }

    const data = (await res.json()) as { data?: Array<{ url: string; revised_prompt?: string }>; created?: number }
    if (!data.data || data.data.length === 0) return formatToolError('CogView API 返回了空结果')

    const imagesDir = join(WORKSPACE.cache, 'images')
    if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true })

    const results: string[] = []
    for (let i = 0; i < data.data.length; i++) {
      const img = data.data[i]
      const ts = data.created || Date.now()
      const filePath = join(imagesDir, `cogview_${ts}_${i}.png`)

      const imgRes = await fetch(img.url)
      if (!imgRes.ok) {
        results.push(`图片 ${i + 1}: 下载失败，URL: ${img.url}`)
        continue
      }
      writeFileSync(filePath, Buffer.from(await imgRes.arrayBuffer()))

      const line = [`图片 ${i + 1}:`, `文件: ${filePath}`, `URL: ${img.url}`]
      if (img.revised_prompt) line.push(`优化提示词: ${img.revised_prompt}`)
      results.push(line.join('\n'))
    }

    return formatToolResult(results.join('\n\n---\n\n'))
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return formatToolError('CogView API 请求超时（120秒）')
    }
    return formatToolError(`图片生成失败: ${err.message}`)
  }
}

// ─── 工具 ───

function parseSize(size?: string): [number, number] | null {
  if (!size) return null
  const m = size.match(/^(\d+)x(\d+)$/)
  if (!m) return null
  return [parseInt(m[1]), parseInt(m[2])]
}

