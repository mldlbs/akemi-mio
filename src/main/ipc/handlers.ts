import { ipcMain, BrowserWindow } from 'electron'
import { eventBus } from '../core/EventBus'
import { log } from '../logger/Logger'
import { AgentService } from '../agent/AgentService'
import { StateManager } from '../core/StateManager'
import { TtsService } from '../tts/TtsService'
import { SelfEvolutionService } from '../evolution'
import { EvolutionDashboardService, MemoryContextService, ConversationContextService, FileOrganizerProgressService } from '../wallpaper/WallpaperService'
import { MetricsCollector } from '../observability/MetricsCollector'
import type { DecisionQueryService } from '../core/evaluation/DecisionQueryService'
import type { GuardrailMetricsQueryService } from '../core/evaluation/GuardrailMetricsQueryService'
import type { VoiceBookmarkService } from '../memory/VoiceBookmarkService'
import type { TaskPanelService } from '../wallpaper/TaskPanelService'
import type { WallpaperInteractiveService } from '../wallpaper/WallpaperInteractiveService'
import type { RuntimeRestoreService } from '../runtime/RuntimeRestoreService'
import type { VoiceNoteService } from '../voicenote/VoiceNoteService'
import { existsSync } from 'fs'
import type { HandlerContext } from './handlers/context'
import { registerWindowHandlers } from './handlers/window'
import { registerAgentHandlers } from './handlers/agent'
import { registerAsrHandlers } from './handlers/asr'
import { registerTtsHandlers } from './handlers/tts'
import { registerLearningHandlers } from './handlers/learning'
import { registerEvolutionHandlers } from './handlers/evolution'
import { registerCredentialsHandlers } from './handlers/credentials'
import { registerHealthHandlers } from './handlers/health'
import { registerMessagesHandlers } from './handlers/messages'
import { registerWorkflowHandlers } from './handlers/workflow'
import { registerDesktopHandlers } from './handlers/desktop'
import { registerWritingHandlers } from './handlers/writing'
import { registerWallpaperHandlers } from './handlers/wallpaper'
import { registerTypingHandlers } from './handlers/typing'
import { registerQuickTaskHandlers } from './handlers/quicktask'
import { registerVoiceBookmarkHandlers } from './handlers/voice-bookmark'
import { registerToolHandlers } from './handlers/tool'
import { registerEvaluationHandlers } from './handlers/evaluation'
import { registerMemoryHandlers } from './handlers/memory'
import { registerVoiceNoteHandlers } from './handlers/voicenote'

const sandboxWindows = new Map<string, BrowserWindow>()

function openSandboxWindow(name: string, htmlPath: string): void {
  const existing = sandboxWindows.get(name)
  if (existing && !existing.isDestroyed()) { existing.focus(); return }
  if (!existsSync(htmlPath)) { log('WARN', 'sandbox_html_not_found', { name, htmlPath }); return }
  const win = new BrowserWindow({
    width: 960, height: 720, title: '星尘流韵 — Astral Flow',
    webPreferences: { contextIsolation: true, nodeIntegration: false, webSecurity: true },
  })
  win.loadFile(htmlPath)
  sandboxWindows.set(name, win)
  win.on('closed', () => sandboxWindows.delete(name))
}

export interface ServiceRef<T> { current: T | null }
export function createServiceRef<T>(): ServiceRef<T> { return { current: null } }

export function registerHandlers(
  agentService: AgentService,
  stateManager: StateManager,
  ttsService: TtsService,
  evolutionRef?: { current: SelfEvolutionService | null },
  pipelineRef?: { current: import('../evolution/automation').PipelineOrchestrator | null },
  metricsCollector?: MetricsCollector,
  dashboardRef?: { current: EvolutionDashboardService | null },
  memoryContextRef?: { current: MemoryContextService | null },
  decisionQueryRef?: { current: DecisionQueryService | null },
  metricsQueryRef?: { current: GuardrailMetricsQueryService | null },
  organizerRef?: { current: FileOrganizerProgressService | null },
  voiceBookmarkRef?: { current: VoiceBookmarkService | null },
  taskPanelRef?: { current: TaskPanelService | null },
  wallpaperInteractiveRef?: { current: WallpaperInteractiveService | null },
  restoreRef?: { current: RuntimeRestoreService | null },
  conversationContextRef?: { current: ConversationContextService | null },
  voiceNoteRef?: { current: VoiceNoteService | null },
): void {
  const ctx: HandlerContext = {
    agentService, stateManager, ttsService, evolutionRef, pipelineRef, metricsCollector,
    dashboardRef, memoryContextRef, decisionQueryRef, metricsQueryRef,
    organizerRef, voiceBookmarkRef, taskPanelRef, wallpaperInteractiveRef,
    restoreRef, conversationContextRef, voiceNoteRef,
  }

  // Window handlers require eventBus — inject it
  registerWindowHandlers({ ...ctx, eventBus })
  registerAgentHandlers(ctx)
  registerAsrHandlers(ctx)
  registerTtsHandlers(ctx)
  registerLearningHandlers(ctx)
  registerEvolutionHandlers(ctx)
  registerCredentialsHandlers(ctx)
  registerHealthHandlers(ctx)
  registerMessagesHandlers(ctx)
  registerWorkflowHandlers(ctx)
  registerDesktopHandlers(ctx)
  registerWritingHandlers(ctx)
  registerWallpaperHandlers(ctx)
  registerTypingHandlers(ctx)
  registerQuickTaskHandlers(ctx)
  registerVoiceBookmarkHandlers(ctx)
  registerToolHandlers(ctx)
  registerEvaluationHandlers(ctx)
  registerMemoryHandlers(ctx)
  registerVoiceNoteHandlers(ctx)
}
