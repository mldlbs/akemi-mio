import { useState } from 'react'
import type { SettingsTabProps } from './types'
import { CRED_KEYS } from './credentialKeys'

export function SettingsSystemTab({ values, onSetCredential }: SettingsTabProps) {
  const safetyMode = values[CRED_KEYS.EVOLUTION_SAFETY_MODE] || 'review'

  return (
    <>
      <div className="settings-section">
        <span className="settings-section-title">更新</span>
        <div className="settings-field">
          <span className="settings-label">版本更新</span>
          <UpdateChecker />
        </div>
      </div>

      <div className="settings-section">
        <span className="settings-section-title">进化</span>
        <div className="settings-field">
          <span className="settings-label">进化安全模式</span>
          <div className="settings-toggle">
            <button
              type="button"
              className={`settings-toggle-btn${safetyMode === 'review' ? ' active' : ''}`}
              onClick={() => onSetCredential(CRED_KEYS.EVOLUTION_SAFETY_MODE, 'review')}
            >
              审查（安全）
            </button>
            <button
              type="button"
              className={`settings-toggle-btn${safetyMode === 'auto' ? ' active' : ''}`}
              onClick={() => onSetCredential(CRED_KEYS.EVOLUTION_SAFETY_MODE, 'auto')}
            >
              自动
            </button>
          </div>
          <span className="settings-help">审查模式下进化仅生成计划不会自动执行</span>
        </div>
      </div>
    </>
  )
}

function UpdateChecker() {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<{ available: boolean; version?: string } | null>(null)

  const handleCheck = async () => {
    setChecking(true)
    setResult(null)
    try {
      const res = await window.electronAPI.checkUpdate()
      setResult(res)
    } catch {
      setResult({ available: false })
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="settings-update-row">
      <button type="button" className="settings-btn" onClick={handleCheck} disabled={checking}>
        {checking ? '检查中...' : '检查更新'}
      </button>
      {result && (
        <span className={`settings-badge settings-badge-${result.available ? 'warn' : 'ok'}`}>
          {result.available ? `有新版本 ${result.version}` : '已是最新版本'}
        </span>
      )}
    </div>
  )
}
