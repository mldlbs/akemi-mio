"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const Logger = require("./Logger-BD3PzZBa.js");
const index = require("../index.js");
require("fs");
require("path");
require("https");
require("electron");
require("events");
require("child_process");
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
class EvolutionGitOps {
  constructor() {
  }
  async autoGitCommit(planTitle) {
    try {
      await index.execAsync("git add -A", { timeout: 15e3 });
      await index.execAsync(`git commit -m "[evolution] ${planTitle}"`, { timeout: 15e3 });
      Logger.log("INFO", "evolution_auto_commit", { planTitle });
    } catch (err) {
      Logger.log("INFO", "evolution_auto_commit_skip", { error: err.message?.slice(0, 100) });
    }
  }
  async workspacePreCheck(lastSuccessTime) {
    try {
      const oneHourAgo = Date.now() - 60 * 60 * 1e3;
      if (lastSuccessTime > 0 && lastSuccessTime > oneHourAgo) return false;
      const status = await index.execAsync("git status --short", { timeout: 1e4 });
      const dirtyCount = status.trim() ? status.trim().split("\n").length : 0;
      if (dirtyCount > 5) {
        await index.execAsync('git stash push -m "[evolution] auto-stash pre-analysis"', { timeout: 15e3 });
        Logger.log("INFO", "evolution_workspace_stashed", { dirtyCount });
        return true;
      }
    } catch (err) {
      Logger.log("INFO", "evolution_workspace_stash_skip", { error: err.message?.slice(0, 100) });
    }
    return false;
  }
  async workspacePostRestore() {
    try {
      await index.execAsync("git stash pop", { timeout: 15e3 });
      Logger.log("INFO", "evolution_workspace_stash_restored");
    } catch (err) {
      Logger.log("INFO", "evolution_workspace_stash_restore_skip", { error: err.message?.slice(0, 100) });
    }
  }
  async collectChangedFiles() {
    try {
      const output = await index.execAsync("git status --porcelain 2>&1", { timeout: 5e3 });
      const lines = (output || "").split("\n").filter(Boolean);
      const newFiles = [];
      const modifiedFiles = [];
      for (const line of lines) {
        const status = line.slice(0, 2).trim();
        const file = line.slice(3).trim();
        if (status === "??" || status.startsWith("A")) newFiles.push(file);
        else if (status.startsWith("M") || status.startsWith("R")) modifiedFiles.push(file);
      }
      return { newFiles, modifiedFiles };
    } catch {
      return { newFiles: [], modifiedFiles: [] };
    }
  }
  async getCurrentBranch() {
    try {
      const result = await index.execAsync("git rev-parse --abbrev-ref HEAD", { timeout: 1e4 });
      return result.trim();
    } catch {
      return "unknown";
    }
  }
  async createSnapshot(tag) {
    try {
      await index.execAsync("git add -A", { timeout: 15e3 });
      await index.execAsync(`git commit -m "[snapshot] ${tag}"`, { timeout: 15e3 });
      const branch = `evolution/snapshot/${tag}_${Date.now()}`;
      await index.execAsync(`git branch ${branch}`, { timeout: 1e4 });
      Logger.log("INFO", "evolution_snapshot_created", { tag, branch });
      return branch;
    } catch (err) {
      Logger.log("WARN", "evolution_snapshot_failed", { error: err.message?.slice(0, 100) });
      return null;
    }
  }
  async rollbackToSnapshot(branch, level = "module") {
    try {
      const currentBranch = await this.getCurrentBranch();
      await index.execAsync('git stash push -m "[rollback] auto-stash before rollback"', { timeout: 15e3 });
      await index.execAsync(`git checkout ${branch} -- .`, { timeout: 15e3 });
      if (level === "module" || level === "system") {
        await index.execAsync("git clean -fd", { timeout: 15e3 });
      }
      await index.execAsync(`git checkout ${currentBranch}`, { timeout: 1e4 });
      Logger.log("INFO", "evolution_rollback_completed", { branch, level });
      return true;
    } catch (err) {
      Logger.log("ERROR", "evolution_rollback_failed", { error: err.message?.slice(0, 100) });
      return false;
    }
  }
  async rollback(level, ref) {
    return this.rollbackToSnapshot(ref, level);
  }
  async cleanupSnapshot(branch) {
    try {
      await index.execAsync(`git branch -D ${branch}`, { timeout: 1e4 });
      Logger.log("INFO", "evolution_snapshot_cleaned", { branch });
      return true;
    } catch (err) {
      Logger.log("WARN", "evolution_snapshot_cleanup_failed", { error: err.message?.slice(0, 100) });
      return false;
    }
  }
}
exports.EvolutionGitOps = EvolutionGitOps;
