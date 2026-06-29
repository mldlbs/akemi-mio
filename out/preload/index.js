"use strict";
const electron = require("electron");
const electronAPI = {
  closeWindow: () => electron.ipcRenderer.invoke("window:close"),
  minimizeWindow: () => electron.ipcRenderer.invoke("window:minimize"),
  transcribe: (audio) => electron.ipcRenderer.invoke("asr:transcribe", audio),
  chat: (text, requestId, sessionId, noTts) => electron.ipcRenderer.invoke("ai:chat", text, requestId, sessionId, noTts),
  speak: (text) => electron.ipcRenderer.invoke("tts:speak", text),
  stopSpeaking: () => electron.ipcRenderer.invoke("tts:stop"),
  stopConversation: () => electron.ipcRenderer.invoke("conversation:stop"),
  getState: () => electron.ipcRenderer.invoke("state:get"),
  getWakeWords: () => electron.ipcRenderer.invoke("config:getWakeWords"),
  onStateUpdate: (callback) => {
    const handler = (_event, state) => callback(state);
    electron.ipcRenderer.on("state:update", handler);
    return () => {
      electron.ipcRenderer.removeListener("state:update", handler);
    };
  },
  onAIChunk: (callback) => {
    const handler = (_event, text) => callback(text);
    electron.ipcRenderer.on("ai:chunk", handler);
    return () => {
      electron.ipcRenderer.removeListener("ai:chunk", handler);
    };
  },
  onTTSAudio: (callback) => {
    const handler = (_event, filePath) => callback(filePath);
    electron.ipcRenderer.on("tts:play_audio", handler);
    return () => {
      electron.ipcRenderer.removeListener("tts:play_audio", handler);
    };
  },
  onTTSBuffer: (callback) => {
    const handler = (_event, buf) => callback(buf.buffer);
    electron.ipcRenderer.on("tts:play_audio_buffer", handler);
    return () => {
      electron.ipcRenderer.removeListener("tts:play_audio_buffer", handler);
    };
  },
  onToolStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    electron.ipcRenderer.on("tool:status", handler);
    return () => {
      electron.ipcRenderer.removeListener("tool:status", handler);
    };
  },
  getCredential: (key) => electron.ipcRenderer.invoke("credentials:get", key),
  setCredential: (key, value) => electron.ipcRenderer.invoke("credentials:set", key, value),
  deleteCredential: (key) => electron.ipcRenderer.invoke("credentials:delete", key),
  getMessageHistory: (limit) => electron.ipcRenderer.invoke("messages:getHistory", limit),
  getSessions: () => electron.ipcRenderer.invoke("messages:getSessions"),
  getMessagesBySession: (sessionId) => electron.ipcRenderer.invoke("messages:getBySession", sessionId),
  onMessageNew: (callback) => {
    const handler = (_event, msg) => callback(msg);
    electron.ipcRenderer.on("message:new", handler);
    return () => {
      electron.ipcRenderer.removeListener("message:new", handler);
    };
  },
  // Auto-update
  checkUpdate: () => electron.ipcRenderer.invoke("update:check"),
  downloadUpdate: () => electron.ipcRenderer.invoke("update:download"),
  installUpdate: () => electron.ipcRenderer.invoke("update:install"),
  onUpdateStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    electron.ipcRenderer.on("update:status", handler);
    return () => {
      electron.ipcRenderer.removeListener("update:status", handler);
    };
  },
  // ── Coding Agent UI ──
  // 工具调用事件（ChatExecutor 实际发出含 id/latencyMs 的 payload）
  onToolInvoked: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:tool_invoked", handler);
    return () => electron.ipcRenderer.removeListener("agent:tool_invoked", handler);
  },
  onToolCompleted: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:tool_completed", handler);
    return () => electron.ipcRenderer.removeListener("agent:tool_completed", handler);
  },
  onToolFailed: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:tool_failed", handler);
    return () => electron.ipcRenderer.removeListener("agent:tool_failed", handler);
  },
  // 计划事件
  onPlanCreated: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:plan_created", handler);
    return () => electron.ipcRenderer.removeListener("agent:plan_created", handler);
  },
  onPlanStep: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:plan_step", handler);
    return () => electron.ipcRenderer.removeListener("agent:plan_step", handler);
  },
  onPlanCompleted: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:plan_completed", handler);
    return () => electron.ipcRenderer.removeListener("agent:plan_completed", handler);
  },
  // OTPAR 阶段事件
  onAgentObserve: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:observe", handler);
    return () => electron.ipcRenderer.removeListener("agent:observe", handler);
  },
  onAgentThink: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:think", handler);
    return () => electron.ipcRenderer.removeListener("agent:think", handler);
  },
  onAgentReflect: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:reflect", handler);
    return () => electron.ipcRenderer.removeListener("agent:reflect", handler);
  },
  // 输入输出
  onInputReceived: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:input_received", handler);
    return () => electron.ipcRenderer.removeListener("agent:input_received", handler);
  },
  onResponseGenerated: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:response_generated", handler);
    return () => electron.ipcRenderer.removeListener("agent:response_generated", handler);
  },
  // Guardrail & 错误
  onGuardrail: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:guardrail", handler);
    return () => electron.ipcRenderer.removeListener("agent:guardrail", handler);
  },
  onBudgetExhausted: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:budgetExhausted", handler);
    return () => electron.ipcRenderer.removeListener("agent:budgetExhausted", handler);
  },
  onBudgetRestored: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:budgetRestored", handler);
    return () => electron.ipcRenderer.removeListener("agent:budgetRestored", handler);
  },
  onAgentError: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("agent:error", handler);
    return () => electron.ipcRenderer.removeListener("agent:error", handler);
  },
  // 工作流运行事件
  onWorkflowRunCreated: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("workflow:run_created", handler);
    return () => electron.ipcRenderer.removeListener("workflow:run_created", handler);
  },
  onWorkflowRunUpdated: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("workflow:run_updated", handler);
    return () => electron.ipcRenderer.removeListener("workflow:run_updated", handler);
  },
  onWorkflowRunStep: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("workflow:run_step", handler);
    return () => electron.ipcRenderer.removeListener("workflow:run_step", handler);
  },
  // 工作流定义变更 → UI 刷新
  onWorkflowDefCreated: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("workflow:def_created", handler);
    return () => electron.ipcRenderer.removeListener("workflow:def_created", handler);
  },
  // Invoke handlers
  getActivePlan: () => electron.ipcRenderer.invoke("agent:getActivePlan"),
  listPlans: () => electron.ipcRenderer.invoke("agent:listPlans"),
  openAgentWindow: () => electron.ipcRenderer.invoke("agent:openWindow"),
  closeAgentWindow: () => electron.ipcRenderer.invoke("agent:closeWindow"),
  // 人格切换事件
  onPersonaUpdated: (callback) => {
    const handler = (_event, data) => callback(data);
    electron.ipcRenderer.on("persona:updated", handler);
    return () => electron.ipcRenderer.removeListener("persona:updated", handler);
  },
  // ── Workflow System ──
  listWorkflowDefinitions: () => electron.ipcRenderer.invoke("workflow:listDefinitions"),
  getWorkflowDefinition: (id) => electron.ipcRenderer.invoke("workflow:getDefinition", id),
  listWorkflowRuns: (limit) => electron.ipcRenderer.invoke("workflow:listRuns", limit),
  getWorkflowRun: (runId) => electron.ipcRenderer.invoke("workflow:getRun", runId),
  deleteWorkflowDefinition: (id) => electron.ipcRenderer.invoke("workflow:deleteDefinition", id),
  saveWorkflowDefinition: (def) => electron.ipcRenderer.invoke("workflow:saveDefinition", def),
  startWorkflow: (id) => electron.ipcRenderer.invoke("workflow:startWorkflow", id),
  enableWorkflowDefinition: (id) => electron.ipcRenderer.invoke("workflow:enableDefinition", id),
  disableWorkflowDefinition: (id) => electron.ipcRenderer.invoke("workflow:disableDefinition", id),
  stopWorkflowRun: (runId) => electron.ipcRenderer.invoke("workflow:stopRun", runId),
  duplicateWorkflowDefinition: (id) => electron.ipcRenderer.invoke("workflow:duplicateDefinition", id),
  deleteWorkflowRun: (runId) => electron.ipcRenderer.invoke("workflow:deleteRun", runId),
  // ── Writing Status ──
  getWritingStatus: () => electron.ipcRenderer.invoke("writing:getStatus"),
  // ── Evolution ──
  evolutionStatus: () => electron.ipcRenderer.invoke("evolution:status"),
  evolutionTrigger: () => electron.ipcRenderer.invoke("evolution:trigger")
};
electron.contextBridge.exposeInMainWorld("electronAPI", electronAPI);
