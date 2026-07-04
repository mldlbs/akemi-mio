"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const index = require("../index.js");
const Logger = require("./Logger-BD3PzZBa.js");
require("electron");
require("path");
require("fs");
require("events");
require("child_process");
require("https");
require("http");
require("util");
require("sql.js");
require("drizzle-orm/sqlite-proxy");
require("drizzle-orm/sqlite-core");
require("os");
require("koffi");
require("@anthropic-ai/claude-agent-sdk");
require("ssh2");
require("@kutalia/whisper-node-addon");
require("opencc-js");
require("@xenova/transformers");
require("electron-updater");
require("url");
require("crypto");
require("worker_threads");
class CronMatcher {
  minute;
  hour;
  dom;
  month;
  dow;
  raw;
  constructor(expression) {
    this.raw = expression;
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) {
      throw new Error(`Cron expression must have 5 fields, got ${fields.length}: "${expression}"`);
    }
    this.minute = parseField(fields[0], 0, 59);
    this.hour = parseField(fields[1], 0, 23);
    this.dom = parseField(fields[2], 1, 31);
    this.month = parseField(fields[3], 1, 12);
    this.dow = parseField(fields[4], 0, 7, true);
  }
  match(date) {
    const m = date.getMinutes();
    const h = date.getHours();
    const d = date.getDate();
    const mon = date.getMonth() + 1;
    const w = date.getDay();
    if (!this.minute.includes(m)) return false;
    if (!this.hour.includes(h)) return false;
    if (!this.dom.includes(d)) return false;
    if (!this.month.includes(mon)) return false;
    if (!this.dow.includes(w)) return false;
    return true;
  }
  toString() {
    return this.raw;
  }
}
function parseField(field, min, max, normalizeDow = false) {
  if (field.includes(",")) {
    return field.split(",").flatMap((f) => parseSingle(f, min, max, normalizeDow));
  }
  return parseSingle(field, min, max, normalizeDow);
}
function parseSingle(field, min, max, normalizeDow) {
  if (field === "*") {
    return range(min, max);
  }
  const stepMatch = field.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10);
    if (step <= 0) throw new Error(`Invalid cron step: ${field}`);
    const result = [];
    for (let i = min; i <= max; i += step) result.push(i);
    return result;
  }
  const rangeMatch = field.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const a = Math.max(min, parseInt(rangeMatch[1], 10));
    const b = Math.min(max, parseInt(rangeMatch[2], 10));
    return range(a, b).map((v) => normalizeDowVal(v, normalizeDow));
  }
  const rangeStepMatch = field.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (rangeStepMatch) {
    const a = Math.max(min, parseInt(rangeStepMatch[1], 10));
    const b = Math.min(max, parseInt(rangeStepMatch[2], 10));
    const step = parseInt(rangeStepMatch[3], 10);
    const result = [];
    for (let i = a; i <= b; i += step) result.push(normalizeDowVal(i, normalizeDow));
    return result;
  }
  const num = parseInt(field, 10);
  if (isNaN(num) || num < min || num > max) {
    throw new Error(`Invalid cron field value "${field}" — expected ${min}-${max}`);
  }
  return [normalizeDowVal(num, normalizeDow)];
}
function normalizeDowVal(v, normalize) {
  if (normalize && v === 7) return 0;
  return v;
}
function range(start, end) {
  const result = [];
  for (let i = start; i <= end; i++) result.push(i);
  return result;
}
class WorkflowTriggerManager {
  cronTimer = null;
  eventUnsubscribers = [];
  lastCronCheck = 0;
  running = false;
  CRON_POLL_MS = 6e4;
  start() {
    if (this.running) return;
    this.running = true;
    this.registerEventListeners();
    this.startCronPolling();
    Logger.log("INFO", "workflow_trigger_manager_started");
  }
  stop() {
    this.running = false;
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
    for (const unsub of this.eventUnsubscribers) {
      unsub();
    }
    this.eventUnsubscribers = [];
    Logger.log("INFO", "workflow_trigger_manager_stopped");
  }
  // ── Cron 调度 ──
  startCronPolling() {
    this.cronTimer = setInterval(() => {
      if (!this.running) return;
      this.checkCronTriggers();
    }, this.CRON_POLL_MS);
    this.checkCronTriggers();
  }
  checkCronTriggers() {
    try {
      const now = /* @__PURE__ */ new Date();
      const defs = index.workflowStore.listDefinitions();
      const lastCheck = this.lastCronCheck;
      this.lastCronCheck = now.getTime();
      for (const def of defs) {
        if (def.enabled === false) continue;
        const trigger = def.trigger;
        if (!trigger || trigger.type !== "cron" || !trigger.cron) continue;
        try {
          const matcher = new CronMatcher(trigger.cron);
          const currentMinuteKey = getMinuteKey(now);
          const lastCheckMinuteKey = getMinuteKey(new Date(lastCheck));
          if (matcher.match(now) && currentMinuteKey !== lastCheckMinuteKey) {
            this.fireTrigger(def, trigger);
          }
        } catch (err) {
          Logger.log("WARN", "workflow_cron_parse_error", { defId: def.id, cron: trigger.cron, error: err.message });
        }
      }
    } catch (err) {
      Logger.log("ERROR", "workflow_cron_check_error", { error: err.message });
    }
  }
  // ── 事件触发 ──
  registerEventListeners() {
    try {
      const defs = index.workflowStore.listDefinitions();
      for (const def of defs) {
        if (def.enabled === false) continue;
        const trigger = def.trigger;
        if (!trigger || trigger.type !== "event" || !trigger.event) continue;
        const unsub = index.eventBus.on(trigger.event, () => {
          if (!this.running) return;
          Logger.log("INFO", "workflow_event_triggered", { defId: def.id, event: trigger.event });
          this.fireTrigger(def, trigger);
        });
        this.eventUnsubscribers.push(unsub);
        Logger.log("INFO", "workflow_event_listener_registered", { defId: def.id, event: trigger.event });
      }
    } catch (err) {
      Logger.log("ERROR", "workflow_event_register_error", { error: err.message });
    }
  }
  refreshEventListeners() {
    for (const unsub of this.eventUnsubscribers) {
      unsub();
    }
    this.eventUnsubscribers = [];
    this.registerEventListeners();
  }
  // ── 执行触发 ──
  fireTrigger(def, trigger) {
    try {
      const scheduler = index.getWorkflowScheduler();
      const run = scheduler.startRun(def, trigger.defaultInput);
      Logger.log("INFO", "workflow_auto_triggered", {
        defId: def.id,
        name: def.name,
        triggerType: trigger.type,
        runId: run.runId
      });
    } catch (err) {
      Logger.log("ERROR", "workflow_trigger_fire_error", { defId: def.id, triggerType: trigger.type, error: err.message });
    }
  }
}
function getMinuteKey(date) {
  return `${date.getHours()}:${date.getMinutes()}`;
}
exports.WorkflowTriggerManager = WorkflowTriggerManager;
