# GitHubTrendingCollector 采集清洗（Task b564e432 · issue #6 P1）

## 文档信息

| 项 | 值 |
| --- | --- |
| 文档 | spec · GH trending 脏数据清洗 |
| 任务 | b564e432（run c44370aa）· issue #6 问题1 |
| 日期 | 2026-10-09 |
| 状态 | approved |
| 关联 | plan：docs/taskhub/b564e432/plan.md |

## 模块职责与边界

**做**：`packages/observer/src/collectors/GitHubTrendingCollector.ts` 三处根因修复——(1) API 路径（hot.imsyy.top/hellogithub）`item.title` / `item.description` 经 `stripHtml()` 再拼 content（现 L41 直拼，产 HTML 片段条目）；(2) fallback scrape 的仓库路径提取（现 L63 `href="/([^"]+)"` 取 article 首个 href，会命中 `login?return_to=`、`sponsors/...`）改为扫描 href 直至通过两段式 `/owner/repo` 校验；(3) 描述 `.slice(0,100)` 词中硬截改为词边界截断。导出 `truncateAtWord` / `validRepoPath` 供单测直测。

**不做**：完整描述入结构化字段（问题 2 的 `metadata` 范畴，本任务只做词边界）；其他 collector；Observation 类型（P2）；store 去重（P3）；insight 抽样（P4）。不改 API 源、抓取时机、条数上限（15）。

## 详细设计

- `stripHtml`（已有，正则去标签+空白归一）：API 路径 title/desc 复用；清洗后 title 为空的条目丢弃（防 `【GitHub】 ⭐…` 空标题垃圾）。
- `validRepoPath(raw): string | null`：去 `?query`/`#hash` → 按 `/` 分段；**恰两段**；owner 在 blocklist（`login`/`sponsors`，含大小写归一）→ null；段内字符集 `[\w.-]+`（排除空段与非法字符）；返回 `owner/repo`。`login?return_to=%2F…` 去 query 后单段即拒，`sponsors/xxx` 命中 blocklist 拒，多段路径拒。
- `truncateAtWord(text, max=100)`：长度 ≤max 原样返回；否则取前 max 字符，回退到最后一个空格（仅当空格位于前半段 `> max*0.5`，防止无空格长串退化成极短前缀），trimEnd。不再产词中截断。
- fallback scrape：对 article 内 href 做 `hrefRegex` 全局扫描，取第一个 `validRepoPath` 非 null 的结果；全无合法 href 的 article（如赞助/登录页块）整体跳过。
- content 结构保持 `【GitHub】{path} ⭐{stars} — {desc}` 不变（下游解析兼容）；两路径均用词边界 desc。

## 测试

新增 `tests/main/observer/__tests__/GitHubTrendingCollector.test.ts`（root vitest，alias `@akemi-mio/observer/*`，`vi.mock` http 与 logger）：

1. helper 直测：`truncateAtWord` 词边界回退 / 短串原样 / 无空格长串不退化成极短；`validRepoPath` 对 `owner/repo` 过、`login?return_to=…` / `sponsors/x` / `a/b/c` / 空段拒。
2. API 路径：mock 返回含 `<span>` 标题、HTML 描述、空标题项 → 产出无任何 `<>` 标签、空标题项被丢、desc 为 `truncateAtWord` 结果。
3. fallback：API !ok → scrape HTML 中首个 href 为 `/login?return_to=…`、次个为 `/owner/repo` 的 article → 只收 `owner/repo`；仅含 `/sponsors/…` href 的 article 被跳过；desc 经 stripHtml + 词边界。

## 验收

- 新入库（该 collector 产出）无 HTML 片段 / `login?return_to=` / `sponsors/` 条目 = 0；描述不词中硬截。
- 新单测 + 根 vitest + typecheck（node+web）+ format:check 绿；镜像 `packages/intelligence-observer/src/collectors/GitHubTrendingCollector.ts` 同步（Node UTF-8 脚本）。
