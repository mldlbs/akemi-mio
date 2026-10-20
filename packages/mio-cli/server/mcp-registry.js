'use strict'

// MCP Registry manifest for the Mio Agent Control Plane.
//
// This is the single source of truth a host (codex/opencode/workbuddy/claude)
// reads to discover how to launch Mio's MCP server. It replaces the hand-written
// server-shape that each adapter used to inline: instead of every adapter
// repeating `{ command: node, args: [serverScript], env: { MIO_DATA_DIR } }`,
// that shape is generated here once and written to <dataDir>/mcp-registry.json.
//
// Hosts discover the concrete tool list at runtime via MCP `tools/list` over the
// stdio server, so we intentionally do NOT snapshot tool names here (they change
// often and a stale list would be worse than none).
//
// TaskHub: a6dcd804 (PR-A). Implemented without touching the concurrent
// session's in-flight index.js / mechanism-registry.js edits.

const ADR017_CAPABILITIES = [
  'identity',
  'memory',
  'observation',
  'routing',
  'policy',
  'evolution',
]

function createMcpRegistryManifest({ node, serverScript, dataDir, project } = {}) {
  if (!node) throw new Error('createMcpRegistryManifest requires node')
  if (!serverScript) throw new Error('createMcpRegistryManifest requires serverScript')
  if (!dataDir) throw new Error('createMcpRegistryManifest requires dataDir')

  const env = { MIO_DATA_DIR: dataDir }
  // An explicit project hint lets hosts scope their request, but the server is
  // project-agnostic; we keep project out of the launch shape.
  if (project) env.MIO_PROJECT_HINT = project

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    servers: [
      {
        id: 'mio-control-plane',
        name: 'Mio Agent Control Plane',
        transport: 'stdio',
        command: node,
        args: [serverScript],
        env,
        capabilities: ADR017_CAPABILITIES,
        toolDiscovery: 'runtime',
      },
    ],
  }
}

function writeMcpRegistryManifest(options = {}) {
  const fs = options.fsModule || require('fs')
  const path = options.pathModule || require('path')
  const manifest = createMcpRegistryManifest(options)
  const outPath = path.join(options.dataDir, 'mcp-registry.json')
  fs.mkdirSync(options.dataDir, { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  return outPath
}

module.exports = {
  ADR017_CAPABILITIES,
  createMcpRegistryManifest,
  writeMcpRegistryManifest,
}
