#!/usr/bin/env node
'use strict'

// WorkBuddy hook entry point for Mio.
//
// WorkBuddy implements the Claude Code hook contract: the host runs a command,
// pipes a JSON payload on stdin, and reads a JSON object on stdout. Two events
// make Mio seamless -- no rule-following by the model required:
//
//   UserPromptSubmit -> run `mio recall "<prompt>"` and return the hits as
//                       hookSpecificOutput.additionalContext, so retrieval
//                       happens before the model ever sees the turn.
//   Stop / SessionEnd -> hand the transcript path from the payload to
//                       `mio observe ingest`, so capture does not depend on a
//                       background scan noticing the file.
//
// Invoked as: node workbuddy-hook.js <cliScript> <mioHome>
//
// A hook that throws or prints garbage can break the user's session, so every
// path here exits 0 and prints at most one JSON object.

const fs = require('fs')
const path = require('path')
const { spawnSync, execFileSync } = require('child_process')

const CLI = process.argv[2]
const HOME = process.argv[3] || process.env.MIO_HOME || ''

// Keep the injected block small: this is added to every turn's context, and an
// unbounded dump would crowd out the actual conversation.
const MAX_CONTEXT_CHARS = 1800
const RECALL_LIMIT = 5
// Greetings and one-word prompts never need memory; skipping them avoids
// polluting short exchanges with unrelated project history.
const MIN_PROMPT_CHARS = 6

function readPayload() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

// spawnSync on Windows fails with EBUSY whenever stdio[0] is a pipe, and the
// default stdio is three pipes. Passing 'ignore' for stdin is what makes this
// call work at all -- `status` would otherwise be null while stderr stays empty.
function runCli(args, cwd, timeout) {
  if (!CLI) return null
  const res = spawnSync(process.execPath, [CLI].concat(args), {
    cwd: cwd || undefined,
    encoding: 'utf8',
    timeout: timeout || 8000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: HOME ? Object.assign({}, process.env, { MIO_HOME: HOME }) : process.env,
  })
  if (res.error || res.status !== 0 || !res.stdout) return null
  try {
    return JSON.parse(res.stdout)
  } catch (_) {
    return null
  }
}

function oneLine(text, limit) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

// Same rule the CLI uses (`git rev-parse --git-common-dir`, basename of its
// parent), so hook recall and `mio recall` resolve the same project bucket --
// including worktrees, which must map to the main repository.
function projectNameFor(cwd) {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (commonDir) return path.basename(path.dirname(commonDir))
  } catch (_) {}
  return path.basename(cwd || process.cwd())
}

// Recall in-process. Spawning the CLI costs ~1.5s per prompt (node start plus
// the whole command surface), which would make every turn feel slower; the
// store module itself loads in ~15ms. The CLI stays as a fallback for the case
// where the package layout is unexpected.
function recallInProcess(prompt, cwd) {
  const { createMemoryStore } = require('../server/memory-store.js')
  const store = createMemoryStore({
    dataDir: HOME,
    projectName: () => projectNameFor(cwd),
    agentId: () => 'cli',
  })
  return store.queryMemory({ query: prompt, limit: RECALL_LIMIT })
}

function ingestInProcess(transcript, cwd, sessionId) {
  const observer = require('../observe/observer.js')
  return observer.ingestTranscript(HOME, transcript, {
    cwd: cwd,
    sessionId: sessionId,
    finalize: true,
  })
}

function buildContext(data, prompt) {
  const results = data && Array.isArray(data.results) ? data.results : []
  if (results.length === 0) return ''
  // The same completion can be recorded more than once (two observers, a
  // re-run, a codex + workbuddy pair), and duplicated lines waste the small
  // budget this block gets in every turn.
  const seen = new Set()
  const unique = []
  for (const record of results) {
    const content = oneLine(record.content, 240)
    if (!content || seen.has(content)) continue
    seen.add(content)
    unique.push({ record, content })
  }
  if (unique.length === 0) return ''
  const lines = unique.map(({ record, content }, index) => {
    const tags = Array.isArray(record.tags) ? record.tags.slice(0, 3).join(',') : ''
    const suffix = tags ? ` (${tags})` : ''
    return `${index + 1}. [${record.kind || 'note'}] ${content}${suffix}`
  })
  const header =
    `Mio 记忆：命中 ${data.count} 条（project=${data.project}，query="${oneLine(prompt, 60)}"）。` +
    '以下为此前记录的决策/经验，若与当前任务相关请直接沿用，不必再重复调查：'
  return (header + '\n' + lines.join('\n')).slice(0, MAX_CONTEXT_CHARS)
}

function handlePromptSubmit(payload) {
  const prompt = String(payload.prompt || payload.user_prompt || '')
  if (prompt.trim().length < MIN_PROMPT_CHARS) return null
  // Escape hatch: recall costs ~1.1s (node start + store scan) on every prompt.
  // Users who prefer zero added latency can turn it off and keep capture.
  if (process.env.MIO_HOOK_DISABLE_RECALL) return null
  let data = null
  if (!process.env.MIO_HOOK_FORCE_CLI) {
    try {
      data = recallInProcess(prompt, payload.cwd)
    } catch (_) {
      data = null
    }
  }
  if (!data) {
    data = runCli(['--json', 'recall', prompt, '--limit', String(RECALL_LIMIT)], payload.cwd, 8000)
  }
  const context = buildContext(data, prompt)
  if (!context) return null
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  }
}

function handleStop(payload) {
  const transcript = payload.transcript_path
  if (!transcript) return null
  // Subagent stops carry the parent's transcript; ingesting them would emit a
  // second outcome for a turn the main agent is still writing.
  if (payload.agent_type && payload.agent_type !== 'cli') return null

  if (!process.env.MIO_HOOK_FORCE_CLI) {
    try {
      ingestInProcess(transcript, payload.cwd, payload.session_id)
      return null
    } catch (_) {
      // Fall through to the CLI so a packaging surprise does not lose the turn.
    }
  }

  const args = ['--json', 'observe', 'ingest', '--transcript', transcript]
  if (payload.cwd) args.push('--cwd', payload.cwd)
  if (payload.session_id) args.push('--session', payload.session_id)
  // Ingest one file: fast enough to run inline, and running it inline (instead
  // of detaching) means the write survives the host tearing down the hook.
  runCli(args, payload.cwd, 15000)
  return null
}

function main() {
  if (process.env.MIO_HOOK_DISABLE) {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }))
    return
  }
  const payload = readPayload()
  const event = payload.hook_event_name
  let output = null
  if (event === 'UserPromptSubmit') {
    output = handlePromptSubmit(payload)
  } else if (event === 'Stop' || event === 'SessionEnd' || event === 'FinalStop') {
    output = handleStop(payload)
  }
  process.stdout.write(JSON.stringify(output || { continue: true, suppressOutput: true }))
}

try {
  main()
} catch (_) {
  // A failing hook must never block or fail the user's turn.
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }))
}
