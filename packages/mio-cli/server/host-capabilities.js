'use strict'

const adapters = {
  codex: require('../adapters/codex.js'),
  opencode: require('../adapters/opencode.js'),
  workbuddy: require('../adapters/workbuddy.js'),
  hermes: require('../adapters/hermes.js'),
  claude: require('../adapters/claude-code.js'),
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
    capabilities: ['mcp-tools', 'memory', 'observer-ingest', 'observer-transcript', 'policy-check', 'experience-reuse', 'runtime-status'],
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
