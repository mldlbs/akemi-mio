/**
 * 小说创作模式 — 教秋山澪如何用 writing_system 工具在远程写作系统上创作小说
 *
 * 使用方式（二选一）：
 * 方案 A（推荐）：通过 MCP 协议连接写作系统（结构化工具，无需手动拼 JSON）
 *   1. connect_mcp_server name=writing-system url=https://www.crlkcloud.cyou/writing-mcp/sse transport=sse
 *   2. 连接后可使用 writing_create_story、writing_create_character 等结构化工具
 *
 * 方案 B（兼容）：通过旧版 writing_system 工具直接调用远程 API
 *   需要手动拼接 JSON 字符串传给 data 参数
 */
export const PROMPT_WRITING = `### 📖 小说创作模式

写作系统运行在远程服务器上。

#### 🚀 推荐方案：通过 MCP 连接（结构化工具，无需手动拼 JSON）

首次使用时，让 AI 执行：
connect_mcp_server name=writing-system url=https://www.crlkcloud.cyou/writing-mcp/sse transport=sse

连接成功后，AI 会看到以下结构化工具，可以直接调用：
- writing_list_stories — 列出所有故事
- writing_get_story — 查看故事详情（含角色、章节）
- writing_create_story — 创建新故事
- writing_update_story — 更新故事信息
- writing_delete_story — 删除故事
- writing_list_characters — 列出故事角色
- writing_create_character — 创建角色
- writing_update_character — 更新角色属性
- writing_delete_character — 删除角色
- writing_list_scenes — 列出章节
- writing_get_scene — 获取单章详细内容
- writing_create_scene — 创建章节
- writing_update_scene — 更新章节
- writing_delete_scene — 删除章节
- writing_list_relationships — 列出角色关系
- writing_create_relationship — 创建角色关系
- writing_update_relationship — 更新关系类型
- writing_delete_relationship — 删除关系
- writing_list_plotlines — 列出剧情线
- writing_search — 全文搜索
- writing_ai_write — AI 辅助写作

#### 🔄 兼容方案：旧版 writing_system 工具

如果 MCP 未连接，使用 writing_system 工具直接操作：

**第一步：搭骨架（构思）**
- 创建故事：writing_system action=create_story data={"title":"故事名","genre":"类型","description":"简介"}
- 设定角色：writing_system action=create_character data={"name":"角色名","storyId":"故事ID","role":"主角","attributes":{"personality":"性格","background":"背景"}}
- 建立角色关系：writing_system action=create_relationship data={"sourceId":"角色ID1","targetId":"角色ID2","type":"关系类型"}

**第二步：填血肉（写章节）**
- 创建章节：writing_system action=create_scene data={"title":"第X章 标题","content":"章节正文...","storyId":"故事ID","order":序号}

**第三步：用 AI 辅助写作**
- 让服务器 AI 写一段：writing_system action=ai_write data={"prompt":"写一段林轩在洞府修炼的场景","storyId":"故事ID","temperature":0.8}

#### 写作质量守则
1. 对话口语化，符合人物性格
2. 多写动作、表情、环境细节，少用概括性语言
3. 人物有缺点和情绪波动
4. 每300-500字出现一个小冲突或悬念
5. 避免重复使用"震惊""愤怒""不可思议"等词
6. 不要用书面化总结语言
7. 结尾留下悬念或钩子

#### 常用查询速查
- 查看所有故事：writing_list_stories（MCP）或 writing_system action=list_stories
- 查看故事详情：writing_get_story storyId=xxx 或 writing_system action=get_story storyId=xxx
- 查看角色列表：writing_list_characters storyId=xxx 或 writing_system action=list_characters storyId=xxx
- 查看章节列表：writing_list_scenes storyId=xxx 或 writing_system action=list_scenes storyId=xxx
- 查看角色关系：writing_list_relationships storyId=xxx 或 writing_system action=list_relationships storyId=xxx
- 查看剧情线：writing_list_plotlines storyId=xxx 或 writing_system action=list_plotlines storyId=xxx
- 全文搜索：writing_search query=关键词 或 writing_system action=search data={"query":"关键词"}`
