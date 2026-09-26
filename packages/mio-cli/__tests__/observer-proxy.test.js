'use strict'

// D7: collectors talked to a bare fetch(), which -- unlike the browser the
// user just used successfully -- reads no proxy at all. With Windows' system
// proxy on (HKCU Internet Settings, ProxyEnable=1) and no direct route, every
// external source timed out while the same URL opened fine elsewhere.
//
// httpFetch() is the new seam: no proxy resolved -> plain global fetch (the
// old path, byte for byte), a proxy resolved -> undici + ProxyAgent, and a
// dead proxy -> fall back to direct instead of breaking a route that worked.
// The proxy here is a real local server, so "it went through the proxy" is
// observed, not asserted by a mock.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')

const DIST = path.resolve(__dirname, '..', '..', 'observer', 'dist', 'http.js')

function loadHttp() {
  if (!fs.existsSync(DIST)) {
    assert.fail(`missing ${DIST} -- build it first: npx tsc -p packages/observer/tsconfig.json`)
  }
  delete require.cache[require.resolve(DIST)]
  return require(DIST)
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('D7 resolveProxyUrl: env proxy is normalized, scheme-aware, bypassable', () => {
  const { resolveProxyUrl, normalizeProxy, isBypassed } = loadHttp()
  const none = { env: {}, readSystemProxy: () => null }

  assert.equal(resolveProxyUrl('http://example.com', none), null, 'no env and no system proxy -> direct')

  assert.equal(
    resolveProxyUrl('http://example.com', { env: { HTTP_PROXY: '127.0.0.1:7890' }, readSystemProxy: () => null }),
    'http://127.0.0.1:7890',
    'scheme-less env value gets http:// and stays a host:port',
  )
  assert.equal(
    resolveProxyUrl('https://example.com', { env: { http_proxy: '127.0.0.1:7890' }, readSystemProxy: () => null }),
    null,
    'HTTP_PROXY must not be reused for https targets',
  )
  assert.equal(
    resolveProxyUrl('https://example.com', { env: { HTTPS_PROXY: 'http://p:3128' }, readSystemProxy: () => null }),
    'http://p:3128',
    'HTTPS_PROXY carries https targets',
  )
  assert.equal(
    resolveProxyUrl('http://example.com', { env: { ALL_PROXY: 'http://all:1080' }, readSystemProxy: () => null }),
    'http://all:1080',
    'ALL_PROXY covers any scheme',
  )
  assert.equal(normalizeProxy('http://user:pass@h:8080/some/path'), 'http://user:pass@h:8080')
  assert.equal(normalizeProxy('socks5://h:1080'), null, 'only http/https proxies are supported')

  const bypassed = { env: { HTTP_PROXY: 'http://p:3128' }, readSystemProxy: () => null }
  assert.equal(resolveProxyUrl('http://x.com', { ...bypassed, env: { ...bypassed.env, NO_PROXY: '*' } }), null)
  assert.equal(resolveProxyUrl('http://api.x.com', { ...bypassed, env: { ...bypassed.env, NO_PROXY: 'x.com' } }), null, 'NO_PROXY matches subdomains')
  assert.equal(
    resolveProxyUrl('http://xy.com', { ...bypassed, env: { ...bypassed.env, NO_PROXY: 'x.com' } }),
    'http://p:3128',
    'NO_PROXY must not over-match a bare suffix',
  )
  assert.equal(
    resolveProxyUrl('http://127.0.0.1:9999/x', { ...bypassed, env: { ...bypassed.env, NO_PROXY: '127.*' } }),
    null,
    '127.* keeps loopback on the direct path',
  )
  assert.ok(isBypassed('foo.internal', ['<local>']) === false)
  assert.ok(isBypassed('intranet', ['<local>']), '<local> means hosts without a dot')
})

test('D7 resolveProxyUrl: Windows system proxy is read and its ProxyOverride honoured', () => {
  const { resolveProxyUrl, parseProxyServer, parseBypassList } = loadHttp()

  const single = { servers: parseProxyServer('127.0.0.1:7890'), bypass: [] }
  assert.equal(
    resolveProxyUrl('https://github.com/trending', { env: {}, readSystemProxy: () => single }),
    'http://127.0.0.1:7890',
    'ProxyServer without a protocol prefix applies to both schemes',
  )

  const perScheme = { servers: parseProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891'), bypass: [] }
  assert.equal(resolveProxyUrl('http://a.com', { env: {}, readSystemProxy: () => perScheme }), 'http://127.0.0.1:7890')
  assert.equal(resolveProxyUrl('https://a.com', { env: {}, readSystemProxy: () => perScheme }), 'http://127.0.0.1:7891')

  const socksOnly = { servers: parseProxyServer('socks=127.0.0.1:7890'), bypass: [] }
  assert.equal(resolveProxyUrl('http://a.com', { env: {}, readSystemProxy: () => socksOnly }), null, 'a socks-only system proxy is not an HTTP proxy for us')

  const proxied = { servers: parseProxyServer('127.0.0.1:7890'), bypass: parseBypassList('*.zhihu.com;127.*;<local>', /[;]/) }
  const withSystem = { env: {}, readSystemProxy: () => proxied }
  assert.equal(resolveProxyUrl('https://www.zhihu.com', withSystem), null, 'ProxyOverride *.zhihu.com bypasses the system proxy')
  assert.equal(resolveProxyUrl('https://api.zhihu.com', withSystem), null, 'ProxyOverride pattern matches subdomains')
  assert.equal(resolveProxyUrl('https://github.com/trending', withSystem), 'http://127.0.0.1:7890', 'everything else still goes to the proxy')

  assert.equal(
    resolveProxyUrl('https://a.com', { env: { HTTPS_PROXY: 'http://env:1' }, readSystemProxy: () => perScheme }),
    'http://env:1',
    'env wins over the registry',
  )
})

test('D7 httpFetch: a proxy is actually used when configured, and only then', async () => {
  const { httpFetch, closeProxyAgents } = loadHttp()

  let originHits = 0
  let proxyTunnels = 0
  const origin = http.createServer((_req, res) => {
    originHits++
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('hello-from-origin')
  })
  // undici's ProxyAgent always tunnels with CONNECT -- even for http targets --
  // so the stub is a real forward proxy: it dials the origin and pipes bytes.
  const proxy = http.createServer((req, res) => {
    res.writeHead(502)
    res.end('absolute-form requests are not expected here: ' + req.url)
  })
  proxy.on('connect', (req, socket, head) => {
    proxyTunnels++
    const [host, port] = String(req.url).split(':')
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  const originPort = await listen(origin)
  const proxyPort = await listen(proxy)
  const url = `http://127.0.0.1:${originPort}/trending`
  const stubProxy = `http://127.0.0.1:${proxyPort}`

  try {
    const viaProxy = await httpFetch(url, {}, { env: { HTTP_PROXY: stubProxy }, readSystemProxy: () => null })
    assert.equal(viaProxy.status, 200)
    assert.equal(await viaProxy.text(), 'hello-from-origin')
    assert.equal(proxyTunnels, 1, 'the request was tunneled through the proxy')
    assert.equal(originHits, 1, 'the origin was reached through that tunnel')

    const direct = await httpFetch(url, {}, { env: {}, readSystemProxy: () => null })
    assert.equal(await direct.text(), 'hello-from-origin')
    assert.equal(originHits, 2, 'with no proxy configured the origin is fetched directly')
    assert.equal(proxyTunnels, 1, 'and no extra tunnel is opened')

    const bypassed = await httpFetch(url, {}, { env: { HTTP_PROXY: stubProxy, NO_PROXY: '127.*' }, readSystemProxy: () => null })
    assert.equal(await bypassed.text(), 'hello-from-origin')
    assert.equal(originHits, 3)
    assert.equal(proxyTunnels, 1, 'NO_PROXY keeps loopback on the direct path')
  } finally {
    await closeProxyAgents()
    await close(origin)
    await close(proxy)
  }
})

test('D7 httpFetch: a dead proxy falls back to direct instead of failing the fetch', async () => {
  const { httpFetch, closeProxyAgents } = loadHttp()

  let originHits = 0
  const origin = http.createServer((_req, res) => {
    originHits++
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('still-reachable')
  })
  const originPort = await listen(origin)
  // A port nothing listens on: proxy-enabled (ProxyEnable=1) but the client is
  // closed -- the exact shape that used to break every source.
  const dead = http.createServer(() => {})
  const deadPort = await listen(dead)
  await close(dead)

  try {
    const res = await httpFetch(`http://127.0.0.1:${originPort}/x`, {}, {
      env: { HTTP_PROXY: `http://127.0.0.1:${deadPort}` },
      readSystemProxy: () => null,
    })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'still-reachable')
    assert.equal(originHits, 1, 'the direct route answered after the proxy failed')
  } finally {
    await closeProxyAgents()
    await close(origin)
  }
})

test('D7: every collector fetches through httpFetch, in both copies', () => {
  const collectors = [
    'WeiboCollector',
    'RSSCollector',
    'HackerNewsCollector',
    'DouyinCollector',
    'BilibiliCollector',
    'GitHubTrendingCollector',
  ]
  const copies = ['observer', 'intelligence-observer']
  const bareFetch = /(?<![A-Za-z0-9_.])fetch\(/

  for (const pkg of copies) {
    for (const name of collectors) {
      const file = path.resolve(__dirname, '..', '..', pkg, 'src', 'collectors', `${name}.ts`)
      const source = fs.readFileSync(file, 'utf8')
      assert.ok(source.includes("from '../http'"), `${pkg}/${name}.ts must import httpFetch`)
      assert.equal(bareFetch.test(source), false, `${pkg}/${name}.ts still calls global fetch directly`)
      assert.ok(source.includes('httpFetch('), `${pkg}/${name}.ts must call httpFetch`)
    }
  }

  const mirror = path.resolve(__dirname, '..', '..', 'intelligence-observer', 'src', 'http.ts')
  const original = path.resolve(__dirname, '..', '..', 'observer', 'src', 'http.ts')
  assert.ok(fs.existsSync(mirror), 'the app bundle keeps its own copy of http.ts')
  assert.ok(fs.existsSync(original))
  const mirrorSource = fs.readFileSync(mirror, 'utf8')
  assert.ok(mirrorSource.includes('@akemi-mio/core/logger/Logger'), 'mirror uses the app logger')
  assert.ok(
    mirrorSource.replace("import { log } from '@akemi-mio/core/logger/Logger'", "import { log } from './logger'") ===
      fs.readFileSync(original, 'utf8'),
    'http.ts must stay identical between the two copies except for the logger import',
  )
})
