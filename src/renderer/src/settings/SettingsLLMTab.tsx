import type { SettingsTabProps } from './types'
import { CRED_KEYS } from './credentialKeys'

const LLM_SECTIONS: {
  title: string
  fields: { key: string; label: string; type?: string; placeholder?: string }[]
}[] = [
  {
    title: '对话模型',
    fields: [
      { key: CRED_KEYS.LLM_API_URL, label: 'API URL', placeholder: 'https://api.openai.com/v1' },
      { key: CRED_KEYS.LLM_CHAT_MODEL, label: '模型', placeholder: 'gpt-4o' },
      { key: CRED_KEYS.LLM_KEY, label: 'API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  {
    title: '代码模型',
    fields: [
      { key: CRED_KEYS.LLM_CODE_API_URL, label: 'API URL', placeholder: 'https://api.deepseek.com/v1' },
      { key: CRED_KEYS.LLM_CODE_MODEL, label: '模型', placeholder: 'deepseek-v4-flash' },
    ],
  },
]

export function SettingsLLMTab({ values, onSetCredential }: SettingsTabProps) {
  return (
    <>
      {LLM_SECTIONS.map((section) => (
        <div key={section.title} className="settings-section">
          <span className="settings-section-title">{section.title}</span>
          {section.fields.map((f) => (
            <label key={f.key} className="settings-field">
              <span className="settings-label">{f.label}</span>
              <input
                className="settings-input"
                type={f.type ?? 'text'}
                value={values[f.key] ?? ''}
                onChange={(e) => onSetCredential(f.key, e.target.value)}
                placeholder={f.placeholder}
              />
            </label>
          ))}
        </div>
      ))}
    </>
  )
}
