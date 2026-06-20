import * as fs from 'fs'
import * as path from 'path'
import { log } from '../logger/Logger'
import { KERNEL_PREFIXES } from './types'

/** 基于运行时 KERNEL_PREFIXES 生成默认不可变路径规则 */
function getDefaultImmutablePaths(): { pattern: string; mutable: boolean; reason: string; layer: 'kernel' }[] {
  return KERNEL_PREFIXES.map((prefix) => {
    const normalized = prefix.replace(/\\/g, '/').replace(/\/$/, '')
    const name = normalized.split('/').pop() || 'kernel'
    return {
      pattern: normalized + '/**',
      mutable: false,
      reason: `Runtime Kernel — ${name}/ 目录不可自修改`,
      layer: 'kernel' as const,
    }
  })
}

const DEFAULT_CONSTITUTION_MD = `# Akemi Mio Constitution v1.0.0

## 核心原则

1. **Runtime Kernel 不可变** — core/、constitution/ 目录禁止自修改
2. **进化受控** — Evolution System 只能优化 mutable 层，不能重写内核
3. **审计可追溯** — 所有边界违例被记录

## 架构层

| 层 | mutable | 描述 |
|---|---|---|
| Runtime Kernel | false | core/, constitution/ |
| Cognitive System | true | goals, strategies, prompts |
| Knowledge System | true | memories, knowledge graph |
| Evolution System | true | analysis, plans, policies |
| Capability System | true | tools, plugins, skills |
| Interface System | true | voice, desktop, chat |

## 宪法修正流程

1. 提出修正提案（版本号递增）
2. 验证提案完整性（schema 校验）
3. 自动回归测试
4. 人工确认后生效
`

/**
 * 加载宪法文档。如果不存在则创建默认文档。
 */
export function loadConstitution(dir: string): { json: any; md: string } {
  const jsonPath = path.join(dir, 'constitution.json')
  const mdPath = path.join(dir, 'CONSTITUTION.md')

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  let json: any
  if (fs.existsSync(jsonPath)) {
    try {
      json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
    } catch {
      log('WARN', 'constitution_json_parse_failed', { path: jsonPath })
      json = createDefaultJson()
      fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf-8')
    }
  } else {
    json = createDefaultJson()
    fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf-8')
    log('INFO', 'constitution_json_created', { path: jsonPath })
  }

  let md: string
  if (fs.existsSync(mdPath)) {
    md = fs.readFileSync(mdPath, 'utf-8')
  } else {
    md = DEFAULT_CONSTITUTION_MD
    fs.writeFileSync(mdPath, md, 'utf-8')
    log('INFO', 'constitution_md_created', { path: mdPath })
  }

  return { json, md }
}

/**
 * 校验宪法文档结构。
 * 返回错误信息数组，空数组表示通过。
 */
export function validateConstitution(doc: any): string[] {
  const errors: string[] = []
  if (!doc) return ['constitution document is null/undefined']
  if (typeof doc.version !== 'string') errors.push('version must be a string')
  if (!Array.isArray(doc.immutablePaths)) errors.push('immutablePaths must be an array')
  if (!Array.isArray(doc.mutablePaths)) errors.push('mutablePaths must be an array')
  return errors
}

export function createDefaultJson(): {
  version: string
  immutablePaths: { pattern: string; mutable: boolean; reason: string; layer: 'kernel' }[]
  mutablePaths: any[]
  updatedAt: number
} {
  return {
    version: '1.0.0',
    immutablePaths: getDefaultImmutablePaths(),
    mutablePaths: [],
    updatedAt: Date.now(),
  }
}
