/**
 * clamp — 通用数值钳位函数
 *
 * 用法：
 *   clamp(5, 0, 10)   // → 5
 *   clamp(-1, 0, 10)  // → 0
 *   clamp(15, 0, 10)  // → 10
 */

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}
