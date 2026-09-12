export interface DsmlToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface DsmlParseResult {
  text: string
  toolCalls: DsmlToolCall[]
}

const DSML_PREFIXES = ['<\uFF5CDSML\uFF5C', '<\uFF5C\uFF5CDSML\uFF5C\uFF5C', '<||DSML||'] as const
const DSML_CLOSE_PREFIXES = ['</\uFF5CDSML\uFF5C', '</\uFF5C\uFF5CDSML\uFF5C\uFF5C', '</||DSML||'] as const
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const DSML_PREFIX_RE = DSML_PREFIXES.map(escapeRegExp).join('|')
const DSML_CLOSE_PREFIX_RE = DSML_CLOSE_PREFIXES.map(escapeRegExp).join('|')
const DSML_BLOCK_RE = new RegExp(
  `(?:${DSML_PREFIX_RE})(?:function_calls|tool_calls)>[\\s\\S]*?(?:${DSML_CLOSE_PREFIX_RE})(?:function_calls|tool_calls)>`,
  'g',
)

function readAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(['"])(.*?)\\1`, 'i').exec(attributes)
  return match?.[2]
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function parseParameterValue(value: string, stringValue: string | undefined): unknown {
  const decoded = decodeXml(value)
  if (stringValue !== 'false') return decoded

  try {
    return JSON.parse(decoded)
  } catch {
    return decoded
  }
}

function parseInvokes(block: string, requestId: string | undefined, startIndex: number): DsmlToolCall[] {
  const calls: DsmlToolCall[] = []
  const prefix = DSML_PREFIXES.map(escapeRegExp).join('|')
  const closePrefix = DSML_CLOSE_PREFIX_RE
  const invokeRe = new RegExp(`(?:${prefix})invoke\\b([^>]*)>([\\s\\S]*?)(?:${closePrefix})invoke>`, 'gi')
  const parameterRe = new RegExp(`(?:${prefix})parameter\\b([^>]*?)(?:/\\s*>|>([\\s\\S]*?)(?:${closePrefix})parameter>)`, 'gi')

  for (const match of block.matchAll(invokeRe)) {
    const name = readAttribute(match[1], 'name')?.trim()
    if (!name) continue

    const args: Record<string, unknown> = {}
    for (const parameter of match[2].matchAll(parameterRe)) {
      const parameterName = readAttribute(parameter[1], 'name')?.trim()
      if (!parameterName) continue
      const stringValue = readAttribute(parameter[1], 'string')?.toLowerCase()
      args[parameterName] = parseParameterValue(parameter[2] ?? '', stringValue)
    }

    calls.push({
      id: `dsml_${requestId || 'call'}_${startIndex + calls.length}`,
      name,
      arguments: args,
    })
  }

  return calls
}

/**
 * Parses DeepSeek's text-based DSML tool-call representation.
 *
 * The provider has emitted both full-width and ASCII DSML delimiters, so the
 * parser deliberately accepts both without changing ordinary model text.
 */
export function parseDsmlToolCalls(input: string, requestId?: string): DsmlParseResult {
  if (!input) return { text: '', toolCalls: [] }

  let nextCallIndex = 0
  const toolCalls: DsmlToolCall[] = []
  const text = input.replace(DSML_BLOCK_RE, (block) => {
    const calls = parseInvokes(block, requestId, nextCallIndex)
    nextCallIndex += calls.length
    toolCalls.push(...calls)
    return ''
  })

  return {
    text: text.trim(),
    toolCalls,
  }
}
