/**
 * FanqiePublishTools — 番茄小说发布 + 认证探针工具
 *
 * fanqie_publish_novel — 从写作系统获取小说内容
 * fanqie_auth_inspect — 认证探针，检查 Playwright 浏览器上下文中的所有认证存储层
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import { fetchScene, fetchAllScenes } from '../../fanqie-publish/FanqiePublisher'

export const fanqieAuthInspectTool = buildTool({
  name: 'fanqie_auth_inspect',
  description:
    '【认证探针】检查 Playwright 浏览器当前上下文中的所有认证存储层（Cookie、localStorage、sessionStorage、IndexedDB），' +
    '判断是否有番茄小说的登录态。在操作番茄作者平台前先调用此工具确认认证状态。' +
    '使用方式：在 browser_navigate 到相关页面后调用此工具。',
  inputJSONSchema: {
    type: 'object' as const,
    properties: {
      targetUrl: {
        type: 'string',
        description: '要检查的目标域名，如 fanqienovel.com 或 author.fanqienovel.com',
      },
    },
    required: ['targetUrl'],
  },
  handler: async (args: Record<string, any>) => {
    const { targetUrl } = args as { targetUrl: string }
    const domain = targetUrl.replace(/^https?:\/\//, '').split('/')[0]

    const lines: string[] = [
      '## 认证探针指令',
      '',
      '请使用 Playwright MCP 的 `browser_evaluate` 工具，在浏览器中依次执行以下 JS，检查目标域名 **' + domain + '** 的认证状态：',
      '',
      '### 1. Cookie 检查',
      '```js',
      '(() => {',
      '  const cookies = document.cookie.split(";").map(c => c.trim()).filter(Boolean);',
      '  const target = cookies.filter(c =>',
      '    c.includes("session") || c.includes("token") || c.includes("auth") || c.includes("sid") || c.includes("passport")',
      '  );',
      '  return { all: cookies, authRelated: target, count: cookies.length };',
      '})()',
      '```',
      '',
      '### 2. localStorage 检查',
      '```js',
      '(() => {',
      '  const keys = Object.keys(localStorage);',
      '  const authKeys = keys.filter(k =>',
      '    k.toLowerCase().includes("token") || k.toLowerCase().includes("auth") ||',
      '    k.toLowerCase().includes("session") || k.toLowerCase().includes("user")',
      '  );',
      '  const result = {};',
      '  for (const k of authKeys) {',
      '    const v = localStorage.getItem(k);',
      '    result[k] = v ? v.substring(0, 100) + (v.length > 100 ? "..." : "") : null;',
      '  }',
      '  return { allKeys: keys, authKeys: result };',
      '})()',
      '```',
      '',
      '### 3. sessionStorage 检查',
      '```js',
      '(() => {',
      '  const keys = Object.keys(sessionStorage);',
      '  const authKeys = keys.filter(k =>',
      '    k.toLowerCase().includes("token") || k.toLowerCase().includes("auth") ||',
      '    k.toLowerCase().includes("session") || k.toLowerCase().includes("user")',
      '  );',
      '  const result = {};',
      '  for (const k of authKeys) {',
      '    const v = sessionStorage.getItem(k);',
      '    result[k] = v ? v.substring(0, 100) + (v.length > 100 ? "..." : "") : null;',
      '  }',
      '  return { allKeys: keys, authKeys: result };',
      '})()',
      '```',
      '',
      '### 4. 当前页面 URL + 标题',
      '```js',
      '(() => ({ url: window.location.href, title: document.title, origin: window.location.origin }))()',
      '```',
      '',
      '### 5. 当前浏览器上下文诊断',
      '```js',
      '(() => ({ webdriver: navigator.webdriver, userAgent: navigator.userAgent, cookieEnabled: navigator.cookieEnabled }))()',
      '```',
      '',
      '### 诊断结论',
      '',
      '根据返回结果判断：',
      '',
      '| Cookie 有 | localStorage 有 | 结论 |',
      '|-----------|----------------|------|',
      '| ✅ | ✅ 或 ❌ | 已登录，可直接操作 |',
      '| ❌ | ✅ | Token 在 localStorage |',
      '| ❌ | ❌ | **未登录**，需先登录 |',
      '| 有但 URL 跳转 | — | Session 过期或设备绑定 |',
      '',
      '执行完毕后，把**所有 5 项的结果汇总**告诉我，我帮你判断登录态在哪里。',
    ]

    return formatToolResult(lines.join('\n'))
  },
})

export const fanqiePublishNovelTool = buildTool({
  name: 'fanqie_publish_novel',
  description:
    '【番茄小说发布助手】从写作系统获取小说章节内容，并给出发布指导。\n' +
    '这个工具只负责获取内容，不操作浏览器。MIO 在获得内容后，使用 Playwright MCP 工具' +
    '（browser_navigate, browser_click, browser_snapshot, browser_fill_form, browser_type 等）' +
    '在番茄小说作者平台完成实际的章节发布操作。\n' +
    '返回内容包括章节标题、正文、发布步骤指南。',
  inputJSONSchema: {
    type: 'object' as const,
    properties: {
      storyId: {
        type: 'string',
        description: '写作系统中的小说ID',
      },
      sceneId: {
        type: 'string',
        description: '写作系统中的章节ID（发布单章时使用，与 publishAllScenes 二选一）',
      },
      publishAllScenes: {
        type: 'boolean',
        description: '是否发布该小说的所有章节（获取全部章节列表供后续逐个发布）',
      },
      mode: {
        type: 'string',
        enum: ['draft', 'publish'],
        description: '发布模式：draft(保存草稿) / publish(直接发布)，默认 draft',
      },
    },
    required: ['storyId'],
  },
  handler: async (args: Record<string, any>) => {
    try {
      const { storyId, sceneId, publishAllScenes, mode = 'draft' } = args

      if (!storyId) {
        return formatToolError('需要 storyId')
      }

      if (publishAllScenes) {
        // 批量模式：返回全部章节列表
        const { storyTitle, scenes, loginEstablished } = await fetchAllScenes(storyId)

        if (scenes.length === 0) {
          return formatToolResult(`故事"${storyTitle}"暂无章节可发布。`)
        }

        const sceneList = scenes
          .map((s, i) => `  ${i + 1}. [${s.id}] ${s.title || `第${s.order}章`}`)
          .join('\n')

        const loginNote = loginEstablished
          ? '✅ 已登录（cookie 有效）'
          : '⚠️ 需要先登录：打开 browser_navigate 到 author.fanqienovel.com，在浏览器中扫码登录'

        return formatToolResult(
          '📚 **内容已就绪，请 MIO 按以下步骤发布**\n\n' +
          `📖 作品：${storyTitle}\n` +
          `📄 共 ${scenes.length} 个章节\n\n` +
          `${loginNote}\n\n` +
          `### 发布步骤\n\n` +
          `1. 如果未登录，先使用 \`browser_navigate\` 打开 https://author.fanqienovel.com\n` +
          `2. 使用 \`browser_snapshot\` 查看当前页面状态\n` +
          `3. 逐个发布章节：\n` +
          scenes.map((s, i) =>
            `  **第 ${i + 1} 章：${s.title || `未命名(${s.order})`}**\n` +
            `  - 使用 \`fanqie_publish_novel storyId=${storyId} sceneId=${s.id} mode=${mode}\` 获取内容\n` +
            `  - 使用 \`browser_navigate\` 打开编辑页面\n` +
            `  - 使用 \`browser_fill_form\` 或 \`browser_type\` 填入标题和正文\n` +
            `  - 使用 \`browser_click\` 点击发布/保存草稿按钮\n` +
            `  - 使用 \`browser_snapshot\` 确认发布成功\n`
          ).join('\n') +
          '\n> 💡 每发布一章后等待 2-3 秒再发下一章，避免触发风控'
        )
      }

      // 单章模式：返回内容和标题
      if (!sceneId) {
        return formatToolError('需要 sceneId（发布单章）或设置 publishAllScenes=true（发布全部章节）')
      }

      const data = await fetchScene(storyId, sceneId)

      const loginNote = data.loginEstablished
        ? '✅ Cookie 已保存，可直接操作'
        : '⚠️ 未检测到登录状态。请先使用 browser_navigate 打开 author.fanqienovel.com 完成登录'

      return formatToolResult(
        '📝 **内容已获取，请 MIO 发布到番茄小说**\n\n' +
        `📖 作品：${data.storyTitle}\n` +
        `📄 章节：${data.sceneTitle}（第 ${data.sceneOrder} 章）\n` +
        `${loginNote}\n\n` +
        `### 发布操作计划\n\n` +
        `1. 使用 \`browser_navigate\` 打开番茄作者平台\n` +
        `2. 使用 \`browser_snapshot\` 检查页面状态，确认已登录\n` +
        `3. 找到"新建章节"按钮并 \`browser_click\`\n` +
        `4. 使用 \`browser_type\` 填入标题：${data.sceneTitle}\n` +
        `5. 使用 \`browser_type\` 或 \`browser_fill_form\` 填入正文\n` +
        `6. 点击 ${mode === 'draft' ? '保存草稿' : '发布'}按钮\n` +
        `7. 使用 \`browser_snapshot\` 确认成功\n\n` +
        `### 章节正文\n` +
        `\`\`\`\n${data.sceneContent.slice(0, 500)}${data.sceneContent.length > 500 ? '\n...（内容较长，已截断）' : ''}\n` +
        `\`\`\`\n` +
        `${data.sceneContent.length > 500 ? `\n完整内容长度：${data.sceneContent.length} 字符` : ''}`
      )

    } catch (err: any) {
      return formatToolError(`获取内容失败：${err.message}`)
    }
  },
})
