import type { IntentRouteDecision } from './types'

export type ToolChoiceMode = 'auto' | 'required'

export interface RouteExecutionPolicy {
  toolChoiceMode: ToolChoiceMode
  allowedToolNames: string[] | undefined
}

const READ_ONLY_TOOLS = ['list_files', 'read_file', 'grep', 'analyze_codebase']

/**
 * chat_only 也保留的非破坏性工具：联网搜索 + 只读 + 计划查询。
 * 防止意图分类器误判为 chat_only 时模型完全无法执行（例如“有什么新闻吗”需要 web_search）。
 * 不包含 run_command / write_file / edit_file / 发布类等写操作。
 */
const CHAT_SAFE_TOOLS = ['web_search', 'web_fetch', ...READ_ONLY_TOOLS, 'list_plans']

export function resolveRouteExecutionPolicy(decision: IntentRouteDecision): RouteExecutionPolicy {
  if (decision.route === 'chat_only') {
    return { toolChoiceMode: 'auto', allowedToolNames: [...CHAT_SAFE_TOOLS] }
  }
  if (decision.route === 'observe_first') {
    return { toolChoiceMode: 'required', allowedToolNames: [...READ_ONLY_TOOLS] }
  }
  return { toolChoiceMode: 'required', allowedToolNames: undefined }
}
