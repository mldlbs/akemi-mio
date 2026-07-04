"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const electron = require("electron");
function createElectronAPI(ipc) {
  return {
    closeWindow: () => ipc.invoke("window:close"),
    minimizeWindow: () => ipc.invoke("window:minimize"),
    transcribe: (audio) => ipc.invoke("asr:transcribe", audio),
    chat: (text, requestId, sessionId, noTts) => ipc.invoke("ai:chat", text, requestId, sessionId, noTts),
    speak: (text) => ipc.invoke("tts:speak", text),
    stopSpeaking: () => ipc.invoke("tts:stop"),
    stopConversation: () => ipc.invoke("conversation:stop"),
    getState: () => ipc.invoke("state:get"),
    getWakeWords: () => ipc.invoke("config:getWakeWords"),
    onStateUpdate: (callback) => {
      const handler = (_event, state) => callback(state);
      ipc.on("state:update", handler);
      return () => {
        ipc.removeListener("state:update", handler);
      };
    },
    onAIChunk: (callback) => {
      const handler = (_event, text) => callback(text);
      ipc.on("ai:chunk", handler);
      return () => {
        ipc.removeListener("ai:chunk", handler);
      };
    },
    onTTSAudio: (callback) => {
      const handler = (_event, filePath) => callback(filePath);
      ipc.on("tts:play_audio", handler);
      return () => {
        ipc.removeListener("tts:play_audio", handler);
      };
    },
    onTTSBuffer: (callback) => {
      const handler = (_event, buf) => callback(buf.buffer);
      ipc.on("tts:play_audio_buffer", handler);
      return () => {
        ipc.removeListener("tts:play_audio_buffer", handler);
      };
    },
    onToolStatus: (callback) => {
      const handler = (_event, status) => callback(status);
      ipc.on("tool:status", handler);
      return () => {
        ipc.removeListener("tool:status", handler);
      };
    },
    getCredential: (key) => ipc.invoke("credentials:get", key),
    setCredential: (key, value) => ipc.invoke("credentials:set", key, value),
    deleteCredential: (key) => ipc.invoke("credentials:delete", key),
    getMessageHistory: (limit) => ipc.invoke("messages:getHistory", limit),
    getSessions: () => ipc.invoke("messages:getSessions"),
    getMessagesBySession: (sessionId) => ipc.invoke("messages:getBySession", sessionId),
    onMessageNew: (callback) => {
      const handler = (_event, msg) => callback(msg);
      ipc.on("message:new", handler);
      return () => {
        ipc.removeListener("message:new", handler);
      };
    },
    checkUpdate: () => ipc.invoke("update:check"),
    downloadUpdate: () => ipc.invoke("update:download"),
    installUpdate: () => ipc.invoke("update:install"),
    onUpdateStatus: (callback) => {
      const handler = (_event, status) => callback(status);
      ipc.on("update:status", handler);
      return () => {
        ipc.removeListener("update:status", handler);
      };
    },
    // ── Coding Agent UI ──
    onToolInvoked: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:tool_invoked", handler);
      return () => ipc.removeListener("agent:tool_invoked", handler);
    },
    onToolCompleted: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:tool_completed", handler);
      return () => ipc.removeListener("agent:tool_completed", handler);
    },
    onToolFailed: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:tool_failed", handler);
      return () => ipc.removeListener("agent:tool_failed", handler);
    },
    onPlanCreated: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:plan_created", handler);
      return () => ipc.removeListener("agent:plan_created", handler);
    },
    onPlanStep: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:plan_step", handler);
      return () => ipc.removeListener("agent:plan_step", handler);
    },
    onPlanCompleted: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:plan_completed", handler);
      return () => ipc.removeListener("agent:plan_completed", handler);
    },
    onAgentObserve: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:observe", handler);
      return () => ipc.removeListener("agent:observe", handler);
    },
    onAgentThink: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:think", handler);
      return () => ipc.removeListener("agent:think", handler);
    },
    onAgentReflect: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:reflect", handler);
      return () => ipc.removeListener("agent:reflect", handler);
    },
    onInputReceived: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:input_received", handler);
      return () => ipc.removeListener("agent:input_received", handler);
    },
    onResponseGenerated: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:response_generated", handler);
      return () => ipc.removeListener("agent:response_generated", handler);
    },
    onGuardrail: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:guardrail", handler);
      return () => ipc.removeListener("agent:guardrail", handler);
    },
    onBudgetExhausted: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:budgetExhausted", handler);
      return () => ipc.removeListener("agent:budgetExhausted", handler);
    },
    onBudgetRestored: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:budgetRestored", handler);
      return () => ipc.removeListener("agent:budgetRestored", handler);
    },
    onAgentError: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("agent:error", handler);
      return () => ipc.removeListener("agent:error", handler);
    },
    onWorkflowRunCreated: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("workflow:run_created", handler);
      return () => ipc.removeListener("workflow:run_created", handler);
    },
    onWorkflowRunUpdated: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("workflow:run_updated", handler);
      return () => ipc.removeListener("workflow:run_updated", handler);
    },
    onWorkflowRunStep: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("workflow:run_step", handler);
      return () => ipc.removeListener("workflow:run_step", handler);
    },
    onWorkflowDefCreated: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("workflow:def_created", handler);
      return () => ipc.removeListener("workflow:def_created", handler);
    },
    getActivePlan: () => ipc.invoke("agent:getActivePlan"),
    listPlans: () => ipc.invoke("agent:listPlans"),
    openAgentWindow: () => ipc.invoke("agent:openWindow"),
    closeAgentWindow: () => ipc.invoke("agent:closeWindow"),
    onPersonaUpdated: (callback) => {
      const handler = (_event, data) => callback(data);
      ipc.on("persona:updated", handler);
      return () => {
        ipc.removeListener("persona:updated", handler);
      };
    },
    // ── Workflow System ──
    listWorkflowDefinitions: () => ipc.invoke("workflow:listDefinitions"),
    getWorkflowDefinition: (id) => ipc.invoke("workflow:getDefinition", id),
    listWorkflowRuns: (limit) => ipc.invoke("workflow:listRuns", limit),
    getWorkflowRun: (runId) => ipc.invoke("workflow:getRun", runId),
    deleteWorkflowDefinition: (id) => ipc.invoke("workflow:deleteDefinition", id),
    saveWorkflowDefinition: (def) => ipc.invoke("workflow:saveDefinition", def),
    startWorkflow: (id) => ipc.invoke("workflow:startWorkflow", id),
    enableWorkflowDefinition: (id) => ipc.invoke("workflow:enableDefinition", id),
    disableWorkflowDefinition: (id) => ipc.invoke("workflow:disableDefinition", id),
    stopWorkflowRun: (runId) => ipc.invoke("workflow:stopRun", runId),
    duplicateWorkflowDefinition: (id) => ipc.invoke("workflow:duplicateDefinition", id),
    deleteWorkflowRun: (runId) => ipc.invoke("workflow:deleteRun", runId),
    approveGate: (runId, stepId, decision, modifiedInput) => ipc.invoke("workflow:approveGate", runId, stepId, decision, modifiedInput),
    // ── Writing Status ──
    getWritingStatus: () => ipc.invoke("writing:getStatus"),
    // ── Evolution ──
    evolutionStatus: () => ipc.invoke("evolution:status"),
    evolutionTrigger: () => ipc.invoke("evolution:trigger")
  };
}
const electronAPI = createElectronAPI(electron.ipcRenderer);
electron.contextBridge.exposeInMainWorld("electronAPI", electronAPI);
exports.createElectronAPI = createElectronAPI;
