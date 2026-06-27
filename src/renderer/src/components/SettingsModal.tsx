import { useState, useEffect, useCallback, type FormEvent } from 'react'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

const SETTINGS_FIELDS = [
  { key: 'llm_key', label: 'LLM API Key', type: 'password', placeholder: 'sk-...' },
  { key: 'llm_api_url', label: 'API URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
  { key: 'llm_chat_model', label: '聊天模型', type: 'text', placeholder: 'gpt-4o' },
] as const

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [ttsMode, setTtsMode] = useState('cloud')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setMessage(null)
    Promise.all(
      SETTINGS_FIELDS.map(async (f) => {
        const v = await window.electronAPI.getCredential(f.key)
        return [f.key, v ?? ''] as const
      }),
    ).then((entries) => {
      setValues(Object.fromEntries(entries))
    })
    window.electronAPI.getCredential('tts_mode').then((v) => {
      if (v === 'local' || v === 'cloud') setTtsMode(v)
    })
  }, [open])

  const handleSave = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      for (const [key, val] of Object.entries(values)) {
        await window.electronAPI.setCredential(key, val)
      }
      await window.electronAPI.setCredential('tts_mode', ttsMode)
      setMessage({ type: 'ok', text: '已保存' })
    } catch (err) {
      setMessage({ type: 'error', text: String(err) })
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )

  return (
    <div className="settings-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">设置</span>
          <button className="settings-close" onClick={onClose}>
            <i className="ri-close-line" />
          </button>
        </div>

        <form className="settings-body" onSubmit={handleSave}>
          {SETTINGS_FIELDS.map((f) => (
            <label key={f.key} className="settings-field">
              <span className="settings-label">{f.label}</span>
              <input
                className="settings-input"
                type={f.type}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
              />
            </label>
          ))}

          <div className="settings-field">
            <span className="settings-label">TTS 模式</span>
            <div className="settings-toggle">
              <button
                type="button"
                className={`settings-toggle-btn${ttsMode === 'cloud' ? ' active' : ''}`}
                onClick={() => setTtsMode('cloud')}
              >
                云端
              </button>
              <button
                type="button"
                className={`settings-toggle-btn${ttsMode === 'local' ? ' active' : ''}`}
                onClick={() => setTtsMode('local')}
              >
                本地
              </button>
            </div>
          </div>

          {message && <div className={`settings-message settings-${message.type}`}>{message.text}</div>}

          <div className="settings-actions">
            <button type="submit" className="settings-save" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
