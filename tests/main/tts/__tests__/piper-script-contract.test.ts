import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const script = readFileSync(join(process.cwd(), 'scripts', 'piper_speak.py'), 'utf8')
const config = readFileSync(join(process.cwd(), 'packages', 'core', 'src', 'config', 'index.ts'), 'utf8')
const orchestrator = readFileSync(join(process.cwd(), 'packages', 'audio', 'src', 'PiperOrchestrator.ts'), 'utf8')

describe('Piper runtime script contract', () => {
  it('accepts the flags emitted by PiperOrchestrator', () => {
    expect(script).toContain('argparse.ArgumentParser')
    expect(script).toContain('--model')
    expect(script).toContain('--output_file')
    expect(script).toContain('--length_scale')
    expect(script).toContain('--noise_scale')
    expect(script).toContain('--noise_w')
  })

  it('uses the current PiperVoice WAV API', () => {
    expect(script).toContain('from piper import PiperVoice')
    expect(script).toContain('PiperVoice.load')
    expect(script).toContain('voice.synthesize_wav')
  })

  it('uses the checked-in script during development instead of a stale user-data copy', () => {
    expect(config).toContain('!isPackagedApp() && existsSync(projectPiperScript)')
  })

  it('syncs the packaged script into userData so a stale copy cannot shadow it', () => {
    // 实测事故：userData 里躺着一份 6 月的旧 piper_speak.py，它用 PIPER_MODEL_PATH
    // env 取模型路径并硬编码回落到仓库路径，而主进程传的是 --model CLI ——
    // 旧脚本不认，于是 TTS 报 FileNotFoundError 指向不存在的仓库模型。
    // 修法：以随包发布的 scripts/piper_speak.py 为准，同步进 userData。
    expect(config).toContain('export function resolvePiperScript')
    expect(config).toContain("'scripts', 'piper_speak.py'")
    expect(config).toContain('copyFileSync')
    // 关键：只在内容不同时才覆盖，避免每次启动都写文件
    expect(config).toContain('if (current !== incoming)')

    // 消费方必须走懒解析，而不是模块加载期就定死的常量
    expect(orchestrator).toContain('resolvePiperScript()')
    expect(orchestrator).not.toMatch(/^\s+PIPER_SCRIPT,\s*$/m)
  })

  it('does not launch Piper warmup for missing model files or blank input', () => {
    expect(orchestrator).toContain("import { existsSync, unlinkSync } from 'fs'")
    expect(orchestrator).toContain("const warmupText = '预热'")
    expect(orchestrator).toContain('piper_warmup_model_unavailable')
  })

  it('resolves the Piper Python interpreter through a lazy probe instead of a bare "python"', () => {
    // 打包版不经过 scripts/dev.js，必须由 config 自己探测出"真的装了 piper"的解释器，
    // 否则会落到 PATH 上第一个 python（可能是没依赖的托管解释器）→ numpy ModuleNotFoundError。
    expect(config).toContain('resolvePiperPython')
    expect(config).toContain("findPythonWithPackage('piper')")
    // env 覆盖仍然保留
    expect(config).toContain('PIPER_PYTHON')

    // orchestrator 必须走这条解析路径，且不得把裸 'python' 当可执行文件传进去
    expect(orchestrator).toContain('piperPython()')
    expect(orchestrator).not.toMatch(/execFile\(\s*'python'/)
  })
})
