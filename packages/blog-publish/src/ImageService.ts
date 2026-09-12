/**
 * ImageService — 博客图片自动处理服务
 *
 * 功能：
 * 1. 扫描 Markdown 正文中的图片引用（本地路径 & URL）
 * 2. 将本地图片上传到 CDN（通过配置的上传脚本/API）
 * 3. 替换 Markdown 中的图片引用为 CDN URL
 * 4. 支持图片压缩（可选）
 *
 * 设计原则：
 * - 使用外部上传工具（rclone/curl/scp）而非内嵌上传逻辑
 * - 上传方式通过 credential 配置，灵活适配各种 CDN
 * - 与 BlogToolboxTools 格式一致，返回处理报告
 */

import { statSync, readFileSync } from 'fs'
import { resolve, isAbsolute, extname } from 'path'
import { execSync } from 'child_process'
import { getCredentialsManager } from '@akemi-mio/capabilities/tool/deps'
import type { ImageProcessResult } from './types'

// =============================================================================
// 图片匹配正则
// =============================================================================

/** 匹配 Markdown 图片语法：![alt](url) */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g

/** 匹配 HTML img 标签：<img src="url" /> */
const HTML_IMG_RE = /<img[^>]+src=["']([^"']+)["'][^>]*\/?>/gi

// =============================================================================
// 支持上传的本地图片扩展名
// =============================================================================

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'])

// =============================================================================
// ImageService
// =============================================================================

export class ImageService {
  /**
   * 从 Markdown 内容中提取所有图片 URL。
   * 返回 { 原始引用 → 标准化路径 } 的映射。
   */
  extractImages(markdown: string): Array<{ raw: string; url: string; isLocal: boolean }> {
    const images: Array<{ raw: string; url: string; isLocal: boolean }> = []
    const seen = new Set<string>()

    // 匹配 Markdown 图片语法
    let match: RegExpExecArray | null
    while ((match = MARKDOWN_IMAGE_RE.exec(markdown)) !== null) {
      const url = match[2].trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      images.push({
        raw: match[0],
        url,
        isLocal: this.isLocalPath(url),
      })
    }

    // 匹配 HTML img 标签
    while ((match = HTML_IMG_RE.exec(markdown)) !== null) {
      const url = match[1].trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      images.push({
        raw: match[0],
        url,
        isLocal: this.isLocalPath(url),
      })
    }

    return images
  }

  /**
   * 判断路径是否为本地文件。
   */
  isLocalPath(path: string): boolean {
    if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) {
      return false
    }
    return true
  }

  /**
   * 检查本地图片文件是否存在。
   */
  getLocalImagePath(url: string): string | null {
    if (!this.isLocalPath(url)) return null

    // 尝试解析为绝对路径
    if (isAbsolute(url)) {
      try {
        const stats = statSync(url)
        if (stats.isFile() && IMAGE_EXTENSIONS.has(extname(url).toLowerCase())) {
          return url
        }
      } catch {
        return null
      }
    }

    // 尝试相对于工作目录
    try {
      const fullPath = resolve(process.cwd(), url)
      const stats = statSync(fullPath)
      if (stats.isFile() && IMAGE_EXTENSIONS.has(extname(url).toLowerCase())) {
        return fullPath
      }
    } catch {
      return null
    }

    return null
  }

  /**
   * 上传单个图片到 CDN。
   * 上传方式通过 credential 配置：
   * - image_cdn_upload_cmd: 自定义上传命令（{source} 和 {target} 占位符）
   * - image_cdn_base_url: CDN 基础 URL
   * - image_cdn_target_dir: 上传目标目录（可选）
   *
   * 如果未配置上传命令，尝试使用 rclone 或 curl。
   */
  async uploadImage(localPath: string, cdnPrefix: string): Promise<string> {
    const cm = getCredentialsManager()
    const uploadCmd = cm?.get('image_cdn_upload_cmd')
    const baseUrl = cm?.get('image_cdn_base_url')
    const targetDir = cm?.get('image_cdn_target_dir') || 'blog-images'

    if (!baseUrl) {
      throw new Error('CDN 基础 URL 未配置。请使用 set_credential 设置 image_cdn_base_url')
    }

    // 生成目标文件名（保留原始文件名，加上时间戳防止冲突）
    const ext = extname(localPath)
    const basename = localPath.replace(/^.*[\\/]/, '').replace(ext, '')
    const timestamp = Date.now()
    const targetFilename = `${basename}-${timestamp}${ext}`
    const targetPath = `${targetDir}/${targetFilename}`

    if (uploadCmd) {
      // 使用自定义上传命令
      const cmd = uploadCmd.replace(/\{source\}/g, localPath).replace(/\{target\}/g, targetPath)

      try {
        execSync(cmd, { timeout: 60_000, encoding: 'utf-8' })
      } catch (err: any) {
        throw new Error(`图片上传失败: ${err.message || String(err)}`)
      }
    } else {
      // 尝试使用 rclone
      try {
        execSync(`rclone copy "${localPath}" "cdn:${targetPath}"`, { timeout: 60_000, encoding: 'utf-8' })
      } catch {
        // rclone 也不可用，尝试简单的 HTTP PUT
        try {
          const data = readFileSync(localPath)
          const response = await fetch(`${baseUrl}/${targetPath}`, {
            method: 'PUT',
            body: data,
            headers: { 'Content-Type': `image/${ext.replace('.', '')}` },
            signal: AbortSignal.timeout(30_000),
          })
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`)
          }
        } catch (err: any) {
          throw new Error(`图片上传失败（已尝试自定义命令/rclone/HTTP PUT）: ${err.message}`)
        }
      }
    }

    // 返回 CDN URL
    const cdnUrl = `${baseUrl.replace(/\/+$/, '')}/${targetPath}`
    return cdnUrl
  }

  /**
   * 处理 Markdown 中的所有本地图片。
   * 上传到 CDN 并替换引用。
   */
  async processImages(markdown: string, cdnPrefix?: string): Promise<ImageProcessResult> {
    const images = this.extractImages(markdown)
    const localImages = images.filter((img) => img.isLocal)

    if (localImages.length === 0) {
      return {
        totalImages: images.length,
        uploaded: 0,
        failed: 0,
        updatedContent: markdown,
        imageMap: {},
        errors: [],
      }
    }

    const imageMap: Record<string, string> = {}
    const errors: string[] = []
    let uploaded = 0
    let failed = 0

    const prefix = cdnPrefix || 'blog-images'

    for (const img of localImages) {
      const localPath = this.getLocalImagePath(img.url)
      if (!localPath) {
        errors.push(`本地图片不存在: ${img.url}`)
        failed++
        continue
      }

      try {
        const cdnUrl = await this.uploadImage(localPath, prefix)
        imageMap[img.url] = cdnUrl
        uploaded++
      } catch (err: any) {
        errors.push(`上传失败 [${img.url}]: ${err.message}`)
        failed++
      }
    }

    // 替换 Markdown 中的图片引用
    let updatedContent = markdown
    for (const [originalUrl, cdnUrl] of Object.entries(imageMap)) {
      // 替换 Markdown 图片引用
      updatedContent = updatedContent.replace(
        new RegExp(`(!\\[[^\\]]*\\]\\()${escapeRegex(originalUrl)}(\\).*?)?`, 'g'),
        (match, prefix) => {
          return `${prefix}${cdnUrl})`
        },
      )
      // 替换 HTML img 标签
      updatedContent = updatedContent.replace(
        new RegExp(`(<img[^>]+src=["'])${escapeRegex(originalUrl)}(["'][^>]*/?>)`, 'g'),
        (match, prefix, suffix) => {
          return `${prefix}${cdnUrl}${suffix}`
        },
      )
    }

    return {
      totalImages: images.length,
      uploaded,
      failed,
      updatedContent,
      imageMap,
      errors,
    }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 全局单例 */
export const imageService = new ImageService()
