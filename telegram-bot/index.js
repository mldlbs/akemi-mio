/**
 * Akemi Mio Telegram Bot — 生图 + 图生图（img2img）
 *
 * 发文字 → txt2img
 * 发图片（带文字描述） → img2img
 * 底栏按钮：风格切换、状态
 * 出图后按钮：再来一张、切换风格、以图改图
 */

const { HttpsProxyAgent } = require('https-proxy-agent')
const { Telegraf, Markup } = require('telegraf')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// ─── 配置 ───

const TOKEN = process.env.BOT_TOKEN || (() => {
  try {
    const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8')
    const m = env.match(/^BOT_TOKEN=(.+)$/m)
    return m ? m[1].trim() : null
  } catch { return null }
})()

if (!TOKEN) {
  console.error('❌ 请设置 BOT_TOKEN 环境变量或新建 .env 文件写入 BOT_TOKEN=xxx')
  process.exit(1)
}

const COMFYUI_URL = process.env.COMFYUI_URL || 'http://127.0.0.1:8188'
const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:6653'

// ComfyUI input 目录（用于上传中转图片）
const COMFYUI_INPUT_DIR = process.env.COMFYUI_INPUT_DIR ||
  path.join(process.env.APPDATA || 'C:\\Users\\gf191\\AppData\\Roaming', 'akemi-mio', 'cache', 'comfyui', 'input')

// 预设风格
const STYLES = {
  none: { label: '无', prompt: '' },
  anime: { label: '动漫', prompt: ', anime style, anime girl, manga, vibrant colors, cel shading' },
  realistic: { label: '写实', prompt: ', photorealistic, 8k, highly detailed, realistic skin texture' },
  cyberpunk: { label: '赛博朋克', prompt: ', cyberpunk, neon lights, rain, dark atmosphere, futuristic city' },
  watercolor: { label: '水彩', prompt: ', watercolor painting, soft colors, artistic, paper texture' },
  sketch: { label: '素描', prompt: ', pencil sketch, black and white, detailed line art' },
  pixel: { label: '像素风', prompt: ', pixel art, 8-bit, retro game style, blocky' },
}

// img2img 强度（denoise），0=完全保留原图，1=完全重绘
const DEFAULT_IMG2IMG_STRENGTH = 0.85

// 用户会话状态
const userState = new Map()

// ─── 工具函数 ───

/** 下载 Telegram 文件到 ComfyUI input 目录，返回文件名 */
async function downloadTelegramFile(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId)
  const ext = path.extname(link.pathname) || '.jpg'
  const fileName = `telegram_${crypto.randomBytes(4).readUInt32LE(0).toString(16)}${ext}`
  const filePath = path.join(COMFYUI_INPUT_DIR, fileName)

  // 确保 input 目录存在
  if (!fs.existsSync(COMFYUI_INPUT_DIR)) {
    fs.mkdirSync(COMFYUI_INPUT_DIR, { recursive: true })
  }

  const res = await fetch(link.href, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error('下载 Telegram 图片失败')
  const buffer = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(filePath, buffer)
  console.log(`  下载图片: ${fileName} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`)
  return fileName
}

/** 调 ComfyUI 生图 */
async function generateImage(promptText, seed) {
  seed = seed ?? Math.floor(Math.random() * 2 ** 32)
  const workflow = buildWorkflow(promptText, seed)

  const res = await fetch(`${COMFYUI_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`ComfyUI 提交失败 (${res.status})`)
  }
  const { prompt_id } = await res.json()
  console.log(`  txt2img prompt_id=${prompt_id}`)
  return pollResult(prompt_id)
}

/** 调 ComfyUI 图生图 */
async function generateImg2img(initImageName, promptText, denoise, seed) {
  seed = seed ?? Math.floor(Math.random() * 2 ** 32)
  const workflow = buildImg2imgWorkflow(initImageName, promptText, denoise, seed)

  const res = await fetch(`${COMFYUI_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`ComfyUI 提交失败 (${res.status})`)
  }
  const { prompt_id } = await res.json()
  console.log(`  img2img prompt_id=${prompt_id}`)
  return pollResult(prompt_id)
}

/** 轮询 ComfyUI 结果 */
async function pollResult(promptId) {
  const t0 = Date.now()
  while (Date.now() - t0 < 300_000) {
    await new Promise(r => setTimeout(r, 1500))
    try {
      const histRes = await fetch(`${COMFYUI_URL}/history/${promptId}`, { signal: AbortSignal.timeout(5000) })
      if (!histRes.ok) continue
      const history = await histRes.json()
      const entry = history[promptId]
      if (!entry?.outputs) continue
      for (const nodeId of Object.keys(entry.outputs)) {
        for (const img of entry.outputs[nodeId].images || []) {
          if (img.type !== 'output') continue
          const viewUrl = `${COMFYUI_URL}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=output`
          const imgRes = await fetch(viewUrl)
          if (imgRes.ok) {
            const buffer = Buffer.from(await imgRes.arrayBuffer())
            console.log(`  完成: ${img.filename} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`)
            return { buffer, filename: img.filename }
          }
        }
      }
    } catch { /* retry */ }
  }
  throw new Error('生成超时')
}

/** txt2img 工作流 */
function buildWorkflow(prompt, seed) {
  return {
    '3': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['11', 0] } },
    '4': { class_type: 'KSampler', inputs: { seed, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['10', 0], positive: ['3', 0], negative: ['7', 0], latent_image: ['12', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality, distorted', clip: ['11', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['13', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'bot' } },
    '10': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux-schnell\\' + 'flux1-schnell-Q4_K_S.gguf' } },
    '11': { class_type: 'DualCLIPLoaderGGUF', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5-v1_1-xxl-encoder-Q6_K.gguf', type: 'flux' } },
    '12': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '13': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
  }
}

/** img2img 工作流（LoadImage → VAEEncode → KSampler with denoise < 1） */
function buildImg2imgWorkflow(imageName, prompt, denoise, seed) {
  return {
    '1': { class_type: 'LoadImage', inputs: { image: imageName } },
    '2': { class_type: 'VAEEncode', inputs: { pixels: ['1', 0], vae: ['13', 0] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['11', 0] } },
    '4': { class_type: 'KSampler', inputs: { seed, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise, model: ['10', 0], positive: ['3', 0], negative: ['7', 0], latent_image: ['2', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality, distorted', clip: ['11', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['13', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'bot' } },
    '10': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux-schnell\\' + 'flux1-schnell-Q4_K_S.gguf' } },
    '11': { class_type: 'DualCLIPLoaderGGUF', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5-v1_1-xxl-encoder-Q6_K.gguf', type: 'flux' } },
    '13': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
  }
}

async function checkComfyUI() {
  try { return (await fetch(`${COMFYUI_URL}/system_stats`, { signal: AbortSignal.timeout(5000) })).ok }
  catch { return false }
}

// ─── 键盘构建 ───

const mainKeyboard = Markup.keyboard([
  ['🎨 输入提示词', '🖌️ 切换风格'],
  ['✅ 状态'],
]).resize().persistent()

function styleButtons(currentStyle) {
  const buttons = Object.entries(STYLES).flatMap(([key, s]) =>
    Markup.button.callback(
      `${key === currentStyle ? '▸' : ''}${s.label}${key === currentStyle ? '◂' : ''}`,
      `style:${key}`,
    )
  )
  const rows = []
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3))
  return Markup.inlineKeyboard(rows)
}

function actionButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 再来一张', 'remake')],
    [Markup.button.callback('🖼️ 以图改图', 'img2img_last'), Markup.button.callback('🖌️ 风格', 'show_styles')],
  ])
}

// ─── Bot 逻辑 ───

const agent = new HttpsProxyAgent(PROXY_URL)
const bot = new Telegraf(TOKEN, { telegram: { agent }, handlerTimeout: 300_000 })

// /start
bot.start(async (ctx) => {
  userState.set(ctx.chat.id, { prompt: '', style: 'none' })
  await ctx.reply(
    '🤖 **秋山澪 生图 Bot**\n\n' +
    '直接发文字 → txt2img 生图 ✨\n' +
    '发图片 + 描述文字 → img2img 以图改图 🖼️\n' +
    '底部按钮切换风格',
    { parse_mode: 'Markdown', ...mainKeyboard },
  )
})

// ✅ 状态
bot.hears('✅ 状态', async (ctx) => {
  const comfyOk = await checkComfyUI()
  const state = userState.get(ctx.chat.id) || { style: 'none' }
  await ctx.reply(
    `🤖 Bot: ✅ 在线\n⚙️ ComfyUI: ${comfyOk ? '✅ 就绪' : '❌ 离线'}\n🎨 风格: ${STYLES[state.style]?.label || '无'}`,
    mainKeyboard,
  )
})

// 🖌️ 切换风格
bot.hears('🖌️ 切换风格', async (ctx) => {
  const state = userState.get(ctx.chat.id) || { prompt: '', style: 'none' }
  userState.set(ctx.chat.id, state)
  await ctx.reply('选择图片风格：', styleButtons(state.style))
})

// 🎨 输入提示词引导
bot.hears('🎨 输入提示词', async (ctx) => {
  await ctx.reply('发文字生图 ✨ 或发图片+描述来以图改图 🖼️\n例如发送一张猫的图片 + "变成赛博朋克风格"', mainKeyboard)
})

// 行内按钮：选择风格
bot.action(/style:(.+)/, async (ctx) => {
  const styleKey = ctx.match[1]
  if (!STYLES[styleKey]) return ctx.answerCbQuery('未知风格')
  const state = userState.get(ctx.chat.id) || { prompt: '', style: 'none' }
  state.style = styleKey
  userState.set(ctx.chat.id, state)
  await ctx.answerCbQuery(`风格: ${STYLES[styleKey].label}`)
  await ctx.editMessageText(`✅ 风格: **${STYLES[styleKey].label}**\n直接发文字生图吧 ✨`, {
    parse_mode: 'Markdown', ...styleButtons(styleKey),
  }).catch(err => {
    if (err.description?.includes('message is not modified')) return
    throw err
  })
})

// 🔄 再来一张
bot.action('remake', async (ctx) => {
  const state = userState.get(ctx.chat.id)
  if (!state || !state.prompt) {
    await ctx.answerCbQuery('还没生过图，发文字试试吧')
    return
  }
  await ctx.answerCbQuery('重新生成...')
  await ctx.deleteMessage().catch(() => {})
  await doDraw(ctx, state.prompt, state.style)
})

// 🖼️ 以上次出图为基础改图
bot.action('img2img_last', async (ctx) => {
  const state = userState.get(ctx.chat.id)
  if (!state || !state.lastOutputImage) {
    await ctx.answerCbQuery('还没有生过图，先发文字生一张吧')
    return
  }
  await ctx.answerCbQuery('以图改图模式，请发送修改描述')
  // 设置标记：等待用户输入描述
  state.waitingImg2img = true
  userState.set(ctx.chat.id, state)
  await ctx.reply(
    `🖼️ 以上一张图为底图\n发送描述文字来修改它（例如：\`换上古装\`）\n或 /cancel 取消`,
    { parse_mode: 'Markdown', ...mainKeyboard },
  )
})

// 🖌️ 切换风格（从结果按钮）
bot.action('show_styles', async (ctx) => {
  const state = userState.get(ctx.chat.id) || { prompt: '', style: 'none' }
  await ctx.answerCbQuery()
  await ctx.reply('选择图片风格：', styleButtons(state.style))
})

// /cancel — 取消待输入状态
bot.command('cancel', async (ctx) => {
  const state = userState.get(ctx.chat.id)
  if (state) {
    state.waitingImg2img = false
    userState.set(ctx.chat.id, state)
    await ctx.reply('已取消', mainKeyboard)
  }
})

// ─── 处理图片 ───

bot.on('photo', async (ctx) => {
  const comfyOk = await checkComfyUI()
  if (!comfyOk) return ctx.reply('❌ ComfyUI 未运行', mainKeyboard)

  // 取最高分辨率
  const photo = ctx.message.photo[ctx.message.photo.length - 1]
  const statusMsg = await ctx.reply('📥 收到图片，正在下载...')

  try {
    const fileName = await downloadTelegramFile(ctx, photo.file_id)
    console.log(`  已存入 ComfyUI input: ${fileName}`)

    // 保存到会话
    const state = userState.get(ctx.chat.id) || { prompt: '', style: 'none' }
    state.pendingImage = fileName
    state.waitingImg2img = true
    userState.set(ctx.chat.id, state)

    // 如果带了文字描述，直接 img2img
    const caption = ctx.message.caption?.trim()
    if (caption && caption.length <= 500) {
      state.waitingImg2img = false
      state.prompt = caption
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `🖼️ 收到图片 + "${caption}"，开始以图改图...`)
      await doImg2img(ctx, fileName, caption + (STYLES[state.style]?.prompt || ''), statusMsg.message_id)
    } else {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined,
        '🖼️ 图片已收到！再发一段描述文字告诉我怎么修改它 ✨\n或 /cancel 取消')
    }
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `❌ ${err.message}`)
    console.error(err.message)
  }
})

// ─── 处理文字 ───

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim()
  if (!text || text.startsWith('/')) return
  if (text.length > 500) return ctx.reply('❌ 提示词太长啦', mainKeyboard)

  const state = userState.get(ctx.chat.id) || { prompt: '', style: 'none' }

  // 检查是否在等待 img2img 描述
  if (state.waitingImg2img && state.lastOutputImage) {
    state.waitingImg2img = false
    state.prompt = text
    userState.set(ctx.chat.id, state)
    await doImg2img(ctx, state.lastOutputImage, text + (STYLES[state.style]?.prompt || ''), null)
    return
  }

  // 检查是否有待处理的图片
  if (state.pendingImage) {
    const img = state.pendingImage
    state.pendingImage = null
    state.waitingImg2img = false
    state.prompt = text
    userState.set(ctx.chat.id, state)
    await doImg2img(ctx, img, text + (STYLES[state.style]?.prompt || ''), null)
    return
  }

  // 普通 txt2img
  state.prompt = text
  userState.set(ctx.chat.id, state)
  await doDraw(ctx, text, state.style)
})

// ─── 核心生图 ───

async function doDraw(ctx, promptText, styleKey) {
  const comfyOk = await checkComfyUI()
  if (!comfyOk) return ctx.reply('❌ ComfyUI 未运行', mainKeyboard)

  const fullPrompt = promptText + (STYLES[styleKey]?.prompt || '')
  const statusMsg = await ctx.reply(`🎨 绘制中${styleKey !== 'none' ? ` (${STYLES[styleKey].label})` : ''}...`)

  try {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined,
      `⏳ 生成中...\n\`${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}\``,
      { parse_mode: 'Markdown' })

    const { buffer, filename } = await generateImage(fullPrompt)

    // 保存到会话用于 img2img 和 remake
    const state = userState.get(ctx.chat.id) || { prompt: '', style: styleKey }
    state.lastOutputImage = filename
    userState.set(ctx.chat.id, state)

    await ctx.replyWithPhoto(
      { source: buffer },
      { caption: `🎨 \`${promptText}\`\n🆔 seed: 随机`, parse_mode: 'Markdown', ...actionButtons() },
    )
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {})
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `❌ 生成失败: ${err.message}`)
      .catch(() => ctx.reply(`❌ ${err.message}`))
    console.error(err.message)
  }
}

async function doImg2img(ctx, imageName, promptText, editMsgId) {
  const denoise = DEFAULT_IMG2IMG_STRENGTH
  const statusMsg = editMsgId ? null : await ctx.reply('🖼️ 以图改图中...')

  try {
    if (editMsgId) {
      await ctx.telegram.editMessageText(ctx.chat.id, editMsgId, undefined, `⏳ 以图改图中 (denoise=${denoise})...`)
    } else {
      await ctx.reply(`⏳ 以图改图中 (denoise=${denoise})...`)
    }

    const { buffer, filename } = await generateImg2img(imageName, promptText, denoise)

    // 保存用于下次以图改图
    const state = userState.get(ctx.chat.id) || { prompt: '', style: 'none' }
    state.lastOutputImage = filename
    userState.set(ctx.chat.id, state)

    await ctx.replyWithPhoto(
      { source: buffer },
      { caption: `🖼️ 以图改图完成\n✨ \`${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}\``, parse_mode: 'Markdown', ...actionButtons() },
    )

    if (editMsgId) await ctx.telegram.deleteMessage(ctx.chat.id, editMsgId).catch(() => {})
    if (statusMsg) await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {})
  } catch (err) {
    const errText = `❌ 以图改图失败: ${err.message}`
    if (editMsgId) {
      await ctx.telegram.editMessageText(ctx.chat.id, editMsgId, undefined, errText).catch(() => {})
    } else {
      await ctx.reply(errText)
    }
    console.error(err.message)
  }
}

// 全局错误处理器（防止单个未捕获错误导致 bot crash 无限重启）
bot.catch((err) => {
  const desc = err?.message || String(err)
  // "message is not modified" 无害，静默忽略
  if (desc.includes('message is not modified')) return
  console.error('⚠️ bot.catch:', desc)
})

// 启动
bot.launch().then(() => {
  console.log('🤖 Akemi Mio Bot 已启动!')
  console.log('   发文字 → txt2img | 发图片 → img2img')
}).catch(err => {
  console.error('❌ 启动失败:', err.message)
  process.exit(1)
})

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
