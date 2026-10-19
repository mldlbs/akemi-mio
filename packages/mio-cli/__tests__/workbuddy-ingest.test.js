'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const observer = require('../observe/observer.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-ingest-' + label + '-'))
}

// Minimal WorkBuddy transcript: the user line opens a turn, the assistant line
// fills it, and the next user line finalises it. `cwd` is what the digest and
// the AGENTS.md context block key off.
function writeTranscript(dir, { cwd, summary, timestamp }) {
  const projectDir = path.join(dir, 'projects', 'd-work-code-demo')
  fs.mkdirSync(projectDir, { recursive: true })
  const file = path.join(projectDir, 'session-abc.jsonl')
  const lines = [
    { type: 'message', role: 'user', id: 'u1', timestamp, cwd },
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'text', text: summary }],
      cwd,
    },
    { type: 'function_call', name: 'Bash', callId: 'c1', cwd },
    { type: 'function_call_result', name: 'Bash', callId: 'c1', status: 'completed', cwd },
    { type: 'message', role: 'user', id: 'u2', timestamp: timestamp + 1000, cwd },
  ]
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return file
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('ingestTranscript captures one finished turn without scanning every root', () => {
  const home = tempDir('home')
  const workspace = tempDir('ws')
  fs.mkdirSync(path.join(workspace, '.workbuddy-ai'), { recursive: true })
  const transcriptRoot = tempDir('tx')
  const summary = '修好了 WorkBuddy 的目录解析并跑通了 ingest 测试'
  const file = writeTranscript(transcriptRoot, { cwd: workspace, summary, timestamp: Date.now() - 60000 })

  const res = observer.ingestTranscript(home, file, {
    cwd: workspace,
    sessionId: 'sess-1',
    finalize: true,
  })
  assert.equal(res.files, 1)
  assert.equal(res.lines, 5)
  assert.equal(res.outcomes, 1, 'the completed turn is emitted')

  const traces = readJsonl(path.join(home, 'traces.jsonl'))
  assert.equal(traces.length, 1)
  assert.equal(traces[0].event_type, 'task_outcome')
  assert.equal(traces[0].outcome, 'success')
  assert.equal(traces[0].project, 'demo')
  assert.equal(traces[0].payload.sessionId, 'sess-1', 'the hook payload session id wins over the file name')
  assert.equal(traces[0].payload.toolCalls, 1)

  const memory = readJsonl(path.join(home, 'memory.jsonl'))
  assert.equal(memory.length, 1)
  assert.ok(memory[0].content.includes('[workbuddy] 任务完成'))
  assert.ok(memory[0].tags.includes('demo'))

  // Digest goes where WorkBuddy 5.x actually reads it.
  const digestDir = path.join(workspace, '.workbuddy-ai', 'memory')
  const digests = fs.readdirSync(digestDir).filter((name) => name.endsWith('.md'))
  assert.equal(digests.length, 1, 'digest written under .workbuddy-ai/memory')
  const digest = fs.readFileSync(path.join(digestDir, digests[0]), 'utf8')
  assert.ok(digest.includes('Mio 自动摘要'))
  assert.ok(digest.includes('success'))

  const agents = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8')
  assert.ok(agents.includes('<!-- MIO_CONTEXT_BEGIN -->'))
  assert.ok(agents.includes('success'))

  // Re-running the same hook must not duplicate the outcome: offsets live in
  // the shared state file, exactly like the daemon's cycle.
  const again = observer.ingestTranscript(home, file, { cwd: workspace, sessionId: 'sess-1', finalize: true })
  assert.equal(again.lines, 0)
  assert.equal(again.outcomes, 0)
  assert.equal(readJsonl(path.join(home, 'traces.jsonl')).length, 1)
})

test('a trailing turn with no closing user line is emitted only when the hook asks', () => {
  const workspace = tempDir('ws')
  const transcriptRoot = tempDir('tx')
  const projectDir = path.join(transcriptRoot, 'projects', 'd-work-code-live')
  fs.mkdirSync(projectDir, { recursive: true })
  const file = path.join(projectDir, 'live.jsonl')
  // Stop fires while the transcript still ends on the assistant answer: there
  // is no following user line to finalise the turn, so only the explicit
  // finalize path can emit it.
  const lines = [
    { type: 'message', role: 'user', id: 'u1', timestamp: Date.now() - 5000, cwd: workspace },
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'text', text: '这是本轮最后一次回答，后面没有新的用户消息' }],
      cwd: workspace,
    },
  ]
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')

  const passiveHome = tempDir('home-passive')
  const passive = observer.ingestTranscript(passiveHome, file, { cwd: workspace })
  assert.equal(passive.outcomes, 0, 'the daemon path waits for IDLE_MS instead of guessing')

  const hookHome = tempDir('home-hook')
  const hook = observer.ingestTranscript(hookHome, file, { cwd: workspace, finalize: true })
  assert.equal(hook.outcomes, 1, 'the Stop hook knows the turn is over')
  assert.equal(readJsonl(path.join(hookHome, 'traces.jsonl')).length, 1)
})

test('digest falls back to the legacy memory dir when the workspace has no .workbuddy-ai', () => {
  const home = tempDir('home')
  const workspace = tempDir('ws')
  fs.mkdirSync(path.join(workspace, '.workbuddy', 'memory'), { recursive: true })
  const transcriptRoot = tempDir('tx')
  const file = writeTranscript(transcriptRoot, {
    cwd: workspace,
    summary: '老版本 WorkBuddy 工作区仍然写回旧记忆目录',
    timestamp: Date.now() - 60000,
  })

  observer.ingestTranscript(home, file, { cwd: workspace, sessionId: 'sess-2', finalize: true })
  const digests = fs
    .readdirSync(path.join(workspace, '.workbuddy', 'memory'))
    .filter((name) => name.endsWith('.md'))
  assert.equal(digests.length, 1)
})

test('listTranscripts covers both config roots and de-duplicates', () => {
  const home = tempDir('home')
  delete process.env.WORKBUDDY_CONFIG_DIR
  delete process.env.CODEBUDDY_CONFIG_DIR

  const modern = path.join(home, '.workbuddy-ai', 'projects', 'd-work-code-a')
  const legacy = path.join(home, '.workbuddy', 'projects', 'd-work-code-b')
  fs.mkdirSync(modern, { recursive: true })
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(modern, 'a.jsonl'), '{}\n')
  fs.writeFileSync(path.join(legacy, 'b.jsonl'), '{}\n')

  const files = observer.listTranscripts(home)
  assert.equal(files.length, 2, 'a session living in either root is observed')
  assert.deepEqual(
    files.map((file) => path.basename(file)).sort(),
    ['a.jsonl', 'b.jsonl']
  )
  assert.equal(observer.workbuddyConfigDirs(home).length, 2)
  assert.equal(path.basename(observer.workbuddyConfigDirs(home)[0]), '.workbuddy-ai')
})
