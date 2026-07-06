import { useState, useCallback } from 'react'
import { useSettings } from '../settings/useSettings'
import { SettingsLLMTab } from '../settings/SettingsLLMTab'
import { SettingsVoiceTab } from '../settings/SettingsVoiceTab'
import { SettingsAppearanceTab } from '../settings/SettingsAppearanceTab'
import { SettingsSystemTab } from '../settings/SettingsSystemTab'
import { useDeviceStore } from '../store/deviceStore'

export type SettingsTab = 'llm' | 'voice' | 'appearance' | 'system'

const TABS: { id: SettingsTab; icon: string; label: string }[] = [
  { id: 'llm', icon: 'ri-key-2-line', label: 'LLM' },
  { id: 'voice', icon: 'ri-voiceprint-line', label: '语音' },
  { id: 'appearance', icon: 'ri-palette-line', label: '外观' },
  { id: 'system', icon: 'ri-computer-line', label: '系统' },
]

export function SettingsModal() {
  const open = useDeviceStore((s) => s.settingsOpen)
  const onClose = useCallback(() => useDeviceStore.getState().setSettingsOpen(false), [])

  const [activeTab, setActiveTab] = useState<SettingsTab>('llm')
  const { values, setAndSave, saving, lastSaved } = useSettings(open)

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // do nothing — 仅关闭按钮可关闭
  }, [])

  if (!open) return null

  return (
    <div className="settings-overlay" onKeyDown={handleKeyDown}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">设置</span>
          <button className="settings-close" onClick={onClose}>
            <i className="ri-close-line" />
          </button>
        </div>

        <div className="settings-tab-bar">
          {TABS.map((tab) => (
            <button key={tab.id} className={`settings-tab${activeTab === tab.id ? ' active' : ''}`} onClick={() => setActiveTab(tab.id)}>
              <i className={tab.icon} />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="settings-tab-panel">
          {activeTab === 'llm' && <SettingsLLMTab values={values} onSetCredential={setAndSave} />}
          {activeTab === 'voice' && <SettingsVoiceTab values={values} onSetCredential={setAndSave} />}
          {activeTab === 'appearance' && <SettingsAppearanceTab />}
          {activeTab === 'system' && <SettingsSystemTab values={values} onSetCredential={setAndSave} />}
        </div>

        <div className="settings-footer">
          {saving && (
            <span className="settings-saving-indicator">
              <i className="ri-loader-2-line ri-spin" /> 保存中...
            </span>
          )}
          {lastSaved && !saving && (
            <span className="settings-saved-indicator">
              <i className="ri-check-line" /> 已保存
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
