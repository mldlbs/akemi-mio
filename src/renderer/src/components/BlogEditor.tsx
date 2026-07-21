/**
 * BlogEditor — 语音驱动博客编辑器
 *
 * 提供：
 * 1. Markdown 编辑区，支持文字输入
 * 2. 录音按钮：录制口述内容 → ASR 转写 → 插入文本到光标位置
 * 3. 音频保存：录音自动保存为 WAV 文件供事后复核
 * 4. 工具栏：标题、粗体、列表等快捷插入
 * 5. 预览模式：切换编辑/预览视图
 *
 * 复用现有通道：
 * - window.electronAPI.transcribe() — ASR 语音识别
 * - window.electronAPI.blogSaveAudio() — 保存录音文件
 * - window.electronAPI.blogListAudio() — 获取会话录音列表
 */

import { useRef, useState, useCallback, useEffect } from 'react'

const RLOG = (level: string, event: string, meta?: Record<string, unknown>) => {
  const beijing = new Date(Date.now() + 8 * 3600 * 1000)
  const ts = beijing.toISOString().replace('Z', '+08:00')
  console.log(JSON.stringify({ level, timestamp: ts, event, ...(meta || {}) }))
}

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

const BUFFER_SIZE = 4096
const ASR_SAMPLE_RATE = 16000
const MAX_RECORD_SECONDS = 120 // 最长 2 分钟口述
const MIN_RECORD_SAMPLES = 8000

// ══════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════

function resample(audio: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return audio
  const ratio = fromRate / toRate
  const result = new Float32Array(Math.ceil(audio.length / ratio))
  for (let i = 0; i < result.length; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    result[i] = idx + 1 < audio.length ? audio[idx] * (1 - frac) + audio[idx + 1] * frac : audio[idx] || 0
  }
  return result
}

// ══════════════════════════════════════════
//  BlogEditor Props
// ══════════════════════════════════════════

interface BlogAudioRecording {
  id: string
  durationSec: number
  transcribedText: string
  createdAt: number
}

interface BlogEditorProps {
  /** 外部传入的初始内容 */
  initialContent?: string
  /** 内容变更回调 */
  onChange?: (content: string) => void
}

export function BlogEditor({ initialContent = '', onChange }: BlogEditorProps) {
  // ── 编辑器状态 ──
  const [content, setContent] = useState(initialContent)
  const [preview, setPreview] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ── 录音状态 ──
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [recordDuration, setRecordDuration] = useState(0)
  const [lastDictation, setLastDictation] = useState<BlogAudioRecording | null>(null)
  const [recordings, setRecordings] = useState<BlogAudioRecording[]>([])
  const [showRecordings, setShowRecordings] = useState(false)

  // ── 录音 refs ──
  const recordingRef = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const samplesRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const durRef = useRef(0)
  const recordingStartRef = useRef(0)

  // ── 加载已有录音 ──
  useEffect(() => {
    loadRecordings()
  }, [])

  async function loadRecordings() {
    try {
      const list = await window.electronAPI.blogListAudio('dictation', 20)
      setRecordings(list)
    } catch {
      // 静默
    }
  }

  // ── 内容变更 ──
  const handleChange = useCallback(
    (newContent: string) => {
      setContent(newContent)
      onChange?.(newContent)
    },
    [onChange],
  )

  // ── 插入文本到光标位置 ──
  const insertAtCursor = useCallback((text: string) => {
    const ta = textareaRef.current
    if (!ta) {
      // fallback: 追加到末尾
      setContent((prev) => prev + (prev ? '\n\n' : '') + text)
      return
    }

    const start = ta.selectionStart
    const end = ta.selectionEnd
    const newVal = content.substring(0, start) + text + content.substring(end)

    setContent(newVal)
    onChange?.(newVal)

    // 更新光标位置到插入文本之后
    requestAnimationFrame(() => {
      const pos = start + text.length
      ta.selectionStart = pos
      ta.selectionEnd = pos
      ta.focus()
    })
  }, [content, onChange])

  // ── 工具栏操作 ──
  const insertMarkdown = useCallback(
    (template: string) => {
      insertAtCursor(template)
    },
    [insertAtCursor],
  )

  // ── 关闭音频流 ──
  const closeAudio = useCallback(() => {
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null
      processorRef.current.disconnect()
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close()
      audioCtxRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    processorRef.current = null
    setRecordDuration(0)
    durRef.current = 0
  }, [])

  // ── 处理录音 → ASR 转写 ──
  const processDictation = useCallback(async () => {
    const samples = samplesRef.current
    const sr = sampleRateRef.current
    if (!samples.length || !sr) return

    setTranscribing(true)

    // 合并采样块
    let totalLen = 0
    for (const s of samples) totalLen += s.length
    const merged = new Float32Array(totalLen)
    let off = 0
    for (const s of samples) {
      merged.set(s, off)
      off += s.length
    }
    samples.length = 0

    // 重采样到 16kHz
    let resampled = sr !== ASR_SAMPLE_RATE ? resample(merged, sr, ASR_SAMPLE_RATE) : merged
    if (resampled.length < MIN_RECORD_SAMPLES) {
      setTranscribing(false)
      return
    }

    // 归一化增益 → Int16 PCM
    let peak = 0
    for (let i = 0; i < resampled.length; i++) {
      const v = Math.abs(resampled[i])
      if (v > peak) peak = v
    }
    const gain = peak > 0.001 ? Math.min(0.6 / peak, 20) : 1
    const pcm = new Int16Array(resampled.length)
    for (let i = 0; i < resampled.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, resampled[i] * gain * 32768))

    const audioBuf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)
    const durationSec = durRef.current

    try {
      // ASR 识别
      const transcribeResult = await window.electronAPI.transcribe(audioBuf)
      const transcribedText = transcribeResult.text?.trim()

      if (transcribedText) {
        // 保存录音文件
        let audioId = ''
        try {
          const saved = await window.electronAPI.blogSaveAudio(audioBuf, 'dictation', {
            durationSec,
            transcribedText,
          })
          if (saved?.id) audioId = saved.id
        } catch {
          // 保存失败不阻塞主流程
        }

        // 插入文本到编辑器
        insertAtCursor(transcribedText)

        // 记录本次口述
        const rec: BlogAudioRecording = {
          id: audioId || `local_${Date.now()}`,
          durationSec,
          transcribedText,
          createdAt: Date.now(),
        }
        setLastDictation(rec)
        setRecordings((prev) => [rec, ...prev])

        RLOG('INFO', 'blog_dictation_done', {
          text: transcribedText.slice(0, 60),
          duration: durationSec,
          audioId,
        })
      } else {
        RLOG('WARN', 'blog_dictation_empty', { error: transcribeResult.error })
      }
    } catch (err) {
      RLOG('ERROR', 'blog_dictation_failed', { error: String(err) })
    } finally {
      setTranscribing(false)
      closeAudio()
    }
  }, [insertAtCursor, closeAudio])

  // ── 开始录音 ──
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      streamRef.current = stream
      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const sr = audioCtx.sampleRate
      sampleRateRef.current = sr
      const source = audioCtx.createMediaStreamSource(stream)

      const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)
      processorRef.current = processor
      samplesRef.current = []
      recordingRef.current = true
      recordingStartRef.current = Date.now()

      processor.onaudioprocess = (e) => {
        if (!recordingRef.current) return
        const input = e.inputBuffer.getChannelData(0)
        samplesRef.current.push(new Float32Array(input))
      }

      source.connect(processor)
      processor.connect(audioCtx.destination)

      // 计时
      durRef.current = 0
      timerRef.current = setInterval(() => {
        durRef.current++
        setRecordDuration(durRef.current)
      }, 1000)

      // 最长录音超时
      maxTimerRef.current = setTimeout(() => {
        if (recordingRef.current) {
          stopRecording()
        }
      }, MAX_RECORD_SECONDS * 1000)

      setRecording(true)
      RLOG('INFO', 'blog_dictation_start', { sampleRate: sr })
    } catch (err) {
      RLOG('ERROR', 'blog_dictation_mic_failed', { error: String(err) })
    }
  }, [])

  // ── 停止录音 → 自动处理 ──
  const stopRecording = useCallback(() => {
    if (!recordingRef.current) return
    recordingRef.current = false
    setRecording(false)
    RLOG('INFO', 'blog_dictation_stop', { duration: durRef.current })
    processDictation()
  }, [processDictation])

  // ── 切换录音 ──
  const toggleRecording = useCallback(() => {
    if (recording) {
      stopRecording()
    } else {
      startRecording()
    }
  }, [recording, startRecording, stopRecording])

  // ── 播放音频 ──
  const playAudio = useCallback(async (recordingId: string) => {
    try {
      const pathResult = await window.electronAPI.blogGetAudioPath(recordingId)
      if (pathResult?.audioPath) {
        const audio = new Audio(`file://${pathResult.audioPath}`)
        audio.play().catch((err) => RLOG('WARN', 'blog_audio_play_failed', { error: String(err) }))
      }
    } catch {
      // 静默
    }
  }, [])

  // ── 删除录音 ──
  const deleteRecording = useCallback(async (recordingId: string) => {
    try {
      await window.electronAPI.blogDeleteAudio(recordingId)
    } catch {
      // 静默
    }
    setRecordings((prev) => prev.filter((r) => r.id !== recordingId))
    if (lastDictation?.id === recordingId) setLastDictation(null)
  }, [])

  // ── 清理 ──
  useEffect(() => {
    return () => {
      recordingRef.current = false
      closeAudio()
    }
  }, [closeAudio])

  // ══════════════════════════════════════════
  //  渲染
  // ══════════════════════════════════════════

  return (
    <div className="blog-editor">
      {/* ── 工具栏 ── */}
      <div className="blog-editor-toolbar">
        <div className="blog-editor-toolbar-group">
          <button className="blog-editor-tb-btn" onClick={() => insertMarkdown('# ')} title="标题">
            <i className="ri-h-1" />
          </button>
          <button className="blog-editor-tb-btn" onClick={() => insertMarkdown('**粗体**')} title="粗体">
            <i className="ri-bold" />
          </button>
          <button className="blog-editor-tb-btn" onClick={() => insertMarkdown('*斜体*')} title="斜体">
            <i className="ri-italic" />
          </button>
          <button className="blog-editor-tb-btn" onClick={() => insertMarkdown('- ')} title="无序列表">
            <i className="ri-list-unordered" />
          </button>
          <button className="blog-editor-tb-btn" onClick={() => insertMarkdown('1. ')} title="有序列表">
            <i className="ri-list-ordered" />
          </button>
          <button className="blog-editor-tb-btn" onClick={() => insertMarkdown('> ')} title="引用">
            <i className="ri-double-quotes-l" />
          </button>
          <button className="blog-editor-tb-btn" onClick={() => insertMarkdown('```\n\n```')} title="代码块">
            <i className="ri-code-line" />
          </button>
          <button className="blog-editor-tb-btn" onClick={() => insertMarkdown('[](url)')} title="链接">
            <i className="ri-link" />
          </button>
        </div>
        <div className="blog-editor-toolbar-group">
          <button
            className={`blog-editor-tb-btn${preview ? ' active' : ''}`}
            onClick={() => setPreview(!preview)}
            title={preview ? '编辑模式' : '预览模式'}
          >
            <i className={preview ? 'ri-edit-line' : 'ri-eye-line'} />
          </button>
          <button
            className="blog-editor-tb-btn"
            onClick={() => setShowRecordings(!showRecordings)}
            title="历史录音"
          >
            <i className="ri-file-list-3-line" />
          </button>
        </div>
      </div>

      {/* ── 编辑/预览区域 ── */}
      <div className="blog-editor-body">
        {preview ? (
          <div className="blog-editor-preview markdown-body">
            {renderMarkdown(content)}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className="blog-editor-textarea"
            value={content}
            onChange={(e) => handleChange(e.target.value)}
            placeholder="开始写博客… 或点击麦克风按钮口述内容"
            spellCheck={false}
          />
        )}
      </div>

      {/* ── 底部栏：录音控制 + 最近口述 ── */}
      <div className="blog-editor-footer">
        <div className="blog-editor-footer-left">
          {/* 录音按钮 */}
          <button
            className={`blog-editor-rec-btn${recording ? ' recording' : ''}${transcribing ? ' transcribing' : ''}`}
            onClick={toggleRecording}
            disabled={transcribing}
            title={recording ? '停止录音' : '开始口述录音'}
          >
            {transcribing ? (
              <i className="ri-loader-4-line ri-spin" />
            ) : recording ? (
              <i className="ri-stop-fill" />
            ) : (
              <i className="ri-mic-fill" />
            )}
          </button>
          {recording && (
            <span className="blog-editor-rec-timer">
              <span className="rec-dot-pulse" />
              {formatDuration(recordDuration)}
            </span>
          )}
          {transcribing && <span className="blog-editor-rec-timer">识别中…</span>}

          {/* 字数统计 */}
          <span className="blog-editor-word-count">{content.replace(/\s/g, '').length} 字</span>
        </div>

        <div className="blog-editor-footer-right">
          {/* 最近口述提示 */}
          {lastDictation && !recording && !transcribing && (
            <span className="blog-editor-last-dictation" title={lastDictation.transcribedText}>
              <i className="ri-voiceprint-line" />
              {lastDictation.transcribedText.slice(0, 40)}…
            </span>
          )}
        </div>
      </div>

      {/* ── 历史录音面板 ── */}
      {showRecordings && (
        <div className="blog-editor-recordings">
          <div className="blog-editor-recordings-header">
            <span>口述录音历史</span>
            <button className="blog-editor-rec-close" onClick={() => setShowRecordings(false)}>
              <i className="ri-close-line" />
            </button>
          </div>
          {recordings.length === 0 ? (
            <div className="blog-editor-recordings-empty">暂无录音</div>
          ) : (
            <div className="blog-editor-recordings-list">
              {recordings.map((rec) => (
                <div key={rec.id} className="blog-editor-recording-item">
                  <div className="blog-editor-recording-meta">
                    <span className="blog-editor-recording-time">{formatDateTime(rec.createdAt)}</span>
                    <span className="blog-editor-recording-dur">{rec.durationSec}s</span>
                  </div>
                  <div className="blog-editor-recording-text">{rec.transcribedText}</div>
                  <div className="blog-editor-recording-actions">
                    <button className="blog-editor-rec-action" onClick={() => playAudio(rec.id)} title="播放">
                      <i className="ri-play-circle-line" />
                    </button>
                    <button className="blog-editor-rec-action" onClick={() => insertAtCursor(rec.transcribedText)} title="重新插入">
                      <i className="ri-file-copy-line" />
                    </button>
                    <button className="blog-editor-rec-action" onClick={() => deleteRecording(rec.id)} title="删除">
                      <i className="ri-delete-bin-line" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════
//  辅助函数
// ══════════════════════════════════════════

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${min}`
}

/** 简易 Markdown → JSX 渲染（轻量级，仅预览用） */
function renderMarkdown(md: string): React.ReactNode {
  if (!md) return <p className="md-empty">（空内容）</p>

  const lines = md.split('\n')
  const elements: React.ReactNode[] = []
  let inCodeBlock = false
  let codeBlockLines: string[] = []
  let codeLang = ''
  let inList = false
  let listItems: React.ReactNode[] = []

  function flushList() {
    if (listItems.length > 0) {
      elements.push(
        <ul key={`list-${elements.length}`} className="md-list">
          {listItems}
        </ul>,
      )
      listItems = []
      inList = false
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 代码块
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre key={`code-${i}`} className="md-code-block">
            <code>{codeBlockLines.join('\n')}</code>
          </pre>,
        )
        codeBlockLines = []
        inCodeBlock = false
      } else {
        flushList()
        inCodeBlock = true
        codeLang = line.slice(3).trim()
      }
      continue
    }
    if (inCodeBlock) {
      codeBlockLines.push(line)
      continue
    }

    // 空行
    if (!line.trim()) {
      flushList()
      continue
    }

    // 标题
    if (line.startsWith('### ')) {
      flushList()
      elements.push(<h3 key={`h3-${i}`} className="md-h3">{line.slice(4)}</h3>)
      continue
    }
    if (line.startsWith('## ')) {
      flushList()
      elements.push(<h2 key={`h2-${i}`} className="md-h2">{line.slice(3)}</h2>)
      continue
    }
    if (line.startsWith('# ')) {
      flushList()
      elements.push(<h1 key={`h1-${i}`} className="md-h1">{line.slice(2)}</h1>)
      continue
    }

    // 引用
    if (line.startsWith('> ')) {
      flushList()
      elements.push(<blockquote key={`bq-${i}`} className="md-blockquote">{line.slice(2)}</blockquote>)
      continue
    }

    // 列表项
    if (line.startsWith('- ') || line.startsWith('* ')) {
      inList = true
      listItems.push(<li key={`li-${i}`}>{renderInline(line.slice(2))}</li>)
      continue
    }
    if (/^\d+\.\s/.test(line)) {
      inList = true
      listItems.push(<li key={`oli-${i}`}>{renderInline(line.replace(/^\d+\.\s/, ''))}</li>)
      continue
    }

    // 水平线
    if (/^---+\s*$/.test(line)) {
      flushList()
      elements.push(<hr key={`hr-${i}`} className="md-hr" />)
      continue
    }

    // 普通段落
    flushList()
    elements.push(<p key={`p-${i}`} className="md-p">{renderInline(line)}</p>)
  }

  flushList()
  if (inCodeBlock) {
    elements.push(<pre key="code-unclosed" className="md-code-block"><code>{codeBlockLines.join('\n')}</code></pre>)
  }

  return elements
}

/** 行内渲染：粗体、斜体、行内代码、链接 */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let remaining = text
  let idx = 0

  while (remaining.length > 0) {
    // 行内代码 `...`
    const codeMatch = remaining.match(/`([^`]+)`/)
    // 粗体 **...**
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/)
    // 斜体 *...*
    const italicMatch = remaining.match(/\*(.+?)\*/)
    // 链接 [...](...)
    const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/)

    // 找最近的一个格式标记
    let earliest: { type: string; index: number; length: number; content: string[] } | null = null
    for (const m of [
      codeMatch ? { type: 'code' as const, index: m.index!, length: m[0].length, content: [m[1]] } : null,
      boldMatch ? { type: 'bold' as const, index: m.index!, length: m[0].length, content: [m[1]] } : null,
      italicMatch ? { type: 'italic' as const, index: m.index!, length: m[0].length, content: [m[1]] } : null,
      linkMatch ? { type: 'link' as const, index: m.index!, length: m[0].length, content: [m[1], m[2]] } : null,
    ]) {
      if (m && (!earliest || m.index < earliest.index)) {
        earliest = m
      }
    }

    if (!earliest) {
      parts.push(remaining)
      break
    }

    // 添加前面的文本
    if (earliest.index > 0) {
      parts.push(remaining.slice(0, earliest.index))
    }

    // 添加格式化元素
    switch (earliest.type) {
      case 'code':
        parts.push(<code key={`ic-${idx}`} className="md-inline-code">{earliest.content[0]}</code>)
        break
      case 'bold':
        parts.push(<strong key={`b-${idx}`} className="md-bold">{renderInline(earliest.content[0])}</strong>)
        break
      case 'italic':
        parts.push(<em key={`i-${idx}`} className="md-italic">{earliest.content[0]}</em>)
        break
      case 'link':
        parts.push(
          <a key={`a-${idx}`} className="md-link" href={earliest.content[1]} target="_blank" rel="noreferrer">
            {earliest.content[0]}
          </a>,
        )
        break
    }

    remaining = remaining.slice(earliest.index + earliest.length)
    idx++
  }

  return parts
}
