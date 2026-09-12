import { useState, useEffect } from 'react'
import type { SettingsTabProps } from './types'
import { CRED_KEYS } from './credentialKeys'

export function SettingsSystemTab({ values, onSetCredential }: SettingsTabProps) {
  const safetyMode = values[CRED_KEYS.EVOLUTION_SAFETY_MODE] || 'review'
  const [workspaceRoots, setWorkspaceRoots] = useState<string[]>([])
  const [activeRoot, setActiveRoot] = useState('')

  const loadWorkspaceRoots = async () => {
    const res = await window.electronAPI.getProjectRoots?.()
    if (res) {
      setWorkspaceRoots(res.roots)
      setActiveRoot(res.active)
    }
  }

  useEffect(() => {
    loadWorkspaceRoots()
  }, [])

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

      <div className="settings-section">
        <span className="settings-section-title">项目工作区</span>
        <div className="settings-field">
          <span className="settings-label">已授权目录</span>
          <div className="settings-workspace-list">
            {workspaceRoots.length === 0 && <span className="settings-help">未授权任何目录，文件工具将使用默认 projects 目录</span>}
            {workspaceRoots.map((root) => (
              <div key={root} className="settings-workspace-item">
                <span className="settings-workspace-path" title={root}>
                  {root}
                </span>
                {root === activeRoot ? (
                  <span className="settings-workspace-active">当前</span>
                ) : (
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={async () => {
                      await window.electronAPI.setActiveProjectRoot?.(root)
                      loadWorkspaceRoots()
                    }}
                  >
                    设为当前
                  </button>
                )}
                <button
                  type="button"
                  className="settings-btn"
                  onClick={async () => {
                    await window.electronAPI.removeProjectRoot?.(root)
                    loadWorkspaceRoots()
                  }}
                >
                  撤销
                </button>
              </div>
            ))}
          </div>
          <span className="settings-help">授权后文件工具可在这些目录中读写；「设为当前」决定默认项目工作区。</span>
        </div>
        <div className="settings-field">
          <button
            type="button"
            className="settings-btn"
            onClick={async () => {
              const result = await window.electronAPI.selectProjectRootDialog?.()
              if (result) {
                await window.electronAPI.addProjectRoot?.(result)
                loadWorkspaceRoots()
              }
            }}
          >
            新增授权
          </button>
        </div>
      </div>
      <div className="settings-section">
        <span className="settings-section-title">Telegram</span>
        <div className="settings-field">
          <span className="settings-label">启用 Telegram</span>
          <div className="settings-toggle">
            <button
              type="button"
              className={`settings-toggle-btn${values[CRED_KEYS.TELEGRAM_ENABLED] === 'true' ? ' active' : ''}`}
              onClick={() => onSetCredential(CRED_KEYS.TELEGRAM_ENABLED, 'true')}
            >
              开启
            </button>
            <button
              type="button"
              className={`settings-toggle-btn${values[CRED_KEYS.TELEGRAM_ENABLED] !== 'true' ? ' active' : ''}`}
              onClick={() => onSetCredential(CRED_KEYS.TELEGRAM_ENABLED, 'false')}
            >
              禁用
            </button>
          </div>
          <span className="settings-help">默认禁用，开启后需配置下方代理地址（需重启生效）</span>
        </div>
        <div className="settings-field">
          <span className="settings-label">代理服务器地址</span>
          <input
            type="text"
            className="settings-input"
            placeholder="https://skills.crlkcloud.cyou/telegram"
            value={values[CRED_KEYS.TELEGRAM_SERVER_URL] || ''}
            onChange={(e) => onSetCredential(CRED_KEYS.TELEGRAM_SERVER_URL, e.target.value)}
          />
          <span className="settings-help">Telegram 代理服务器地址，留空使用默认值</span>
        </div>
        <div className="settings-field">
          <span className="settings-label">推送 Chat ID</span>
          <input
            type="text"
            className="settings-input"
            placeholder="例如 8878140402"
            value={values[CRED_KEYS.TELEGRAM_CHAT_ID] || ''}
            onChange={(e) => onSetCredential(CRED_KEYS.TELEGRAM_CHAT_ID, e.target.value)}
          />
          <span className="settings-help">设置后启用系统事件推送，留空关闭推送</span>
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
