/**
 * social-orphan-cleanup.mjs — 社交工作区旧布局孤儿文件清理（设计 Phase 5）
 *
 * 背景：social/ 目录在 7 月重构后，新版布局为 social/workflows/*.mjs，
 * 根目录的 cli.mjs / pipeline.mjs / serve.mjs 与 .creds.json 均为旧布局遗留，
 * 当前无任何文件引用（发布由 SocialPublishService → workflows/cli.mjs 驱动）。
 *
 * 用法：
 *   node scripts/social-orphan-cleanup.mjs            # dry-run：仅列出
 *   node scripts/social-orphan-cleanup.mjs --delete   # 校验后删除
 *
 * 防护：
 *   - 仅当 social/workflows/cli.mjs 存在（新布局生效）时才允许删除；
 *   - 删除前扫描 social 目录内所有 .mjs/.md/.json/.yaml，确认无引用；
 *   - root .creds.json 为明文凭据副本，删除前会单独提示。
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// %APPDATA%/akemi-mio/evolution_workspace/social（与 src/main/config WORKSPACE.evolution 对齐）
function socialDir() {
  const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(base, 'akemi-mio', 'evolution_workspace', 'social')
}

const ORPHANS = ['cli.mjs', 'pipeline.mjs', 'serve.mjs', '.creds.json']

// 精确引用检测：只匹配“解析到根目录孤儿文件”的路径引用，
// 避免 substring 误报（例如 workflows/cli.mjs 帮助文案里的自身路径）
function isLiveRef(text, fileRel) {
  // 忽略孤儿文件自身
  if (/^(cli|pipeline|serve)\.mjs$/.test(fileRel)) return false
  if (fileRel === '.creds.json') return false

  const rootModuleRef = /(?:\.\.\/|\.\/|social\/)(?:cli|pipeline|serve)\.mjs/
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    // 跳过注释 / 文档行（头注释里的旧路径是自述，不是依赖）
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*') || line.startsWith('#')) continue
    if (rootModuleRef.test(line)) return true
    // root .creds.json：引用行不含 config 前缀才是根目录副本
    if (line.includes('.creds.json') && !line.includes('config')) return true
  }
  return false
}

function collectReferences(socialRoot) {
  const refs = new Set()
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        walk(p)
      } else if (/\.(mjs|md|json|yaml|yml)$/.test(name)) {
        const rel = p.slice(socialRoot.length + 1)
        if (isLiveRef(readFileSync(p, 'utf8'), rel)) refs.add(rel)
      }
    }
  }
  walk(socialRoot)
  return [...refs]
}

function main() {
  const deleteMode = process.argv.includes('--delete')
  const root = socialDir()
  const newCli = join(root, 'workflows', 'cli.mjs')
  if (!existsSync(root)) {
    console.log(`社交目录不存在: ${root}`)
    return
  }
  if (!existsSync(newCli)) {
    console.log(`新布局未生效（缺少 ${newCli}），中止清理`)
    return
  }

  const existing = ORPHANS.filter((name) => existsSync(join(root, name)))
  if (existing.length === 0) {
    console.log('无孤儿文件，无需清理')
    return
  }

  const referencing = collectReferences(root)
  console.log(`孤儿文件（${root}）：`)
  for (const name of existing) {
    const size = statSync(join(root, name)).size
    console.log(`  - ${name} (${size} bytes)`)
  }
  if (existing.includes('.creds.json')) {
    console.log('  ⚠ .creds.json 为明文凭据副本（与 config/.creds.json 相同），确认无需后再删')
  }

  if (referencing.length > 0) {
    console.log(`存在引用，中止：\n  ${referencing.join('\n  ')}`)
    return
  }

  if (!deleteMode) {
    console.log('\ndry-run：未删除。确认后执行 node scripts/social-orphan-cleanup.mjs --delete')
    return
  }

  for (const name of existing) {
    unlinkSync(join(root, name))
    console.log(`已删除 ${name}`)
  }
}

main()