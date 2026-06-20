import { buildTool, formatToolResult, formatToolError } from '../types'
import { LLM_IMAGE_KEY, LLM_IMAGE_MODEL, LLM_IMAGE_API_URL, WORKSPACE } from '../../config'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

export const generateImageTool = buildTool({
  name: 'generate_image',
  description: '使用 CogView-3-Flash（智谱AI）根据提示词生成图片。返回图片的本地路径和在线URL',
  inputJSONSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '图片描述提示词（支持中文），如"一只可爱的橘猫坐在钢琴上，夕阳背景，唯美风格"',
      },
      size: {
        type: 'string',
        description: '图片尺寸，可选 1024x1024（默认）、1024x1792、1792x1024',
      },
      imageCount: {
        type: 'number',
        description: '生成图片数量，可选 1-4，默认 1',
      },
    },
    required: ['prompt'],
  },
  handler: async (args: { prompt: string; size?: string; imageCount?: number }) => {
    const apiKey = LLM_IMAGE_KEY
    if (!apiKey) {
      return formatToolError('未配置 LLM_IMAGE_KEY。请在 .env 中设置 LLM_IMAGE_KEY=your_zhipu_api_key')
    }

    const prompt = String(args.prompt).trim()
    if (!prompt) return formatToolError('prompt 不能为空')

    const size = args.size || '1024x1024'
    const n = Math.min(Math.max(args.imageCount || 1, 1), 4)

    try {
      const res = await fetch(LLM_IMAGE_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: LLM_IMAGE_MODEL,
          prompt,
          size,
          n,
        }),
        signal: AbortSignal.timeout(120000),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return formatToolError(`CogView API 错误 (${res.status}): ${body.slice(0, 500)}`)
      }

      const data = (await res.json()) as {
        data?: Array<{ url: string; revised_prompt?: string }>
        created?: number
      }

      if (!data.data || data.data.length === 0) {
        return formatToolError('CogView API 返回了空结果')
      }

      // 保存到 workspace images 目录
      const imagesDir = join(WORKSPACE.cache, 'images')
      if (!existsSync(imagesDir)) {
        mkdirSync(imagesDir, { recursive: true })
      }

      const results: string[] = []
      for (let i = 0; i < data.data.length; i++) {
        const img = data.data[i]
        const ts = data.created || Date.now()
        const filename = `cogview_${ts}_${i}.png`
        const filePath = join(imagesDir, filename)

        // 下载图片
        const imgRes = await fetch(img.url)
        if (!imgRes.ok) {
          results.push(`图片 ${i + 1}: 下载失败 (${imgRes.status})，URL: ${img.url}`)
          continue
        }
        const imgBuffer = Buffer.from(await imgRes.arrayBuffer())
        writeFileSync(filePath, imgBuffer)

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
  },
  isReadOnly: false,
})
