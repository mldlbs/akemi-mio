import type { AgentService } from '@akemi-mio/intelligence/agent/AgentService'
import type { StateManager } from '@akemi-mio/core/core/StateManager'
import type { TtsService } from '@akemi-mio/audio/TtsService'
import type { SelfEvolutionService } from '@akemi-mio/evolution'
import type { MetricsCollector } from '@akemi-mio/intelligence/observability/MetricsCollector'
import type {
  EvolutionDashboardService,
  MemoryContextService,
  ConversationContextService,
  FileOrganizerProgressService,
} from '@akemi-mio/platform/wallpaper/WallpaperService'
import type { GuardrailMetricsQueryService } from '@akemi-mio/core/core/evaluation/GuardrailMetricsQueryService'
import type { VoiceBookmarkService } from '@akemi-mio/intelligence-memory/VoiceBookmarkService'
import type { TaskPanelService } from '@akemi-mio/platform/wallpaper/TaskPanelService'
import type { WallpaperInteractiveService } from '@akemi-mio/platform/wallpaper/WallpaperInteractiveService'
import type { VoiceNoteService } from '@akemi-mio/voicenote/VoiceNoteService'

export interface HandlerContext {
  agentService: AgentService
  stateManager: StateManager
  ttsService: TtsService
  evolutionRef?: { current: SelfEvolutionService | null }
  metricsCollector?: MetricsCollector
  dashboardRef?: { current: EvolutionDashboardService | null }
  memoryContextRef?: { current: MemoryContextService | null }
  metricsQueryRef?: { current: GuardrailMetricsQueryService | null }
  organizerRef?: { current: FileOrganizerProgressService | null }
  voiceBookmarkRef?: { current: VoiceBookmarkService | null }
  taskPanelRef?: { current: TaskPanelService | null }
  wallpaperInteractiveRef?: { current: WallpaperInteractiveService | null }
  conversationContextRef?: { current: ConversationContextService | null }
  voiceNoteRef?: { current: VoiceNoteService | null }
}
