# P1.3b Phase B 初步观测报告

## 数据概况

| 指标 | 值 |
|------|-----|
| LLM interactions | 3 (pb_1, pb_2, pb_3) |
| Capability-related attempts | 2 (browser_automation, web_scraping) |
| llm+tool_calls | 8 次 (3 轮对话) |

## 事件汇总

```
pb_1: "打开 baidu.com"
  tool_llm_tool_calls → [browser_automation]  ✅ LLM 选择了 capability！
  tool_llm_tool_calls → [web_scraping]         ✅ LLM 选择了 capability！
  tool_llm_tool_calls → [call_raw_tool]        ⚠️ 降级到回退
  → 最终成功：标题 "百度一下，你就知道"

pb_2: "搜索前端技术新闻"
  tool_llm_tool_calls → [call_raw_tool]         ⚠️ 直接走回退
  → browser_navigate ✅ → browser_get_snapshot ❌（未知工具）
  → 连续 3 次失败，返回文本回复

pb_3: "写朋友圈文案"
  tool_llm_tool_calls → 无工具调用（纯文本生成）
  → 成功
```

## 发现 1 ✅ 核心假设成立：LLM 主动选择 Capability

这是最重要的事实——**LLM 在 capability-first 模式下，面对 "4+1" 个函数，主动选择了 `browser_automation` 和 `web_scraping`**。

P1.3a 的结论（capability.selected = 0）已经被推翻：
```
P1.3a: 4 + 173 raw tools → LLM 选 raw tools ← 被淹没
P1.3b: 4 capabilities + 1 fallback → LLM 选 capabilities ← ✅
```

## 发现 2 ❌ Capability Invocation 有 bug：Tool 名映射错误

LLM 选择了 `browser_automation` 但调用失败了。根因：

```
CapabilityCatalog 的 defaultTool 解析逻辑：
  tools = dependencies.filter(d => d.capability === capId).map(d => d.capability)
        = ["browser.automation"]  // ← 这里应该是 ACTUAL MCP tool name

所以：
  resolver.resolve("browser.automation")
  → binding.tool = "browser.automation"  ❌ 不是 "browser_navigate"

invoke 时：
  getAdapter("playwright", "browser.automation") → undefined  ❌ key 不匹配
  callTool("browser.automation", input) → 失败 ❌ MCP 没有这个工具
```

LLM 发现自己调了 `browser_automation` 没反应，3s 后就 fallback 到 `call_raw_tool("browser_navigate")` 了。这说明：
1. LLM **愿意**用 capability ✅
2. Capability 路由链路跑通了（selected → resolve）✅
3. 但 **defaultTool 不是真实的 MCP 工具名**，导致 invoke 失败 ❌

## 发现 3 ⚠️ browser_get_snapshot 工具缺失

```
call_raw_tool("browser_get_snapshot")
→ ServerManager: 未知工具: browser_get_snapshot
```

这是 Playwright MCP 暴露的工具名与系统注册的工具名不一致的问题（或 LLM 猜错了工具名）。在 dual mode 下同样会出现。

## 初步结论

**capability-first 模式的行为层验证已经通过了一半：**

| 指标 | 状态 | 说明 |
|------|------|------|
| capability.selected > 0 | ✅ | browser_automation, web_scraping 都被选中 |
| LLM 接受新的函数空间 | ✅ | 4+1 个函数没有让 LLM 困惑 |
| selected → invoked | ❌ | 因 defaultTool 映射错误，invoke 失败 |
| invoked → completed | ⏸ | 等 fix 后验证 |
| raw fallback 可用 | ✅ | call_raw_tool("browser_navigate") 正常工作 |

**修复方案：** CapabilityCatalog 的 `defaultTool` 应该是实际的 MCP tool name（如 `browser_navigate`），或者 adapter 的 key 改为用 capability id。当前 manifest 的 dependencies 映射把 capability id 当 tool name 用了。

需要我先修这个 bug 再继续收集数据吗？
