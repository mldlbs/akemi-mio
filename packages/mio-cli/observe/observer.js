#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')

const INTERVAL_MS = 3000
// A WorkBuddy turn is considered finished when its transcript file has not
// been appended for this long AND an assistant answer is present.
const IDLE_MS = 15000

function homeDir() {
  return process.env.MIO_HOME || path.join(os.homedir(), '.mio-intelligence')
}

function workbuddyConfigDir() {
  return (
    process.env.WORKBUDDY_CONFIG_DIR ||
    process.env.CODEBUDDY_CONFIG_DIR ||
    path.join(os.homedir(), '.workbuddy')
  )
}

function createId(prefix) {
  return prefix + '_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex')
}

function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/#{2,}|\*{2,}|`{1,}|_{2,}|~{2,}|-{2,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function projectFromDirName(dirName) {
  // WorkBuddy project dirs encode the workspace path with dashes, e.g.
  // "d-work-code-douyin_store" -> "douyin_store"
  const parts = String(dirName || '').split('-').filter(Boolean)
  if (parts.length > 1 && /^\\d+$/.test(parts[parts.length - 1])) {
    return dirName || 'unknown'
  }
  return parts.length > 1 ? parts[parts.length - 1] : dirName || 'unknown'
}

function log(home, message) {
  const line = '[' + new Date().toISOString() + '] ' + message + '\n'
  try {
    fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
    fs.appendFileSync(path.join(home, 'logs', 'observe.log'), line, 'utf8')
  } catch (_) {}
  if (process.stdout.isTTY || process.env.MIO_OBSERVE_VERBOSE) {
    process.stdout.write(line)
  }
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

function stateFile(home) {
  return path.join(home, 'observe-state.json')
}

function loadState(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'))
    if (parsed && typeof parsed === 'object') {
      return {
        version: 1,
        files: parsed.files || {},
        buffers: parsed.buffers || {},
        openTurns: parsed.openTurns || {},
        contexts: parsed.contexts || {},
        codexFiles: parsed.codexFiles || {},
        codexBuffers: parsed.codexBuffers || {},
        codexTurns: parsed.codexTurns || {},
        ocSeeded: parsed.ocSeeded || false,
        ocLastRowid: parsed.ocLastRowid || 0,
        ocDbMtime: parsed.ocDbMtime || null,
        ocPending: parsed.ocPending || false,
        ocTurns: parsed.ocTurns || {},
        hmSeeded: parsed.hmSeeded || false,
        hmLastMsgId: parsed.hmLastMsgId || 0,
        hmTurns: parsed.hmTurns || {},
        clFiles: parsed.clFiles || {},
        clBuffers: parsed.clBuffers || {},
        clTurns: parsed.clTurns || {},
      }
    }
  } catch (_) {}
  return {
    version: 1,
    files: {},
    buffers: {},
    openTurns: {},
    contexts: {},
    codexFiles: {},
    codexBuffers: {},
    codexTurns: {},
    ocSeeded: false,
    ocLastRowid: 0,
    ocDbMtime: null,
    ocPending: false,
    ocTurns: {},
    hmSeeded: false,
    hmLastMsgId: 0,
    hmTurns: {},
    clFiles: {},
    clBuffers: {},
    clTurns: {},
  }
}

function saveState(home, state) {
  try {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(stateFile(home), JSON.stringify(state) + '\n', 'utf8')
  } catch (_) {}
}

function listTranscripts() {
  const root = path.join(workbuddyConfigDir(), 'projects')
  const out = []
  if (!fs.existsSync(root)) return out
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(root)
  return out
}

function codexConfigDir() {
  return process.env.CODEX_CONFIG_DIR || path.join(os.homedir(), '.codex')
}

function listCodexTranscripts() {
  const root = path.join(codexConfigDir(), 'sessions')
  const out = []
  if (!fs.existsSync(root)) return out
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(root)
  return out
}

function fileMeta(file) {
  const dirName = path.basename(path.dirname(file))
  return {
    sessionId: path.basename(file, '.jsonl'),
    project: projectFromDirName(dirName),
  }
}

// ---------------------------------------------------------------------------
// sinks (write into MIO_HOME with the same schema as the MCP server)
// ---------------------------------------------------------------------------

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8')
}

function createSinks(home) {
  const tracePath = path.join(home, 'traces.jsonl')
  const memoryPath = path.join(home, 'memory.jsonl')
  const seenTraceIds = new Set()
  const seenMemoryContents = new Set()

  function trace(event) {
    const record = {
      id: createId('trace'),
      timestamp: new Date().toISOString(),
      trace_id: event.trace_id,
      event_type: event.event_type,
      outcome: event.outcome || null,
      payload: event.payload || {},
      agent: event.agent || 'workbuddy-observer',
      host: event.host || 'workbuddy-observer',
      project: event.project || 'unknown',
    }
    if (seenTraceIds.has(record.trace_id)) return
    seenTraceIds.add(record.trace_id)
    if (seenTraceIds.size > 20000) seenTraceIds.clear()
    appendJsonl(tracePath, record)
  }

  function memory(entry) {
    const key = entry.project + '|' + entry.content
    if (seenMemoryContents.has(key)) return
    seenMemoryContents.add(key)
    const record = {
      id: createId('mem'),
      timestamp: new Date().toISOString(),
      kind: entry.kind || 'note',
      content: entry.content,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      project: entry.project || 'unknown',
      source: entry.source || 'workbuddy-observer',
    }
    appendJsonl(memoryPath, record)
  }

  return { trace, memory }
}

// ---------------------------------------------------------------------------
// WorkBuddy transcript turn machine
// ---------------------------------------------------------------------------

function createTurn(meta) {
  return {
    id: null,
    ts: null,
    project: meta.project,
    sessionId: meta.sessionId,
    cwd: meta.cwd || null,
    toolCount: 0,
    errors: [],
    lastAssistant: null,
  }
}

function feedWorkbuddyLine(turn, obj) {
  if (!obj || typeof obj !== 'object') return { finalized: null, next: turn }
  let finalized = null
  if (obj.cwd) turn.cwd = obj.cwd
  if (obj.type === 'message') {
    if (obj.role === 'user') {
      finalized = turn
      const next = createTurn(turn)
      next.id = obj.id
      next.ts = obj.timestamp
      next.cwd = obj.cwd || turn.cwd
      return { finalized, next: next }
    }
    if (obj.role === 'assistant') {
      const text = (Array.isArray(obj.content) ? obj.content : [])
        .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
        .filter(Boolean)
        .join('\n')
      turn.lastAssistant = {
        status: obj.status,
        text: text,
        error: (obj.providerData && obj.providerData.error) || null,
      }
    }
  } else if (obj.type === 'function_call') {
    turn.toolCount += 1
  } else if (obj.type === 'function_call_result') {
    const status = String(obj.status || (obj.is_error ? 'error' : 'completed'))
    if (status !== 'completed') {
      turn.errors.push({ callId: obj.callId, name: obj.name, status: status })
      if (turn.errors.length > 20) turn.errors.shift()
    }
  }
  return { finalized: finalized, next: turn }
}

const CONTEXT_BEGIN = '<!-- MIO_CONTEXT_BEGIN -->'
const CONTEXT_END = '<!-- MIO_CONTEXT_END -->'
const CONTEXT_MAX = 6

// Maintain a compact 'recent Mio context' block inside <workspace>/AGENTS.md,
// which WorkBuddy's MemoryLoader auto-injects into every session. This makes
// retrieval guaranteed (not dependent on the model deciding to read memory).
function updateProjectContext(state, cwd, line, targetFile) {
  if (!cwd || !line) return
  const target = path.join(cwd, targetFile || 'AGENTS.md')
  const list = state.contexts[cwd] || []
  list.unshift(line)
  if (list.length > CONTEXT_MAX) list.pop()
  state.contexts[cwd] = list
  try {
    let content = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
    const block = CONTEXT_BEGIN + '\n## Mio 最近上下文（自动注入）\n' + list.map(function (l) { return '- ' + l }).join('\n') + '\n' + CONTEXT_END
    const start = content.indexOf(CONTEXT_BEGIN)
    if (start !== -1) {
      const end = content.indexOf(CONTEXT_END, start)
      content = end === -1 ? content.slice(0, start) : content.slice(0, start) + content.slice(end + CONTEXT_END.length)
    }
    content = content.trimEnd() + '\n\n' + block + '\n'
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, 'utf8')
  } catch (_) {}
}

function localDateKey(ts) {
  const d = new Date(Number(ts) || Date.now())
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + day
}

// Write a compact Mio digest back into WorkBuddy's own memory file
// (<workspace>/.workbuddy/memory/YYYY-MM-DD.md). WorkBuddy instructs its model
// to maintain and read these files every session, so the digest is
// 'retrieved' next session without any Mio tool call by the model.
function writeWorkbuddyDigest(turn, outcome, summary) {
  if (!turn.cwd || !summary) return
  const dir = path.join(turn.cwd, '.workbuddy', 'memory')
  const file = path.join(dir, localDateKey(turn.ts) + '.md')
  try {
    fs.mkdirSync(dir, { recursive: true })
    const time = new Date(Number(turn.ts) || Date.now()).toLocaleString('zh-CN', { hour12: false })
    const entry =
      '\n## Mio 自动摘要 (' + time + ')\n' +
      '- outcome: ' + outcome + ' | tools: ' + turn.toolCount + ' | ' + summary.slice(0, 160) + '\n'
    fs.appendFileSync(file, entry, 'utf8')
  } catch (_) {}
}

function emitWorkbuddyOutcome(turn, sinks, state) {
  const la = turn.lastAssistant
  if (!la) return false
  let outcome
  if (la.status === 'completed') outcome = 'success'
  else if (la.error) outcome = 'failure'
  else outcome = 'aborted'

  const summary = cleanText(la.text)
  const turnToken = String(turn.id || 'unknown').slice(0, 8)
  const tsToken = turn.ts ? Math.floor(Number(turn.ts) / 1000) : Math.floor(Date.now() / 1000)

  sinks.trace({
    trace_id: 'workbuddy:' + turn.sessionId + ':' + turnToken + ':' + tsToken,
    event_type: 'task_outcome',
    outcome: outcome,
    payload: {
      host: 'workbuddy',
      project: turn.project,
      sessionId: turn.sessionId,
      turnId: turn.id,
      toolCalls: turn.toolCount,
      errors: turn.errors.length,
      summary: summary.slice(0, 300),
    },
    agent: 'workbuddy',
    host: 'workbuddy',
    project: turn.project,
  })

  // Low threshold: even a short but real completion summary must reach the
  // passive retrieval paths (memory + daily digest + AGENTS.md context block).
  // 40 was too strict and silently dropped short summaries from retrieval.
  if (outcome === 'success' && summary.length >= 10) {
    sinks.memory({
      kind: 'note',
      content: '[workbuddy] 任务完成: ' + summary.slice(0, 160),
      tags: ['task-outcome', 'workbuddy', turn.project],
      project: turn.project,
      source: 'workbuddy-observer',
    })
    writeWorkbuddyDigest(turn, outcome, summary)
    var ctxTime = new Date(Number(turn.ts) || Date.now()).toLocaleString('zh-CN', { hour12: false })
    updateProjectContext(state, turn.cwd, ctxTime + ' | ' + outcome + ' | ' + summary.slice(0, 80))
  }

  for (const err of turn.errors) {
    sinks.trace({
      trace_id: 'workbuddy:' + turn.sessionId + ':' + turnToken + ':' + String(err.callId || 'err').slice(0, 12),
      event_type: 'error',
      outcome: 'error',
      payload: {
        host: 'workbuddy',
        project: turn.project,
        sessionId: turn.sessionId,
        turnId: turn.id,
        tool: err.name,
        status: err.status,
      },
      agent: 'workbuddy',
      host: 'workbuddy',
      project: turn.project,
    })
  }
  return true
}

// ---------------------------------------------------------------------------
// Codex session turn machine (passive observation)
// ---------------------------------------------------------------------------

// Codex rollout transcripts are append-only JSONL under
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. The first session_meta line
// carries the workspace cwd; task_started / task_complete / turn_aborted mark
// turn boundaries, agent_message carries the running answer text.
function createCodexTurn() {
  return {
    id: null,
    ts: null,
    sessionId: null,
    cwd: null,
    lastAgent: null,
    aborted: false,
  }
}

function feedCodexLine(turn, obj) {
  if (!obj || typeof obj !== 'object') return {}
  if (obj.type === 'session_meta') {
    const p = obj.payload || {}
    if (!turn.cwd && p.cwd) turn.cwd = p.cwd
    if (!turn.sessionId && (p.session_id || p.id)) turn.sessionId = p.session_id || p.id
    return {}
  }
  if (obj.type !== 'event_msg') return {}
  const p = obj.payload || {}
  if (p.type === 'task_started') {
    // A turn that started earlier but never completed is discarded.
    turn.id = p.turn_id || null
    turn.ts = p.started_at ? Number(p.started_at) * 1000 : null
    turn.lastAgent = null
    turn.aborted = false
    return {}
  }
  if (p.type === 'agent_message' && p.message) {
    turn.lastAgent = p.message
    return {}
  }
  if (p.type === 'task_complete') {
    const finalized = {
      id: turn.id,
      ts: p.completed_at ? Number(p.completed_at) * 1000 : turn.ts,
      sessionId: turn.sessionId,
      cwd: turn.cwd,
      project: path.basename(turn.cwd || '') || 'unknown',
      lastAgent: p.last_agent_message || turn.lastAgent,
      aborted: false,
    }
    turn.id = null
    turn.lastAgent = null
    return { finalized: finalized }
  }
  if (p.type === 'turn_aborted') {
    const finalized = {
      id: turn.id,
      ts: p.completed_at ? Number(p.completed_at) * 1000 : turn.ts,
      sessionId: turn.sessionId,
      cwd: turn.cwd,
      project: path.basename(turn.cwd || '') || 'unknown',
      lastAgent: turn.lastAgent,
      aborted: true,
    }
    turn.id = null
    turn.lastAgent = null
    return { finalized: finalized }
  }
  return {}
}

function emitCodexOutcome(turn, sinks, state) {
  if (!turn.lastAgent) return false
  const summary = cleanText(turn.lastAgent)
  if (!summary) return false
  const outcome = turn.aborted ? 'aborted' : 'success'
  const turnToken = String(turn.id || 'unknown').slice(0, 8)

  sinks.trace({
    trace_id: 'codex:' + (turn.sessionId || 'unknown') + ':' + turnToken,
    event_type: 'task_outcome',
    outcome: outcome,
    payload: {
      host: 'codex',
      project: turn.project,
      sessionId: turn.sessionId,
      turnId: turn.id,
      toolCalls: 0,
      errors: 0,
      summary: summary.slice(0, 300),
      source: 'codex-observer',
    },
    agent: 'codex',
    host: 'codex',
    project: turn.project,
  })

  if (outcome === 'success' && summary.length >= 10) {
    sinks.memory({
      kind: 'note',
      content: '[codex] 任务完成: ' + summary.slice(0, 160),
      tags: ['task-outcome', 'codex', turn.project],
      project: turn.project,
      source: 'codex-observer',
    })
    var ctxTime = new Date(Number(turn.ts) || Date.now()).toLocaleString('zh-CN', { hour12: false })
    updateProjectContext(state, turn.cwd, ctxTime + ' | ' + outcome + ' | ' + summary.slice(0, 80))
  }
  return true
}

function runCodexCycle(home, state, sinks, opts) {
  const out = { files: 0, lines: 0, outcomes: 0 }
  const files = listCodexTranscripts()
  const now = Date.now()
  const maxAgeMs = (opts && opts.maxAgeMs) || 24 * 60 * 60 * 1000

  for (const file of files) {
    out.files += 1
    let st
    try {
      st = fs.statSync(file)
    } catch (_) {
      continue
    }
    const info = state.codexFiles[file] || { size: 0 }
    if (!state.codexFiles[file] && now - st.mtimeMs > maxAgeMs) continue
    const size = st.size
    if (size < info.size) {
      info.size = 0
      state.codexBuffers[file] = ''
    }

    if (!state.codexTurns[file]) state.codexTurns[file] = createCodexTurn()
    const turn = state.codexTurns[file]

    if (size > info.size) {
      let chunk = ''
      try {
        const fd = fs.openSync(file, 'r')
        const buf = Buffer.alloc(size - info.size)
        fs.readSync(fd, buf, 0, buf.length, info.size)
        fs.closeSync(fd)
        chunk = buf.toString('utf8')
      } catch (_) {
        continue
      }
      const pending = (state.codexBuffers[file] || '') + chunk
      const lines = pending.split(/\r?\n/)
      state.codexBuffers[file] = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        out.lines += 1
        let obj
        try {
          obj = JSON.parse(line)
        } catch (_) {
          continue
        }
        const result = feedCodexLine(turn, obj)
        if (result.finalized) {
          if (emitCodexOutcome(result.finalized, sinks, state)) out.outcomes += 1
        }
      }
      state.codexFiles[file] = { size: size, mtimeMs: st.mtimeMs }
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// OpenCode session observation (passive, via `opencode db`)
// ---------------------------------------------------------------------------

// OpenCode stores everything in ~/.local/share/opencode/opencode.db (SQLite).
// On Windows the db file is held with an exclusive lock while OpenCode runs,
// so we cannot open it with node:sqlite directly. Instead we shell out to the
// `opencode db` CLI, which opens the same database through the app itself and
// works even while OpenCode is running. We tail `part` rows by rowid so each
// session is scanned incrementally and only text/tool parts are transferred.

function opencodeDataDir() {
  return (
    process.env.OPENCODE_DATA_DIR ||
    path.join(os.homedir(), '.local', 'share', 'opencode')
  )
}

function opencodeDbPath() {
  return path.join(opencodeDataDir(), 'opencode.db')
}

function findOpencodeBin() {
  if (process.env.OPENCODE_BIN && fs.existsSync(process.env.OPENCODE_BIN)) {
    return process.env.OPENCODE_BIN
  }
  const exeDir = path.dirname(process.execPath)
  const candidates = [
    path.join(exeDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(exeDir, '..', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(exeDir, '..', '..', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
  ]
  for (const c of candidates) {
    const resolved = path.resolve(c)
    if (fs.existsSync(resolved)) return resolved
  }
  // Resolve from PATH so the SQL is never passed through cmd.exe, where
  // '>' in the query is interpreted as output redirection and creates
  // stray files (e.g. "WHERE p.rowid > 0" -> a file named "0").
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    const res = spawnSync(finder, ['opencode'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    if (res.status === 0 && res.stdout) {
      const lines = res.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      const preferred =
        process.platform === 'win32'
          ? lines.filter((p) => /\.(exe|cmd|bat)$/i.test(p))
          : lines
      const first = (preferred.length > 0 ? preferred : lines).find((p) => fs.existsSync(p))
      if (first) return first
    }
  } catch (_) {}
  return null
}

function runOpencodeQuery(sql) {
  const bin = findOpencodeBin()
  // Never shell the SQL through cmd.exe: '>' in the query would be parsed
  // as output redirection, creating files named after the redirect target.
  if (!bin) return null
  const args = ['db', sql, '--format', 'json']
  let res
  try {
    res = spawnSync(bin, args, { encoding: 'utf8', timeout: 90000, windowsHide: true, maxBuffer: 256 * 1024 * 1024 })
  } catch (_) {
    return null
  }
  if (res.error || res.status !== 0 || !res.stdout) return null
  try {
    return JSON.parse(res.stdout)
  } catch (_) {
    return null
  }
}

// Only transfer text and tool parts; skip reasoning/step bookkeeping rows to
// keep the transferred payload small.
const OPENCODE_PART_FILTER = " AND (p.data LIKE '%\"type\":\"text\"%' OR p.data LIKE '%\"type\":\"tool\"%')"

function createOpencodeTurn(meta) {
  meta = meta || {}
  return {
    id: null,
    ts: null,
    sessionId: meta.sessionId || null,
    cwd: meta.directory || null,
    project: meta.directory ? path.basename(meta.directory) : 'unknown',
    agent: meta.agent || null,
    title: meta.title || null,
    lastMid: null,
    lastText: null,
    toolCount: 0,
    errors: [],
    pendingTerminal: null,
    done: false,
  }
}

function opencodeOutcomeFor(finish) {
  if (finish === 'error') return 'failure'
  if (finish === 'cancel' || finish === 'aborted' || finish === 'interrupted') return 'aborted'
  return 'success'
}

function finalizeOpencodeTurn(turn, outcome) {
  if (!turn.id) return null
  const finalized = {
    id: turn.id,
    ts: turn.ts,
    sessionId: turn.sessionId,
    cwd: turn.cwd,
    project: turn.project,
    agent: turn.agent,
    title: turn.title,
    lastText: turn.lastText,
    toolCount: turn.toolCount,
    errors: turn.errors.slice(),
    outcome: outcome,
  }
  turn.done = true
  return finalized
}

function applyOpencodeAssistantPart(turn, pd, md, row) {
  if (pd.type === 'text' && typeof pd.text === 'string' && pd.text.trim()) {
    turn.lastText = pd.text
  } else if (pd.type === 'tool') {
    turn.toolCount += 1
    const status = pd.state && pd.state.status
    if (status && status !== 'completed' && status !== 'ok' && status !== 'success' && status !== 'running') {
      turn.errors.push({ tool: pd.tool || 'unknown', status: status })
      if (turn.errors.length > 20) turn.errors.shift()
    }
  }
  if (md.finish && md.finish !== 'tool-calls') {
    turn.pendingTerminal = md.finish
  }
  turn.lastMid = row.mid
}

function feedOpencodePart(turn, row) {
  let pd
  let md
  try {
    pd = JSON.parse(row.pd)
  } catch (_) {
    pd = null
  }
  try {
    md = JSON.parse(row.md)
  } catch (_) {
    md = null
  }
  if (!pd || !md) return { next: turn }

  // A user message starts a new turn; any unfinished previous turn is aborted.
  if (md.role === 'user') {
    let finalized = null
    if (turn.id && !turn.done) {
      finalized = finalizeOpencodeTurn(turn, turn.pendingTerminal ? opencodeOutcomeFor(turn.pendingTerminal) : 'aborted')
    }
    const next = createOpencodeTurn({
      sessionId: row.sid,
      directory: row.sdir,
      title: row.stitle,
      agent: row.sagent,
    })
    next.id = row.mid
    next.ts = Number(row.t) || Date.now()
    next.lastMid = row.mid
    return { finalized, next }
  }

  if (turn.done) return { next: turn }

  // Message boundary after a terminal finish closes the previous turn.
  if (turn.lastMid && row.mid !== turn.lastMid && turn.pendingTerminal) {
    const finalized = finalizeOpencodeTurn(turn, opencodeOutcomeFor(turn.pendingTerminal))
    const next = createOpencodeTurn({
      sessionId: row.sid,
      directory: row.sdir,
      title: row.stitle,
      agent: row.sagent,
    })
    applyOpencodeAssistantPart(next, pd, md, row)
    return { finalized, next }
  }

  applyOpencodeAssistantPart(turn, pd, md, row)
  return { next: turn }
}

function emitOpencodeOutcome(turn, sinks, state) {
  if (!turn.id) return false
  const summary = cleanText(turn.lastText)
  if (!summary) return false
  const outcome = turn.outcome
  const turnToken = String(turn.id).slice(0, 8)
  const tsToken = turn.ts ? Math.floor(turn.ts / 1000) : Math.floor(Date.now() / 1000)

  sinks.trace({
    trace_id: 'opencode:' + (turn.sessionId || 'unknown') + ':' + turnToken + ':' + tsToken,
    event_type: 'task_outcome',
    outcome: outcome,
    payload: {
      host: 'opencode',
      project: turn.project,
      sessionId: turn.sessionId,
      turnId: turn.id,
      title: turn.title,
      agent: turn.agent,
      toolCalls: turn.toolCount,
      errors: turn.errors.length,
      summary: summary.slice(0, 300),
      source: 'opencode-observer',
    },
    agent: 'opencode',
    host: 'opencode',
    project: turn.project,
  })

  if (outcome === 'success' && summary.length >= 10) {
    sinks.memory({
      kind: 'note',
      content: '[opencode] 任务完成: ' + summary.slice(0, 160),
      tags: ['task-outcome', 'opencode', turn.project],
      project: turn.project,
      source: 'opencode-observer',
    })
    var ctxTime = new Date(Number(turn.ts) || Date.now()).toLocaleString('zh-CN', { hour12: false })
    updateProjectContext(state, turn.cwd, ctxTime + ' | ' + outcome + ' | ' + summary.slice(0, 80))
  }

  for (const err of turn.errors) {
    sinks.trace({
      trace_id: 'opencode:' + (turn.sessionId || 'unknown') + ':' + turnToken + ':' + String(err.tool || 'err').slice(0, 12),
      event_type: 'error',
      outcome: 'error',
      payload: {
        host: 'opencode',
        project: turn.project,
        sessionId: turn.sessionId,
        turnId: turn.id,
        tool: err.tool,
        status: err.status,
      },
      agent: 'opencode',
      host: 'opencode',
      project: turn.project,
    })
  }
  return true
}

function runOpencodeCycle(home, state, sinks, opts) {
  const out = { files: 0, lines: 0, outcomes: 0 }
  const db = opencodeDbPath()
  if (!fs.existsSync(db)) return out
  let st
  try {
    st = fs.statSync(db)
  } catch (_) {
    return out
  }
  out.files = 1
  const maxAgeMs = (opts && opts.maxAgeMs) || 24 * 60 * 60 * 1000

  // First run: seed the rowid cursor to the first part written within the
  // backfill window so ancient history never floods MIO_HOME.
  if (!state.ocSeeded) {
    const ts = Date.now() - maxAgeMs
    const first = runOpencodeQuery('SELECT rowid FROM part WHERE time_created >= ' + ts + ' ORDER BY rowid LIMIT 1')
    let rid = 0
    if (Array.isArray(first) && first.length > 0) {
      rid = Number(first[0].rowid) || 0
    } else {
      const maxRow = runOpencodeQuery('SELECT COALESCE(MAX(rowid), 0) AS rid FROM part')
      if (Array.isArray(maxRow) && maxRow.length > 0) rid = Number(maxRow[0].rid) || 0
    }
    state.ocLastRowid = rid
    state.ocSeeded = true
    state.ocDbMtime = st.mtimeMs
    state.ocPending = true
    return out
  }

  const changed = state.ocDbMtime === null || state.ocDbMtime !== st.mtimeMs
  if (!changed && !state.ocPending) return out

  const limit = 1500
  const sql =
    'SELECT p.rowid AS rid, p.session_id AS sid, p.message_id AS mid, p.time_created AS t, ' +
    'p.data AS pd, m.data AS md, s.directory AS sdir, s.title AS stitle, s.agent AS sagent ' +
    'FROM part p JOIN message m ON m.id = p.message_id JOIN session s ON s.id = p.session_id ' +
    'WHERE p.rowid > ' + state.ocLastRowid + OPENCODE_PART_FILTER +
    ' ORDER BY p.rowid LIMIT ' + limit
  const rows = runOpencodeQuery(sql)
  if (!Array.isArray(rows)) return out
  state.ocDbMtime = st.mtimeMs
  if (rows.length === 0) {
    state.ocPending = false
    return out
  }

  let lastRid = state.ocLastRowid
  for (const row of rows) {
    const rid = Number(row.rid)
    if (rid > lastRid) lastRid = rid
    out.lines += 1
    const sid = row.sid
    let turn = state.ocTurns[sid]
    if (!turn) {
      turn = createOpencodeTurn({ sessionId: sid, directory: row.sdir, title: row.stitle, agent: row.sagent })
      state.ocTurns[sid] = turn
    }
    const result = feedOpencodePart(turn, row)
    if (result.finalized) {
      if (emitOpencodeOutcome(result.finalized, sinks, state)) out.outcomes += 1
    }
    state.ocTurns[sid] = result.next
  }
  state.ocLastRowid = lastRid
  state.ocPending = rows.length >= limit

  // Caught up: any turn holding a terminal finish is complete.
  if (!state.ocPending) {
    for (const sid of Object.keys(state.ocTurns)) {
      const turn = state.ocTurns[sid]
      if (turn && turn.id && turn.pendingTerminal && !turn.done) {
        const finalized = finalizeOpencodeTurn(turn, opencodeOutcomeFor(turn.pendingTerminal))
        if (finalized && emitOpencodeOutcome(finalized, sinks, state)) out.outcomes += 1
        state.ocTurns[sid] = createOpencodeTurn({ sessionId: sid, directory: turn.cwd, title: turn.title, agent: turn.agent })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Hermes session observation (passive, via its own SQLite state.db)
// ---------------------------------------------------------------------------

// Hermes (Nous Research hermes-agent) keeps every conversation in
// <LocalAppData>/hermes/state.db. Unlike OpenCode the file is not exclusively
// locked, and `messages.id` is a monotonic AUTOINCREMENT cursor, so we can tail
// it read-only with node:sqlite (Node 22+). Each message is one row carrying
// role / content / finish_reason, so a user row opens a turn and an assistant
// row with a terminal finish_reason closes it immediately. Hermes already has
// native memory, so this observer only imports Hermes experience into the Mio
// ecosystem (traces + memory + AGENTS.md context when a git repo is present).

let _hermesSqlite = null
let _hermesSqliteTried = false

function hermesSqliteModule() {
  if (_hermesSqliteTried) return _hermesSqlite
  _hermesSqliteTried = true
  try {
    _hermesSqlite = require('node:sqlite')
  } catch (_) {
    _hermesSqlite = null
  }
  return _hermesSqlite
}

function hermesDbPath() {
  return (
    process.env.HERMES_DATA_DIR ||
    path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'state.db')
  )
}

function hermesProjectName(meta) {
  if (meta.git) return path.basename(meta.git)
  if (meta.cwd && meta.cwd !== os.homedir()) return path.basename(meta.cwd)
  return 'hermes'
}

function createHermesTurn(meta) {
  meta = meta || {}
  return {
    id: null,
    ts: null,
    sessionId: meta.sessionId || null,
    cwd: meta.git || null,
    project: hermesProjectName({ git: meta.git, cwd: meta.projectHint }),
    title: meta.title || null,
    agent: meta.agent || null,
    lastText: null,
    toolCount: 0,
    lastMid: null,
  }
}

function hermesOutcomeFor(finish) {
  if (finish === 'error' || finish === 'failure') return 'failure'
  if (finish === 'cancel' || finish === 'aborted' || finish === 'interrupted') return 'aborted'
  return 'success'
}

function finalizeHermesTurn(turn, outcome) {
  if (!turn.id) return null
  const finalized = {
    id: turn.id,
    ts: turn.ts,
    sessionId: turn.sessionId,
    cwd: turn.cwd,
    project: turn.project,
    agent: turn.agent,
    title: turn.title,
    lastText: turn.lastText,
    toolCount: turn.toolCount,
    errors: [],
    outcome: outcome,
  }
  return finalized
}

function feedHermesRow(turn, row) {
  const meta = { sessionId: row.sid, title: row.stitle, git: row.sgit, agent: row.ssource, projectHint: row.scwd }

  if (row.role === 'user') {
    let finalized = null
    if (turn.id) finalized = finalizeHermesTurn(turn, 'aborted')
    const next = createHermesTurn(meta)
    next.id = Number(row.id)
    next.ts = Math.floor(Number(row.t) * 1000) || Date.now()
    next.lastMid = Number(row.id)
    return { finalized, next }
  }

  if (row.role === 'assistant') {
    if (!turn.id) return { next: turn }
    if (typeof row.content === 'string' && row.content.trim()) {
      turn.lastText = row.content
    }
    if (row.tool_calls) {
      try {
        const calls = JSON.parse(row.tool_calls)
        if (Array.isArray(calls)) turn.toolCount += calls.length
      } catch (_) {}
    }
    if (row.finish_reason && row.finish_reason !== 'tool_calls') {
      const finalized = finalizeHermesTurn(turn, hermesOutcomeFor(row.finish_reason))
      return { finalized, next: createHermesTurn(meta) }
    }
    turn.lastMid = Number(row.id)
    return { next: turn }
  }

  return { next: turn }
}

function emitHermesOutcome(turn, sinks, state) {
  if (!turn.id) return false
  const summary = cleanText(turn.lastText)
  if (!summary) return false
  const outcome = turn.outcome
  const tsToken = turn.ts ? Math.floor(turn.ts / 1000) : Math.floor(Date.now() / 1000)

  sinks.trace({
    trace_id: 'hermes:' + (turn.sessionId || 'unknown') + ':' + String(turn.id) + ':' + tsToken,
    event_type: 'task_outcome',
    outcome: outcome,
    payload: {
      host: 'hermes',
      project: turn.project,
      sessionId: turn.sessionId,
      turnId: turn.id,
      title: turn.title,
      agent: turn.agent,
      toolCalls: turn.toolCount,
      errors: 0,
      summary: summary.slice(0, 300),
      source: 'hermes-observer',
    },
    agent: 'hermes',
    host: 'hermes',
    project: turn.project,
  })

  if (outcome === 'success' && summary.length >= 10) {
    sinks.memory({
      kind: 'note',
      content: '[hermes] 任务完成: ' + summary.slice(0, 160),
      tags: ['task-outcome', 'hermes', turn.project],
      project: turn.project,
      source: 'hermes-observer',
    })
    // Hermes reads AGENTS.md Context Files; write back only into a real repo
    // workspace so we never pollute the user's home directory.
    if (turn.cwd) {
      var ctxTime = new Date(Number(turn.ts) || Date.now()).toLocaleString('zh-CN', { hour12: false })
      updateProjectContext(state, turn.cwd, ctxTime + ' | ' + outcome + ' | ' + summary.slice(0, 80))
    }
  }
  return true
}

function runHermesCycle(home, state, sinks, opts) {
  const out = { files: 0, lines: 0, outcomes: 0 }
  const dbPath = hermesDbPath()
  if (!fs.existsSync(dbPath)) return out
  const sqlite = hermesSqliteModule()
  if (!sqlite) return out
  let db
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  } catch (_) {
    return out
  }
  out.files = 1
  const maxAgeMs = (opts && opts.maxAgeMs) || 24 * 60 * 60 * 1000
  try {
    if (!state.hmSeeded) {
      const cutoff = (Date.now() - maxAgeMs) / 1000
      const first = db.prepare('SELECT id FROM messages WHERE active = 1 AND timestamp >= ? ORDER BY id LIMIT 1').get(cutoff)
      if (first) {
        state.hmLastMsgId = first.id
      } else {
        const maxRow = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').get()
        state.hmLastMsgId = maxRow.id
      }
      state.hmSeeded = true
    }

    const limit = 2000
    const stmt = db.prepare(
      'SELECT m.id AS id, m.session_id AS sid, m.role AS role, m.content AS content, ' +
      'm.tool_name AS tool_name, m.tool_calls AS tool_calls, m.timestamp AS t, m.finish_reason AS finish_reason, ' +
      's.title AS stitle, s.cwd AS scwd, s.git_repo_root AS sgit, s.source AS ssource ' +
      'FROM messages m LEFT JOIN sessions s ON s.id = m.session_id ' +
      'WHERE m.id > ? AND m.active = 1 ORDER BY m.id LIMIT ' + limit
    )
    const rows = stmt.all(state.hmLastMsgId)
    if (rows.length === 0) return out

    let lastId = state.hmLastMsgId
    for (const row of rows) {
      const rid = Number(row.id)
      if (rid > lastId) lastId = rid
      out.lines += 1
      const sid = row.sid
      let turn = state.hmTurns[sid]
      if (!turn) {
        turn = createHermesTurn({ sessionId: sid, title: row.stitle, git: row.sgit, agent: row.ssource, projectHint: row.scwd })
        state.hmTurns[sid] = turn
      }
      const result = feedHermesRow(turn, row)
      if (result.finalized) {
        if (emitHermesOutcome(result.finalized, sinks, state)) out.outcomes += 1
      }
      state.hmTurns[sid] = result.next
    }
    state.hmLastMsgId = lastId
  } finally {
    db.close()
  }
  return out
}


// ---------------------------------------------------------------------------
// Claude Code session observation (passive, transcript JSONL tailing)
// ---------------------------------------------------------------------------

// Claude Code writes append-only JSONL transcripts under
// <configDir>/projects/<munged-cwd>/<sessionId>.jsonl. Each line carries
// {type, message:{role, content}, cwd, sessionId, timestamp, uuid, ...}.
// Assistant content items are text/thinking/tool_use; tool results come back
// as user lines whose content array holds tool_result items with is_error.
// A user prompt line (string content or a text item) closes the previous
// turn; sidechain lines (subagent transcripts) are skipped as noise.

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

function claudeProjectsDir() {
  return path.join(claudeConfigDir(), 'projects')
}

function listClaudeTranscripts() {
  const root = claudeProjectsDir()
  const out = []
  if (!fs.existsSync(root)) return out
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(root)
  return out
}

function createClaudeTurn(meta) {
  meta = meta || {}
  return {
    id: null,
    ts: null,
    sessionId: meta.sessionId || null,
    cwd: meta.cwd || null,
    project: meta.cwd ? path.basename(meta.cwd) : 'unknown',
    lastText: null,
    toolCount: 0,
    errors: [],
    apiError: false,
  }
}

function claudeContentItems(obj) {
  const content = obj && obj.message && obj.message.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter(Boolean) : []
}

function finishClaudeTurn(turn, outcome) {
  return {
    id: turn.id,
    ts: turn.ts,
    sessionId: turn.sessionId,
    cwd: turn.cwd,
    project: turn.project,
    lastText: turn.lastText,
    toolCount: turn.toolCount,
    errors: turn.errors.slice(),
    apiError: turn.apiError,
    outcome: outcome,
  }
}

function feedClaudeLine(turn, obj) {
  if (!obj || typeof obj !== 'object') return { next: turn }
  // Subagent (sidechain) transcripts duplicate main-thread work; skip them.
  if (obj.isSidechain === true) return { next: turn }
  if (obj.sessionId) turn.sessionId = obj.sessionId
  if (obj.cwd) {
    turn.cwd = obj.cwd
    turn.project = path.basename(obj.cwd)
  }

  if (obj.type === 'user') {
    const items = claudeContentItems(obj)
    let hasToolError = false
    for (const item of items) {
      if (item.type === 'tool_result' && item.is_error) {
        turn.errors.push({ toolUseId: item.tool_use_id || 'unknown' })
        hasToolError = true
      }
    }
    if (turn.errors.length > 20) turn.errors.splice(0, turn.errors.length - 20)

    // tool_result-only user lines continue the current turn; a string content
    // or text item means a fresh prompt, which closes the previous turn.
    const isPrompt =
      typeof (obj.message && obj.message.content) === 'string' ||
      items.some((item) => item.type === 'text')
    if (isPrompt) {
      let finalized = null
      if (turn.id) {
        finalized = finishClaudeTurn(turn, turn.apiError ? 'failure' : turn.lastText ? 'success' : 'aborted')
      }
      const next = createClaudeTurn({ sessionId: turn.sessionId, cwd: turn.cwd })
      next.id = obj.uuid || null
      next.ts = obj.timestamp ? Date.parse(obj.timestamp) || Date.now() : Date.now()
      return { finalized, next }
    }
    return { next: turn }
  }

  if (obj.type === 'assistant') {
    for (const item of claudeContentItems(obj)) {
      if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        turn.lastText = item.text
      } else if (item.type === 'tool_use') {
        turn.toolCount += 1
      }
    }
    if (obj.isApiErrorMessage === true || obj.error) turn.apiError = true
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN
    if (Number.isFinite(ts)) turn.ts = ts
    return { next: turn }
  }

  return { next: turn }
}

function emitClaudeOutcome(turn, sinks, state) {
  if (!turn.id) return false
  const summary = cleanText(turn.lastText)
  if (!summary && !turn.apiError) return false
  const outcome = turn.apiError && turn.outcome !== 'failure' ? 'failure' : turn.outcome
  const turnToken = String(turn.id).slice(0, 8)
  const tsToken = turn.ts ? Math.floor(turn.ts / 1000) : Math.floor(Date.now() / 1000)

  sinks.trace({
    trace_id: 'claude:' + (turn.sessionId || 'unknown') + ':' + turnToken + ':' + tsToken,
    event_type: 'task_outcome',
    outcome: outcome,
    payload: {
      host: 'claude-code',
      project: turn.project,
      sessionId: turn.sessionId,
      turnId: turn.id,
      toolCalls: turn.toolCount,
      errors: turn.errors.length,
      summary: summary.slice(0, 300),
      source: 'claude-observer',
    },
    agent: 'claude-code',
    host: 'claude-code',
    project: turn.project,
  })

  if (outcome === 'success' && summary.length >= 10) {
    sinks.memory({
      kind: 'note',
      content: '[claude-code] 任务完成: ' + summary.slice(0, 160),
      tags: ['task-outcome', 'claude-code', turn.project],
      project: turn.project,
      source: 'claude-observer',
    })
    // Claude Code auto-loads <workspace>/CLAUDE.md, so write the context
    // block there instead of AGENTS.md.
    if (turn.cwd) {
      var ctxTime = new Date(Number(turn.ts) || Date.now()).toLocaleString('zh-CN', { hour12: false })
      updateProjectContext(state, turn.cwd, ctxTime + ' | ' + outcome + ' | ' + summary.slice(0, 80), 'CLAUDE.md')
    }
  }

  for (const err of turn.errors) {
    sinks.trace({
      trace_id: 'claude:' + (turn.sessionId || 'unknown') + ':' + turnToken + ':' + String(err.toolUseId || 'err').slice(0, 12),
      event_type: 'error',
      outcome: 'error',
      payload: {
        host: 'claude-code',
        project: turn.project,
        sessionId: turn.sessionId,
        turnId: turn.id,
        toolUseId: err.toolUseId,
      },
      agent: 'claude-code',
      host: 'claude-code',
      project: turn.project,
    })
  }
  return true
}

function runClaudeCycle(home, state, sinks, opts) {
  const out = { files: 0, lines: 0, outcomes: 0 }
  const files = listClaudeTranscripts()
  const now = Date.now()
  const maxAgeMs = (opts && opts.maxAgeMs) || 24 * 60 * 60 * 1000

  for (const file of files) {
    out.files += 1
    let st
    try {
      st = fs.statSync(file)
    } catch (_) {
      continue
    }
    const info = state.clFiles[file] || { size: 0 }
    if (!state.clFiles[file] && now - st.mtimeMs > maxAgeMs) continue
    const size = st.size
    if (size < info.size) {
      info.size = 0
      state.clBuffers[file] = ''
    }

    let turn = state.clTurns[file] || createClaudeTurn()

    if (size > info.size) {
      let chunk = ''
      try {
        const fd = fs.openSync(file, 'r')
        const buf = Buffer.alloc(size - info.size)
        fs.readSync(fd, buf, 0, buf.length, info.size)
        fs.closeSync(fd)
        chunk = buf.toString('utf8')
      } catch (_) {
        continue
      }
      const pending = (state.clBuffers[file] || '') + chunk
      const lines = pending.split(/\r?\n/)
      state.clBuffers[file] = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        out.lines += 1
        let obj
        try {
          obj = JSON.parse(line)
        } catch (_) {
          continue
        }
        const result = feedClaudeLine(turn, obj)
        turn = result.next
        if (result.finalized) {
          if (emitClaudeOutcome(result.finalized, sinks, state)) out.outcomes += 1
        }
      }
      state.clFiles[file] = { size: size, mtimeMs: st.mtimeMs }
    }

    // Idle finalize: the session has answered but no new prompt arrived yet.
    if (turn.id && turn.lastText && now - st.mtimeMs > IDLE_MS) {
      if (emitClaudeOutcome(finishClaudeTurn(turn, turn.apiError ? 'failure' : 'success'), sinks, state)) {
        out.outcomes += 1
      }
      state.clTurns[file] = null
    } else if (turn.id) {
      state.clTurns[file] = turn
    } else {
      state.clTurns[file] = null
    }
  }

  return out
}


// ---------------------------------------------------------------------------
// cycle
// ---------------------------------------------------------------------------

function runCycle(home, state, sinks, opts) {
  const out = { files: 0, lines: 0, outcomes: 0 }
  fs.mkdirSync(home, { recursive: true })
  const files = listTranscripts()
  const now = Date.now()
  const maxAgeMs = (opts && opts.maxAgeMs) || 24 * 60 * 60 * 1000

  for (const file of files) {
    out.files += 1
    let st
    try {
      st = fs.statSync(file)
    } catch (_) {
      continue
    }
    const info = state.files[file] || { size: 0 }
    // Do not flood MIO_HOME with ancient history: only backfill files that are
    // already tracked or that changed within the max age window.
    if (!state.files[file] && now - st.mtimeMs > maxAgeMs) continue
    const size = st.size
    if (size < info.size) {
      // rotated/truncated -> restart from the beginning
      info.size = 0
      state.buffers[file] = ''
    }

    const meta = fileMeta(file)
    let turn = state.openTurns[file] || createTurn(meta)
    turn.project = meta.project
    turn.sessionId = meta.sessionId

    if (size > info.size) {
      let chunk = ''
      try {
        const fd = fs.openSync(file, 'r')
        const buf = Buffer.alloc(size - info.size)
        fs.readSync(fd, buf, 0, buf.length, info.size)
        fs.closeSync(fd)
        chunk = buf.toString('utf8')
      } catch (_) {
        continue
      }
      const pending = (state.buffers[file] || '') + chunk
      const lines = pending.split(/\r?\n/)
      state.buffers[file] = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        out.lines += 1
        let obj
        try {
          obj = JSON.parse(line)
        } catch (_) {
          continue
        }
        const result = feedWorkbuddyLine(turn, obj)
        if (result.finalized) {
          if (emitWorkbuddyOutcome(result.finalized, sinks, state)) out.outcomes += 1
        }
        turn = result.next
      }
      state.files[file] = { size: size, mtimeMs: st.mtimeMs }
    }

    if (turn.lastAssistant && now - st.mtimeMs > IDLE_MS) {
      if (emitWorkbuddyOutcome(turn, sinks, state)) out.outcomes += 1
      state.openTurns[file] = null
    } else if (turn.id) {
      state.openTurns[file] = turn
    } else {
      state.openTurns[file] = null
    }
  }

  const codexRes = runCodexCycle(home, state, sinks, opts)
  out.files += codexRes.files
  out.lines += codexRes.lines
  out.outcomes += codexRes.outcomes

  const ocRes = runOpencodeCycle(home, state, sinks, opts)
  out.files += ocRes.files
  out.lines += ocRes.lines
  out.outcomes += ocRes.outcomes

  const hmRes = runHermesCycle(home, state, sinks, opts)
  out.files += hmRes.files
  out.lines += hmRes.lines
  out.outcomes += hmRes.outcomes

  const clRes = runClaudeCycle(home, state, sinks, opts)
  out.files += clRes.files
  out.lines += clRes.lines
  out.outcomes += clRes.outcomes

  saveState(home, state)
  return out
}

function startForeground(home) {
  const state = loadState(home)
  const sinks = createSinks(home)
  log(home, 'observe started (home=' + home + ', interval=' + INTERVAL_MS + 'ms)')
  const tick = () => {
    try {
      const res = runCycle(home, state, sinks)
      if (res.lines > 0) {
        log(home, 'cycle: files=' + res.files + ' lines=' + res.lines + ' outcomes=' + res.outcomes)
      }
    } catch (err) {
      log(home, 'cycle error: ' + (err && err.stack ? err.stack : String(err)))
    }
  }
  tick()
  setInterval(tick, INTERVAL_MS)
}

// ---------------------------------------------------------------------------
// background daemon control
// ---------------------------------------------------------------------------

function pidFile(home) {
  return path.join(home, 'observe.pid')
}

function readPid(home) {
  try {
    const pid = Number(fs.readFileSync(pidFile(home), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch (_) {
    return null
  }
}

function isRunning(home) {
  const pid = readPid(home)
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (_) {
    return false
  }
}

function startBackground(home) {
  if (isRunning(home)) {
    return { running: true, started: false, pid: readPid(home) }
  }
  const script = path.join(__dirname, '..', 'bin', 'mio.js')
  const child = spawn(process.execPath, [script, 'observe'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: home,
  })
  child.unref()
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(pidFile(home), String(child.pid), 'utf8')
  return { running: true, started: true, pid: child.pid }
}

function stopBackground(home) {
  const pid = readPid(home)
  if (pid) {
    try {
      process.kill(pid)
    } catch (_) {}
    try {
      fs.unlinkSync(pidFile(home))
    } catch (_) {}
  }
  return { running: false, stopped: Boolean(pid), pid: pid || null }
}

module.exports = {
  INTERVAL_MS,
  homeDir,
  workbuddyConfigDir,
  loadState,
  saveState,
  updateProjectContext,
  runCycle,
  opencodeDbPath,
  runOpencodeCycle,
  runHermesCycle,
  hermesDbPath,
  claudeProjectsDir,
  runClaudeCycle,
  createClaudeTurn,
  feedClaudeLine,
  createSinks,
  startForeground,
  startBackground,
  stopBackground,
  isRunning,
  readPid,
}
