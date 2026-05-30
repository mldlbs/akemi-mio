const fs = require('fs')
const path = require('path')

const MODEL = 'Xenova/whisper-medium'
const MIRROR = 'https://hf-mirror.com'
const OUT_DIR = path.resolve(__dirname, '..', 'models', MODEL)

const FILES = [
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'vocab.json',
  'normalizer.json',
  'merges.txt',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'generation_config.json',
  'quantize_config.json',
  'quant_config.json',
  // encoder + decoder (quantized int8)
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
]

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  process.stdout.write(`  GET ${path.basename(dest)} ... `)
  const resp = await fetch(url, { redirect: 'follow' })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`)
  const total = parseInt(resp.headers.get('content-length') || '0', 10)
  if (total === 0) {
    console.log('size unknown, streaming...')
  }
  let loaded = 0
  const reader = resp.body.getReader()
  const file = fs.createWriteStream(dest)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    loaded += value.length
    file.write(Buffer.from(value))
    if (total) {
      const pct = Math.round(loaded / total * 100)
      process.stdout.write(`\r  ${path.basename(dest)}: ${pct}% (${(loaded / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB)`)
    } else {
      process.stdout.write(`\r  ${path.basename(dest)}: ${(loaded / 1024 / 1024).toFixed(1)}MB`)
    }
  }
  file.end()
  process.stdout.write('\r  ' + path.basename(dest) + ': done\n')
}

async function main() {
  console.log(`Downloading ${MODEL} (quantized int8) from ${MIRROR} ...`)
  for (const f of FILES) {
    const dest = path.join(OUT_DIR, f)
    if (fs.existsSync(dest)) {
      console.log(`  ${path.basename(f)} exists, skip`)
      continue
    }
    const url = `${MIRROR}/${MODEL}/resolve/main/${f}`
    await download(url, dest)
  }
  console.log('\nDone! Model saved to models/Xenova/whisper-medium/')
}

main().catch((err) => {
  console.error('\nDownload failed:', err)
  process.exit(1)
})
