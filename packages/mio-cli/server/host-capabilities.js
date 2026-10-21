'use strict'

// Same resolution the CLI uses: template if one exists, hand-written module
// otherwise. Keeping this in step with bin/mio.js matters -- otherwise
// `mio host capabilities` would describe a different adapter than the one
// `mio install` actually drives.
const { loadAdapter } = require('../adapters/loader.js')
const adapters = {
  codex: loadAdapter('codex'),
  opencode: loadAdapter('opencode'),
  workbuddy: loadAdapter('workbuddy'),
  hermes: loadAdapter('hermes'),
  claude: loadAdapter('claude'),
}

const HOST_CAPABILITIES = [
  {
    name: 'codex',
    capabilities: ['mcp-tools', 'memory', 'observer-ingest', 'policy-check', 'experience-reuse', 'runtime-status'],
  },
  {
    name: 'opencode',
    capabilities: ['mcp-tools', 'memory', 'observer-ingest', 'policy-check', 'experience-reuse', 'runtime-status'],
  },
  {
    name: 'workbuddy',
    capabilities: [
      'mcp-tools',
      'memory',
      'observer-ingest',
      'observer-transcript',
      'policy-check',
      'experience-reuse',
      'runtime-status',
      // WorkBuddy implements the Claude Code hook contract, so retrieval and
      // capture can run without the model choosing to call a tool.
      'hooks',
    ],
  },
  {
    name: 'hermes',
    capabilities: ['mcp-tools', 'memory', 'observer-ingest', 'observer-transcript', 'policy-check', 'experience-reuse', 'runtime-status'],
  },
  {
    name: 'claude',
    capabilities: ['mcp-tools', 'memory', 'observer-ingest', 'observer-transcript', 'policy-check', 'experience-reuse', 'runtime-status'],
  },
]

function safeInstalled(adapter) {
  try {
    return Boolean(adapter && typeof adapter.isInstalled === 'function' && adapter.isInstalled())
  } catch (_) {
    return false
  }
}

function listHostCapabilities(adapterOverrides = adapters) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    hosts: HOST_CAPABILITIES.map((host) => ({
      name: host.name,
      installed: safeInstalled(adapterOverrides[host.name]),
      capabilities: host.capabilities,
      mutationMode: 'host-capability',
    })),
  }
}

module.exports = { HOST_CAPABILITIES, listHostCapabilities }
