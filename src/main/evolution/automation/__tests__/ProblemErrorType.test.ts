/**
 * ProblemErrorType — 测试
 *
 * 验证错误分类的准确性
 */
import { describe, it, expect } from 'vitest'
import { classifyProblemError, shouldRetryOnError, shouldCacheErrorType, ProblemErrorType } from '../ProblemErrorType'

describe('ProblemErrorType', () => {
  describe('classifyProblemError', () => {
    it('classifies unfixable errors', () => {
      expect(classifyProblemError('file not found: /path/to/file.ts')).toBe(ProblemErrorType.UNFIXABLE)
      expect(classifyProblemError('ENOENT: no such file or directory')).toBe(ProblemErrorType.UNFIXABLE)
      expect(classifyProblemError('Cannot find module "lodash"')).toBe(ProblemErrorType.UNFIXABLE)
      expect(classifyProblemError('路径不存在: /tmp/test')).toBe(ProblemErrorType.UNFIXABLE)
      expect(classifyProblemError('循环依赖: a -> b -> a')).toBe(ProblemErrorType.UNFIXABLE)
    })

    it('classifies environment errors', () => {
      expect(classifyProblemError('command not found: tsc')).toBe(ProblemErrorType.ENVIRONMENT)
      expect(classifyProblemError('EACCES: permission denied')).toBe(ProblemErrorType.ENVIRONMENT)
      expect(classifyProblemError('npm ERR! code 1')).toBe(ProblemErrorType.ENVIRONMENT)
      expect(classifyProblemError('docker not found')).toBe(ProblemErrorType.ENVIRONMENT)
    })

    it('classifies regression errors', () => {
      expect(classifyProblemError('Regression detected: 3 tests now failing')).toBe(ProblemErrorType.REGRESSION)
      expect(classifyProblemError('修复后出现新错误')).toBe(ProblemErrorType.REGRESSION)
    })

    it('classifies transient errors', () => {
      expect(classifyProblemError('ETIMEDOUT: connection to host failed')).toBe(ProblemErrorType.TRANSIENT)
      expect(classifyProblemError('网络错误: 连接被重置')).toBe(ProblemErrorType.TRANSIENT)
      expect(classifyProblemError('rate limit exceeded')).toBe(ProblemErrorType.TRANSIENT)
    })

    it('classifies timeout errors', () => {
      expect(classifyProblemError('execution timeout after 30000ms')).toBe(ProblemErrorType.TIMEOUT)
      expect(classifyProblemError('timed out')).toBe(ProblemErrorType.TIMEOUT)
    })

    it('returns UNKNOWN for unmatched errors', () => {
      expect(classifyProblemError('')).toBe(ProblemErrorType.UNKNOWN)
      expect(classifyProblemError('Some random error message')).toBe(ProblemErrorType.UNKNOWN)
    })
  })

  describe('shouldRetryOnError', () => {
    it('returns true for retryable types', () => {
      expect(shouldRetryOnError(ProblemErrorType.TRANSIENT)).toBe(true)
      expect(shouldRetryOnError(ProblemErrorType.TIMEOUT)).toBe(true)
      expect(shouldRetryOnError(ProblemErrorType.UNKNOWN)).toBe(true)
    })

    it('returns false for non-retryable types', () => {
      expect(shouldRetryOnError(ProblemErrorType.UNFIXABLE)).toBe(false)
      expect(shouldRetryOnError(ProblemErrorType.ENVIRONMENT)).toBe(false)
      expect(shouldRetryOnError(ProblemErrorType.REGRESSION)).toBe(false)
    })
  })

  describe('shouldCacheErrorType', () => {
    it('returns true for cacheable types', () => {
      expect(shouldCacheErrorType(ProblemErrorType.UNFIXABLE)).toBe(true)
      expect(shouldCacheErrorType(ProblemErrorType.ENVIRONMENT)).toBe(true)
    })

    it('returns false for non-cacheable types', () => {
      expect(shouldCacheErrorType(ProblemErrorType.TRANSIENT)).toBe(false)
      expect(shouldCacheErrorType(ProblemErrorType.TIMEOUT)).toBe(false)
      expect(shouldCacheErrorType(ProblemErrorType.REGRESSION)).toBe(false)
      expect(shouldCacheErrorType(ProblemErrorType.UNKNOWN)).toBe(false)
    })
  })
})
