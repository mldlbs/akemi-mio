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
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
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

module.exports = { earliestRunningSince, restartWarning }