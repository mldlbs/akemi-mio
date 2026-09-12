import { buildTool, formatToolResult, formatToolError } from '@akemi-mio/capabilities/tool/types'
import { socialPublishService } from '../../social-publish/SocialPublishService'

/**
 * social_publish — publishing 能力域 · social-publish provider 的入口工具
 *
 * 入参即 publishing canonical 契约（content / platform / title / replyToId / dryRun），
 * handler 委托 SocialPublishService 分发给 7 平台适配器（阶段一：后端调 CLI）。
 */
export const socialPublishTool = buildTool({
  name: 'social_publish',
  description:
    '社交平台发布能力（publishing）。向 7 个社交平台（x/telegram/weibo/zhihu/douyin/xiaohongshu/wechat_mp）发布内容。' +
    'content 与 platform 必填；dryRun=true 时只做校验不真实发布。',
  inputJSONSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '正文内容，必填' },
      platform: { type: 'string', description: '目标平台: telegram/x/weibo/zhihu/douyin/xiaohongshu/wechat_mp，必填' },
      title: { type: 'string', description: '标题（公众号等平台需要）' },
      replyToId: { type: 'string', description: '回复目标 postId（可选）' },
      dryRun: { type: 'boolean', description: '演练模式：只校验不真实发布（默认 false）' },
    },
    required: ['content', 'platform'],
  },
  handler: async (input: { platform: string; content: string; title?: string; replyToId?: string; dryRun?: boolean }) => {
    try {
      const result = await socialPublishService.post(input)
      return formatToolResult(JSON.stringify(result, null, 2))
    } catch (err: any) {
      return formatToolError(`social_publish 执行失败: ${err.message || String(err)}`)
    }
  },
  isReadOnly: false,
})

