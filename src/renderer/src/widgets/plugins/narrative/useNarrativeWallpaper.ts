/**
 * useNarrativeWallpaper — 语音叙事动态壁纸 Hook
 *
 * 通过 IPC 订阅 ASR 文本流，匹配关键词 → 切换场景 / 触发效果。
 * 管理场景状态机、去抖、防误触。
 *
 * 数据流：
 *   ASR 识别文本 → IPC 'narrative:asr-text' → 关键词匹配 → 场景切换/效果触发
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  SceneId,
  SceneKeywordEntry,
  ActionEffectEntry,
  SceneRuntimeState,
  EffectType,
  ActionEffectInstance,
} from './types'
import {
  DEFAULT_SCENE_KEYWORDS,
  DEFAULT_ACTION_EFFECTS,
  getSceneVisual,
} from './types'

// =============================================================================
// 常量
// =============================================================================

/** 匹配去抖间隔（ms）— 同一场景的重复匹配不触发 */
const MATCH_DEBOUNCE_MS = 5000

/** 默认场景过渡时长（ms） */
const DEFAULT_TRANSITION_MS = 800

/** 忽略文本中若仅含这些字符则不匹配 */
const IGNORE_PATTERN = /^[\s\p{P}\p{S}]{1,8}$/u

/** 连续叙事中默认场景切换后保持同一场景的最短时间（ms） */
const MIN_SCENE_DURATION_MS = 3000

// =============================================================================
// 类型
// =============================================================================

export interface UseNarrativeWallpaperOptions {
  /** 自定义关键词映射表（覆盖默认） */
  sceneKeywords?: SceneKeywordEntry[]
  /** 自定义动作效果映射表（覆盖默认） */
  actionEffects?: ActionEffectEntry[]
  /** 是否默认启用引擎 */
  enabled?: boolean
  /** 场景过渡默认时长（ms） */
  defaultTransitionMs?: number
}

export interface UseNarrativeWallpaperResult {
  /** 运行时状态 */
  state: SceneRuntimeState
  /** 引擎是否启用 */
  enabled: boolean
  /** 启用/禁用引擎 */
  setEnabled: (v: boolean) => void
  /** 手动触发场景切换 */
  triggerScene: (sceneId: SceneId, text?: string) => void
  /** 手动触发动作效果 */
  triggerAction: (effectType: EffectType, intensity?: number, durationMs?: number) => void
  /** 手动推送 ASR 文本（用于测试/调试） */
  feedText: (text: string) => void
}

// =============================================================================
// Hook
// =============================================================================

export function useNarrativeWallpaper(
  options?: UseNarrativeWallpaperOptions,
): UseNarrativeWallpaperResult {
  const {
    sceneKeywords = DEFAULT_SCENE_KEYWORDS,
    actionEffects = DEFAULT_ACTION_EFFECTS,
    enabled: initialEnabled = true,
    defaultTransitionMs = DEFAULT_TRANSITION_MS,
  } = options ?? {}

  // ── 状态 ──
  const [enabled, setEnabled] = useState(initialEnabled)
  const [state, setState] = useState<SceneRuntimeState>({
    currentScene: null,
    previousScene: null,
    activeEffects: [],
    activeActions: [],
    isTransitioning: false,
    transitionProgress: 1,
    sceneDurationMs: 0,
    matchedText: null,
    engineActive: false,
  })

  // ── Refs（避免闭包过期） ──
  const stateRef = useRef(state)
  stateRef.current = state

  const lastMatchRef = useRef<{ sceneId: SceneId; timestamp: number } | null>(null)
  const sceneStartRef = useRef(Date.now())
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const sceneKeywordsRef = useRef(sceneKeywords)
  sceneKeywordsRef.current = sceneKeywords

  const actionEffectsRef = useRef(actionEffects)
  actionEffectsRef.current = actionEffects

  // ── 去抖计时器 ──
  const debounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // ── 动作效果 ID 生成 ──
  const actionIdCounter = useRef(0)

  // ===========================================================================
  // 关键词匹配逻辑
  // ===========================================================================

  /**
   * 对 ASR 文本执行关键词匹配，返回匹配到的场景条目（按优先级排序）。
   */
  const matchKeywords = useCallback(
    (text: string): SceneKeywordEntry[] => {
      if (!text || text.trim().length === 0) return []
      const trimmed = text.trim()
      if (IGNORE_PATTERN.test(trimmed)) return []

      const matches: SceneKeywordEntry[] = []

      for (const entry of sceneKeywordsRef.current) {
        // 单关键词匹配
        const hasKeyword = entry.keywords.some((kw) => trimmed.includes(kw))

        // 复合匹配
        let hasCompound = true
        if (entry.compoundMatch && entry.compoundMatch.length > 0) {
          hasCompound = entry.compoundMatch.some((compoundGroup) =>
            compoundGroup.every((kw) => trimmed.includes(kw)),
          )
        }

        if (hasKeyword || hasCompound) {
          matches.push(entry)
        }
      }

      // 按优先级降序
      return matches.sort((a, b) => b.priority - a.priority)
    },
    [],
  )

  /**
   * 匹配动作效果关键词。
   */
  const matchActions = useCallback(
    (text: string): ActionEffectEntry[] => {
      if (!text || text.trim().length === 0) return []

      const matches: ActionEffectEntry[] = []

      for (const entry of actionEffectsRef.current) {
        const hasKeyword = entry.keywords.some((kw) => text.includes(kw))
        if (hasKeyword) {
          matches.push(entry)
        }
      }

      return matches
    },
    [],
  )

  // ===========================================================================
  // 状态更新
  // ===========================================================================

  /**
   * 切换到新场景。
   */
  const triggerScene = useCallback(
    (sceneId: SceneId, text?: string) => {
      const prev = stateRef.current
      if (prev.currentScene === sceneId) {
        // 相同场景，不重复切换
        return
      }

      const visual = getSceneVisual(sceneId)
      const transitionMs = visual ? DEFAULT_TRANSITION_MS : defaultTransitionMs

      setState((s) => ({
        ...s,
        currentScene: sceneId,
        previousScene: s.currentScene,
        isTransitioning: true,
        transitionProgress: 0,
        sceneDurationMs: 0,
        matchedText: text ?? null,
        activeEffects: [],
        activeActions: [],
        engineActive: true,
      }))

      sceneStartRef.current = Date.now()
      lastMatchRef.current = { sceneId, timestamp: Date.now() }
    },
    [defaultTransitionMs],
  )

  /**
   * 触发瞬时动作效果。
   */
  const triggerAction = useCallback(
    (effectType: EffectType, intensity = 0.8, durationMs = 3000) => {
      const id = `action_${++actionIdCounter.current}`
      const action: ActionEffectInstance = {
        id,
        type: effectType,
        startTime: Date.now(),
        durationMs,
        intensity,
      }

      setState((s) => ({
        ...s,
        activeActions: [...s.activeActions, action],
        activeEffects: s.activeEffects.includes(effectType)
          ? s.activeEffects
          : [...s.activeEffects, effectType],
      }))

      // 定时清理
      setTimeout(() => {
        setState((s) => ({
          ...s,
          activeActions: s.activeActions.filter((a) => a.id !== id),
          activeEffects: s.activeEffects.filter(
            (e) =>
              e !== effectType ||
              s.activeActions.some((a) => a.type === e && a.id !== id),
          ),
        }))
      }, durationMs)
    },
    [],
  )

  /**
   * 处理 ASR 文本：关键词匹配 → 场景切换 / 效果触发。
   */
  const processText = useCallback(
    (text: string) => {
      if (!enabledRef.current) return
      if (!text || text.trim().length === 0) return

      const trimmed = text.trim()
      if (IGNORE_PATTERN.test(trimmed)) return

      // ── 匹配场景关键词 ──
      const sceneMatches = matchKeywords(trimmed)
      if (sceneMatches.length > 0) {
        const bestMatch = sceneMatches[0]
        const now = Date.now()
        const lastMatch = lastMatchRef.current

        // 去重：同一场景在去抖时间内不重复触发
        const isDuplicate =
          lastMatch &&
          lastMatch.sceneId === bestMatch.sceneId &&
          now - lastMatch.timestamp < MATCH_DEBOUNCE_MS

        // 最小场景持续时长检查
        const tooSoon =
          stateRef.current.currentScene !== null &&
          now - sceneStartRef.current < MIN_SCENE_DURATION_MS

        if (!isDuplicate && !tooSoon) {
          triggerScene(bestMatch.sceneId, trimmed)
        }
      }

      // ── 匹配动作效果关键词 ──
      const actionMatches = matchActions(trimmed)
      for (const action of actionMatches) {
        // 动作效果去抖：每个关键词组去抖
        const key = action.keywords[0] ?? Math.random().toString()
        const existingTimer = debounceTimersRef.current.get(key)
        if (existingTimer) continue

        for (const effect of action.effects) {
          triggerAction(effect, action.intensity, action.durationMs)
        }

        // 设置去抖
        const timer = setTimeout(() => {
          debounceTimersRef.current.delete(key)
        }, MATCH_DEBOUNCE_MS)
        debounceTimersRef.current.set(key, timer)
      }
    },
    [matchKeywords, matchActions, triggerScene, triggerAction],
  )

  // ===========================================================================
  // IPC 订阅
  // ===========================================================================

  useEffect(() => {
    if (!window.electronAPI?.onNarrativeAsrText) return

    const unsub = window.electronAPI.onNarrativeAsrText((payload) => {
      if (payload?.text) {
        processText(payload.text)
      }
    })

    return () => {
      unsub()
    }
  }, [processText])

  // ===========================================================================
  // 过渡进度更新定时器
  // ===========================================================================

  useEffect(() => {
    if (!state.isTransitioning) return

    const startTime = Date.now()
    const duration = defaultTransitionMs

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime
      const progress = Math.min(1, elapsed / duration)

      setState((s) => {
        if (!s.isTransitioning) return s
        return {
          ...s,
          transitionProgress: progress,
          isTransitioning: progress < 1,
        }
      })
    }, 16) // ~60fps

    return () => clearInterval(interval)
  }, [state.isTransitioning, defaultTransitionMs])

  // ===========================================================================
  // 场景持续时间更新
  // ===========================================================================

  useEffect(() => {
    if (!state.currentScene) return

    const interval = setInterval(() => {
      setState((s) => ({
        ...s,
        sceneDurationMs: s.currentScene ? Date.now() - sceneStartRef.current : 0,
      }))
    }, 1000)

    return () => clearInterval(interval)
  }, [state.currentScene])

  // ===========================================================================
  // 清理
  // ===========================================================================

  useEffect(() => {
    return () => {
      // 清理所有去抖计时器
      for (const [, timer] of debounceTimersRef.current) {
        clearTimeout(timer)
      }
      debounceTimersRef.current.clear()
    }
  }, [])

  // ===========================================================================
  // 公开方法
  // ===========================================================================

  const feedText = useCallback(
    (text: string) => {
      processText(text)
    },
    [processText],
  )

  return {
    state,
    enabled,
    setEnabled,
    triggerScene,
    triggerAction,
    feedText,
  }
}
