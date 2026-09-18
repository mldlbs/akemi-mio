/**
 * 错误码 → 用户可读文案（**主进程侧的规范实现**）。
 *
 * 值域的唯一事实来源是同目录 `types.ts` 的 `CHAT_ERROR_CODES`（`ChatResult.error` 的类型）。
 *
 * ## 为什么有两份实现
 *
 * 与 `src/renderer/src/lib/chatErrorText.ts` 是**同一份逻辑的两份拷贝**，原因是架构边界：
 * renderer 刻意零 `@akemi-mio/*` 依赖，import 不到这里；而 renderer 那边也不该被
 * 主进程包拖进来。两份实现由
 * `tests/main/__tests__/chat-error-code.contract.test.ts` 做**行为等价**断言
 * （逐码比对两边 `chatErrorText()` 的返回值，再比垃圾输入）——
 * **改这里必须同步改那边，否则测试红。** 别只改一份。
 *
 * ## 主进程内的消费方
 *
 * - `messaging/src/telegram/TelegramService.ts` —— 以前直接把 `result.error` 拼给用户
 *   （`❌ 错误: CIRCUIT_OPEN`），现在走这里。
 * - `main/src/ipc/handlers/wallpaper.ts` —— 任务面板的「快捷提问」失败原因。
 */

/**
 * 错误码 → 文案。
 * 导出是为了让契约测试能直接核对覆盖情况（而不是只能靠调用 `chatErrorText` 反推）。
 */
export const CHAT_ERROR_TEXT: Record<string, string> = {
  CIRCUIT_OPEN: '模型服务暂时不可用，已暂停请求，约 30 秒后自动恢复',
  PAUSED: '对话已暂停，恢复后再试',
  BUSY: '正在处理上一条消息，请稍候再试',
  NO_REPLY: '模型没有返回内容，请重试',
  EMPTY_RESPONSE: '模型没有返回内容，请重试',
  INTERNAL: '内部错误，请重试',
  TIMEOUT: '模型响应超时，请重试',
  NETWORK: '网络异常，请检查连接后重试',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  RATE_LIMITED_EXHAUSTED: '请求过于频繁，多次重试仍未成功，请稍后再试',
  NO_KEY: '未配置模型密钥，请在设置中填写',
  INVALID_KEY: '模型密钥无效，请在设置中检查',
  INVALID_REQUEST: '请求格式有误，请重试',
  NO_TOOLS_AVAILABLE: '当前没有可用工具，请检查设置',
}

/**
 * 不需要打扰用户的「错误码」。
 *
 * `INTERRUPTED` 由 ChatExecutor 在用户主动打断（发新消息 / 取消）时产出，不是故障；
 * `ABORTED` 来自 LlmService，而 `RunContext.interrupt()` 是唯一会 abort 该 signal 的地方
 * （它同时会把 `interruptFlag` 置位），因此语义相同。
 *
 * ⚠️ **主进程消费方要自己决定怎么处理 null**：renderer 侧「用户自己按的取消不该弹错误」，
 * 但 telegram 那边消息已经发出去了，必须给个收尾（否则进度条永远停在「处理中…」）。
 */
export const SILENT_CODES = new Set(['INTERRUPTED', 'ABORTED'])

/**
 * 有意**不**映射文案的码（键 = 码，值 = 为什么可以不映射）。
 *
 * 契约测试的判据是：
 * `CHAT_ERROR_CODES` 减去（`CHAT_ERROR_TEXT` 的键 + `SILENT_CODES` + 本表的键）之后必须为空。
 */
export const UNMAPPED_BY_DESIGN: Record<string, string> = {
  UNKNOWN_INTENT:
    '当前不可达：executeIntentCommand 全仓零调用（registerIntentHandler 注册了 4 个 handler，' +
    '但分发方法从没被调用过）。码保留下来便于排查，不专门写文案；' +
    '万一哪天变成可达，会落到「请求失败（UNKNOWN_INTENT）」兜底，不至于静默。',
}

/** `API_ERROR:503` → 说清是「服务端返回错误」而不是把状态码当内部码甩出去 */
const API_ERROR_RE = /^API_ERROR:(\d{3})$/

/**
 * 「看起来像错误码」：短、无空白。
 *
 * `ChatResult.error` 已收紧成 `ChatErrorCode` 联合类型，所以**新产出**的码一定短且无空白。
 * 这层守卫仍然要留着 —— 它是边界上的最后一道防线：历史版本确实产出过原始异常报文
 * （`_emitModelError(String(err), …)`，已在 `b12b82f5` 修掉），
 * 那种内容（含空格、含堆栈、超长）不该糊到用户界面上。
 */
const CODE_LIKE_RE = /^[A-Za-z0-9_:.-]{1,60}$/

/** 不像错误码（原始异常报文等）时的兜底文案 */
const GENERIC_FAILURE = '模型服务暂时不可用，请重试'

/**
 * 把错误码翻译成可展示的文案。
 * 无错误（含空串 / null / undefined）返回 null，调用方据此判断是否要展示。
 */
export function chatErrorText(error: string | undefined | null): string | null {
  if (!error) return null
  if (SILENT_CODES.has(error)) return null

  const mapped = CHAT_ERROR_TEXT[error]
  if (mapped) return mapped

  const apiError = API_ERROR_RE.exec(error)
  if (apiError) return `模型服务返回错误（${apiError[1]}），请稍后重试`

  // 不像错误码（多半是原始异常报文 / 超长技术串）→ 不展示原文，统一兜底
  if (!CODE_LIKE_RE.test(error)) return GENERIC_FAILURE

  // 像错误码但没收录：保留原始码，便于排查，也不至于像上面那样泄露内部细节
  return `请求失败（${error}）`
}
