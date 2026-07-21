/**
 * BlogReview — 博客审核界面（含语音批注）
 *
 * 在文章审核阶段提供：
 * 1. Markdown 内容展示（只读预览）
 * 2. 段落级语音批注：选中段落 → 录制语音 → ASR 转写 → 关联批注
 * 3. 已有批注列表：播放音频、查看转写文本
 * 4. 保存/导出终稿
 *
 * 复用现有通道：
 * - window.electronAPI.transcribe() — ASR 语音识别
 * - window.electronAPI.blogSaveAudio() — 保存批注录音
 * - window.electronAPI.blogListAudio() — 获取批注列表
 * - window.electronAPI.blogGetAudioPath() — 获取音频路径
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
const MAX_RECORD_SECONDS = 60
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
//  类型定义
// ══════════════════════════════════════════

interface VoiceAnnotation {
  /** 批注 ID */
  id: string
  /** 音频条目 ID */
  audioId: string
  /** 关联的段落索引 */
  paragraphIndex: number
  /** 关联段落的文本摘要 */
  paragraphSnippet: string
  /** ASR 转写文本 */
  transcribedText: string
  /** 录制时长 */
  durationSec: number
  /** 创建时间 */
  createdAt: number
}

interface BlogReviewProps {
  /** 博客 Markdown 内容（只读） */
  content: string
  /** 标题 */
  title?: string
  /** 审核完成回调（返回最终内容） */
  onComplete?: (content: string, annotations: VoiceAnnotation[]) => void
  /** 返回编辑回调 */
  onBackToEdit?: () => void
}

// ══════════════════════════════════════════
//  BlogReview Component
// ══════════════════════════════════════════

export function BlogReview({ content, title, onComplete, onBackToEdit }: BlogReviewProps) {
  // ── 状态 ──
  const [annotations, setAnnotations] = useState<VoiceAnnotation[]>([])
  const [selectedPara, setSelectedPara] = useState<{ index: number; snippet: string } | null>(null)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [recordDuration, setRecordDuration] = useState(0)
  const [editedContent, setEditedContent] = useState(content)
  const [showDiff, setShowDiff] = useState(false)
  const [editingEnabled, setEditingEnabled] = useState(false)
  const [editText, setEditText] = useState(content)

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

  // ── 段落分割 ──
  const paragraphs = splitParagraphs(content)
  const paraCount = paragraphs.length

  // ── 加载已有批注 ──
  useEffect(() => {
    loadAnnotations()
  }, [])

  async function loadAnnotations() {
    try {
      const list = await window.electronAPI.blogListAudio('annotation', 50)
      const annots: VoiceAnnotation[] = list.map((entry: any) => ({
        id: entry.id,
        audioId: entry.id,
        paragraphIndex: entry.paragraphIndex ?? 0,
        paragraphSnippet: getParagraphSnippet(entry.paragraphIndex ?? 0),
        transcribedText: entry.transcribedText || '',
        durationSec: entry.durationSec,
        createdAt: entry.createdAt,
      }))
      setAnnotations(annots)
    } catch {
      // 静默
    }
  }

  function getParagraphSnippet(index: number): string {
    const paras = splitParagraphs(content)
    return paras[index]?.slice(0, 60) || ''
  }

  // ── 选择段落 ──
  const handleParaClick = useCallback((index: number) => {
    const snippet = splitParagraphs(content)[index]?.slice(0, 80) || ''
    setSelectedPara((prev) =>
      prev?.index === index ? null : { index, snippet },
    )
  }, [content])

  // ── 关闭音频 ──
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

  // ── 处理批注录音 → ASR 转写 ──
  const processAnnotation = useCallback(async () => {
    if (!selectedPara) return
    const samples = samplesRef.current
    const sr = sampleRateRef.current
    if (!samples.length || !sr) return

    setTranscribing(true)

    let totalLen = 0
    for (const s of samples) totalLen += s.length
    const merged = new Float32Array(totalLen)
    let off = 0
    for (const s of samples) {
      merged.set(s, off)
      off += s.length
    }
    samples.length = 0

    let resampled = sr !== ASR_SAMPLE_RATE ? resample(merged, sr, ASR_SAMPLE_RATE) : merged
    if (resampled.length < MIN_RECORD_SAMPLES) {
      setTranscribing(false)
      return
    }

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
      const transcribeResult = await window.electronAPI.transcribe(audioBuf)
      const transcribedText = transcribeResult.text?.trim()

      if (transcribedText) {
        // 保存批注音频
        let audioId = ''
        try {
          const saved = await window.electronAPI.blogSaveAudio(audioBuf, 'annotation', {
            paragraphIndex: selectedPara.index,
            durationSec,
            transcribedText,
            label: `段落 ${selectedPara.index + 1} 批注`,
          })
          if (saved?.id) audioId = saved.id
        } catch {
          // 非阻塞
        }

        const annotation: VoiceAnnotation = {
          id: audioId || `annot_${Date.now()}`,
          audioId: audioId || '',
          paragraphIndex: selectedPara.index,
          paragraphSnippet: selectedPara.snippet,
          transcribedText,
          durationSec,
          createdAt: Date.now(),
        }

        setAnnotations((prev) => [...prev, annotation])
        RLOG('INFO', 'blog_annotation_created', {
          paragraph: selectedPara.index,
          text: transcribedText.slice(0, 60),
        })
      }
    } catch (err) {
      RLOG('ERROR', 'blog_annotation_asr_failed', { error: String(err) })
    } finally {
      setTranscribing(false)
      closeAudio()
    }
  }, [selectedPara, closeAudio])

  // ── 开始录音 ──
  const startAnnotationRecord = useCallback(async () => {
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

      processor.onaudioprocess = (e) => {
        if (!recordingRef.current) return
        const input = e.inputBuffer.getChannelData(0)
        samplesRef.current.push(new Float32Array(input))
      }

      source.connect(processor)
      processor.connect(audioCtx.destination)

      durRef.current = 0
      timerRef.current = setInterval(() => {
        durRef.current++
        setRecordDuration(durRef.current)
      }, 1000)

      maxTimerRef.current = setTimeout(() => {
        if (recordingRef.current) stopAnnotationRecord()
      }, MAX_RECORD_SECONDS * 1000)

      setRecording(true)
      RLOG('INFO', 'blog_annotation_recording_start')
    } catch (err) {
      RLOG('ERROR', 'blog_annotation_mic_failed', { error: String(err) })
    }
  }, [])

  const stopAnnotationRecord = useCallback(() => {
    if (!recordingRef.current) return
    recordingRef.current = false
    setRecording(false)
    processAnnotation()
  }, [processAnnotation])

  // ── 播放批注音频 ──
  const playAnnotation = useCallback(async (audioId: string) => {
    try {
      const pathResult = await window.electronAPI.blogGetAudioPath(audioId)
      if (pathResult?.audioPath) {
        const audio = new Audio(`file://${pathResult.audioPath}`)
        audio.play().catch((err) => RLOG('WARN', 'blog_annotation_play_failed', { error: String(err) }))
      }
    } catch {
      // 静默
    }
  }, [])

  // ── 删除批注 ──
  const deleteAnnotation = useCallback(async (annotId: string) => {
    try {
      await window.electronAPI.blogDeleteAudio(annotId)
    } catch {
      // 静默
    }
    setAnnotations((prev) => prev.filter((a) => a.id !== annotId))
  }, [])

  // ── 清理 ──
  useEffect(() => {
    return () => {
      recordingRef.current = false
      closeAudio()
    }
  }, [closeAudio])

  // ── 编辑模式 ──
  const toggleEdit = useCallback(() => {
    setEditingEnabled((prev) => !prev)
    if (!editingEnabled) setEditText(content)
  }, [editingEnabled, content])

  const handleEditChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditText(e.target.value)
  }, [])

  const saveEdits = useCallback(() => {
    setEditedContent(editText)
    setEditingEnabled(false)
    setShowDiff(true)
  }, [editText])

  // ── 审核完成 ──
  const handleComplete = useCallback(() => {
    const finalContent = editingEnabled ? editText : editedContent
    onComplete?.(finalContent, annotations)
  }, [editingEnabled, editText, editedContent, annotations, onComplete])

  // ══════════════════════════════════════════
  //  渲染
  // ══════════════════════════════════════════

  return (
    <div className="blog-review">
      {/* ── 顶部栏 ── */}
      <div className="blog-review-header">
        <div className="blog-review-header-left">
          <h2 className="blog-review-title">{title || '博客审核'}</h2>
          <span className="blog-review-meta">
            {paraCount} 段落 · {annotations.length} 条批注
          </span>
        </div>
        <div className="blog-review-header-actions">
          <button className="blog-review-btn" onClick={() => setShowDiff(!showDiff)}>
            <i className="ri-file-diff-line" /> {showDiff ? '隐藏修改' : '显示修改'}
          </button>
          <button className="blog-review-btn" onClick={toggleEdit}>
            <i className="ri-edit-line" /> {editingEnabled ? '预览' : '编辑'}
          </button>
          {onBackToEdit && (
            <button className="blog-review-btn" onClick={onBackToEdit}>
              <i className="ri-arrow-go-back-line" /> 返回编辑
            </button>
          )}
          <button className="blog-review-btn-primary" onClick={handleComplete}>
            <i className="ri-check-line" /> 审核完成
          </button>
        </div>
      </div>

      {/* ── 内容区 ── */}
      <div className="blog-review-body">
        {editingEnabled ? (
          <textarea
            className="blog-review-textarea"
            value={editText}
            onChange={handleEditChange}
            spellCheck={false}
          />
        ) : (
          <div className="blog-review-content">
            <h1 className="br-title">{title || '（无标题）'}</h1>
            {paragraphs.map((para, idx) => {
              const paraAnnotations = annotations.filter((a) => a.paragraphIndex === idx)
              const isSelected = selectedPara?.index === idx
              const isAnnotated = paraAnnotations.length > 0
              const hasChanges = showDiff && content !== editedContent

              return (
                <div
                  key={idx}
                  className={`br-paragraph${isSelected ? ' selected' : ''}${isAnnotated ? ' annotated' : ''}`}
                  onClick={() => handleParaClick(idx)}
                >
                  <div className="br-para-index">{idx + 1}</div>
                  <div className="br-para-content">{renderParaContent(para)}</div>
                  <div className="br-para-actions">
                    {isAnnotated && (
                      <span className="br-para-annot-badge" title={`${paraAnnotations.length} 条批注`}>
                        <i className="ri-voiceprint-line" /> {paraAnnotations.length}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── 批注侧栏 ── */}
      <div className="blog-review-sidebar">
        {/* 录音批注区 */}
        <div className="br-sidebar-section">
          <h3 className="br-sidebar-title">
            <i className="ri-voiceprint-line" /> 语音批注
          </h3>
          {selectedPara ? (
            <div className="br-annotation-recorder">
              <div className="br-annotation-para-info">
                段落 {selectedPara.index + 1}: 「{selectedPara.snippet}」
              </div>
              {recording || transcribing ? (
                <div className="br-annotation-status">
                  <span className={`br-annotation-rec-icon ${recording ? 'active' : ''}`}>
                    <i className={transcribing ? 'ri-loader-4-line ri-spin' : 'ri-record-circle-fill'} />
                  </span>
                  <span className="br-annotation-rec-timer">
                    {transcribing ? '识别中…' : formatDuration(recordDuration)}
                  </span>
                  {recording && (
                    <button className="br-annotation-stop-btn" onClick={stopAnnotationRecord}>
                      <i className="ri-stop-fill" /> 停止
                    </button>
                  )}
                </div>
              ) : (
                <button className="br-annotation-record-btn" onClick={startAnnotationRecord}>
                  <i className="ri-mic-fill" /> 录制批注
                </button>
              )}
              <button className="br-annotation-cancel-btn" onClick={() => setSelectedPara(null)}>
                取消选择
              </button>
            </div>
          ) : (
            <p className="br-sidebar-hint">点击段落可添加语音批注</p>
          )}
        </div>

        {/* 已有批注列表 */}
        {annotations.length > 0 && (
          <div className="br-sidebar-section">
            <h3 className="br-sidebar-title">
              <i className="ri-file-list-3-line" /> 已有批注 ({annotations.length})
            </h3>
            <div className="br-annotations-list">
              {annotations
                .slice()
                .sort((a, b) => b.createdAt - a.createdAt)
                .map((annot) => (
                  <div key={annot.id} className="br-annotation-item">
                    <div className="br-annotation-item-header">
                      <span className="br-annotation-para-badge">
                        P{annot.paragraphIndex + 1}
                      </span>
                      <span className="br-annotation-dur">{annot.durationSec}s</span>
                      <span className="br-annotation-time">{formatTime(annot.createdAt)}</span>
                    </div>
                    <div className="br-annotation-text">{annot.transcribedText}</div>
                    <div className="br-annotation-snippet">{annot.paragraphSnippet}</div>
                    <div className="br-annotation-item-actions">
                      {annot.audioId && (
                        <button className="br-annotation-action" onClick={() => playAnnotation(annot.audioId)} title="播放">
                          <i className="ri-play-circle-line" />
                        </button>
                      )}
                      <button className="br-annotation-action" onClick={() => deleteAnnotation(annot.id)} title="删除">
                        <i className="ri-delete-bin-line" />
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════
//  辅助函数
// ══════════════════════════════════════════

function splitParagraphs(md: string): string[] {
  return md
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

/** 简单段落内容渲染（纯文本保持换行） */
function renderParaContent(text: string): React.ReactNode {
  // 图片
  const imgMatch = text.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
  if (imgMatch) {
    return <img src={imgMatch[2]} alt={imgMatch[1]} className="br-para-img" />
  }
  // 标题
  if (text.startsWith('#')) {
    return <span className="br-para-heading">{text}</span>
  }
  // 代码块
  if (text.startsWith('```')) {
    return <code className="br-para-code">{text.replace(/```/g, '').trim()}</code>
  }
  // 普通文本
  return <span>{text}</span>
}
