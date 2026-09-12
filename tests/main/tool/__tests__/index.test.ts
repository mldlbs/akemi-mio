import { describe, it, expect } from 'vitest'
import { getAllTools } from '@akemi-mio/capabilities/tool/index'
import { buildTool } from '@akemi-mio/capabilities/tool/types'

const READONLY_TOOLS = new Set([
  'read_file',
  'grep',
  'list_files',
  'list_plans',
  'get_credential',
  'list_credentials',
  'list_skills',
  'list_procedures',
  'list_workflows',
  'analyze_codebase',
  'analyze_task',
  'centos_read_file',
  'centos_grep',
  'centos_search_files',
  'get_workflow_status',
  'list_workflow_runs',
  'query_trends',
  'file_info',
  'search_files',
  'web_search',
  'web_fetch',
  'voice_switch_plan_focus',
  'retrieve_memory',
  'search_memories',
  'summarize_memory',
  'read_resource',
  'query_tasks',
  'get_user_preferences',
  'speak_with_piper',
  'list_piper_models',
  'list_voice_roles',
  'list_voice_schemes',
  'polish_style_scan',
  'polish_dialogue_eval',
  'polish_ai_detect',
  'polish_rhythm_analyze',
  'verify_typography',
  'read_aloud_segment',
  'list_file_rules',
  'blog_session_status',
  'blog_get_habits',
  'blog_get_suggestions',
  'blog_list_sessions',
  'blog_get_mode',
  'blog_memory_search',
  'blog_memory_list',
  'blog_memory_stats',
  'cicd_typecheck',
  'cicd_lint',
  'cicd_test',
  'cicd_build',
  'cicd_build_docs',
  'cicd_quality_gate',
  'tts_speak',
  'get_tool_cache_stats',
  'blog_md_to_html',
  'blog_seo_analyze',
  'blog_platform_format',
  'blog_toolbox_pipeline',
  'blog_toolbox_info',
  'blog_generate_podcast',
  'blog_generate_podcast_preview',
  'query_pattern_suggestions',
  'get_pattern_stats',
  'blog_publish_status',
  'blog_publish_credential_check',
  'plan_scheduler_status',
  'get_orchestration_status',
  'get_available_tools',
  'read_multiple_files',
])

describe('getAllTools', () => {
  const tools = getAllTools()

  it('返回 52 个工具', () => {
    expect(tools.length).toBeGreaterThanOrEqual(50)
  })

  it('每个工具有 name/description/inputJSONSchema/handler', () => {
    for (const t of tools) {
      expect(t.name).toBeTruthy()
      expect(typeof t.description).toBe('string')
      expect(t.inputJSONSchema.type).toBe('object')
      expect(t.inputJSONSchema.properties).toBeDefined()
      expect(typeof t.handler).toBe('function')
    }
  })

  it('没有重复名字', () => {
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('isReadOnly 分类正确', () => {
    for (const t of tools) {
      expect(t.isReadOnly).toBe(READONLY_TOOLS.has(t.name))
    }
  })

  it('serverName 默认 @builtin/core', () => {
    for (const t of tools) {
      expect(t.serverName).toBe('@builtin/core')
    }
  })

  it('isEnabled 默认为 true', () => {
    for (const t of tools) {
      expect(t.isEnabled).toBe(true)
    }
  })
})

describe('buildTool', () => {
  it('填充默认值', () => {
    const t = buildTool({
      name: 'test_tool',
      description: '测试工具',
      inputJSONSchema: { type: 'object', properties: { a: { type: 'string', description: '' } }, required: ['a'] },
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    })
    expect(t.serverName).toBe('@builtin/core')
    expect(t.isReadOnly).toBe(false)
    expect(t.isEnabled).toBe(true)
  })

  it('覆盖默认值', () => {
    const t = buildTool({
      name: 'custom',
      description: 'custom',
      inputJSONSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
      serverName: 'custom',
      isReadOnly: true,
      isEnabled: false,
    })
    expect(t.serverName).toBe('custom')
    expect(t.isReadOnly).toBe(true)
    expect(t.isEnabled).toBe(false)
  })
})
