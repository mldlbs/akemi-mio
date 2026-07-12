/**
 * Agent Wallpaper 插件 — 入口
 *
 * 导出所有 Agent 子模块的 Wallpaper 插件实现。
 * 每个插件对应 wallpaper-mapping.ts 中的一个可替换子模块。
 *
 * ── 当前可用的 Wallpaper 插件 ──
 * - SleepCyclePlugin:   低负载后台维护（原 SleepCycle）
 * - （更多插件按迁移阶段逐步添加）
 *
 * @see SleepCyclePlugin — Phase 2 迁移成果
 */

export { SleepCyclePlugin, registerSleepCyclePlugin } from './SleepCyclePlugin'
