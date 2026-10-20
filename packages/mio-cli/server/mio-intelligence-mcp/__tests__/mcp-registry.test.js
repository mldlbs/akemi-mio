'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { test } = require('node:test')

const { createMcpRegistryManifest, writeMcpRegistryManifest, ADR017_CAPABILITIES } =
  require('../../mcp-registry.js')

const NODE = '/usr/bin/node'
const SERVER = '/opt/mio/server/index.js'

test('createMcpRegistryManifest builds a single stdio server entry', () => {
  const manifest = createMcpRegistryManifest({ node: NODE, serverScript: SERVER, dataDir: '/tmp/mio' })
  assert.strictEqual(manifest.version, 1)
  assert.strictEqual(manifest.servers.length, 1)
  const srv = manifest.servers[0]
  assert.strictEqual(srv.id, 'mio-control-plane')
  assert.strictEqual(srv.transport, 'stdio')
  assert.strictEqual(srv.command, NODE)
  assert.deepStrictEqual(srv.args, [SERVER])
  assert.strictEqual(srv.env.MIO_DATA_DIR, '/tmp/mio')
  assert.strictEqual(srv.toolDiscovery, 'runtime')
  assert.deepStrictEqual(srv.capabilities, ADR017_CAPABILITIES)
  assert.strictEqual(ADR017_CAPABILITIES.length, 6)
})

test('createMcpRegistryManifest embeds project hint when given', () => {
  const manifest = createMcpRegistryManifest({ node: NODE, serverScript: SERVER, dataDir: '/tmp/mio', project: 'acme' })
  assert.strictEqual(manifest.servers[0].env.MIO_PROJECT_HINT, 'acme')
})

test('createMcpRegistryManifest throws without required fields', () => {
  assert.throws(() => createMcpRegistryManifest({ serverScript: SERVER, dataDir: '/tmp' }), /node/)
  assert.throws(() => createMcpRegistryManifest({ node: NODE, dataDir: '/tmp' }), /serverScript/)
  assert.throws(() => createMcpRegistryManifest({ node: NODE, serverScript: SERVER }), /dataDir/)
})

test('writeMcpRegistryManifest writes parseable JSON to dataDir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-registry-'))
  try {
    const outPath = writeMcpRegistryManifest({ node: NODE, serverScript: SERVER, dataDir: dir, fsModule: fs, pathModule: path })
    assert.strictEqual(outPath, path.join(dir, 'mcp-registry.json'))
    const onDisk = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    assert.strictEqual(onDisk.servers[0].command, NODE)
    assert.deepStrictEqual(onDisk.servers[0].args, [SERVER])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
