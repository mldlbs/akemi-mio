import type { RouteInput } from './types'

export function buildRouteClassificationPrompt(input: RouteInput): string {
  return `Classify the user's intent for tool routing. Return JSON only, with no markdown or explanation.
Choose exactly one route: chat_only, observe_first, tool_first, or tool_required.

Routing rules:
- tool_required: the request can only be fulfilled with tools — asking for current or recent information (news, weather, prices, stocks), searching the web, fetching a URL, running commands, testing connectivity, inspecting files, or changing the workspace.
- tool_first: the request is a task that likely needs tools; call the most relevant tool first, then answer.
- observe_first: the request is ambiguous but may involve the workspace; inspect read-only context first.
- chat_only: ONLY for clearly casual conversation that needs no external information and no action. If any tool could help fulfill the request, do not choose chat_only.

Available capabilities include web search, web fetch, file read/list/grep, code analysis, plans, and memory.
Include confidence from 0 to 1 and a brief reason.
Optional suggestedTools must be an array of tool names.
For tool_required and tool_first only, also include successCriteria: a short array (2-4 items) of concrete, verifiable completion conditions for the user request (e.g. "tests pass", "file updated", "artifact generated"). Omit successCriteria for chat_only and observe_first.
Context: ${JSON.stringify(input)}`
}

export function buildRouteRuntimePrompt(decision: { route: string; reason: string; suggestedTools?: string[] } | null): string | null {
  if (!decision || decision.route === 'chat_only') return null
  const directive =
    decision.route === 'observe_first'
      ? 'You MUST call at least one read-only tool (list_files, read_file, grep, analyze_codebase) before the final answer.'
      : 'You MUST actually call a tool to fulfill the request before the final answer. Do not just promise to do something — call the tool and use its result.'
  const suggested = decision.suggestedTools?.length ? ` Prefer the most relevant tools among: ${decision.suggestedTools.join(', ')}.` : ''
  const isInfoRequest = decision.suggestedTools?.some((t) => t.includes('web_search') || t.includes('web_fetch'))
  const infoNote = isInfoRequest
    ? ' This is an information request: the final answer may exceed the usual 80-character TTS limit and should summarize the gathered results with several key points and concrete facts, in spoken style without markdown.'
    : ''
  return `Tool route: ${decision.route}. Reason: ${decision.reason}. ${directive}${suggested}${infoNote}`
}
