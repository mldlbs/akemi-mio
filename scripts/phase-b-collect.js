const WebSocket = require('ws')
const WS_URL = 'ws://localhost:9222/devtools/page/8FEC26C246FDC3BA634683BC20A0AF39'
const ws = new WebSocket(WS_URL)
let mid = 0, done = 0

function send(expr) { ws.send(JSON.stringify({id:++mid, method:'Runtime.evaluate', params:{expression:expr, awaitPromise:true, timeout:120000}})) }

const TASKS = [
  // file.management tasks
  ['帮我读一下 /etc/hosts 文件内容', 'file'],
  ['创建一个 test.txt 文件，写入 hello world', 'file'],
  ['把 test.txt 改成 test2.txt', 'file'],
  ['列出当前目录的文件', 'file'],
  // search.retrieval tasks
  ['搜索代码里所有的 TODO 注释', 'search'],
  ['帮我搜一下最新的 TypeScript 新闻', 'search'],
  ['搜索 src/ 下所有 .ts 文件', 'search'],
  // system.execution tasks
  ['执行 pwd 命令', 'system'],
  ['运行 ls -la', 'system'],
  ['帮我执行一下 echo hello', 'system'],
  // existing capability tasks
  ['帮我打开 baidu.com 首页', 'browser'],
  ['写一首关于秋天的短诗', 'content'],
]

ws.on('open', () => {
  console.log('=== M5.4 Observation ===')
  for (let i = 0; i < TASKS.length; i++) {
    setTimeout(() => {
      const [text, category] = TASKS[i]
      const id = 'm54_' + i
      const e = JSON.stringify(text)
      send('window.electronAPI.chat(' + e + ',' + JSON.stringify(id) + ',undefined,true).then(r=>r.reply||r.error||JSON.stringify(r)).catch(e=>"ERR:"+e.message)')
      console.log('[' + (i+1) + '/' + TASKS.length + '][' + category + ']', text.substring(0, 40))
    }, 8000 + i * 25000)
  }
})

ws.on('message', data => {
  try {
    const r = JSON.parse(data.toString())
    if (r.id && r.result && r.result.result && r.result.result.value) {
      const v = String(r.result.result.value)
      if (v.length > 5 && v !== 'undefined' && !v.startsWith('{"reply')) done++
    }
  } catch(e) {}
})

ws.on('error', e => console.error('WS:', e.message))
setTimeout(() => { console.log('=== done ==='); process.exit(0) }, TASKS.length * 25000 + 15000)
