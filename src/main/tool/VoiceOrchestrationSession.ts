/**
 * Bridge re-export — VoiceConfirmationSession
 * The canonical implementation lives in VoiceConfirmationSession.ts.
 * This file exists for import path compatibility only.
 */
export { VoiceConfirmationSession, voiceConfirmationSession } from './VoiceConfirmationSession'
export type {
  ConfirmSessionState,
  ConfirmResponse,
  ConfirmSessionEvent,
  ConfirmSessionListener,
  ConfirmSessionConfig,
} from './VoiceConfirmationSession'
