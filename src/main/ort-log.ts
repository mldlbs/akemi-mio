// ONNX Runtime 优化配置
// @xenova/transformers 使用 onnxruntime-web (WASM 后端)，不是 onnxruntime-node

// 1. 日志级别: 3=ERROR, 4=FATAL
process.env.ORT_LOG_SEVERITY_LEVEL = '3'

// 2. WASM 多线程并行 — 影响 @xenova/transformers 的推理速度
const cpuCount = require('os').cpus().length
const threadCount = Math.max(2, Math.min(cpuCount - 2, 8))
process.env.OMP_NUM_THREADS = String(threadCount)

// 3. 配置 transformers.js 的 WASM 后端（在首次 pipeline() 调用前生效）
try {
  const { env } = require('@xenova/transformers')
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = threadCount
    env.backends.onnx.logLevel = 'error'
  }
} catch {}

// 4. 截获 stderr — 兜底过滤 C++ ORT 警告
const stderrWrite = process.stderr.write.bind(process.stderr) as (buffer: Buffer | string, cb?: (err?: Error) => void) => boolean
process.stderr.write = ((buffer: any, ...args: any[]) => {
  const str = buffer.toString()
  if (str.includes('[W:onnxruntime:]') || str.includes('Removing initializer')) return true
  return stderrWrite(buffer, ...args)
}) as typeof process.stderr.write

console.log(`[ORT] CPU cores=${cpuCount}, wasm_threads=${threadCount}`)
