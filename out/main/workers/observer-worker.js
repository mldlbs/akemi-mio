"use strict";
const worker_threads = require("worker_threads");
worker_threads.parentPort?.postMessage({ type: "lifecycle", event: "started", workerName: "observer" });
worker_threads.parentPort?.on("message", async (msg) => {
  if (msg.type === "task") {
    try {
      await handleTask(msg);
    } catch (err) {
      worker_threads.parentPort?.postMessage({ type: "result", taskId: msg.taskId, success: false, data: null, error: err.message });
    }
  } else if (msg.type === "shutdown") {
    worker_threads.parentPort?.postMessage({ type: "lifecycle", event: "stopped", workerName: "observer" });
    process.exit(0);
  }
});
async function handleTask(msg) {
  const { taskId, data } = msg;
  const method = msg.method || msg.name || "";
  if (method === "init") {
    const { ObserverService } = await Promise.resolve().then(() => require("../chunks/ObserverService-Do7Z4WM9.js"));
    const service2 = new ObserverService(data?.baseDir);
    globalThis.__observerService = service2;
    worker_threads.parentPort?.postMessage({ type: "result", taskId, success: true, data: { initialized: true } });
    return;
  }
  const service = globalThis.__observerService;
  if (!service) throw new Error("ObserverService not initialized");
  switch (method) {
    case "initLlm": {
      const llm = service.getLlm();
      await llm.initialize();
      worker_threads.parentPort?.postMessage({ type: "result", taskId, success: true, data: { loaded: llm.isLoaded } });
      break;
    }
    case "start": {
      await service.start();
      worker_threads.parentPort?.postMessage({ type: "result", taskId, success: true, data: null });
      break;
    }
    case "stop": {
      service.stop();
      worker_threads.parentPort?.postMessage({ type: "result", taskId, success: true, data: null });
      break;
    }
    case "collect": {
      await service.forceCollect();
      worker_threads.parentPort?.postMessage({ type: "result", taskId, success: true, data: null });
      break;
    }
    case "pipeline": {
      const result = await service.forcePipeline(data?.mode || "analytical");
      worker_threads.parentPort?.postMessage({ type: "result", taskId, success: true, data: result });
      break;
    }
    case "ferment": {
      await service.forceFerment();
      worker_threads.parentPort?.postMessage({ type: "result", taskId, success: true, data: null });
      break;
    }
    default:
      throw new Error(`Unknown observer task method: ${method}`);
  }
}
