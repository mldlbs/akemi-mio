import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { describe, expect, it, vi } from 'vitest'

import {
  resolveBehavioralObservationPersistDir,
  resolveBehavioralObservationUserDataDir,
  runBehavioralObservation,
} from '../../../../../scripts/m57-behavioral-observation'

function makeDependencies(
  store: {
    init: ReturnType<typeof vi.fn>
    queryStrict: ReturnType<typeof vi.fn>
    shutdown: ReturnType<typeof vi.fn>
  },
  overrides?: Partial<Parameters<typeof runBehavioralObservation>[1]>,
) {
  return {
    initDatabase: vi.fn().mockResolvedValue(undefined),
    closeDatabase: vi.fn(),
    createStore: () => store,
    writeSnapshot: vi.fn().mockResolvedValue('behavioral-observation.json'),
    ...overrides,
  }
}

describe('m57 behavioral observation runner', () => {
  it('defaults CLI observation paths to the real user-data workspace when USER_DATA_DIR is unset', () => {
    vi.stubEnv('USER_DATA_DIR', undefined)
    vi.stubEnv('APPDATA', 'C:\\Users\\tester\\AppData\\Roaming')

    expect(resolveBehavioralObservationUserDataDir()).toBe('C:\\Users\\tester\\AppData\\Roaming\\akemi-mio')
    expect(resolveBehavioralObservationPersistDir([])).toBe(
      'C:\\Users\\tester\\AppData\\Roaming\\akemi-mio\\evolution_workspace\\pipeline_data',
    )

    vi.unstubAllEnvs()
  })

  it('does not write an artifact after a materialization read failure and still shuts down and closes', async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'm57-behavioral-observation-'))
    const readFailure = new Error('strict_read_failed')
    const store = {
      init: vi.fn().mockResolvedValue(undefined),
      queryStrict: vi.fn().mockRejectedValue(readFailure),
      shutdown: vi.fn().mockRejectedValue(new Error('shutdown_failed')),
    }
    const dependencies = makeDependencies(store)

    try {
      await expect(runBehavioralObservation(persistDir, dependencies)).rejects.toBe(readFailure)
      expect(existsSync(join(persistDir, 'behavioral-observation.json'))).toBe(false)
      expect(store.shutdown).toHaveBeenCalledOnce()
      expect(dependencies.closeDatabase).toHaveBeenCalledOnce()
      expect(dependencies.writeSnapshot).not.toHaveBeenCalled()
    } finally {
      rmSync(persistDir, { recursive: true, force: true })
    }
  })

  it('closes the database when initialization fails', async () => {
    const initFailure = new Error('init_failed')
    const store = {
      init: vi.fn().mockRejectedValue(initFailure),
      queryStrict: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const dependencies = makeDependencies(store, {
      initDatabase: vi.fn().mockRejectedValue(initFailure),
    })

    await expect(runBehavioralObservation('unused', dependencies)).rejects.toBe(initFailure)
    expect(store.shutdown).toHaveBeenCalledOnce()
    expect(dependencies.closeDatabase).toHaveBeenCalledOnce()
  })

  it('closes the database when store initialization fails', async () => {
    const storeInitFailure = new Error('store_init_failed')
    const store = {
      init: vi.fn().mockRejectedValue(storeInitFailure),
      queryStrict: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const dependencies = makeDependencies(store)

    await expect(runBehavioralObservation('unused', dependencies)).rejects.toBe(storeInitFailure)
    expect(store.shutdown).toHaveBeenCalledOnce()
    expect(dependencies.closeDatabase).toHaveBeenCalledOnce()
  })

  it('closes the database when shutdown fails', async () => {
    const shutdownFailure = new Error('shutdown_failed')
    const store = {
      init: vi.fn().mockResolvedValue(undefined),
      queryStrict: vi.fn().mockResolvedValue([]),
      shutdown: vi.fn().mockRejectedValue(shutdownFailure),
    }
    const dependencies = makeDependencies(store)

    await expect(runBehavioralObservation('unused', dependencies)).rejects.toBe(shutdownFailure)
    expect(dependencies.closeDatabase).toHaveBeenCalledOnce()
  })

  it('closes the database when store construction fails without attempting shutdown', async () => {
    const createFailure = new Error('store_create_failed')
    const placeholderStore = {
      init: vi.fn(),
      queryStrict: vi.fn(),
      shutdown: vi.fn(),
    }
    const dependencies = makeDependencies(placeholderStore, {
      createStore: vi.fn(() => {
        throw createFailure
      }),
    })

    await expect(runBehavioralObservation('unused', dependencies)).rejects.toBe(createFailure)
    expect(placeholderStore.shutdown).not.toHaveBeenCalled()
    expect(dependencies.closeDatabase).toHaveBeenCalledOnce()
  })

  it('runs shutdown and close when writing the artifact fails', async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'm57-behavioral-observation-'))
    const writeFailure = new Error('write_failed')
    const store = {
      init: vi.fn().mockResolvedValue(undefined),
      queryStrict: vi.fn().mockResolvedValue([]),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const dependencies = makeDependencies(store, {
      writeSnapshot: vi.fn().mockRejectedValue(writeFailure),
    })

    try {
      await expect(runBehavioralObservation(persistDir, dependencies)).rejects.toBe(writeFailure)
      expect(existsSync(join(persistDir, 'behavioral-observation.json'))).toBe(false)
      expect(store.shutdown).toHaveBeenCalledOnce()
      expect(dependencies.closeDatabase).toHaveBeenCalledOnce()
    } finally {
      rmSync(persistDir, { recursive: true, force: true })
    }
  })
})
