/**
 * 可选的确定性伪随机数生成器 (mulberry32)。
 * 当提供 seed 时，产生可复现的随机序列。
 * 用于创意引擎测试和调试场景 —— 生产环境默认使用 Math.random 以保证涌现性。
 */

export type RandomGenerator = () => number

/**
 * 创建一个 mulberry32 随机数生成器（范围 [0, 1)）。
 * 与 Math.random 接口兼容，但可复现。
 */
export function createSeededRandom(seed: number): RandomGenerator {
  let s = seed | 0
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 如果提供了种子，返回 seeded RNG；否则返回 Math.random。
 */
export function resolveRandom(seed?: number): RandomGenerator {
  return seed !== undefined ? createSeededRandom(seed) : Math.random
}

/**
 * 在给定范围内生成一个随机整数。
 */
export function randomInt(rng: RandomGenerator, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min
}

/**
 * 从数组中随机选择一个元素。
 */
export function randomPick<T>(rng: RandomGenerator, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]
}

/**
 * 随机打乱数组（Fisher-Yates）。
 */
export function randomShuffle<T>(rng: RandomGenerator, arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]]
  }
  return result
}
