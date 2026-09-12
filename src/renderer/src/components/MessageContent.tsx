const DSML_MARKER = String.raw`(?:\|\|DSML\|\||｜DSML｜|｜｜DSML｜｜)`
const DSML_BLOCK_RE = new RegExp(
  `<${DSML_MARKER}(?:function_calls|tool_calls)>[\\s\\S]*?<\\/${DSML_MARKER}(?:function_calls|tool_calls)>`,
  'gi',
)
const DSML_START_RE = new RegExp(`<${DSML_MARKER}(?:function_calls|tool_calls)>`, 'i')
const DSML_INVOKE_RE = new RegExp(`<${DSML_MARKER}invoke\\s+name=["']([^"']+)["'][^>]*>`, 'gi')
const XML_BLOCK_RE = /<(?:function_calls|tool_calls)>[\s\S]*?<\/(?:function_calls|tool_calls)>/gi
const XML_START_RE = /<(?:function_calls|tool_calls)>/i
const XML_INVOKE_RE = /<invoke\s+name=["']([^"']+)["'][^>]*>/gi

export interface MessageDisclosure {
  text: string
  toolNames: string[]
  hasToolTrace: boolean
}

export function parseMessageDisclosure(content: string): MessageDisclosure {
  const traces: string[] = []
  let text = content
    .replace(DSML_BLOCK_RE, (block) => {
      traces.push(block)
      return ''
    })
    .replace(XML_BLOCK_RE, (block) => {
      traces.push(block)
      return ''
    })

  const incompleteStart = [text.search(DSML_START_RE), text.search(XML_START_RE)].filter((index) => index >= 0).sort((a, b) => a - b)[0]

  if (incompleteStart !== undefined) {
    traces.push(text.slice(incompleteStart))
    text = text.slice(0, incompleteStart)
  }

  const toolNames = new Set<string>()
  for (const trace of traces) {
    for (const expression of [DSML_INVOKE_RE, XML_INVOKE_RE]) {
      expression.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = expression.exec(trace))) toolNames.add(match[1])
    }
  }

  return {
    text: text.trim(),
    toolNames: [...toolNames],
    hasToolTrace: traces.length > 0,
  }
}

export function MessageContent({ content }: { content: string }) {
  const disclosure = parseMessageDisclosure(content)

  if (!disclosure.hasToolTrace) return <div className="msg-bubble">{content}</div>

  const count = disclosure.toolNames.length
  const summary = count > 0 ? `已调用 ${count} 个工具` : '工具调用详情'

  return (
    <>
      {disclosure.text && <div className="msg-bubble">{disclosure.text}</div>}
      <details className="msg-tool-disclosure">
        <summary>
          <i className="ri-terminal-box-line" aria-hidden="true" />
          <span>{summary}</span>
          <span className="msg-tool-disclosure-hint">查看详情</span>
        </summary>
        {count > 0 && (
          <div className="msg-tool-disclosure-list">
            {disclosure.toolNames.map((toolName) => (
              <span key={toolName}>{toolName}</span>
            ))}
          </div>
        )}
      </details>
    </>
  )
}
