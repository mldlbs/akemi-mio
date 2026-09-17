/**
 * 聊天错误码 → 用户可读文案。
 *
 * 背景：主进程 `ChatResult.error` 是给程序看的错误码（`CIRCUIT_OPEN` / `INTERNAL` /
 * `NO_REPLY` / `PAUSED` …）。此前 renderer 侧要么直接把原始码显示出来
 * （`WallpaperAgentPanel` 显示成「错误: CIRCUIT_OPEN」），要么干脆丢弃
 * （`useAIOutput.sendChat` 不接收返回值）—— 用户看到的是一串内部码或什么都没有。
 *
 * 这里集中翻译一次，避免每个消费点各写一套、也避免再出现「丢弃返回值」。
 */

const CHAT_ERROR_TEXT: Record<string, string> = {
  CIRCUIT_OPEN: '模型服务暂时不可用，已暂停请求，约 30 秒后自动恢复',
  PAUSED: '对话已暂停，恢复后再试',
  NO_REPLY: '模型没有返回内容，请重试',
  INTERNAL: '内部错误，请重试',
  TIMEOUT: '模型响应超时，请重试',
  NETWORK: '网络异常，请检查连接后重试',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  NO_KEY: '未配置模型密钥，请在设置中填写',
  INVALID_KEY: '模型密钥无效，请在设置中检查',
}

/**
 * 把错误码翻译成可展示的文案。
 * 无错误（含空串 / null / undefined）返回 null，调用方据此判断是否要展示。
 */
export function chatErrorText(error: string | undefined | null): string | null {
  if (!error) return null
  return CHAT_ERROR_TEXT[error] ?? `请求失败（${error}）`
}
