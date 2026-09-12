import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const workspaceRoot = process.cwd()
const appRuntimePath = join(workspaceRoot, 'packages', 'main', 'src', 'bootstrap', 'AppRuntime.ts')

describe('AppRuntime lazy service wiring', () => {
  it('registers IPC handlers before the renderer window starts loading', () => {
    const source = readFileSync(appRuntimePath, 'utf8')
    const registerHandlersIndex = source.indexOf('registerHandlers(')
    const createWindowIndex = source.indexOf('const win = createWindow(stateManager)')

    expect(registerHandlersIndex).toBeGreaterThanOrEqual(0)
    expect(createWindowIndex).toBeGreaterThanOrEqual(0)
    expect(registerHandlersIndex).toBeLessThan(createWindowIndex)
  })

  it('passes service refs required by lazy services into registerLazyServices', () => {
    const source = readFileSync(appRuntimePath, 'utf8')

    expect(source).toMatch(/const pipelineRef = createServiceRef<PipelineOrchestrator>\(\)/)
    expect(source).toMatch(/const taskPanelRef = createServiceRef<TaskPanelService>\(\)/)
    expect(source).toMatch(/const wallpaperInteractiveRef = createServiceRef<WallpaperInteractiveService>\(\)/)

    expect(source).toMatch(
      /this\.registerLazyServices\(\s*agentService,\s*llmService,\s*memoryService,\s*memoryIndexer,\s*stateManager,\s*planManager,\s*cognitiveService,\s*evolutionRef,\s*dashboardRef,\s*pipelineRef,\s*taskPanelRef,\s*wallpaperInteractiveRef,\s*\)/s,
    )

    expect(source).toMatch(
      /private registerLazyServices\(\s*agentService: AgentService,\s*llmService: LlmService,\s*memoryService: MemoryService,\s*memoryIndexer: MemoryIndexer,\s*stateManager: StateManager,\s*planManager: any,\s*cognitiveService: CognitiveService,\s*evolutionRef\?: \{ current: SelfEvolutionService \| null \},\s*dashboardRef\?: \{ current: EvolutionDashboardService \| null \},\s*pipelineRef\?: \{ current: PipelineOrchestrator \| null \},\s*taskPanelRef\?: \{ current: TaskPanelService \| null \},\s*wallpaperInteractiveRef\?: \{ current: WallpaperInteractiveService \| null \},\s*\): void/s,
    )
  })
})
