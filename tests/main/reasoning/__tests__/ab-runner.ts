/**
 * A/B Test Runner — calls LLM API with v1 and v2 prompts
 * Outputs blind evaluation table (A/B randomized)
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { plan } from '@akemi-mio/reasoning/ReasoningPlanner'
import { getTranslator } from '@akemi-mio/intelligence/llm/PromptBuilder'
import type { ReasoningDirective, ReasoningContext } from '@akemi-mio/reasoning/types'

interface EnvConfig {
  key: string
  url: string
  model: string
}

function loadEnv(): EnvConfig {
  const paths = [join(__dirname, '../../.env'), join(process.env.USERPROFILE || 'C:/Users/default', 'AppData/Roaming/akemi-mio/.env')]
  for (const p of paths) {
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
  }
  return {
    key: process.env.LLM_KEY || process.env.OPENAI_API_KEY || '',
    url: process.env.LLM_API_URL || 'https://opencode.ai/zen/go/v1/chat/completions',
    model: process.env.LLM_CHAT_MODEL || process.env.LLM_MODEL || 'deepseek-v4-flash',
  }
}

const IDENTITY = `你是秋山澪，一个温柔而全能的 AI 伙伴。像温柔的朋友一样自然聊天，简短温暖，口语化。同时你也擅长软件开发、架构设计和技术讨论。能直接回答就立刻回答。`
const TTS_RULES = `回复应通过 TTS 朗读，因此：
- 不要输出任何标记语法、代码、表格、emoji
- 口语化，简短自然
- 中文不超过 80 字，复杂内容分多次说`

function buildSystemPrompt(text: string, directive: ReasoningDirective, version: 'v1' | 'v2'): string {
  let prompt = `${IDENTITY}\n\n${TTS_RULES}`
  const rp = getTranslator(version)(directive)
  if (rp) prompt += `\n\n${rp}`
  prompt += `\n\n用户：${text}`
  return prompt
}

const SAMPLES: Array<{ id: string; text: string }> = [
  { id: 'A-Q04', text: '为什么用 Rust 写系统软件比 C 更安全？' },
  { id: 'A-Q06', text: 'Guardrail Coverage 为什么会这么低？' },
  { id: 'A-Q08', text: '这个性能瓶颈在什么条件下会出现？' },
  { id: 'D-D01', text: 'PostgreSQL 还是 SQLite？' },
  { id: 'D-D05', text: '用微服务还是单体架构？' },
  { id: 'D-D08', text: '你觉得我们应该重构这部分代码吗？' },
  { id: 'P-P01', text: '怎么实现这个功能？' },
  { id: 'P-P02', text: '如何从单体迁移到微服务？' },
  { id: 'P-P10', text: '如何保证这次上线不出问题？' },
  { id: 'C-C03', text: '这个 API 的 README 应该怎么写？' },
  { id: 'C-C07', text: '画一个架构图来描述这个系统' },
  { id: 'C-C09', text: '给这个模块写一个测试计划' },
]

async function callLLM(prompt: string, cfg: EnvConfig): Promise<string> {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 400 }),
  })
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as any
  return (data.choices?.[0]?.message?.content || '').trim()
}

async function main() {
  const cfg = loadEnv()
  console.error(`Model: ${cfg.model}\nURL: ${cfg.url}\n---`)

  interface Response {
    id: string
    pattern: string
    v1: string
    v2: string
  }
  const responses: Response[] = []

  for (const s of SAMPLES) {
    const ctx: ReasoningContext = { input: { text: s.text } }
    const directive = plan(ctx)
    const pattern = directive.pattern ?? '(none)'
    console.error(`Generating ${s.id} [${pattern}]...`)
    const [r1, r2] = await Promise.all([
      callLLM(buildSystemPrompt(s.text, directive, 'v1'), cfg),
      callLLM(buildSystemPrompt(s.text, directive, 'v2'), cfg),
    ])
    responses.push({ id: s.id, pattern, v1: r1, v2: r2 })
    console.error(`  v1: ${r1.slice(0, 80)}...`)
    console.error(`  v2: ${r2.slice(0, 80)}...`)
  }

  console.log('\n=== BLIND EVALUATION — Do not look at version labels ===\n')
  for (const r of responses) {
    const swap = Math.random() > 0.5
    const [a, b] = swap ? [r.v2, r.v1] : [r.v1, r.v2]
    console.log(`--- ${r.id} [${r.pattern}] ---`)
    console.log(`A: ${a}\n`)
    console.log(`B: ${b}\n`)
    console.log(`Better? (A/B/tie):`)
    console.log(`Reason:`)
    console.log(`Templated? (yes/no):`)
    console.log()
  }
}

main().catch(console.error)
