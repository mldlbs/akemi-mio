process.env.ORT_LOG_SEVERITY_LEVEL = '3'

try {
  const ort = require('onnxruntime-node')
  if (ort.env) ort.env.logLevel = 'error'
} catch {}
