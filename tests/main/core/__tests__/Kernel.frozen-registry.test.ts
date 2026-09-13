import { describe, expect, it, vi } from 'vitest'
import type { IModule, SubsystemState } from '@akemi-mio/core/core/lifecycle/types'

const logCalls = vi.hoisted(() => [] as Array<{ level: string; event: string; ctx?: any }>)

vi.mock('@akemi-mio/core/logger/Logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@akemi-mio/core/logger/Logger')>()
  return {
    ...actual,
    log: (level: string, event: string, ctx?: any) => {
      logCalls.push({ level, event, ctx })
    },
  }
})

const { Kernel } = await import('@akemi-mio/core/core/Kernel')

function fakeModule(name: string): IModule {
  return {
    name,
    prefix: `packages/${name}/src/`,
    exports: [],
    hotReloadable: false,
    state: 'created' as SubsystemState,
    async init() {},
    async start() {},
    async stop() {},
    async destroy() {},
    async healthCheck() {
      return { healthy: true } as never
    },
    getExport() {
      return undefined
    },
    async handleSyscall() {
      return undefined
    },
  }
}

/**
 * 注册表在启动早期冻结，而 evolution 之类的模块是 lazyInit 里才创建的，
 * 必然晚于冻结。它们的注册请求永远不可能成功，但**没有功能影响**
 * （进化系统自己跑得好好的）。
 *
 * 所以这两种情况必须分开：内核模块注册不上 = 启动顺序出事了，要 WARN；
 * 懒加载模块注册不上 = 设计如此，别每次启动刷一条假故障。
 */
describe('Kernel 冻结后的注册请求', () => {
  it('内核模块 → WARN；懒加载模块 → DEBUG', async () => {
    logCalls.length = 0
    const kernel = Kernel.getInstance()
    kernel.freezeModuleRegistry()

    await kernel.registerModule(fakeModule('core')) // 在 KERNEL_MODULES 里
    await kernel.registerModule(fakeModule('evolution')) // 不在

    const hits = logCalls.filter((c) => c.event === 'kernel.registry_frozen_cannot_register')
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ level: 'WARN', ctx: { name: 'core', kernelModule: true } })
    expect(hits[1]).toMatchObject({ level: 'DEBUG', ctx: { name: 'evolution', kernelModule: false } })
  })
})
