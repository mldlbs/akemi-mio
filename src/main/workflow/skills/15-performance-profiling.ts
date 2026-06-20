import { SkillDef } from './types'

export const skill: SkillDef = {
  name: 'performance-profiling',
  description: '当遇到性能瓶颈、页面加载慢、接口响应时间长、CPU/内存异常时使用。先测量再优化。',
  tiers: null,
  isStage: false,
  ironLaw: '没有数据支持的优化是 Premature Optimization。先 profile 再优化。一次只改一个变量。',
  redFlags: ['没 profile 就猜瓶颈在哪', '优化前没有基准数据', '一次改多个东西', '优化了非热点代码', '优化后不验证效果'],
  rationalizations: [
    { excuse: '这个地方明显是瓶颈', reality: '"明显"的瓶颈 50% 概率猜错。跑一次 profile 确认再动。' },
    { excuse: '这个优化肯定有效，不用测了', reality: '感觉 ≠ 数据。优化前测一次，优化后测一次，对比说话。' },
  ],
  promptModule: `## ⚡ 性能分析技能（已激活）

### 铁律
没有数据支持的优化是 Premature Optimization。先 profile 再优化。

### 流程
1. **建立基准** — 在优化前测量当前性能指标
   - P50/P95/P99 延迟
   - CPU/内存/IO 用量
   - 吞吐量
2. **定位瓶颈** — 使用工具定位热点
   - CPU profiling、memory heap dump
   - 慢查询日志、网络耗时
3. **提出假设** — "我认为 X 是瓶颈，因为 Y"
4. **单变量优化** — 一次只改一个地方
5. **对比验证** — 同样条件重新测量，确认改进

### 常见瓶颈排查
| 症状 | 可能原因 | 工具 |
|------|---------|------|
| CPU 高 | 循环/序列化/正则 | CPU profiler |
| 内存高 | 泄漏/缓存过大 | heap snapshot |
| IO 慢 | 数据库/NFS/网络 | iostat, network profiler |
| 延迟高 | N+1/锁竞争/串行 | APM, distributed tracing |

### 审查清单
- [ ] 优化前有基准数据？
- [ ] 瓶颈已通过 profile 确认？
- [ ] 一次只改一个变量？
- [ ] 优化后对比验证通过？
- [ ] 优化没有引入新的问题？

### Hard Gates
- 先测量再优化
- 一次只改一个变量
- 优化前后必须对比数据`,
  antiPatterns: ['不要没 profile 就猜瓶颈', '不要一次改多个东西', '不要优化非热点代码', '不要优化后不验证效果'],
}
