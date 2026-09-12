/**
 * Trigger retrieval + scoring events by sending chat messages to the Electron app.
 * Usage: node scripts/trigger-retrieval-scoring.mjs
 */
import { _electron as electron } from 'playwright'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT = resolve(ROOT, 'out', 'main', 'index.js')

async function main() {
  console.log('Launching Electron app...')
  const app = await electron.launch({
    args: [OUT],
    cwd: ROOT,
    env: { ...process.env, RUNTIME_ENABLED: '1' },
  })

  // Wait for the first BrowserWindow to appear
  const win = await app.firstWindow()
  console.log('Window opened')

  // Wait for the app to be fully initialized
  await win.waitForLoadState('domcontentloaded')

  // Wait a bit for all services to init
  await new Promise(r => setTimeout(r, 8000))

  // Check if electronAPI.chat exists
  const hasAPI = await win.evaluate(() => {
    return typeof window.electronAPI?.chat === 'function'
  })
  console.log('electronAPI.chat available:', hasAPI)

  if (!hasAPI) {
    console.log('electronAPI.chat not available, checking renderer type...')
    const url = await win.evaluate(() => window.location.href)
    console.log('Window URL:', url)

    // Try to find the chat input and send a message through the UI
    const body = await win.evaluate(() => document.body?.innerText?.slice(0, 500))
    console.log('Body preview:', body)
  }

  // Send chat messages to trigger retrieval + scoring events
  const messages = [
    '你好，今天天气怎么样？',
    '帮我看看有没有什么新消息',
    '你还记得我之前说过什么吗？',
    '关于学习 TypeScript 有什么建议吗？',
    '讲个有趣的故事吧',
    '今天有什么计划？',
    '帮我查一下最近的更新',
    '你怎么看待人工智能？',
    '能帮我分析一下这段代码吗',
    '周末有什么好推荐？',
  ]

  for (let i = 0; i < messages.length; i++) {
    try {
      console.log(`[${i + 1}/${messages.length}] Sending: "${messages[i].slice(0, 30)}..."`)
      const result = await win.evaluate(async (msg) => {
        const api = window.electronAPI
        if (api?.chat) {
          const r = await api.chat(msg, `trigger_${Date.now()}`)
          return r
        }
        return null
      }, messages[i])
      console.log(`  Reply length: ${result?.reply?.length ?? 'N/A'} chars`)
    } catch (err) {
      console.log(`  Error: ${err.message}`)
    }
    // Wait between messages
    await new Promise(r => setTimeout(r, 3000))
  }

  console.log('')
  console.log('Done. Closing app...')
  await app.close()
  console.log('App closed.')

  console.log('')
  console.log('Now run: node scripts/query-retrieval-metrics.mjs')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
