'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const HOOK = path.resolve(__dirname, '..', 'hooks', 'workbuddy-hook.js')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mio-hook-' + label + '-'))
}

function seedMemory(home, records) {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    path.join(home, 'memory.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  )
}

function memoryRecord(id, content, extra) {
  return Object.assign(
    {
      id,
      timestamp: new Date().toISOString(),
      kind: 'note',
      content,
      tags: ['task-outcome', 'demo'],
      project: 'demo',
      source: 'test',
    },
    extra || {}
  )
}

// On Windows, spawnSync fails with EBUSY whenever stdin is a pipe, so the
// payload is written to a file and passed as a read-only fd instead.
function runHook(home, payload, opts) {
  const options = opts || {}
  const payloadFile = path.join(os.tmpdir(), 'mio-hook-payload-' + process.pid + '-' + Date.now() + '.json')
  fs.writeFileSync(payloadFile, typeof payload === 'string' ? payload : JSON.stringify(payload))
  const fd = fs.openSync(payloadFile, 'r')
  try {
    const env = Object.assign({}, process.env)
    delete env.MIO_HOOK_FORCE_CLI
    delete env.MIO_HOOK_DISABLE
    if (options.forceCli) env.MIO_HOOK_FORCE_CLI = '1'
    if (options.log) env.FAKE_CLI_LOG = options.log
    if (options.env) Object.assign(env, options.env)
    const res = spawnSync(process.execPath, [HOOK, options.cli || '', home], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: [fd, 'pipe', 'pipe'],
      env,
    })
    return res
  } finally {
    fs.closeSync(fd)
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('UserPromptSubmit recalls from the store in-process and injects the hits', () => {
  const home = tempDir('home')
  const workspace = path.join(tempDir('ws'), 'demo')
  fs.mkdirSync(workspace, { recursive: true })
  seedMemory(home, [
    memoryRecord('m1', 'WorkBuddy 的记忆目录其实是 ~/.workbuddy-ai，旧目录不会被读取'),
    memoryRecord('m2', 'observer 只扫 ~/.workbuddy 导致新会话完全采不到'),
  ])

  const res = runHook(home, {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'WorkBuddy 记忆目录为什么采不到新会话',
    cwd: workspace,
    session_id: 's1',
  })
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.continue, true)
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  const context = out.hookSpecificOutput.additionalContext
  assert.ok(context.includes('Mio 记忆'), 'context carries the Mio header')
  assert.ok(context.includes('~/.workbuddy-ai'), 'a matching record is injected')
  assert.ok(context.includes('project=demo'), 'project is derived from the payload cwd')
})

test('short prompts and empty stores inject nothing', () => {
  const home = tempDir('home')
  const workspace = path.join(tempDir('ws'), 'demo')
  fs.mkdirSync(workspace, { recursive: true })

  const short = runHook(home, { hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: workspace })
  assert.equal(short.status, 0)
  assert.equal(JSON.parse(short.stdout).hookSpecificOutput, undefined)

  const empty = runHook(home, {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'a prompt long enough to search but nothing stored yet',
    cwd: workspace,
  })
  assert.equal(empty.status, 0)
  assert.equal(JSON.parse(empty.stdout).hookSpecificOutput, undefined)
})

test('duplicate records are injected once', () => {
  const home = tempDir('home')
  const workspace = path.join(tempDir('ws'), 'demo')
  fs.mkdirSync(workspace, { recursive: true })
  seedMemory(home, [
    memoryRecord('d1', '同一个完成摘要被记录了两次 WorkBuddy 记忆'),
    memoryRecord('d2', '同一个完成摘要被记录了两次 WorkBuddy 记忆'),
    memoryRecord('d3', '另一条不同的决策 WorkBuddy 记忆'),
  ])

  const res = runHook(home, {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'WorkBuddy 记忆 摘要 决策',
    cwd: workspace,
  })
  assert.equal(res.status, 0)
  const context = JSON.parse(res.stdout).hookSpecificOutput.additionalContext
  assert.equal(
    (context.match(/同一个完成摘要被记录了两次/g) || []).length,
    1,
    'the duplicate line is dropped instead of eating the context budget'
  )
})

test('Stop ingests the transcript named by the payload', () => {
  const home = tempDir('home')
  const workspace = tempDir('ws')
  fs.mkdirSync(path.join(workspace, '.workbuddy-ai', 'memory'), { recursive: true })
  const projectDir = path.join(tempDir('tx'), 'projects', 'd-work-code-demo')
  fs.mkdirSync(projectDir, { recursive: true })
  const transcript = path.join(projectDir, 'abc.jsonl')
  const lines = [
    { type: 'message', role: 'user', id: 'u1', timestamp: Date.now() - 30000, cwd: workspace },
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'text', text: 'hook 把这一轮直接写进了 Mio 记忆库' }],
      cwd: workspace,
    },
  ]
  fs.writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')

  const res = runHook(home, {
    hook_event_name: 'Stop',
    transcript_path: transcript,
    cwd: workspace,
    session_id: 'sess-42',
    agent_type: 'cli',
  })
  assert.equal(res.status, 0, res.stderr)
  assert.equal(JSON.parse(res.stdout).continue, true)

  const traces = readJsonl(path.join(home, 'traces.jsonl'))
  assert.equal(traces.length, 1)
  assert.equal(traces[0].event_type, 'task_outcome')
  assert.equal(traces[0].payload.sessionId, 'sess-42')
  const digests = fs.readdirSync(path.join(workspace, '.workbuddy-ai', 'memory')).filter((n) => n.endsWith('.md'))
  assert.equal(digests.length, 1)
})

test('subagent stops are ignored so the parent turn is not emitted twice', () => {
  const home = tempDir('home')
  const res = runHook(home, {
    hook_event_name: 'Stop',
    transcript_path: path.join(home, 'x.jsonl'),
    agent_type: 'explore',
  })
  assert.equal(res.status, 0)
  assert.equal(readJsonl(path.join(home, 'traces.jsonl')).length, 0)
})

test('malformed payload never breaks the host turn', () => {
  const home = tempDir('home')
  const res = runHook(home, 'not json at all')
  assert.equal(res.status, 0)
  assert.equal(JSON.parse(res.stdout).continue, true)
})

test('MIO_HOOK_DISABLE short-circuits both events', () => {
  const home = tempDir('home')
  const workspace = path.join(tempDir('ws'), 'demo')
  fs.mkdirSync(workspace, { recursive: true })
  seedMemory(home, [memoryRecord('m1', 'WorkBuddy 记忆目录')])

  const res = runHook(
    home,
    { hook_event_name: 'UserPromptSubmit', prompt: 'WorkBuddy 记忆目录在哪里', cwd: workspace },
    { env: { MIO_HOOK_DISABLE: '1' } }
  )
  assert.equal(res.status, 0)
  assert.equal(JSON.parse(res.stdout).hookSpecificOutput, undefined)

  const stop = runHook(
    home,
    { hook_event_name: 'Stop', transcript_path: path.join(home, 'x.jsonl'), agent_type: 'cli' },
    { env: { MIO_HOOK_DISABLE: '1' } }
  )
  assert.equal(stop.status, 0)
  assert.equal(readJsonl(path.join(home, 'traces.jsonl')).length, 0)
})

test('MIO_HOOK_FORCE_CLI falls back to the CLI with the same arguments', () => {
  const dir = tempDir('cli')
  const log = path.join(dir, 'cli.log')
  const cli = path.join(dir, 'fake-cli.js')
  fs.writeFileSync(
    cli,
    [
      "'use strict'",
      "const fs = require('fs')",
      'const args = process.argv.slice(2)',
      'fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(args) + "\\n")',
      "process.stdout.write(JSON.stringify({ query: 'q', project: 'demo', scope: 'project', count: 0, results: [] }))",
      '',
    ].join('\n')
  )

  const res = runHook(
    dir,
    { hook_event_name: 'UserPromptSubmit', prompt: '一个足够长的提问', cwd: dir },
    { forceCli: true, cli, log }
  )
  assert.equal(res.status, 0, res.stderr)
  const calls = readJsonl(log)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('recall'))
  assert.ok(calls[0].includes('一个足够长的提问'))

  const stop = runHook(
    dir,
    {
      hook_event_name: 'Stop',
      transcript_path: path.join(dir, 't.jsonl'),
      cwd: dir,
      session_id: 'sess-9',
      agent_type: 'cli',
    },
    { forceCli: true, cli, log }
  )
  assert.equal(stop.status, 0, stop.stderr)
  const ingestCall = readJsonl(log).find((args) => args.includes('ingest'))
  assert.ok(ingestCall, 'ingest routed through the CLI')
  assert.equal(ingestCall[ingestCall.indexOf('--transcript') + 1], path.join(dir, 't.jsonl'))
  assert.equal(ingestCall[ingestCall.indexOf('--session') + 1], 'sess-9')
})
