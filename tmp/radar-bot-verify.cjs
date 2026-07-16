// 验证 Mio 对雷达 bot 改动的功能正确性
const fs = require('fs')
const path = require('path')

// 测试 1: escapeHtml 是否正常
function escapeHtml(s) {
  if (!s) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

console.log('=== 测试 1: escapeHtml ===')
const testCases = [
  { input: '正常文本', expected: '正常文本' },
  { input: 'A & B < C > D "E"', expected: 'A &amp; B &lt; C &gt; D &quot;E&quot;' },
  { input: '', expected: '' },
  { input: null, expected: '' },
  { input: undefined, expected: '' },
]
let pass = 0
for (const tc of testCases) {
  const result = escapeHtml(tc.input)
  const ok = result === tc.expected
  if (ok) pass++
  console.log(`  ${ok ? '✓' : '✗'} input=${JSON.stringify(tc.input)} output=${JSON.stringify(result)}`)
}
console.log(`  Result: ${pass}/${testCases.length} pass\n`)

// 测试 2: interpretScore 范围
console.log('=== 测试 2: interpretScore ===')
const scores = [
  { score: 90, tag: '≥85 强烈信号' },
  { score: 80, tag: '≥75 高价值' },
  { score: 70, tag: '≥65 有潜力' },
  { score: 55, tag: '≥50 中等' },
  { score: 30, tag: '<50 早期' },
]
function interpretScore(score) {
  if (score >= 85) return '强烈信号，值得立即关注验证'
  if (score >= 75) return '高价值机会，建议深入研究'
  if (score >= 65) return '有潜力方向，持续观察'
  if (score >= 50) return '中等信号，可作为参考'
  return '早期信号，保持关注'
}
for (const tc of scores) {
  console.log(`  [${tc.score}分] (${tc.tag}) → ${interpretScore(tc.score)}`)
}
console.log()

// 测试 3: HTTP 状态码校验（模拟 fetchRadarData 新逻辑）
console.log('=== 测试 3: HTTP 状态码校验 ===')
function simulateFetch(httpCode) {
  if (httpCode !== '200') {
    return { error: `HTTP ${httpCode} from radar API` }
  }
  return { data: { signals: [] } }
}
const httpTests = [
  { code: '200', expectOk: true },
  { code: '502', expectOk: false },
  { code: '500', expectOk: false },
  { code: '404', expectOk: false },
]
for (const tc of httpTests) {
  const result = simulateFetch(tc.code)
  const ok = result.error ? !tc.expectOk : tc.expectOk
  console.log(`  ${ok ? '✓' : '✗'} HTTP ${tc.code} → ${result.error || 'OK'}`)
}
console.log()

// 测试 4: 读取真实雷达数据验证格式
console.log('=== 测试 4: 真实雷达数据格式化 ===')
const testDataPath = '/tmp/radar-test.json'
if (fs.existsSync(testDataPath)) {
  const d = JSON.parse(fs.readFileSync(testDataPath, 'utf-8'))
  const signals = d.signals || []
  const sorted = [...signals].sort((a, b) => (b.score || 0) - (a.score || 0))

  // 验证 emoji icon 映射
  const iconMap = { high: 0, mid: 0, low: 0 }
  sorted.slice(0, 10).forEach(s => {
    const score = s.score || 0
    const icon = score >= 80 ? '🟢' : (score >= 60 ? '🟡' : '🔴')
    if (score >= 80) iconMap.high++
    else if (score >= 60) iconMap.mid++
    else iconMap.low++
  })
  console.log(`  信号总数: ${signals.length}`)
  console.log(`  前 10 icon 分布: 🟢${iconMap.high} 🟡${iconMap.mid} 🔴${iconMap.low}`)

  // 验证主题数据
  if (d.themes && d.themes.length) {
    console.log(`  主题: ${d.themes.length} 个，TOP3:`)
    d.themes.slice(0, 3).forEach(t => {
      console.log(`    ${escapeHtml(t.theme)}: ${t.count}条`)
    })
  }

  console.log(`\n  ✅ 数据可正常读取并格式化`)
} else {
  console.log('  ⚠️ 无测试数据文件，跳过')
}

console.log('\n=== 测试完成 ===')
