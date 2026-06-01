export interface AsrResult { text: string; duration: number; raw?: string; hits?: HotwordHit[] }
export type ProgressCallback = (pct: number, status: string) => void
export interface HotwordHit { hotword: string; count: number }
