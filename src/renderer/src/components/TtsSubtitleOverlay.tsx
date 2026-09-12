import { useState, useEffect, useRef } from 'react'

// =============================================================================
// TtsSubtitleOverlay — TTS 语音实时字幕覆层
// =============================================================================
//
// 在桌面壁纸底部区域显示 PiperTTS 正在合成的语音字幕，
// 实现听看双重反馈。
//
// 特性：
//   - 每个句子渐显后停留，再渐隐消失，模拟自然阅读节奏
//   - 多句同时显示时自动堆叠（最多 3 行）
//   - 鼠标穿透（pointer-events: none），不干扰桌面操作
//   - 字体、大小、透明度通过 CSS 变量自定义
//   - 可通过系统托盘切换显示开关
//
// =============================================================================

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

interface SubtitleItem {
  /** 字幕文本 */
  text: string
  /** 估计持续时间（毫秒） */
  estimatedDurationMs: number
  /** 唯一 ID */
  id: string
  /** 开始时间戳 */
  startTime: number
  /** 动画状态 */
  state: 'entering' | 'visible' | 'exiting' | 'removed'
}

/** 最大同时显示的颜文字句数 */
const MAX_VISIBLE_SUBTITLES = 3

/** 淡入/淡出动画持续时间（毫秒） */
const FADE_DURATION_MS = 300

/** 额外留存缓冲（ms）：在 estimatedDurationMs 基础上额外保留一点时间再淡出 */
const EXTRA_HOLD_MS = 400

// ══════════════════════════════════════════
//  TtsSubtitleOverlay 组件
// ══════════════════════════════════════════

export function TtsSubtitleOverlay() {
  const [subtitles, setSubtitles] = useState<SubtitleItem[]>([])
  const [enabled, setEnabled] = useState(true)
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // ── 首次加载时获取启用状态 ──
  useEffect(() => {
    window.electronAPI.getSubtitleEnabled().then((res) => {
      setEnabled(res.enabled)
    })
  }, [])

  // ── 订阅主进程字幕切换事件（来自系统托盘） ──
  useEffect(() => {
    const unsub = window.electronAPI.onSubtitleToggle((data) => {
      setEnabled(data.enabled)
    })
    return unsub
  }, [])

  // ── 订阅主进程字幕事件 ──
  useEffect(() => {
    const unsub = window.electronAPI.onTtsSubtitle((data) => {
      if (!enabled) return

      const item: SubtitleItem = {
        text: data.text,
        estimatedDurationMs: data.estimatedDurationMs,
        id: data.id,
        startTime: data.startTime,
        state: 'entering',
      }

      setSubtitles((prev) => {
        // 保留最近 N 条字幕，新字幕插入队尾
        const updated = [...prev, item]
        if (updated.length > MAX_VISIBLE_SUBTITLES * 2) {
          // 清理已经移除的字幕，保持列表不无限增长
          return updated.filter((s) => s.state !== 'removed')
        }
        return updated
      })
    })
    return unsub
  }, [enabled])

  // ── 字幕生命周期管理 ──
  useEffect(() => {
    if (!enabled) return

    for (const sub of subtitles) {
      if (sub.state === 'entering' && !timersRef.current.has(sub.id)) {
        // entering → visible：淡入动画后标记为可见
        const timer = setTimeout(() => {
          setSubtitles((prev) => prev.map((s) => (s.id === sub.id ? { ...s, state: 'visible' as const } : s)))
        }, FADE_DURATION_MS)
        timersRef.current.set(sub.id, timer)
      } else if (sub.state === 'visible' && !timersRef.current.has(sub.id + '_exit')) {
        // visible → exiting：显示 estimatedDurationMs 后开始淡出
        const displayDuration = Math.max(500, sub.estimatedDurationMs + EXTRA_HOLD_MS - FADE_DURATION_MS)
        const timer = setTimeout(() => {
          setSubtitles((prev) => prev.map((s) => (s.id === sub.id ? { ...s, state: 'exiting' as const } : s)))
        }, displayDuration)
        timersRef.current.set(sub.id + '_exit', timer)
      } else if (sub.state === 'exiting' && !timersRef.current.has(sub.id + '_remove')) {
        // exiting → removed：淡出动画后移除
        const timer = setTimeout(() => {
          setSubtitles((prev) => prev.map((s) => (s.id === sub.id ? { ...s, state: 'removed' as const } : s)))
          // 清理定时器引用
          timersRef.current.delete(sub.id + '_remove')
          timersRef.current.delete(sub.id + '_exit')
          timersRef.current.delete(sub.id)
        }, FADE_DURATION_MS)
        timersRef.current.set(sub.id + '_remove', timer)
      }
    }
  }, [subtitles, enabled])

  // ── 清理定时器 ──
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer)
      }
      timersRef.current.clear()
    }
  }, [])

  // ── 监听启用状态变化，同步到主进程 ──
  // 注意：enabled 从主进程读取，这里不写回

  // ── 计算可见的字幕（只取最近 3 条未移除的） ──
  const visibleSubtitles = subtitles.filter((s) => s.state !== 'removed').slice(-MAX_VISIBLE_SUBTITLES)

  if (!enabled) return null
  if (visibleSubtitles.length === 0) return null

  return (
    <div className="wp-tts-subtitle-overlay">
      {visibleSubtitles.map((sub, index) => {
        const isEntering = sub.state === 'entering'
        const isExiting = sub.state === 'exiting'
        const opacity = isEntering ? 0 : isExiting ? 0 : 1

        return (
          <div
            key={sub.id}
            className={`wp-tts-subtitle-line ${isEntering ? 'wp-tts-subtitle-in' : ''} ${isExiting ? 'wp-tts-subtitle-out' : ''}`}
            style={{
              opacity,
              transition: `opacity ${FADE_DURATION_MS}ms ease`,
              // 堆叠偏移：越新的字幕越靠上（index=0 是最老的在底部）
              transform: `translateY(${-index * 4}px)`,
            }}
            title={sub.text}
          >
            <span className="wp-tts-subtitle-text">{sub.text}</span>
          </div>
        )
      })}
    </div>
  )
}
