'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const observer = require('../observe/observer.js')

function tempHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-claude-' + label + '-'))
}

function writeTranscript(dir, sessionId, lines) {
  const file = path.join(dir, sessionId + '.jsonl')
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  return file
}

function userPrompt(uuid, text, cwd, ts) {
  return {
    type: 'user',
    uuid,
    cwd,
    sessionId: 'sess-claude',
    timestamp: ts,
    isSidechain: false,
    message: { role: 'user', content: text },
  }
}

function assistantText(uuid, text, cwd, ts) {
  return {
    type: 'assistant',
    uuid,
    cwd,
    sessionId: 'sess-claude',
    timestamp: ts,
    isSidechain: false,
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal' },
        { type: 'text', text },
      ],
    },
  }
}

function assistantToolUse(uuid, id, cwd, ts) {
  return {
    type: 'assistant',
    uuid,
    cwd,
    sessionId: 'sess-claude',
    timestamp: ts,
    isSidechain: false,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: {} }],
    },
  }
}

function toolResult(uuid, toolUseId, isError, ts) {
  return {
    type: 'user',
    uuid,
    cwd: undefined,
    sessionId: 'sess-claude',
    timestamp: ts,
    isSidechain: false,
    toolUseResult: {},
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: 'x' }],
    },
  }
}

test('claude adapter install writes user-scope mcpServers and CLAUDE.md rules', () => {
  const configDir = tempHome('cfg')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-claude-ws-'))
  const adapter = require('../adapters/claude-code.js')

  try {
    assert.equal(adapter.isInstalled(), false)
    const result = adapter.install({
      node: process.execPath,
      serverScript: '/tmp/mio-server.js',
      home: '/tmp/mio-home',
      workspace,
    })
    assert.equal(result.changed, true)

    const config = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'))
    const entry = config.mcpServers['mio-intelligence']
    assert.ok(entry, 'mio-intelligence entry written')
    assert.equal(entry.command, process.execPath)
    assert.equal(JSON.parse(entry.env.MIO_CONTEXT).agentId, 'claude-code')

    const userRules = fs.readFileSync(path.join(configDir, 'CLAUDE.md'), 'utf8')
    assert.ok(userRules.includes('<!-- MIO_INTELLIGENCE_BEGIN -->'))
    const projectRules = fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8')
    assert.ok(projectRules.includes('<!-- MIO_INTELLIGENCE_BEGIN -->'))
    assert.equal(adapter.isInstalled(), true)

    // Re-install: blocks already present -> rules unchanged (same semantics
    // as the other adapters), and the install stays detected.
    const second = adapter.install({
      node: process.execPath,
      serverScript: '/tmp/mio-server.js',
      home: '/tmp/mio-home',
      workspace,
    })
    assert.equal(second.changed, false)
    assert.equal(adapter.isInstalled(), true)
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR
  }
})

test('claude turn machine finalizes on next user prompt and records tool errors', () => {
  const cwd = 'D:\\work\\code\\demo'
  const ts = (t) => new Date(1730000000000 + t).toISOString()
  const lines = [
    userPrompt('u1', 'fix the bug', cwd, ts(0)),
    assistantToolUse('a1', 'tool-1', cwd, ts(1000)),
    toolResult('r1', 'tool-1', true, ts(1500)),
    assistantText('a2', 'Fixed the bug and verified the build.', cwd, ts(2000)),
    userPrompt('u2', 'thanks, next task', cwd, ts(60000)),
  ]

  let turn = observer.createClaudeTurn()
  const finalized = []
  for (const line of lines) {
    const result = observer.feedClaudeLine(turn, line)
    turn = result.next
    if (result.finalized) finalized.push(result.finalized)
  }

  assert.equal(finalized.length, 1)
  const done = finalized[0]
  assert.equal(done.outcome, 'success')
  assert.equal(done.toolCount, 1)
  assert.equal(done.errors.length, 1)
  assert.ok(done.lastText.includes('Fixed the bug'))
  assert.equal(done.cwd, cwd)
})

test('sidechain lines are ignored and aborted turns have no summary', () => {
  const cwd = 'D:\\work\\code\\demo'
  let turn = observer.createClaudeTurn()
  turn = observer.feedClaudeLine(turn, userPrompt('u1', 'start', cwd, new Date().toISOString())).next
  const side = {
    type: 'assistant',
    uuid: 's1',
    cwd,
    timestamp: new Date().toISOString(),
    isSidechain: true,
    message: { role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] },
  }
  turn = observer.feedClaudeLine(turn, side).next
  assert.equal(turn.lastText, null, 'sidechain text must not leak into the main turn')

  const result = observer.feedClaudeLine(turn, userPrompt('u2', 'next', cwd, new Date().toISOString()))
  assert.ok(result.finalized)
  assert.equal(result.finalized.outcome, 'aborted')
})

test('runCycle ingests claude transcripts into traces and memory', () => {
  const configDir = tempHome('obs')
  const mioHome = tempHome('home')
  const projectDir = path.join(configDir, 'projects', 'D--work-code-demo')
  fs.mkdirSync(projectDir, { recursive: true })
  const cwd = 'D:\\work\\code\\demo'
  const ts = (t) => new Date(1730000000000 + t).toISOString()
  writeTranscript(projectDir, 'session-1', [
    userPrompt('u1', 'do the thing', cwd, ts(0)),
    assistantToolUse('a1', 'tool-1', cwd, ts(1000)),
    toolResult('r1', 'tool-1', false, ts(1500)),
    assistantText('a2', 'Task finished with all checks passing.', cwd, ts(2000)),
    userPrompt('u2', 'thanks, moving on', cwd, ts(60000)),
  ])

  process.env.CLAUDE_CONFIG_DIR = configDir
  try {
    const state = observer.loadState(mioHome)
    const sinks = observer.createSinks(mioHome)
    const res = observer.runCycle(mioHome, state, sinks)
    assert.ok(res.outcomes >= 1, 'expected at least one outcome, got ' + JSON.stringify(res))

    const traces = fs
      .readFileSync(path.join(mioHome, 'traces.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const outcomeTrace = traces.find((t) => t.event_type === 'task_outcome' && t.agent === 'claude-code')
    assert.ok(outcomeTrace, 'task_outcome trace written')
    assert.equal(outcomeTrace.outcome, 'success')
    assert.equal(outcomeTrace.project, 'demo')
    const errorTrace = traces.find((t) => t.event_type === 'error' && t.agent === 'claude-code')
    assert.equal(errorTrace, undefined, 'no error trace for successful tool result')

    const memories = fs
      .readFileSync(path.join(mioHome, 'memory.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const memoryEntry = memories.find((m) => m.source === 'claude-observer')
    assert.ok(memoryEntry, 'memory entry written')
    assert.ok(memoryEntry.content.startsWith('[claude-code] 任务完成:'))

    // Second cycle must be a no-op (offsets tracked).
    const res2 = observer.runCycle(mioHome, state, sinks)
    assert.equal(res2.outcomes, 0)
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR
  }
})
