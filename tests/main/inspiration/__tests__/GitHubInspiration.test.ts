import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { GitHubInspiration } from '@akemi-mio/intelligence/inspiration/GitHubInspiration'

function tmpDir(): string {
  const d = join(tmpdir(), `insp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(d, { recursive: true })
  return d
}

describe('GitHubInspiration', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpDir()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('缓存命中时 getSources 返回含 README 正文摘录的内容', () => {
    const cachePath = join(dir, 'github-inspiration.json')
    writeFileSync(
      cachePath,
      JSON.stringify(
        {
          lastFetched: Date.now(),
          entries: [
            {
              repo: {
                owner: 'x',
                repo: 'awesome',
                url: 'https://github.com/x/awesome',
                stars: 1234,
                description: '语音合成工具',
                topics: ['tts'],
                language: 'python',
              },
              fetchedAt: Date.now(),
              readmePreview: '# Awesome\n\n这是一个功能完整的语音合成引擎，支持情感语调与实时流式输出，并带有 WebSocket 服务端。',
              keyFeatures: ['语音合成', '情感控制'],
              architectureHighlights: ['WebSocket 服务端'],
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    )
    const insp = new GitHubInspiration(dir)
    const sources = insp.getSources()
    expect(sources).toHaveLength(1)
    expect(sources[0].content).toContain('README 摘录')
    expect(sources[0].content).toContain('语音合成引擎')
  })
})
