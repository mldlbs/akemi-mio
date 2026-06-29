/**
 * 可选的确定性伪随机数生成器 (mulberry32)。
 * 当提供 seed 时，产生可复现的随机序列。
 * 用于创意引擎测试和调试场景 —— 生产环境默认使用 Math.random 以保证涌现性。
 */
export type RandomGenerator = () => number;
/**
 * 创建一个 mulberry32 随机数生成器（范围 [0, 1)）。
 * 与 Math.random 接口兼容，但可复现。
 */
export declare function createSeededRandom(seed: number): RandomGenerator;
/**
 * 如果提供了种子，返回 seeded RNG；否则返回 Math.random。
 */
export declare function resolveRandom(seed?: number): RandomGenerator;
/**
 * 在给定范围内生成一个随机整数。
 */
export declare function randomInt(rng: RandomGenerator, min: number, max: number): number;
/**
 * 从数组中随机选择一个元素。
 */
export declare function randomPick<T>(rng: RandomGenerator, arr: T[]): T;
/**
 * 随机打乱数组（Fisher-Yates）。
 */
export declare function randomShuffle<T>(rng: RandomGenerator, arr: T[]): T[];
