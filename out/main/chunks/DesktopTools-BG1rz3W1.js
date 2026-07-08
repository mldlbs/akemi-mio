"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const require$$0 = require("child_process");
const promises = require("fs/promises");
const path = require("path");
const fs = require("fs");
const index = require("../index.js");
const Logger = require("./Logger-BD3PzZBa.js");
require("electron");
require("events");
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
require("dns/promises");
require("net");
require("@kutalia/whisper-node-addon");
require("opencc-js");
require("@xenova/transformers");
require("crypto");
require("electron-updater");
require("url");
require("worker_threads");
const DESKTOP_DIR = path.join(index.WORKSPACE.cache, "desktop_tasks");
async function ensureDir() {
  if (!fs.existsSync(DESKTOP_DIR)) {
    await promises.mkdir(DESKTOP_DIR, { recursive: true });
  }
}
const desktopQuickNoteTool = index.buildTool({
  name: "desktop_quick_note",
  description: "快速保存一条笔记到桌面工作区。内容支持 Markdown 格式。",
  inputJSONSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "笔记内容，支持 Markdown" },
      title: { type: "string", description: "笔记标题（可选，默认取时间戳）" }
    },
    required: ["content"]
  },
  handler: async (args) => {
    try {
      await ensureDir();
      const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const title = args.title || `笔记_${timestamp}`;
      const safeName = title.replace(/[<>:"/\\|?*]/g, "_").slice(0, 60);
      const filePath = path.join(DESKTOP_DIR, `${safeName}_${timestamp}.md`);
      const header = `# ${title}
> 创建于 ${(/* @__PURE__ */ new Date()).toLocaleString("zh-CN")}

`;
      await promises.writeFile(filePath, header + args.content, "utf-8");
      Logger.log("INFO", "desktop_quick_note_saved", { title: safeName, path: filePath });
      return index.formatToolResult(`笔记已保存: ${safeName}`);
    } catch (err) {
      Logger.log("ERROR", "desktop_quick_note_failed", { error: String(err) });
      return index.formatToolError(`保存笔记失败: ${err.message}`);
    }
  },
  serverName: "@builtin/desktop",
  isReadOnly: false
});
const TODO_FILE = path.join(DESKTOP_DIR, "todos.json");
async function readTodos() {
  try {
    if (!fs.existsSync(TODO_FILE)) return [];
    const raw = await promises.readFile(TODO_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
async function writeTodos(todos) {
  await ensureDir();
  await promises.writeFile(TODO_FILE, JSON.stringify(todos, null, 2), "utf-8");
}
const desktopTodoAddTool = index.buildTool({
  name: "desktop_todo_add",
  description: "添加一条待办事项到桌面任务列表。",
  inputJSONSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "待办事项标题" },
      priority: { type: "string", enum: ["low", "normal", "high"], description: "优先级（默认 normal）" }
    },
    required: ["title"]
  },
  handler: async (args) => {
    try {
      await ensureDir();
      const todos = await readTodos();
      const item = {
        id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: args.title,
        priority: args.priority || "normal",
        createdAt: Date.now(),
        done: false
      };
      todos.push(item);
      await writeTodos(todos);
      const priorityLabel = { low: "低", normal: "中", high: "高" }[item.priority];
      Logger.log("INFO", "desktop_todo_added", { title: args.title, priority: item.priority });
      return index.formatToolResult(`待办已添加 [${priorityLabel}优先级]: ${args.title}
当前共 ${todos.length} 项待办，${todos.filter((t) => !t.done).length} 项未完成`);
    } catch (err) {
      Logger.log("ERROR", "desktop_todo_add_failed", { error: String(err) });
      return index.formatToolError(`添加待办失败: ${err.message}`);
    }
  },
  serverName: "@builtin/desktop",
  isReadOnly: false
});
const APP_ALIASES = {
  vscode: "code",
  code: "code",
  "visual studio code": "code",
  terminal: "wt",
  wt: "wt",
  "windows terminal": "wt",
  cmd: "cmd",
  explorer: "explorer",
  notepad: "notepad",
  记事本: "notepad",
  calculator: "calc",
  计算器: "calc",
  edge: "start microsoft-edge:",
  chrome: "start chrome:",
  firefox: "start firefox:",
  浏览器: "start microsoft-edge:",
  wechat: `start "" "${process.env.LOCALAPPDATA || ""}\\Programs\\WeChat\\WeChat.exe"`,
  微信: `start "" "${process.env.LOCALAPPDATA || ""}\\Programs\\WeChat\\WeChat.exe"`
};
const desktopAppLaunchTool = index.buildTool({
  name: "desktop_app_launch",
  description: "启动 Windows 应用程序。支持常用别名（vscode, terminal, notepad, calc, edge, chrome, wechat 等）。",
  inputJSONSchema: {
    type: "object",
    properties: {
      appName: { type: "string", description: "应用名称或别名（如 vscode, terminal, notepad, chrome, wechat）" }
    },
    required: ["appName"]
  },
  handler: async (args) => {
    const { appName } = args;
    const command = APP_ALIASES[appName.toLowerCase()] || `start "" "${appName}"`;
    return new Promise((resolve) => {
      require$$0.exec(command, { windowsHide: true, timeout: 1e4 }, (err, stdout, stderr) => {
        if (err) {
          Logger.log("WARN", "desktop_app_launch_failed", { appName, error: String(err) });
          resolve(index.formatToolError(`启动失败: ${err.message}`));
        } else {
          Logger.log("INFO", "desktop_app_launched", { appName, command });
          resolve(index.formatToolResult(`已启动: ${appName}`));
        }
      });
    });
  },
  serverName: "@builtin/desktop",
  isReadOnly: false
});
const desktopTools = [desktopQuickNoteTool, desktopTodoAddTool, desktopAppLaunchTool];
exports.desktopAppLaunchTool = desktopAppLaunchTool;
exports.desktopQuickNoteTool = desktopQuickNoteTool;
exports.desktopTodoAddTool = desktopTodoAddTool;
exports.desktopTools = desktopTools;
