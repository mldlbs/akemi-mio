import { vi } from 'vitest'

// Must use vi.hoisted to ensure the factory runs before the module is imported
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<Function>>()

  const ipc = {
    invoke: vi.fn().mockImplementation((channel: string) => {
      const mockResponses: Record<string, any> = {
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
      return Promise.resolve(channel in mockResponses ? mockResponses[channel] : undefined)
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
    ipcRenderer: ipc,
    contextBridge: { exposeInMainWorld: vi.fn() },
  }
})

vi.mock('electron', () => ({
  contextBridge: mocks.contextBridge,
  ipcRenderer: mocks.ipcRenderer,
  IpcRendererEvent: vi.fn(),
}))

import { describe, it, expect, beforeEach } from 'vitest'
import { createElectronAPI } from '../index'
import { ipcRenderer } from 'electron'

const ipcMock = mocks.ipcRenderer
type ElectronAPI = ReturnType<typeof createElectronAPI>

describe('createElectronAPI', () => {
  let api: ElectronAPI

  beforeEach(() => {
    // Only clear call history for event mocks — invoke uses its hoisted implementation
    ;(ipcMock.on as any).mockClear()
    ;(ipcMock.removeListener as any).mockClear()
    // invoke.mockClear would wipe the implementation too, so skip it
    api = createElectronAPI(ipcRenderer as any)
  })

  // ── Window ──
  describe('window', () => {
    it('closeWindow invokes window:close', async () => {
      const r = await api.closeWindow()
      expect(ipcMock.invoke).toHaveBeenCalledWith('window:close')
      expect(r).toEqual({ success: true })
    })

    it('minimizeWindow invokes window:minimize', async () => {
      const r = await api.minimizeWindow()
      expect(ipcMock.invoke).toHaveBeenCalledWith('window:minimize')
      expect(r).toEqual({ success: true })
    })
  })

  // ── ASR / AI / TTS ──
  describe('asr / ai / tts', () => {
    it('transcribe invokes asr:transcribe with audio buffer', async () => {
      const buf = new ArrayBuffer(8)
      await api.transcribe(buf)
      expect(ipcMock.invoke).toHaveBeenCalledWith('asr:transcribe', buf)
    })

    it('chat invokes ai:chat with text', async () => {
      await api.chat('hello')
      expect(ipcMock.invoke).toHaveBeenCalledWith('ai:chat', 'hello', undefined, undefined, undefined)
    })

    it('chat passes optional args', async () => {
      await api.chat('hello', 'req-1', 'sess-1', true)
      expect(ipcMock.invoke).toHaveBeenCalledWith('ai:chat', 'hello', 'req-1', 'sess-1', true)
    })

    it('speak invokes tts:speak', async () => {
      await api.speak('hello')
      expect(ipcMock.invoke).toHaveBeenCalledWith('tts:speak', 'hello')
    })

    it('stopSpeaking invokes tts:stop', async () => {
      await api.stopSpeaking()
      expect(ipcMock.invoke).toHaveBeenCalledWith('tts:stop')
    })

    it('stopConversation invokes conversation:stop', async () => {
      const r = await api.stopConversation()
      expect(ipcMock.invoke).toHaveBeenCalledWith('conversation:stop')
      expect(r).toEqual({ success: true })
    })

    it('getState invokes state:get', async () => {
      const r = await api.getState()
      expect(ipcMock.invoke).toHaveBeenCalledWith('state:get')
      expect(r).toEqual({ asr: 'idle' })
    })

    it('getWakeWords invokes config:getWakeWords', async () => {
      const r = await api.getWakeWords()
      expect(ipcMock.invoke).toHaveBeenCalledWith('config:getWakeWords')
      expect(r).toEqual(['澪', 'mio'])
    })
  })

  // ── Credentials ──
  describe('credentials', () => {
    it('getCredential invokes credentials:get', async () => {
      await api.getCredential('api-key')
      expect(ipcMock.invoke).toHaveBeenCalledWith('credentials:get', 'api-key')
    })

    it('setCredential invokes credentials:set', async () => {
      await api.setCredential('api-key', 'abc')
      expect(ipcMock.invoke).toHaveBeenCalledWith('credentials:set', 'api-key', 'abc')
    })

    it('deleteCredential invokes credentials:delete', async () => {
      await api.deleteCredential('api-key')
      expect(ipcMock.invoke).toHaveBeenCalledWith('credentials:delete', 'api-key')
    })
  })

  // ── Messages ──
  describe('messages', () => {
    it('getMessageHistory invokes messages:getHistory', async () => {
      await api.getMessageHistory(50)
      expect(ipcMock.invoke).toHaveBeenCalledWith('messages:getHistory', 50)
    })

    it('getMessageHistory works without limit', async () => {
      await api.getMessageHistory()
      expect(ipcMock.invoke).toHaveBeenCalledWith('messages:getHistory', undefined)
    })

    it('getSessions invokes messages:getSessions', async () => {
      await api.getSessions()
      expect(ipcMock.invoke).toHaveBeenCalledWith('messages:getSessions')
    })

    it('getMessagesBySession invokes messages:getBySession', async () => {
      await api.getMessagesBySession('s-1')
      expect(ipcMock.invoke).toHaveBeenCalledWith('messages:getBySession', 's-1')
    })
  })

  // ── Update ──
  describe('update', () => {
    it('checkUpdate invokes update:check', async () => {
      const r = await api.checkUpdate()
      expect(ipcMock.invoke).toHaveBeenCalledWith('update:check')
      expect(r).toEqual({ available: false })
    })

    it('downloadUpdate invokes update:download', async () => {
      const r = await api.downloadUpdate()
      expect(ipcMock.invoke).toHaveBeenCalledWith('update:download')
      expect(r).toEqual({ success: true })
    })

    it('installUpdate invokes update:install', async () => {
      const r = await api.installUpdate()
      expect(ipcMock.invoke).toHaveBeenCalledWith('update:install')
      expect(r).toEqual({ success: true })
    })
  })

  // ── Agent Plans ──
  describe('agent plans', () => {
    it('getActivePlan invokes agent:getActivePlan', async () => {
      const r = await api.getActivePlan()
      expect(ipcMock.invoke).toHaveBeenCalledWith('agent:getActivePlan')
      expect(r).toBeNull()
    })

    it('listPlans invokes agent:listPlans', async () => {
      const r = await api.listPlans()
      expect(ipcMock.invoke).toHaveBeenCalledWith('agent:listPlans')
      expect(r).toEqual([])
    })

    it('openAgentWindow invokes agent:openWindow', async () => {
      const r = await api.openAgentWindow()
      expect(ipcMock.invoke).toHaveBeenCalledWith('agent:openWindow')
      expect(r).toEqual({ success: true })
    })

    it('closeAgentWindow invokes agent:closeWindow', async () => {
      const r = await api.closeAgentWindow()
      expect(ipcMock.invoke).toHaveBeenCalledWith('agent:closeWindow')
      expect(r).toEqual({ success: true })
    })
  })

  // ── Workflow System ──
  describe('workflow system', () => {
    it('listWorkflowDefinitions invokes workflow:listDefinitions', async () => {
      await api.listWorkflowDefinitions()
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:listDefinitions')
    })

    it('getWorkflowDefinition invokes workflow:getDefinition with id', async () => {
      await api.getWorkflowDefinition('w-1')
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:getDefinition', 'w-1')
    })

    it('listWorkflowRuns invokes workflow:listRuns', async () => {
      await api.listWorkflowRuns(10)
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:listRuns', 10)
    })

    it('getWorkflowRun invokes workflow:getRun', async () => {
      await api.getWorkflowRun('r-1')
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:getRun', 'r-1')
    })

    it('deleteWorkflowDefinition invokes workflow:deleteDefinition', async () => {
      await api.deleteWorkflowDefinition('w-1')
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:deleteDefinition', 'w-1')
    })

    it('saveWorkflowDefinition invokes workflow:saveDefinition', async () => {
      const def = { id: 'w-1', name: 'test' }
      await api.saveWorkflowDefinition(def)
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:saveDefinition', def)
    })

    it('startWorkflow invokes workflow:startWorkflow', async () => {
      const r = await api.startWorkflow('w-1')
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:startWorkflow', 'w-1')
      expect(r.runId).toBe('r1')
    })

    it('enableWorkflowDefinition invokes workflow:enableDefinition', async () => {
      await api.enableWorkflowDefinition('w-1')
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:enableDefinition', 'w-1')
    })

    it('disableWorkflowDefinition invokes workflow:disableDefinition', async () => {
      await api.disableWorkflowDefinition('w-1')
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:disableDefinition', 'w-1')
    })

    it('stopWorkflowRun invokes workflow:stopRun', async () => {
      await api.stopWorkflowRun('r-1')
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:stopRun', 'r-1')
    })

    it('duplicateWorkflowDefinition invokes workflow:duplicateDefinition', async () => {
      await api.duplicateWorkflowDefinition('w-1')
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:duplicateDefinition', 'w-1')
    })

    it('deleteWorkflowRun invokes workflow:deleteRun', async () => {
      await api.deleteWorkflowRun('r-1')
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:deleteRun', 'r-1')
    })

    it('approveGate invokes workflow:approveGate with all args', async () => {
      await api.approveGate('r-1', 's-1', 'approve', 'modified input')
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:approveGate', 'r-1', 's-1', 'approve', 'modified input')
    })

    it('approveGate works without modifiedInput', async () => {
      await api.approveGate('r-1', 's-1', 'reject')
      expect(ipcMock.invoke).toHaveBeenCalledWith('workflow:approveGate', 'r-1', 's-1', 'reject', undefined)
    })
  })

  // ── Writing & Evolution ──
  describe('writing & evolution', () => {
    it('getWritingStatus invokes writing:getStatus', async () => {
      const r = await api.getWritingStatus()
      expect(ipcMock.invoke).toHaveBeenCalledWith('writing:getStatus')
      expect(r).toEqual({ stories: [], totalStories: 0, totalScenes: 0 })
    })

    it('evolutionStatus invokes evolution:status', async () => {
      const r = await api.evolutionStatus()
      expect(ipcMock.invoke).toHaveBeenCalledWith('evolution:status')
      expect(r.consecutiveFailures).toBe(0)
    })

    it('evolutionTrigger invokes evolution:trigger', async () => {
      await api.evolutionTrigger()
      expect(ipcMock.invoke).toHaveBeenCalledWith('evolution:trigger')
    })
  })

  // ── Event Listeners ──
  describe('event listeners', () => {
    function testEventListener(
      name: string,
      register: (cb: Function) => () => void,
      channel: string,
      emitArgs: any[],
      expectedCallbackArg?: any,
    ) {
      describe(name, () => {
        it(`registers on ${channel}`, () => {
          const cb = vi.fn()
          register(cb)
          expect(ipcMock.on).toHaveBeenCalledWith(channel, expect.any(Function))
          const handler = ipcMock.on.mock.calls.find((c: string[]) => c[0] === channel)?.[1]
          handler?.(...emitArgs)
          if (expectedCallbackArg !== undefined) {
            expect(cb).toHaveBeenCalledWith(expectedCallbackArg)
          } else {
            expect(cb).toHaveBeenCalled()
          }
        })

        it(`cleanup removes listener from ${channel}`, () => {
          const cb = vi.fn()
          const cleanup = register(cb)
          cleanup()
          const handler = ipcMock.on.mock.calls.find((c: string[]) => c[0] === channel)?.[1]
          expect(ipcMock.removeListener).toHaveBeenCalledWith(channel, handler)
        })
      })
    }

    testEventListener('onStateUpdate', (cb) => api.onStateUpdate(cb), 'state:update', [{}, { asr: 'thinking' }], { asr: 'thinking' })
    testEventListener('onAIChunk', (cb) => api.onAIChunk(cb), 'ai:chunk', [{}, 'chunk text'], 'chunk text')
    testEventListener('onTTSAudio', (cb) => api.onTTSAudio(cb), 'tts:play_audio', [{}, '/path/to/file.mp3'], '/path/to/file.mp3')
    testEventListener('onToolStatus', (cb) => api.onToolStatus(cb), 'tool:status', [{}, { type: 'start', tool: 'search', message: '' }], {
      type: 'start',
      tool: 'search',
      message: '',
    })
    testEventListener('onMessageNew', (cb) => api.onMessageNew(cb), 'message:new', [
      {},
      { id: 'm1', role: 'user', content: 'hi', category: 'chat', sessionId: 's1', source: 'electron', createdAt: 100 },
    ])
    testEventListener('onUpdateStatus', (cb) => api.onUpdateStatus(cb), 'update:status', [{}, { status: 'downloading' }], {
      status: 'downloading',
    })
    testEventListener('onToolInvoked', (cb) => api.onToolInvoked(cb), 'agent:tool_invoked', [{}, { tool: 'read', args: {}, id: 't1' }])
    testEventListener('onToolCompleted', (cb) => api.onToolCompleted(cb), 'agent:tool_completed', [
      {},
      { tool: 'read', result: 'ok', id: 't1', latencyMs: 100 },
    ])
    testEventListener('onToolFailed', (cb) => api.onToolFailed(cb), 'agent:tool_failed', [
      {},
      { tool: 'read', error: 'fail', id: 't1', latencyMs: 50 },
    ])
    testEventListener('onPlanCreated', (cb) => api.onPlanCreated(cb), 'agent:plan_created', [{}, { planId: 'p1', title: 'test' }])
    testEventListener('onPlanStep', (cb) => api.onPlanStep(cb), 'agent:plan_step', [{}, { planId: 'p1', stepIndex: 0, status: 'done' }])
    testEventListener('onPlanCompleted', (cb) => api.onPlanCompleted(cb), 'agent:plan_completed', [{}, { planId: 'p1' }])
    testEventListener('onAgentObserve', (cb) => api.onAgentObserve(cb), 'agent:observe', [
      {},
      { requestId: 'r1', step: 1, proceduresFound: 2, patternsFound: 3, durationMs: 100 },
    ])
    testEventListener('onAgentThink', (cb) => api.onAgentThink(cb), 'agent:think', [
      {},
      { requestId: 'r1', step: 1, toolCallCount: 3, strategyPrompted: true },
    ])
    testEventListener('onAgentReflect', (cb) => api.onAgentReflect(cb), 'agent:reflect', [
      {},
      { requestId: 'r1', step: 1, toolResults: 3, successCount: 2, summary: 'ok', durationMs: 100 },
    ])
    testEventListener('onInputReceived', (cb) => api.onInputReceived(cb), 'agent:input_received', [
      {},
      { text: 'hi', requestId: 'r1', source: 'voice' },
    ])
    testEventListener('onResponseGenerated', (cb) => api.onResponseGenerated(cb), 'agent:response_generated', [
      {},
      { text: 'hello', requestId: 'r1', source: 'agent' },
    ])
    testEventListener('onGuardrail', (cb) => api.onGuardrail(cb), 'agent:guardrail', [{}, { type: 'toxicity', score: 0.1 }])
    testEventListener('onBudgetExhausted', (cb) => api.onBudgetExhausted(cb), 'agent:budgetExhausted', [
      {},
      { resource: 'tokens', utilization: 0.9 },
    ])
    testEventListener('onBudgetRestored', (cb) => api.onBudgetRestored(cb), 'agent:budgetRestored', [
      {},
      { resource: 'tokens', utilization: 0.1 },
    ])
    testEventListener('onAgentError', (cb) => api.onAgentError(cb), 'agent:error', [{}, { error: 'timeout', requestId: 'r1' }])
    testEventListener('onWorkflowRunCreated', (cb) => api.onWorkflowRunCreated(cb), 'workflow:run_created', [
      {},
      { runId: 'r1', workflowDefId: 'w-1' },
    ])
    testEventListener('onWorkflowRunUpdated', (cb) => api.onWorkflowRunUpdated(cb), 'workflow:run_updated', [
      {},
      { runId: 'r1', status: 'running' },
    ])
    testEventListener('onWorkflowRunStep', (cb) => api.onWorkflowRunStep(cb), 'workflow:run_step', [
      {},
      { runId: 'r1', stepId: 's1', status: 'done' },
    ])
    testEventListener('onWorkflowDefCreated', (cb) => api.onWorkflowDefCreated(cb), 'workflow:def_created', [{}, { workflowDefId: 'w-1' }])
    testEventListener('onPersonaUpdated', (cb) => api.onPersonaUpdated(cb), 'persona:updated', [{}, { level: 'expert' }])
  })

  // ── Special: onTTSBuffer ──
  describe('onTTSBuffer (Uint8Array → ArrayBuffer)', () => {
    it('converts Uint8Array to ArrayBuffer', () => {
      const cb = vi.fn()
      api.onTTSBuffer(cb)
      const uint8 = new Uint8Array([1, 2, 3])
      const handler = ipcMock.on.mock.calls.find((c: string[]) => c[0] === 'tts:play_audio_buffer')?.[1]
      handler({}, uint8)
      expect(cb).toHaveBeenCalled()
      const arg = cb.mock.calls[0][0]
      expect(arg).toBeInstanceOf(ArrayBuffer)
      expect(new Uint8Array(arg)).toEqual(uint8)
    })
  })
})
