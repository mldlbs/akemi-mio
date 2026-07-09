/**
 * TypographyVerificationPanel — 排版内容语音校验与预览 UI
 *
 * 功能：
 * 1. 展示 TTS→ASR 闭环校验报告，含逐句差异对比
 * 2. 高亮可疑段落（差异率 > 阈值）
 * 3. 支持点击播放合成音频
 * 4. 支持"朗读这段"单独触发
 * 5. 提供接受/刷新操作
 *
 * 集成：
 * - 通过 IPC（typing:verify）触发校验
 * - 通过 IPC（typing:readAloud）触发单段朗读
 * - 音频播放复用 audioShared.ts 的 playTTS
 */
import { useState, useCallback, useRef, useEffect } from 'react'

// ══════════════════════════════════════════
//  类型（与服务端保持一致）
// ══════════════════════════════════════════

type DiffType = 'match' | 'substitution' | 'deletion' | 'insertion'

interface DiffSegment {
  type: DiffType
  original: string
  recognized: string
  start: number
  end: number
}

interface SentenceCheck {
  originalSentence: string
  recognizedSentence: string
  editDistance: number
  length: number
  diffRate: number
  suspicious: boolean
  diffSegments: DiffSegment[]
}

interface VerificationReport {
  formattedText: string
  plainText: string
  recognizedText: string
  sentences: SentenceCheck[]
  summary: {
    totalSentences: number
    suspiciousSentences: number
    totalDiffRate: number
    hasDiscrepancies: boolean
    audioDurationMs: number
    verificationMs: number
  }
  audioFile?: string
}

// ══════════════════════════════════════════
//  子组件：差异片段染色
// ══════════════════════════════════════════

function DiffSegmentView({ seg }: { seg: DiffSegment }) {
  const className = {
    match: 'tv-diff-match',
    substitution: 'tv-diff-sub',
    deletion: 'tv-diff-del',
    insertion: 'tv-diff-ins',
  }[seg.type]

  const tooltip = {
    match: '',
    substitution: `原文「${seg.original}」→ 识别为「${seg.recognized}」`,
    deletion: `原文「${seg.original}」未被朗读`,
    insertion: `朗读/识别多出「${seg.recognized}」`,
  }[seg.type]

  const display = seg.type === 'insertion'
    ? `[${seg.recognized}]`
    : seg.type === 'deletion'
      ? `[${seg.original}]`
      : seg.original

  if (!tooltip) return <span className={className}>{display}</span>
  return <span className={className} title={tooltip}>{display}</span>
}

// ══════════════════════════════════════════
//  子组件：单句差异行
// ══════════════════════════════════════════

function SentenceRow({
  sentence,
  index,
  onPlaySentence,
}: {
  sentence: SentenceCheck
  index: number
  onPlaySentence: (text: string) => void
}) {
  const [expanded, setExpanded] = useState(false)

  const diffRatePct = (sentence.diffRate * 100).toFixed(0)
  const statusIcon = sentence.suspicious ? '⚠️' : '✅'
  const statusClass = sentence.suspicious ? 'tv-sentence-suspicious' : 'tv-sentence-ok'

  if (!sentence.originalSentence && !sentence.recognizedSentence) return null

  return (
    <div className={`tv-sentence ${statusClass}`}>
      <div className="tv-sentence-header" onClick={() => setExpanded(!expanded)}>
        <span className="tv-sentence-index">#{index + 1}</span>
        <span className="tv-sentence-status-icon">{statusIcon}</span>
        <span className="tv-sentence-preview">
          {sentence.originalSentence.slice(0, 40)}
          {sentence.originalSentence.length > 40 ? '...' : ''}
        </span>
        <span className="tv-sentence-meta">
          {diffRatePct}% 差异
        </span>
      </div>

      {expanded && (
        <div className="tv-sentence-detail">
          {/* 原文（差分染色） */}
          <div className="tv-sentence-line">
            <span className="tv-label">原文：</span>
            <span className="tv-diff-text">
              {sentence.diffSegments.map((seg, i) => (
                seg.type !== 'insertion' ? (
                  <DiffSegmentView key={i} seg={seg} />
                ) : null
              ))}
            </span>
          </div>

          {/* 识别文本 */}
          <div className="tv-sentence-line">
            <span className="tv-label">朗读→识别：</span>
            <span className="tv-diff-text">
              {sentence.diffSegments.map((seg, i) => (
                seg.type !== 'deletion' ? (
                  <DiffSegmentView key={i} seg={seg} />
                ) : null
              ))}
            </span>
          </div>

          {/* 差异摘要 */}
          <div className="tv-sentence-stats">
            <span>编辑距离：{sentence.editDistance}</span>
            <span>差异率：{diffRatePct}%</span>
            {sentence.suspicious && (
              <span className="tv-warning">⚠️ 可能存在吞词或断句错误</span>
            )}
          </div>

          {/* 操作按钮 */}
          {sentence.originalSentence && (
            <button
              className="tv-btn-read"
              onClick={(e) => { e.stopPropagation(); onPlaySentence(sentence.originalSentence) }}
              title="朗读此句"
            >
              <i className="ri-volume-up-fill" /> 朗读这句
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════
//  主组件
// ══════════════════════════════════════════

interface TypographyVerificationPanelProps {
  /** 排版后的完整文本（含样式标记） */
  text: string
  /** 是否正在校验 */
  verifying?: boolean
  /** 外部触发校验 */
  onStartVerify?: () => void
  /** 用户确认接受校验结果 */
  onAccept?: (report: VerificationReport) => void
  /** 用户拒绝校验结果，请求重新排版 */
  onReject?: (report: VerificationReport) => void
}

export function TypographyVerificationPanel({
  text,
  verifying: externalVerifying,
  onStartVerify,
  onAccept,
  onReject,
}: TypographyVerificationPanelProps) {
  const [report, setReport] = useState<VerificationReport | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [panelVisible, setPanelVisible] = useState(false)
  const [readingSentence, setReadingSentence] = useState<string | null>(null)

  const isVerifying = externalVerifying !== undefined ? externalVerifying : verifying

  // 执行校验
  const runVerification = useCallback(async () => {
    if (!text || text.length < 10) {
      setError('文本太短，无需校验')
      return
    }

    setVerifying(true)
    setError(null)
    onStartVerify?.()

    try {
      const result = await window.electronAPI.verifyTypography(text)
      if (result.success && result.report) {
        setReport(result.report)
        setPanelVisible(true)
      } else {
        setError(result.error || '校验失败')
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setVerifying(false)
    }
  }, [text, onStartVerify])

  // 朗读单句
  const playSentence = useCallback(async (sentenceText: string) => {
    setReadingSentence(sentenceText)
    try {
      await window.electronAPI.readAloudTypography(sentenceText)
    } catch (err) {
      console.error('朗读失败:', err)
    } finally {
      setReadingSentence(null)
    }
  }, [])

  // 接受校验结果
  const handleAccept = useCallback(() => {
    if (report && onAccept) {
      onAccept(report)
    }
    setPanelVisible(false)
  }, [report, onAccept])

  // 拒绝
  const handleReject = useCallback(() => {
    if (report && onReject) {
      onReject(report)
    }
    setPanelVisible(false)
  }, [report, onReject])

  // 重新校验
  const handleRerun = useCallback(() => {
    setReport(null)
    runVerification()
  }, [runVerification])

  // 收听全文
  const playFullAudio = useCallback(async () => {
    if (report?.audioFile) {
      // 复用 audioShared playTTS 的逻辑：通过 send tts:play_audio 已播放
      // 如果用户点"收听全文"，重新播放
      try {
        await window.electronAPI.speak(text)
      } catch (err) {
        console.error('全文朗读失败:', err)
      }
    }
  }, [report, text])

  // 关闭面板
  const dismiss = useCallback(() => {
    setPanelVisible(false)
  }, [])

  if (!panelVisible && !verifying && !error) {
    return (
      <div className="tv-trigger-bar">
        <button
          className="tv-btn-trigger"
          onClick={runVerification}
          disabled={isVerifying || !text || text.length < 10}
          title="通过 TTS+ASR 闭环校验排版内容"
        >
          {isVerifying ? (
            <><i className="ri-loader-4-line ri-spin" /> 校验中...</>
          ) : (
            <><i className="ri-voiceprint-line" /> 语音校验</>
          )}
        </button>
        {text && text.length >= 10 && (
          <button
            className="tv-btn-read"
            onClick={() => playSentence(text.slice(0, 200))}
            title="朗读全文预览"
          >
            <i className="ri-volume-up-line" /> 朗读这段
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="tv-panel">
      {/* 加载状态 */}
      {isVerifying && (
        <div className="tv-loading">
          <div className="tv-loading-spinner">
            <i className="ri-loader-4-line ri-spin" />
          </div>
          <div className="tv-loading-text">
            <p>正在执行语音校验...</p>
            <p className="tv-loading-step">1/3 合成语音 → 2/3 语音识别 → 3/3 对比分析</p>
          </div>
        </div>
      )}

      {/* 错误状态 */}
      {error && !isVerifying && (
        <div className="tv-error">
          <div className="tv-error-icon"><i className="ri-error-warning-fill" /></div>
          <p className="tv-error-text">{error}</p>
          <div className="tv-error-actions">
            <button className="tv-btn-secondary" onClick={() => setError(null)}>关闭</button>
            <button className="tv-btn-primary" onClick={runVerification}>重试</button>
          </div>
        </div>
      )}

      {/* 校验报告 */}
      {report && !isVerifying && (
        <div className="tv-report">
          {/* 面板头部 */}
          <div className="tv-report-header">
            <div className="tv-report-title">
              <i className="ri-voiceprint-line" /> 语音校验报告
            </div>
            <div className="tv-report-actions">
              <button className="tv-btn-icon" onClick={playFullAudio} title="收听全文">
                <i className="ri-headphone-line" />
              </button>
              <button className="tv-btn-icon" onClick={handleRerun} title="重新校验">
                <i className="ri-refresh-line" />
              </button>
              <button className="tv-btn-icon" onClick={dismiss} title="关闭">
                <i className="ri-close-line" />
              </button>
            </div>
          </div>

          {/* 摘要卡片 */}
          <div className={`tv-summary-card ${report.summary.hasDiscrepancies ? 'tv-summary-warn' : 'tv-summary-pass'}`}>
            <div className="tv-summary-icon">
              {report.summary.hasDiscrepancies ? '⚠️' : '✅'}
            </div>
            <div className="tv-summary-stats">
              <div className="tv-summary-stat">
                <span className="tv-summary-value">{report.summary.totalSentences}</span>
                <span className="tv-summary-label">总句数</span>
              </div>
              <div className="tv-summary-stat">
                <span className="tv-summary-value">{report.summary.suspiciousSentences}</span>
                <span className="tv-summary-label">可疑句</span>
              </div>
              <div className="tv-summary-stat">
                <span className="tv-summary-value">{(report.summary.totalDiffRate * 100).toFixed(1)}%</span>
                <span className="tv-summary-label">平均差异率</span>
              </div>
              <div className="tv-summary-stat">
                <span className="tv-summary-value">{report.summary.verificationMs > 1000
                  ? (report.summary.verificationMs / 1000).toFixed(1) + 's'
                  : report.summary.verificationMs + 'ms'}</span>
                <span className="tv-summary-label">耗时</span>
              </div>
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="tv-actions-bar">
            <span className="tv-action-hint">
              {report.summary.hasDiscrepancies
                ? '发现可能的问题，请审查下方差异'
                : '语音校验通过，未发现明显问题'}
            </span>
            <div className="tv-actions-right">
              {report.summary.hasDiscrepancies && onReject && (
                <button className="tv-btn-secondary" onClick={handleReject}>
                  返回修改
                </button>
              )}
              {onAccept && (
                <button className="tv-btn-primary" onClick={handleAccept}>
                  确认通过
                </button>
              )}
            </div>
          </div>

          {/* 逐句详情 */}
          <div className="tv-sentences">
            <div className="tv-sentences-title">
              <i className="ri-file-list-3-line" /> 逐句对比
            </div>
            {report.sentences.length === 0 && (
              <div className="tv-sentences-empty">文本过短，无法逐句对比</div>
            )}
            {report.sentences.map((sentence, idx) => (
              <SentenceRow
                key={idx}
                sentence={sentence}
                index={idx}
                onPlaySentence={playSentence}
              />
            ))}
          </div>

          {/* 完整文本对比 */}
          <div className="tv-full-compare">
            <div className="tv-compare-section">
              <div className="tv-compare-label">原文（去格式）</div>
              <div className="tv-compare-text">{report.plainText}</div>
            </div>
            <div className="tv-compare-section">
              <div className="tv-compare-label">朗读→识别</div>
              <div className="tv-compare-text">{report.recognizedText}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
