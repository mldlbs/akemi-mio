import type { SettingsTabProps } from './types'
import { CRED_KEYS } from './credentialKeys'

export function SettingsVoiceTab({ values, onSetCredential }: SettingsTabProps) {
  const ttsMode = values[CRED_KEYS.TTS_MODE] || 'cloud'

  return (
    <>
      <div className="settings-section">
        <span className="settings-section-title">语音输出</span>
        <div className="settings-field">
          <span className="settings-label">TTS 模式</span>
          <div className="settings-toggle">
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
    </>
  )
}
