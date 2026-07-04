"use strict";
const worker_threads = require("worker_threads");
const workerName = worker_threads.workerData?.workerName || "unknown";
worker_threads.parentPort?.postMessage({
  type: "lifecycle",
  event: "started",
  workerName
});
worker_threads.parentPort?.on("message", async (msg) => {
  if (msg.type === "task") {
    try {
      await handleTask(msg);
    } catch (err) {
      worker_threads.parentPort?.postMessage({
        type: "result",
        taskId: msg.taskId,
        success: false,
        data: null,
        error: err.message
      });
    }
  } else if (msg.type === "shutdown") {
    worker_threads.parentPort?.postMessage({
      type: "lifecycle",
      event: "stopped",
      workerName
    });
    process.exit(0);
  }
});
async function handleTask(msg) {
  const { taskId, data } = msg;
  const workerImpl = globalThis.__workerHandler;
  if (!workerImpl) {
    throw new Error(`Worker "${workerName}" has no handler registered`);
  }
  const result = await workerImpl(data);
  worker_threads.parentPort?.postMessage({
    type: "result",
    taskId,
    success: true,
    data: result
  });
}
