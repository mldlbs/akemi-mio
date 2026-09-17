/**
 * 聊天链路可能返回的错误码（`ChatResult.error` 的值域）。
 *
 * **为什么要显式列出来**：此前这个字段的类型只是 `string`，值域完全不受约束，于是反复出现两类事故：
 * ①「同一个物理故障两套记账」—— `LlmService` 的网络异常分支曾把原始异常报文当错误码返回
 *   （`String(err)`，见 `LlmService.ts:647` 的修复注释），`ErrorClassifier` 认不出它，
 *   这类传输层失败就不计入熔断，而显式 `'NETWORK'` 的同类失败会计入；
 * ②「新增错误码但忘了加用户文案」—— renderer 只能把内部码糊到界面上
 *   （用户看到「请求失败（RATE_LIMITED_EXHAUSTED）」）。
 *
 * 靠人工 grep 核对值域已经漏过三次，所以改成让类型来管：
 * - 产出方写出表外的码 → **编译不过**；
 * - `CHAT_ERROR_CODES` 是运行期可枚举的，`tests/main` 的契约测试拿它核对 renderer
 *   的文案表（`src/renderer/src/lib/chatErrorText.ts`）→ **漏文案会变红灯**。
 *
 * 注意 renderer **刻意不 import 本包**（架构边界：`src/renderer` 里零 `@akemi-mio/*`），
 * 所以文案表那边加不了类型约束，只能靠上面那条契约测试桥接。
 */
export const CHAT_ERROR_CODES = [
  // —— 服务可用性 ——
  'CIRCUIT_OPEN', // 熔断器打开，请求被快速失败
  'PAUSED', // 用户暂停了对话（产出点：packages/main/src/ipc/handlers/agent.ts）
  'BUSY', // 上一轮还在跑，本轮被 ChatExecutor 的重入守卫拒绝
  // —— 传输 / 模型侧 ——
  'TIMEOUT',
  'NETWORK',
  'RATE_LIMITED',
  'RATE_LIMITED_EXHAUSTED', // 底层三次重试用尽
  'INVALID_REQUEST', // 工具调用链结构损坏，发请求前的预检直接拒绝
  'EMPTY_RESPONSE', // 响应体里没有 choices[0].message
  'NO_TOOLS_AVAILABLE', // toolChoiceMode==='required' 但一个工具都没注册
  // —— 配置 ——
  'NO_KEY',
  'INVALID_KEY',
  // —— 本轮没有产出回复 ——
  'NO_REPLY', // 模型确实返回了空内容
  'INTERRUPTED', // 用户主动打断（不是故障，renderer 静默不展示）
  'ABORTED', // 外部 abort signal 触发（RunContext.interrupt() 是唯一 abort 点，语义同 INTERRUPTED）
  // —— 其他 ——
  'INTERNAL',
  'UNKNOWN_INTENT', // 当前不可达：executeIntentCommand 全仓零调用（handler 注册了但分发方法没被调过）
] as const

/** `ChatResult.error` 的取值：上表的字面量码，外加带 HTTP 状态码的 `API_ERROR:503` 形式 */
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number] | `API_ERROR:${number}`

export interface ChatResult {
  reply?: string
  error?: ChatErrorCode
}
export type ChunkCallback = (text: string) => void
