import { vi } from 'vitest'

// Electron is not available in node tests — mock the full module
vi.mock('electron', () => {
  const handlers = new Map<string, Set<Function>>()

  const mockIpcRenderer = {
    invoke: vi.fn().mockImplementation((channel: string) => {
      const mocks: Record<string, any> = {
        'window:close': { success: true },
        'window:minimize': { success: true },
        'asr:transcribe': { text: '' },
        'ai:chat': { reply: 'mock' },
        'tts:speak': undefined,
        'tts:stop': undefined,
        'conversation:stop': { success: true },
        'state:get': { asr: 'idle' },
        'config:getWakeWords': ['澪', 'mio'],
        'credentials:get': null,
        'credentials:set': true,
        'credentials:delete': true,
        'messages:getHistory': [],
        'messages:getSessions': [],
        'messages:getBySession': [],
        'update:check': { available: false },
        'update:download': { success: true },
        'update:install': { success: true },
        'agent:getActivePlan': null,
        'agent:listPlans': [],
        'agent:openWindow': { success: true },
        'agent:closeWindow': { success: true },
        'workflow:listDefinitions': [],
        'workflow:getDefinition': null,
        'workflow:listRuns': [],
        'workflow:getRun': null,
        'workflow:deleteDefinition': { success: true },
        'workflow:saveDefinition': { success: true },
        'workflow:startWorkflow': { success: true, runId: 'r1' },
        'workflow:enableDefinition': { success: true },
        'workflow:disableDefinition': { success: true },
        'workflow:stopRun': { success: true },
        'workflow:duplicateDefinition': { success: true },
        'workflow:deleteRun': { success: true },
        'workflow:approveGate': { success: true },
        'writing:getStatus': { stories: [], totalStories: 0, totalScenes: 0 },
        'evolution:status': { lastRun: null, consecutiveFailures: 0, isBusy: false },
        'evolution:trigger': { success: true },
      }
      return Promise.resolve(mocks[channel] ?? undefined)
    }),
    on: vi.fn((channel: string, handler: Function) => {
      if (!handlers.has(channel)) handlers.set(channel, new Set())
      handlers.get(channel)!.add(handler)
    }),
    removeListener: vi.fn((channel: string, handler: Function) => {
      handlers.get(channel)?.delete(handler)
    }),
  }

  return {
    contextBridge: {
      exposeInMainWorld: vi.fn(),
    },
    ipcRenderer: mockIpcRenderer,
    IpcRendererEvent: vi.fn(),
  }
})
