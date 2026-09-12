import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const TEST_USER_DATA_DIR = join(process.cwd(), 'test-user-data', 'db-isolation')
export const TEST_DATABASE_DIR = join(TEST_USER_DATA_DIR, 'databases')
export const TEST_MAIN_DATABASE_PATH = join(TEST_DATABASE_DIR, 'main.db')

export function getTestMainDatabasePath(): string {
  const userDataDir = process.env.USER_DATA_DIR ?? TEST_USER_DATA_DIR
  return join(userDataDir, 'databases', 'main.db')
}

export function useIsolatedTestDatabase(): () => void {
  const previousUserDataDir = process.env.USER_DATA_DIR
  mkdirSync(TEST_USER_DATA_DIR, { recursive: true })
  const isolatedUserDataDir = mkdtempSync(join(TEST_USER_DATA_DIR, 'case-'))
  process.env.USER_DATA_DIR = isolatedUserDataDir

  return () => {
    rmSync(isolatedUserDataDir, { recursive: true, force: true })
    if (previousUserDataDir === undefined) {
      delete process.env.USER_DATA_DIR
    } else {
      process.env.USER_DATA_DIR = previousUserDataDir
    }
  }
}
