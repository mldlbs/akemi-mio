process.env.ORT_LOG_SEVERITY_LEVEL = '3'
process.env.ORT_LOG_LEVEL = 'ERROR'

const originalStderrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  if (
    text.includes('onnxruntime') &&
    text.includes('CleanUnusedInitializersAndNodeArgs') &&
    text.includes('Removing initializer')
  ) {
    const callback = args.find((arg): arg is () => void => typeof arg === 'function')
    callback?.()
    return true
  }
  return originalStderrWrite(chunk as never, ...(args as never[]))
}) as typeof process.stderr.write

try {
  const ort = require('onnxruntime-node')
  if (ort.env) ort.env.logLevel = 'error'
} catch {}
