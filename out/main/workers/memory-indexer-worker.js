"use strict";
require("../chunks/base-worker-B5kAfkpk.js");
require("worker_threads");
const PATTERNS = [
  { type: "architecture_pattern", regex: /(?:架构|体系|分层|模块|服务)[：:]\s*(.+?)[。\n]/ },
  { type: "design_decision", regex: /(?:决定|选择|采用|改为|弃用)[：:]\s*(.+?)[。\n]/ },
  { type: "failure_pattern", regex: /(?:错误|失败|异常|崩溃|超时|挂起|卡死)[：:]\s*(.+?)[。\n]/ },
  { type: "test_pattern", regex: /(?:测试|测试用例|集成测试|单元测试)[：:]\s*(.+?)[。\n]/ },
  { type: "coding_convention", regex: /(?:约定|规范|命名|风格|格式)[：:]\s*(.+?)[。\n]/ }
];
function inferTags(type, content) {
  const tags = [type.replace("_", ":")];
  const keywords = content.match(/[a-zA-Z]{3,}/g) || [];
  for (const kw of keywords.slice(0, 3)) {
    tags.push(kw.toLowerCase());
  }
  return tags;
}
globalThis.__workerHandler = async (data) => {
  const { entries, lastIndexed } = data;
  const knowledgeEntries = [];
  const engineeringEntries = [];
  for (const entry of entries) {
    if (entry.type === "user_fact" && entry.confidence >= 0.6) {
      knowledgeEntries.push({ content: entry.content, confidence: entry.confidence });
    }
    if (entry.updatedAt <= lastIndexed) continue;
    for (const p of PATTERNS) {
      const match = entry.content.match(p.regex);
      if (match) {
        engineeringEntries.push({
          type: p.type,
          content: match[1].trim(),
          source: `memory:${entry.id || "unknown"}`,
          confidence: entry.confidence * 0.8,
          relatedFiles: [],
          tags: inferTags(p.type, match[1])
        });
      }
    }
  }
  return { knowledgeEntries, engineeringEntries };
};
