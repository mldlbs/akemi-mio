"use strict";
require("../chunks/base-worker-B5kAfkpk.js");
require("worker_threads");
const IGNORED_TS_CODES = ["TS6305", "TS6192", "TS5053"];
function runCompileCheck() {
  try {
    const { execSync } = require("child_process");
    const output = execSync("npx tsc --noEmit --pretty false 2>&1", {
      cwd: process.cwd(),
      timeout: 6e4,
      encoding: "utf-8",
      windowsHide: true
    });
    const errors = output.match(/error TS\d+/g) || [];
    const filtered = errors.filter((e) => !IGNORED_TS_CODES.some((code) => e.includes(code)));
    return { passed: filtered.length === 0, errors: filtered.length > 0 ? [output.slice(0, 500)] : [] };
  } catch (e) {
    const text = e.stdout || e.message || "";
    const errors = text.match(/error TS\d+/g) || [];
    const filtered = errors.filter((e2) => !IGNORED_TS_CODES.some((code) => e2.includes(code)));
    return { passed: filtered.length === 0, errors: filtered.length > 0 ? [text.slice(0, 500)] : [] };
  }
}
function runTestCheck() {
  try {
    const { execSync } = require("child_process");
    const output = execSync("npx vitest run --reporter=json 2>&1", {
      cwd: process.cwd(),
      timeout: 12e4,
      encoding: "utf-8",
      windowsHide: true,
      shell: true
    });
    const total = parseInt(output.match(/(\d+)\s+tests/)?.[1] || "0");
    const failed = parseInt(output.match(/(\d+)\s+failed/)?.[1] || "0");
    return { passed: failed === 0, passedCount: total - failed, failedCount: failed, output: output.slice(0, 500) };
  } catch (e) {
    const text = e.stdout || e.message || "";
    const total = parseInt(text.match(/(\d+)\s+tests/)?.[1] || "0");
    const failed = parseInt(text.match(/(\d+)\s+failed/)?.[1] || "0");
    return { passed: failed === 0, passedCount: total - failed, failedCount: failed, output: text.slice(0, 500) };
  }
}
function runLintCheck(changedFiles) {
  const tsFiles = changedFiles.filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
  if (tsFiles.length === 0) return { passed: true, errors: [] };
  try {
    const { execSync } = require("child_process");
    const output = execSync(`npx eslint ${tsFiles.join(" ")} --format=compact 2>&1`, {
      cwd: process.cwd(),
      timeout: 3e4,
      encoding: "utf-8",
      windowsHide: true,
      shell: true
    });
    const errors = (output.match(/error/g) || []).length;
    return { passed: errors === 0, errors: errors > 0 ? [output.slice(0, 500)] : [] };
  } catch (e) {
    const text = e.stderr || e.stdout || e.message || "";
    const errors = (text.match(/error/g) || []).length;
    return { passed: errors === 0, errors: errors > 0 ? [text.slice(0, 500)] : [] };
  }
}
globalThis.__workerHandler = async (data) => {
  const { config, changedFiles } = data;
  const checks = {};
  if (config.compileCheck) checks.compile = runCompileCheck();
  if (config.testRun) checks.test = runTestCheck();
  if (config.lintCheck) checks.lint = runLintCheck(changedFiles);
  return { checks, duration: Date.now(), affectedFiles: changedFiles };
};
