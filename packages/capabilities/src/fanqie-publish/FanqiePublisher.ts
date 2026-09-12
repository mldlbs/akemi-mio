/**
 * FanqiePublisher — 番茄小说发布内容提供者
 *
 * 职责：从写作系统获取小说/章节内容，不做浏览器自动化。
 * 浏览器操作由 MIO 通过 Playwright MCP 工具执行。
 */

import { getCredentialsManager } from '@akemi-mio/capabilities/tool/deps'
import { CRED } from './credential-keys'

async function writingFetch(method: string, path: string, body?: any) {
  const creds = getCredentialsManager()
  const apiUrl = creds?.get('writing_api_url') || process.env.WRITING_API_URL || 'https://www.crlkcloud.cyou/writing/api'
  const url = `${apiUrl}${path}`
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

export interface FanqiePublishData {
  sceneTitle: string
  sceneContent: string
  storyTitle: string
  sceneOrder: number
  totalScenes: number
  /** 是否已标记为已登录 */
  loginEstablished: boolean
}

export async function fetchScene(storyId: string, sceneId: string): Promise<FanqiePublishData> {
  const story = await writingFetch('GET', `/stories/${storyId}`)
  const scene = await writingFetch('GET', `/scenes/${sceneId}`)
  return {
    sceneTitle: scene.title || `章节 ${sceneId}`,
    sceneContent: scene.content || '',
    storyTitle: story.title || story.name || '未命名',
    sceneOrder: scene.order || 0,
    totalScenes: 1,
    loginEstablished: getCredentialsManager()?.get(CRED.LOGIN_ESTABLISHED) === 'true',
  }
}

export interface FanqieScene {
  id: string
  title: string
  content: string
  order: number
}

export async function fetchAllScenes(storyId: string): Promise<{
  storyTitle: string
  scenes: FanqieScene[]
  loginEstablished: boolean
}> {
  const [story, scenes] = await Promise.all([writingFetch('GET', `/stories/${storyId}`), writingFetch('GET', `/scenes?storyId=${storyId}`)])

  const sorted: FanqieScene[] = (Array.isArray(scenes) ? scenes : [])
    .map((s: any) => ({
      id: s.id || s.sceneId,
      title: s.title || '',
      content: s.content || '',
      order: s.order || 0,
    }))
    .sort((a: FanqieScene, b: FanqieScene) => a.order - b.order)

  return {
    storyTitle: story.title || story.name || '未命名',
    scenes: sorted,
    loginEstablished: getCredentialsManager()?.get(CRED.LOGIN_ESTABLISHED) === 'true',
  }
}
