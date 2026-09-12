import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CRED } from '@akemi-mio/capabilities/fanqie-publish/types'
import { fanqieAuthInspectTool, fanqiePublishNovelTool } from '@akemi-mio/capabilities/tool/definitions/FanqiePublishTools'

const mockFetchScene = vi.fn()
const mockFetchAllScenes = vi.fn()
const mockCredentialGet = vi.fn()

vi.mock('@akemi-mio/capabilities/tool/deps', () => ({
  getCredentialsManager: () => ({
    get: mockCredentialGet,
  }),
}))

vi.mock('@akemi-mio/capabilities/fanqie-publish/FanqiePublisher', () => ({
  fetchScene: (...args: unknown[]) => mockFetchScene(...args),
  fetchAllScenes: (...args: unknown[]) => mockFetchAllScenes(...args),
}))

describe('FanqiePublishTools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCredentialGet.mockImplementation((key: string) => {
      if (key === CRED.AUTHOR_URL) return ''
      return undefined
    })
  })

  it('uses configured author url in batch publish guidance', async () => {
    mockCredentialGet.mockImplementation((key: string) => {
      if (key === CRED.AUTHOR_URL) return 'https://writer.example.com/workbench'
      return undefined
    })
    mockFetchAllScenes.mockResolvedValue({
      storyTitle: '雾港夜航',
      scenes: [{ id: 'scene-1', title: '第一章', content: '', order: 1 }],
      loginEstablished: false,
    })

    const result = await fanqiePublishNovelTool.handler({
      storyId: 'story-1',
      publishAllScenes: true,
      mode: 'draft',
    })

    const text = result.content[0]?.text ?? ''
    expect(text).toContain('https://writer.example.com/workbench')
  })

  it('falls back to the default author url when no override is set', async () => {
    mockFetchScene.mockResolvedValue({
      storyTitle: '雾港夜航',
      sceneTitle: '第一章',
      sceneContent: '正文内容',
      sceneOrder: 1,
      totalScenes: 12,
      loginEstablished: false,
    })

    const result = await fanqiePublishNovelTool.handler({
      storyId: 'story-1',
      sceneId: 'scene-1',
      mode: 'draft',
    })

    const text = result.content[0]?.text ?? ''
    expect(text).toContain('author.fanqienovel.com')
  })

  it('normalizes target host for auth inspection instructions', async () => {
    const result = await fanqieAuthInspectTool.handler({
      targetUrl: 'https://author.fanqienovel.com/dashboard?tab=chapters',
    })

    const text = result.content[0]?.text ?? ''
    expect(text).toContain('author.fanqienovel.com')
    expect(text).not.toContain('dashboard?tab=chapters')
  })
})
