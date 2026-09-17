/**
 * 聊天错误码 → 用户可读文案。
 *
 * 背景：主进程 `ChatResult.error` 是给程序看的错误码（`CIRCUIT_OPEN` / `INTERNAL` /
 * `NO_REPLY` / `TIMEOUT` …）。此前 renderer 侧要么直接把原始码显示出来
 * （`WallpaperAgentPanel` 显示成「错误: CIRCUIT_OPEN」），要么干脆丢弃
 * （`useAIOutput.sendChat` 不接收返回值）—— 用户看到的是一串内部码或什么都没有。
 *
 * 这里集中翻译一次，避免每个消费点各写一套、也避免再出现「丢弃返回值」。
 */

const CHAT_ERROR_TEXT: Record<string, string> = {
  CIRCUIT_OPEN: '模型服务暂时不可用，已暂停请求，约 30 秒后自动恢复',
  PAUSED: '对话已暂停，恢复后再试',
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
 * 用户自己按下的取消，不该弹一条错误。
 */
const SILENT_CODES = new Set(['INTERRUPTED', 'ABORTED'])

/** `API_ERROR:503` → 说清是「服务端返回错误」而不是把状态码当内部码甩出去 */
const API_ERROR_RE = /^API_ERROR:(\d{3})$/

/**
 * 「看起来像错误码」：短、无空白。
 *
 * **为什么需要这个判据**：`ChatResult.error` 的类型只是 `string`，没有枚举约束。
 * `LlmService` 在网络异常分支里直接把原始异常报文当错误码返回
 * （`_emitModelError(String(err), …)`，`LlmService.ts:647`），所以这个字段**可能是一段
 * 含空格、甚至含堆栈的技术文本**。那种内容不该糊到用户界面上 —— 落到下面统一兜底。
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
