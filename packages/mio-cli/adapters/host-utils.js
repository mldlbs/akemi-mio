'use strict'

const fs = require('fs')
const { spawnSync } = require('child_process')

// Windows only: returns the earliest creation time (epoch ms) of a running
// process whose ExecutablePath contains `exePathFragment`, or null when the
// host app is not running / detection is unavailable.
function earliestRunningSince(exePathFragment) {
  if (process.platform !== 'win32') return null
  try {
    const escaped = String(exePathFragment).replace(/'/g, "''")
    const script =
      "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*" +
      escaped +
      "*' } | ForEach-Object { [long]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds }"
    // Budget is read per call (not a module constant) and overridable, so the
    // load-sensitive probe test can ask for more time without making real
    // `mio install` waits longer on a hung PowerShell.
    const probeTimeoutMs = Number(process.env.MIO_HOST_PROBE_TIMEOUT_MS) || 10000
    // stdio[0] must not be a pipe. On Windows a piped stdin makes spawnSync
    // fail with EBUSY before powershell starts: status is null and stderr is
    // empty, so this probe returned null every time and the "host is running an
    // older config" warning never fired. powershell reads no stdin here.
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: probeTimeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (res.error || res.status !== 0) return null
    const times = (res.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0)
    if (times.length === 0) return null
    return Math.min(...times)
  } catch (_) {
    return null
  }
}

// Returns a human-readable warning when the host app is currently running from
// a config that predates its process start (i.e. a restart is required to load
// the updated Mio MCP config). Returns null when no restart is needed.
function restartWarning({ hostLabel, exeName, exePathFragment, configPath }) {
  const since = earliestRunningSince(exePathFragment)
  if (since === null) return null
  let mtime = null
  try {
    mtime = fs.statSync(configPath).mtimeMs
  } catch (_) {
    return null
  }
  if (!(mtime > since)) return null
  const started = new Date(since).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  return (
    hostLabel +
    ' is running with an older Mio config (app started ' +
    started +
    ', config updated after). Fully quit ' +
    hostLabel +
    ' (end all ' +
    exeName +
    ' processes) and relaunch to load the updated Mio MCP config.'
  )
}

// Detects whether the host application itself is installed on this machine.
// NOTE: this is deliberately NOT the same question as `isInstalled()` — presence
// means "the user runs this app", installed means "Mio's MCP block is already in
// its config". `mio install --auto` only wires hosts that are present, so a
// machine with one host gets one wiring, not five failed writes.
//
// Detection is file-existence based only (never a network call, never a process
// scan), so it stays cheap and side-effect free. Any unreadable candidate is
// skipped rather than throwing: a config under a locked-down profile simply
// reads as "not present".
function hostPresent({ configPath, extraPaths = [] } = {}) {
  const candidates = [configPath, ...extraPaths].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return true
    } catch (_) {
      // ignore and try the next candidate
    }
  }
  return false
}

module.exports = { earliestRunningSince, restartWarning, hostPresent }