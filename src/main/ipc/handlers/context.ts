import type { AgentService } from '../../agent/AgentService'
import type { StateManager } from '../../core/StateManager'
import type { TtsService } from '../../tts/TtsService'
import type { SelfEvolutionService } from '../../evolution'
import type { MetricsCollector } from '../../observability/MetricsCollector'
import type { EvolutionDashboardService, MemoryContextService, ConversationContextService, FileOrganizerProgressService } from '../../wallpaper/WallpaperService'
import type { DecisionQueryService } from '../../core/evaluation/DecisionQueryService'
import type { GuardrailMetricsQueryService } from '../../core/evaluation/GuardrailMetricsQueryService'
import type { VoiceBookmarkService } from '../../memory/VoiceBookmarkService'
import type { TaskPanelService } from '../../wallpaper/TaskPanelService'
import type { WallpaperInteractiveService } from '../../wallpaper/WallpaperInteractiveService'
import type { RuntimeRestoreService } from '../../runtime/RuntimeRestoreService'
import type { VoiceNoteService } from '../../voicenote/VoiceNoteService'

export interface HandlerContext {
  agentService: AgentService
  stateManager: StateManager
  ttsService: TtsService
  evolutionRef?: { current: SelfEvolutionService | null }
  metricsCollector?: MetricsCollector
  dashboardRef?: { current: EvolutionDashboardService | null }
  memoryContextRef?: { current: MemoryContextService | null }
  decisionQueryRef?: { current: DecisionQueryService | null }
  metricsQueryRef?: { current: GuardrailMetricsQueryService | null }
  organizerRef?: { current: FileOrganizerProgressService | null }
  voiceBookmarkRef?: { current: VoiceBookmarkService | null }
  taskPanelRef?: { current: TaskPanelService | null }
  wallpaperInteractiveRef?: { current: WallpaperInteractiveService | null }
  restoreRef?: { current: RuntimeRestoreService | null }
  conversationContextRef?: { current: ConversationContextService | null }
  voiceNoteRef?: { current: VoiceNoteService | null }
}
