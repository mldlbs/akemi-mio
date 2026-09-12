/**
 * core/persistence — 持久化抽象层
 *
 * 从各领域组件中提取的无偏见持久化逻辑：
 * - JsonStore: 通用 JSON 文件读写
 * - IdentifiableJsonStore: 支持按 id 合并的扩展
 */

export { JsonStore, IdentifiableJsonStore } from './JsonStore'
export type { JsonStoreOptions } from './JsonStore'
