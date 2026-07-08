import { useState, useEffect, useCallback } from 'react'
import type { SettingsTabProps } from './types'
import { CRED_KEYS } from './credentialKeys'

interface VocabEntry {
  word: string
  count: number
  domain: string
  lastSeen: number
  firstSeen: number
}

interface DomainStat {
  label: string
  count: number
}

interface VocabState {
  words: VocabEntry[]
  domainStats: DomainStat[]
  totalWords: number
  enabled: boolean
}

export function SettingsVoiceTab({ values, onSetCredential }: SettingsTabProps) {
  const ttsMode = values[CRED_KEYS.TTS_MODE] || 'auto'

  // ── 词汇管理状态 ──
  const [vocab, setVocab] = useState<VocabState | null>(null)
  const [vocabLoading, setVocabLoading] = useState(false)
  const [vocabEnabled, setVocabEnabled] = useState(true)
  const [vocabMessage, setVocabMessage] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  const loadVocab = useCallback(async () => {
    setVocabLoading(true)
    try {
      const state = await window.electronAPI.getVocabState()
      setVocab(state)
      setVocabEnabled(state.enabled)
    } catch (err) {
      console.error('Failed to load vocabulary:', err)
    } finally {
      setVocabLoading(false)
    }
  }, [])

  useEffect(() => {
    loadVocab()
  }, [loadVocab])

  const handleToggleVocab = useCallback(
    async (enabled: boolean) => {
      try {
        const result = await window.electronAPI.toggleAsrHotwords(enabled)
        setVocabEnabled(result.enabled)
        setVocabMessage(enabled ? '词汇学习已启用' : '词汇学习已禁用')
        setTimeout(() => setVocabMessage(''), 2000)
      } catch (err) {
        console.error('Failed to toggle vocabulary:', err)
      }
    },
    [],
  )

  const handleDeleteWord = useCallback(
    async (word: string) => {
      try {
        const result = await window.electronAPI.deleteVocabWord(word)
        if (result.success) {
          setVocabMessage(`已删除词汇: ${word}`)
          setTimeout(() => setVocabMessage(''), 2000)
          loadVocab()
        }
      } catch (err) {
        console.error('Failed to delete word:', err)
      }
    },
    [loadVocab],
  )

  const handleClearAll = useCallback(async () => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    try {
      await window.electronAPI.clearVocabData()
      setVocabMessage('已清空所有已学习词汇')
      setConfirmClear(false)
      setTimeout(() => setVocabMessage(''), 2000)
      loadVocab()
    } catch (err) {
      console.error('Failed to clear vocabulary:', err)
    }
  }, [confirmClear, loadVocab])

  const handleRefreshContext = useCallback(async () => {
    try {
      await window.electronAPI.refreshVocabContext()
      setVocabMessage('ASR 上下文已刷新')
      setTimeout(() => setVocabMessage(''), 2000)
    } catch (err) {
      console.error('Failed to refresh context:', err)
    }
  }, [])

  const formatDate = (ts: number) => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }

  // ── 渲染 ──

  return (
    <>
      <div className="settings-section">
        <span className="settings-section-title">语音输出</span>
        <div className="settings-field">
          <span className="settings-label">TTS 模式</span>
          <div className="settings-toggle">
            <button
              type="button"
              className={`settings-toggle-btn${ttsMode === 'auto' ? ' active' : ''}`}
              onClick={() => onSetCredential(CRED_KEYS.TTS_MODE, 'auto')}
            >
              自动
            </button>
            <button
              type="button"
              className={`settings-toggle-btn${ttsMode === 'cloud' ? ' active' : ''}`}
              onClick={() => onSetCredential(CRED_KEYS.TTS_MODE, 'cloud')}
            >
              云端
            </button>
            <button
              type="button"
              className={`settings-toggle-btn${ttsMode === 'local' ? ' active' : ''}`}
              onClick={() => onSetCredential(CRED_KEYS.TTS_MODE, 'local')}
            >
              本地
            </button>
          </div>
          {ttsMode === 'auto' && (
            <span className="settings-help">根据网络状况和内容需求自动选择云端/本地引擎</span>
          )}
          {ttsMode === 'cloud' && (
            <span className="settings-help">始终使用云端 TTS（高表现力，需联网）</span>
          )}
          {ttsMode === 'local' && (
            <span className="settings-help">始终使用本地 Piper TTS（低延迟，可离线）</span>
          )}
        </div>
      </div>

      <div className="settings-section">
        <span className="settings-section-title">唤醒词</span>
        <label className="settings-field">
          <span className="settings-label">唤醒词（逗号分隔）</span>
          <input
            className="settings-input"
            type="text"
            value={values[CRED_KEYS.WAKE_WORDS] ?? ''}
            onChange={(e) => onSetCredential(CRED_KEYS.WAKE_WORDS, e.target.value)}
            placeholder="mio, 秋山澪"
          />
          <span className="settings-help">多个唤醒词用逗号分隔</span>
        </label>
      </div>

      <div className="settings-section">
        <span className="settings-section-title">语音识别</span>
        <label className="settings-field">
          <span className="settings-label">百度 ASR API Key</span>
          <input
            className="settings-input"
            type="password"
            value={values[CRED_KEYS.BAIDU_ASR_API_KEY] ?? ''}
            onChange={(e) => onSetCredential(CRED_KEYS.BAIDU_ASR_API_KEY, e.target.value)}
            placeholder="GPU ASR 加载失败时的备用方案"
          />
        </label>
        <label className="settings-field">
          <span className="settings-label">百度 ASR Secret Key</span>
          <input
            className="settings-input"
            type="password"
            value={values[CRED_KEYS.BAIDU_ASR_SECRET_KEY] ?? ''}
            onChange={(e) => onSetCredential(CRED_KEYS.BAIDU_ASR_SECRET_KEY, e.target.value)}
            placeholder="留空则使用环境变量 BAIDU_ASR_SECRET_KEY"
          />
        </label>
        <label className="settings-field">
          <span className="settings-label">ASR 热词（逗号分隔）</span>
          <input
            className="settings-input"
            type="text"
            value={values[CRED_KEYS.ASR_HOTWORDS] ?? ''}
            onChange={(e) => onSetCredential(CRED_KEYS.ASR_HOTWORDS, e.target.value)}
            placeholder="贝斯, 和弦, 旋律"
          />
          <span className="settings-help">热词会提升 ASR 对这些词汇的识别准确率</span>
        </label>
        <label className="settings-field">
          <span className="settings-label">初始提示词</span>
          <input
            className="settings-input"
            type="text"
            value={values[CRED_KEYS.ASR_INITIAL_PROMPT] ?? ''}
            onChange={(e) => onSetCredential(CRED_KEYS.ASR_INITIAL_PROMPT, e.target.value)}
            placeholder="以下是关于泵站设备、音乐练习的语音对话"
          />
        </label>
      </div>

      {/* ── 个性化词表管理 ── */}
      <div className="settings-section">
        <span className="settings-section-title">个性化词表管理</span>
        <span className="settings-help">
          系统会从你的对话中自动学习高频词汇，逐步提升语音识别准确率。
          已学习词汇跨会话持久保存，你可以随时查看和删除。
        </span>

        <div className="settings-field">
          <span className="settings-label">词汇学习</span>
          <div className="settings-toggle">
            <button
              type="button"
              className={`settings-toggle-btn${vocabEnabled ? ' active' : ''}`}
              onClick={() => handleToggleVocab(true)}
            >
              启用
            </button>
            <button
              type="button"
              className={`settings-toggle-btn${!vocabEnabled ? ' active' : ''}`}
              onClick={() => handleToggleVocab(false)}
            >
              禁用
            </button>
          </div>
        </div>

        {vocabMessage && (
          <div className="settings-message">{vocabMessage}</div>
        )}

        {vocabLoading && (
          <div className="settings-loading">加载中...</div>
        )}

        {vocab && (
          <>
            {/* 领域分布 */}
            {vocab.domainStats.length > 0 && (
              <div className="settings-domain-stats" style={{ margin: '8px 0' }}>
                <span className="settings-label" style={{ marginBottom: 4 }}>领域分布（共 {vocab.totalWords} 词）</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {vocab.domainStats.map((ds) => (
                    <span
                      key={ds.label}
                      className="settings-domain-tag"
                      style={{
                        padding: '2px 8px',
                        borderRadius: 10,
                        fontSize: 12,
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border-color)',
                      }}
                    >
                      {ds.label}: {ds.count}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 操作按钮 */}
            <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
              <button
                type="button"
                className="settings-action-btn"
                onClick={handleRefreshContext}
                style={{
                  padding: '4px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--border-color)',
                  background: 'var(--bg-secondary)',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                刷新上下文
              </button>
              {vocab.totalWords > 0 && (
                <button
                  type="button"
                  className="settings-action-btn settings-action-danger"
                  onClick={handleClearAll}
                  style={{
                    padding: '4px 12px',
                    borderRadius: 6,
                    border: '1px solid #e74c3c',
                    background: confirmClear ? '#e74c3c' : 'transparent',
                    color: confirmClear ? '#fff' : '#e74c3c',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  {confirmClear ? '确认清空？' : '清空所有'}
                </button>
              )}
            </div>
            {confirmClear && (
              <div
                className="settings-cancel-clear"
                onClick={() => setConfirmClear(false)}
                style={{ fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer', marginBottom: 4 }}
              >
                取消
              </div>
            )}

            {/* 词汇列表 */}
            {vocab.words.length > 0 ? (
              <div className="settings-vocab-list" style={{ maxHeight: 300, overflowY: 'auto', marginTop: 8 }}>
                {vocab.words.map((entry) => (
                  <div
                    key={entry.word}
                    className="settings-vocab-item"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '4px 8px',
                      borderBottom: '1px solid var(--border-color)',
                      fontSize: 13,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 500 }}>{entry.word}</span>
                      <span
                        className="settings-vocab-domain"
                        style={{
                          marginLeft: 6,
                          fontSize: 10,
                          padding: '1px 5px',
                          borderRadius: 8,
                          background: 'var(--bg-tertiary)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {entry.domain}
                      </span>
                      <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
                        {entry.count}次
                      </span>
                      <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text-muted)' }}>
                        {formatDate(entry.lastSeen)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="settings-vocab-delete"
                      onClick={() => handleDeleteWord(entry.word)}
                      style={{
                        border: 'none',
                        background: 'none',
                        cursor: 'pointer',
                        color: '#e74c3c',
                        fontSize: 16,
                        padding: '2px 6px',
                        lineHeight: 1,
                      }}
                      title="删除此词汇"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              vocab.totalWords > 0 ? null : (
                <div
                  className="settings-vocab-empty"
                  style={{
                    padding: '16px 0',
                    textAlign: 'center',
                    color: 'var(--text-secondary)',
                    fontSize: 13,
                  }}
                >
                  暂无已学习词汇。开始使用语音对话后，系统会自动学习高频词汇。
                </div>
              )
            )}
          </>
        )}
      </div>
    </>
  )
}
