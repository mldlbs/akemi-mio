import { SkillDef } from './types'

export const skill: SkillDef = {
  name: 'writing-plans',
  description: '当接到一个明确需要开发的功能时，先做计划再执行。',
  tiers: null,
  isStage: false,
  ironLaw: '不创建计划就直接 write_file 是违规的。计划步骤必须可执行、可验证。',
  redFlags: ['跳过规划直接改代码', '步骤描述含糊："完成功能"、"修缮"', '步骤缺少验证方式', '创建计划后不执行', '每个步骤没有具体文件路径'],
  rationalizations: [
    { excuse: '功能很明确，不需要写计划', reality: '越是明确的功能，计划越短但越必需。写 3 行计划确认你理解没错。' },
    { excuse: '写计划的时间已经够实现一半了', reality: '没有计划的实现有一半概率要重做。计划是防浪费不是浪费。' },
  ],
  promptModule: `## 📋 编写计划技能（已激活）

### 铁律
不创建计划就直接 write_file 是违规的。计划步骤必须可执行、可验证。

### 流程
1. 分析需求 — read_file 了解现有代码
2. 拆解步骤 — 3~8 个具体步骤
3. 创建计划 — create_dev_plan，每步包含：
   - 文件路径（行号范围）
   - 改动描述（具体做了什么）
   - 验证方法（如何确认改对了）
4. 按序执行 — write_file/edit_file → update_plan_progress
5. 完成 — complete_plan

### 步骤质量检查
- [ ] 每步有文件路径？
- [ ] 每步有验证方式？
- [ ] 步骤独立可测试？
- [ ] 边界情况有覆盖？

### Hard Gates
- 不创建计划不能直接 write_file
- 创建计划后必须按序执行，不能停下`,
  antiPatterns: ['不要跳过规划直接改代码', '不要创建计划后不执行', '不要步骤描述不含文件路径'],
}
