import { describe, expect, it } from 'vitest'
import { parseDsmlToolCalls } from '@akemi-mio/intelligence/llm/DsmlToolCallParser'

describe('parseDsmlToolCalls', () => {
  it('parses compact ASCII DSML and keeps the natural-language prefix', () => {
    const result = parseDsmlToolCalls(
      '我先查一下。<||DSML||tool_calls><||DSML||invoke name="search"><||DSML||parameter name="query" string="true">bond fields</||DSML||parameter><||DSML||parameter name="limit" string="false">5</||DSML||parameter></||DSML||invoke></||DSML||tool_calls>',
      'req-1',
    )

    expect(result.text).toBe('我先查一下。')
    expect(result.toolCalls).toEqual([
      {
        id: 'dsml_req-1_0',
        name: 'search',
        arguments: { query: 'bond fields', limit: 5 },
      },
    ])
  })

  it('parses canonical DSML with multiple invokes and JSON parameter values', () => {
    const result = parseDsmlToolCalls(
      [
        '<\uFF5CDSML\uFF5Cfunction_calls>',
        '<\uFF5CDSML\uFF5Cinvoke name="write_file">',
        '<\uFF5CDSML\uFF5Cparameter name="path" string="true">a.json</\uFF5CDSML\uFF5Cparameter>',
        '<\uFF5CDSML\uFF5Cparameter name="content" string="false">{"ok":true}</\uFF5CDSML\uFF5Cparameter>',
        '</\uFF5CDSML\uFF5Cinvoke>',
        '<\uFF5CDSML\uFF5Cinvoke name="read_file"></\uFF5CDSML\uFF5Cinvoke>',
        '</\uFF5CDSML\uFF5Cfunction_calls>',
      ].join(''),
      'req-2',
    )

    expect(result.text).toBe('')
    expect(result.toolCalls).toEqual([
      {
        id: 'dsml_req-2_0',
        name: 'write_file',
        arguments: { path: 'a.json', content: { ok: true } },
      },
      {
        id: 'dsml_req-2_1',
        name: 'read_file',
        arguments: {},
      },
    ])
  })

  it('parses double-fullwidth-bar DSML from real user messages', () => {
    const result = parseDsmlToolCalls(
      [
        '<\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>',
        '<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="run_command">',
        '<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="command" string="true">curl -I https://example.com</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>',
        '</\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>',
        '</\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>',
      ].join(''),
      'req-4',
    )

    expect(result).toEqual({
      text: '',
      toolCalls: [
        {
          id: 'dsml_req-4_0',
          name: 'run_command',
          arguments: { command: 'curl -I https://example.com' },
        },
      ],
    })
  })

  it('returns ordinary text unchanged when no DSML block is present', () => {
    expect(parseDsmlToolCalls('普通回复', 'req-3')).toEqual({
      text: '普通回复',
      toolCalls: [],
    })
  })
})
