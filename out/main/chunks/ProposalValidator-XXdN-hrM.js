"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const path = require("path");
const Logger = require("./Logger-BD3PzZBa.js");
const index = require("../index.js");
require("fs");
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
class ProposalValidator {
  constitution = null;
  planManager = null;
  resourceBudget = null;
  stabilityScore = null;
  setConstitution(engine) {
    this.constitution = engine;
  }
  setPlanManager(mgr) {
    this.planManager = mgr;
  }
  setResourceBudget(budget) {
    this.resourceBudget = budget;
  }
  setStabilityScore(ss) {
    this.stabilityScore = ss;
  }
  async validate(proposal) {
    const constitutional = this.checkConstitutional(proposal.targetFiles);
    const scopeCheck = this.checkScope(proposal);
    const regressionRisk = this.assessRegressionRisk(proposal.targetFiles);
    const budgetCheck = this.checkBudget(proposal);
    const passed = constitutional.passed && scopeCheck.passed && (budgetCheck?.passed ?? true);
    Logger.log("INFO", "proposal_validation", { proposalId: proposal.id, passed, regressionRisk });
    const result = { proposalId: proposal.id, passed, constitutional, scopeCheck, regressionRisk, budgetCheck };
    index.eventBus.emit("evolution.proposal.validated", {
      proposalId: proposal.id,
      passed,
      regressionRisk
    });
    return result;
  }
  checkConstitutional(targetFiles) {
    const violations = [];
    if (!this.constitution) return { passed: true, violations: [] };
    for (const file of targetFiles) {
      const absolutePath = path.resolve(index.DEV_PROJECT_ROOT || process.cwd(), file);
      const check = this.constitution.checkWrite(absolutePath);
      if (!check.allowed) violations.push(`${file}: ${check.violation?.reason || "路径受保护"}`);
    }
    return { passed: violations.length === 0, violations };
  }
  checkScope(proposal) {
    if (!proposal.targetFiles?.length) return { passed: false, message: "提案未指定目标文件" };
    if ((proposal.title || "").length < 3) return { passed: false, message: "提案标题过短" };
    return { passed: true, message: "范围检查通过" };
  }
  assessRegressionRisk(targetFiles) {
    const risky = targetFiles.filter(
      (f) => ["core/", "eventbus", "scheduler", "lifecycle", "constitution"].some((p) => f.toLowerCase().includes(p))
    );
    if (risky.length > 1) return "high";
    if (risky.length > 0) return "medium";
    return "low";
  }
  checkBudget(proposal) {
    if (!this.resourceBudget) return void 0;
    const check = this.resourceBudget.checkLlmCall("evolution");
    if (check) {
      return { passed: false, message: `预算不足: ${check}` };
    }
    if (proposal.risk === "high" || this.stabilityScore?.getScore() < 70) {
      const doubleCheck = this.resourceBudget.checkLlmCall("evolution");
      if (doubleCheck) {
        return { passed: false, message: `高风险提案预算不足: ${doubleCheck}` };
      }
    }
    return { passed: true, message: "预算充足" };
  }
}
exports.ProposalValidator = ProposalValidator;
