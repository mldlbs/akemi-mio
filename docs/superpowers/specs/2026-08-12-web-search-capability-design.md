# Web Search Capability Design（联网搜索能力）

> **Status:** Design approved (2026-08-12) — awaiting spec review
> **Date:** 2026-08-12
> **Upstream:** ADR-015 capability model contract (`search.retrieval` taxonomy)
> **Related:** `src/main/capability/adapters/search-adapter.ts`; `src/main/tool/getAllTools.ts`; `src/main/bootstrap/AppRuntime.ts`

## 1. Purpose

mio 当前只有本地检索能力（`grep`、`search_files`、`search_memories` 等），没有任何真实联网搜索。ADR-015 的 `search.retrieval` 能力设计明确包含 `web_search` / `web_fetch`，但一直未实现。本设计补齐该缺口：为 mio 增加免费、免配置、国内可用的联网搜索工具。

## 2. Goals / Non-Goals

### Goals

- 新增 `web_search` 工具：关键词搜索，返回标题 / 链接 / 摘要列表
- 新增 `web_fetch` 工具：抓取指定 URL 的正文文本，配合搜索读取全文
- 免费免配置：不依赖任何 API Key，开箱即用
- 国内可用：后端按 Bing → Baidu → DuckDuckGo 顺序回退
- 接入 capability-first 模式：新增独立 `web.search` / `web.fetch` 能力，LLM 通过能力函数调用 `web_search` / `web_fetch`

### Non-Goals

- 不接入 Tavily / Serper / Brave 等付费 API（抽象层预留，后续可加）
- 不做搜索缓存、搜索历史、结果打分、结果去重
- 不改动浏览器代理（CDP）能力
- 不引入新的运行时依赖（Electron 主进程无 DOM，使用轻量字符串解析）

## 3. Design

### 3.1 工具定义

新文件 `src/main/tool/definitions/WebSearchTools.ts`，导出两个工具，均标记 `isReadOnly: true`。

#### `web_search`

```jsonc
{
  "query":        { "type": "string" },                 // 必填，搜索关键词
  "max_results":  { "type": "number", "default": 5 },   // 1–10
  "timeout_ms":   { "type": "number", "default": 8000 } // 单后端超时
}
```

返回：`title` / `url` / `snippet` 列表，附命中的搜索后端标识。

#### `web_fetch`

```jsonc
{
  "url":        { "type": "string" },                    // 必填，仅 http/https
  "max_chars":  { "type": "number", "default": 6000 },   // 500–20000
  "timeout_ms": { "type": "number", "default": 10000 }
}
```

返回：页面标题 + 正文纯文本（截断到 `max_chars`）。

### 3.2 后端回退链

```text
web_search(query)
  ├─ try Bing (cn.bing.com/search?q=)
  ├─ fallback → Baidu (baidu.com/s?wd=)
  ├─ fallback → DuckDuckGo (html.duckduckgo.com/html/?q=)
  └─ 全部失败 → 返回聚合错误（列出各后端失败原因）
```

规则：

- 每个后端：`fetch` 带常见浏览器 UA 头 + `AbortSignal.timeout(timeout_ms)`
- 后端返回结果为空（解析到 0 条）视为失败，切换到下一个
- 单次请求失败（超时 / 非 200 / 解析异常）记录原因并切换
- 命中首个返回非空结果的后端即停止

### 3.3 各后端解析策略

使用正则 / 字符串解析，不引入 DOM 解析库。

| 后端 | 结果块 | 标题 | 链接 | 摘要 |
|---|---|---|---|---|
| Bing | `li.b_algo` | `h2 a` | `cn.bing.com/ck/a?...&u=` 内 base64 解码还原真实 URL | `.b_caption p` |
| Baidu | `div.result` / `.c-container` | `h3 a` | `baidu.com/link?url=` 跳转链接，保留原样 | `.c-abstract` / `.content-right` |
| DuckDuckGo | `.result` | `.result__a` | `.result__a` 的 `href` | `.result__snippet` |

解析后的 title / snippet 需做 HTML 实体与标签清理。

### 3.4 web_fetch 正文提取

```text
校验 url（必须 http/https 且可被 URL 解析）
  → fetch HTML（带 UA + timeout）
  → 移除 <script>/<style>/<noscript>/<svg> 等节点内容
  → 块级标签（p/div/li/h1-h6/br 等）替换为换行
  → 剥离剩余标签
  → 解码常见 HTML 实体
  → 折叠空白行
  → 提取 <title> 与 meta description 置于开头
  → 按 max_chars 截断
```

### 3.5 配置

可选环境变量（不配置也能用，均为兜底默认值）：

```text
SEARCH_TIMEOUT_MS   默认 8000   覆盖单后端超时
SEARCH_MAX_RESULTS  默认 5      覆盖默认返回条数
```

同步更新 `.env.template` 并注释说明。

## 4. Integration Points

| 文件 | 改动 |
|---|---|
| `src/main/tool/definitions/WebSearchTools.ts` | 新增，两个工具实现 |
| `src/main/tool/getAllTools.ts` | import 并注册 `web_search` / `web_fetch` |
| `src/main/bootstrap/AppRuntime.ts` | 新增 `web-search` / `web-fetch` 两个 manifest（`web.search` / `web.fetch` 能力 + capabilitySchemas + dependencies + `network.http` 权限）；注册 `setAdapter('web-search', 'web_search')` 与 `setAdapter('web-fetch', 'web_fetch')` |
| `src/main/tool/__tests__/index.test.ts` | READONLY_TOOLS 集合增加 `web_search` / `web_fetch` |
| `.env.template` | 增加 `SEARCH_TIMEOUT_MS` / `SEARCH_MAX_RESULTS` 注释项 |

说明：

- `src/main/capability/adapters/search-adapter.ts` 已包含 `web_search` / `web_fetch` 的 canonical → tool 参数映射，无需改动
- 新增的 `web-search` / `web-fetch` manifest 各自声明 `permissions: ['network.http']`，覆盖联网请求
- 保留 search-engine manifest 的 `search.retrieval → web_search / web_fetch` 依赖（对 `call_raw_tool` / dual 路由无害）
- **为何新增独立 capability**：capability-first 模式下 LLM 只能看到能力函数 schema。`search.retrieval` 的 defaultTool 是 `grep`，其 schema 为 `{operation, query, scope}` 且无工具选择字段，走不到 web 搜索；独立 `web.search` / `web.fetch` 让 LLM 直接以 `{query}` / `{url}` 调用对应工具
- 工具经 `LocalProviderAdapter` → `ServerManager` 暴露给 LLM，注册后即时可用

## 5. Tests

新增 `src/main/tool/__tests__/WebSearchTools.test.ts`（mock `globalThis.fetch`）：

- 三个后端各自的 HTML 解析正确性（标题 / 链接 / 摘要）
- Bing 跳转链接 `u=` base64 解码还原真实 URL
- 回退链：首个后端失败自动切换到下一个
- 全部后端失败时返回聚合错误信息
- `web_fetch`：正文提取、标签剥离、`max_chars` 截断
- `web_fetch` 非法 URL（非 http/https）拒绝
- 参数 clamp（`max_results` / `max_chars` 边界）

回归：`src/main/tool/__tests__/index.test.ts` 现有断言（工具总数 `>= 50`、无重名、只读集合）保持通过。

新增 `src/main/capability/__tests__/WebSearchCapability.test.ts`：注册 `web-search` / `web-fetch` manifest，断言 `CapabilityCatalog` + `CapabilityResolver` 将 `web.search` → `web_search`、`web.fetch` → `web_fetch`，并校验 `web.search` 能力 schema 字段。

## 6. Verification

1. `npm run typecheck`
2. `npx vitest run src/main/tool/__tests__/WebSearchTools.test.ts src/main/tool/__tests__/index.test.ts src/main/capability/__tests__/WebSearchCapability.test.ts`
3. 真实网络冒烟：直接调用工具实现，确认 Bing / Baidu 实际可抓取并解析出结果（环境允许联网时执行）

## 7. Risks & Mitigations

| 风险 | 影响 | 缓解 |
|---|---|---|
| 搜索引擎 HTML 结构变更 | 解析失败 | 多后端回退链自动切换；解析逻辑集中在独立函数，便于修补 |
| 目标站点反爬 / 限流 | 请求被拒 | 浏览器 UA + 超时控制；失败快速切换后端并返回可读错误 |
| 搜索结果含无关 / 低质内容 | 用户体验下降 | 依赖 LLM 结合 snippet 判断；`max_results` 默认 5 控制噪音 |
| `web_fetch` 被用于抓取任意内网地址 | 安全边界 | 仅允许 `http/https`；桌面助手场景由用户授权触发，文档注明 |

## 8. Future Extension

- 后端抽象层预留 `SearchProvider` 接口，后续可低成本接入 Tavily / Serper（读取 `SEARCH_API_KEY` 等配置自动切换）
- 可在 `web_search` 增加 `engine` 参数手动指定后端
