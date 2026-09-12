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

  it('does not launch Piper warmup for missing model files or blank input', () => {
    expect(orchestrator).toContain("import { existsSync, unlinkSync } from 'fs'")
    expect(orchestrator).toContain("const warmupText = '预热'")
    expect(orchestrator).toContain('piper_warmup_model_unavailable')
  })

  it('uses an explicit Piper Python interpreter when dev startup resolves one', () => {
    expect(config).toContain('PIPER_PYTHON')
    expect(orchestrator).toContain('PIPER_PYTHON')
    expect(orchestrator).not.toContain("execFile(\n          'python'")
  })
})
