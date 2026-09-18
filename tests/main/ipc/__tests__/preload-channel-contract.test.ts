import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (rel: string) => readFileSync(join(root, ...rel.split('/')), 'utf8')

/**
 * preload 调用的 channel，必须真的有人注册。
 *
 * 背景：`ipcRenderer.invoke(channel)` 在 channel 没人 `ipcMain.handle` 时会**直接 reject**
 * （"Error: No handler registered for 'xxx'"）。渲染侧的调用点几乎都写成 `try { … } catch {}`，
 * 于是错误被静默吞掉 —— 表现是「面板永远空着、按钮点了没反应」，而不是报错。
 *
 * 实测踩过的四个（preload 与主进程的名字各自漂移，谁也发现不了谁）：
 *   - `voice-bookmark:list` / `voice-bookmark:search`  主进程从未注册 → 书签面板永远空
 *   - `voice-bookmark:audioPath`                       主进程叫 `voice-bookmark:getAudioPath`
 *   - `blog:getAudioPath`                              主进程叫 `blog:getAudio`
 *
 * 类型系统管不到这里：channel 名是字符串字面量，preload 的返回类型是自己手写的，
 * 两边对不上也照样编译通过。所以只能用源码文本断言把两侧钉在一起。
 */
function preloadInvokedChannels(src: string): Map<string, string> {
  const out = new Map<string, string>()
  // preload 里统一是 `ipc.invoke('…')`（ipc 由 createElectronAPI(ipcRenderer) 注入），
  // 少数直接写 `ipcRenderer.invoke('…')`。反引号动态拼接的一律不匹配 —— 那种情况本测试无能为力。
  const re = /(?:ipcRenderer|\bipc)\.(invoke|send|sendSync)\(\s*'([^']+)'/g
  for (const m of src.matchAll(re)) out.set(m[2], m[1])
  return out
}

function mainRegisteredChannels(): Map<string, string> {
  const ipcDir = join(root, 'packages', 'main', 'src', 'ipc')
  const rels = [
    'packages/main/src/ipc/handlers.ts',
    ...readdirSync(join(ipcDir, 'handlers'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `packages/main/src/ipc/handlers/${f}`),
  ]
  const out = new Map<string, string>()
  for (const rel of rels) {
    const src = read(rel)
    for (const m of src.matchAll(/ipcMain\.(handle|on)\(\s*'([^']+)'/g)) out.set(m[2], m[1])
  }
  return out
}

/**
 * 已知的、尚未接线的一批 —— **不是**「没问题」，是「已记录在案」。
 *
 * 现在它是**空的**：语音确认 / 一站式编排那 7 个通道（voice:llmParseIntent、
 * voice:confirm:start|feed|state|reset、voice:orchestrate:full|confirmAndExecute）
 * 已于 `packages/main/src/ipc/handlers/asr.ts` 接线完毕。
 *
 * 这个常量保留空数组是有意的 —— 它是「过期即报错」机制的载体：
 *   - 冒出**新的**未注册 channel → 测试失败（这正是它的价值）
 *   - 有人临时接线了某个通道却把条目留在这里 → 测试也会失败，逼他删掉
 * 手写清单最大的毛病就是腐烂，让它「过期即报错」比让它悄悄失真强。
 * 接下一批潜伏通道时，把名字加进这个数组，接完立刻删掉。
 */
const KNOWN_UNWIRED_CHANNELS: string[] = []

describe('preload ↔ 主进程 IPC channel 契约', () => {
  it('preload 解析出的 channel 数量合理（防止正则失效导致测试空转）', () => {
    const invoked = preloadInvokedChannels(read('src/preload/index.ts'))
    const registered = mainRegisteredChannels()
    // 数量级断言：正则写坏时这两个数会掉到 0，那时下面的「无缺失」就是假通过
    expect(invoked.size).toBeGreaterThan(100)
    expect(registered.size).toBeGreaterThan(150)
  })

  it('preload invoke 的 channel 要么有 ipcMain.handle，要么在已知未接线清单里', () => {
    const invoked = preloadInvokedChannels(read('src/preload/index.ts'))
    const registered = mainRegisteredChannels()

    const missing = [...invoked.entries()]
      .filter(([ch, kind]) => kind === 'invoke' && !registered.has(ch))
      .map(([ch]) => ch)
      .sort()

    expect(
      missing,
      missing.length
        ? `以下 channel 被 preload 调用但主进程未注册（新出现的必须补 handler，\n已接线的请从 KNOWN_UNWIRED_CHANNELS 里删掉）：\n  ${missing.join('\n  ')}`
        : undefined,
    ).toEqual([...KNOWN_UNWIRED_CHANNELS].sort())
  })
})
