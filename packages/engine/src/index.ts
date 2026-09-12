/**
 * Engine — Agent/PiperTTS 统一抽象层
 *
 * 提供 IEngineQueryable（只读查询）、IEngineService（读 + 写生命周期控制）
 * 和 IEngineStrategyProvider（运行时策略选择）三个接口。
 *
 * 调用方只需依赖 IEngineQueryable 即可获取引擎状态和性能数据，
 * 无需了解底层是 AgentService 还是 PiperOrchestrator。
 *
 * ── 使用方式 ──
 *
 * 1. 获取所有引擎状态（统一监控/健康检查）：
 *    import { engineProvider } from '../engine'
 *    const engines = engineProvider.getAll()
 *    for (const e of engines) {
 *      const status = e.getStatus()
 *      console.log(`${status.name}: ${status.state} (busy=${status.busy})`)
 *    }
 *
 * 2. 引擎级状态查询（只读，适用于调试面板）：
 *    function renderEngineInfo(engine: IEngineQueryable) {
 *      return `${engine.name}: ${JSON.stringify(engine.getStatus())}`
 *    }
 *
 * 3. 运行时引擎切换（策略模式）：
 *    engineProvider.setActive('piper-tts')
 *    const active = engineProvider.getActive()
 *
 * ── 风险控制 ──
 *
 * - 接口仅覆盖 Agent 和 PiperTTS 共有的语义操作，不暴露模块特有行为
 * - 模块特有功能（Agent 的 processTextInput、Piper 的 switchModel）
 *   仍直接通过模块类型访问，不在接口中抽象
 * - 新增引擎（如 EdgeTTS 作为独立引擎、Whisper ASR 等）只需实现
 *   IEngineService 即可被 EngineProvider 管理
 */

// ════════════════════════════════════════════
//  类型导出（只读 + 读写接口）
// ════════════════════════════════════════════

export type { EngineStatus, EngineMetrics, IEngineQueryable, IEngineService, IEngineStrategyProvider } from './types'

// ════════════════════════════════════════════
//  运行时策略提供者
// ════════════════════════════════════════════

export { EngineProvider, engineProvider } from './EngineProvider'
