export interface SettingsTabProps {
  values: Record<string, string>
  onSetCredential: (key: string, value: string) => void
}
