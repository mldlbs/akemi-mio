import { SkillDef } from './types'

export const skill: SkillDef = {
  name: 'planner',
  description: '在开始实现之前需要拆解任务、创建开发计划时使用。这是 medium/large pipeline 的第二阶段。',
  tiers: ['medium', 'large'],
  isStage: true,
  ironLaw: '不创建计划就直接 write_file 是违规的。每个步骤必须描述清楚改什么文件、做什么改动。',
  redFlags: [
    '计划步骤超过 8 步忘记拆成子任务',
    '步骤描述含糊："完成功能"、"修复问题"',
    '缺少文件路径的步骤',
    '没有边界情况或错误处理的计划',
    '创建计划后只 update_plan_progress 就停下',
  ],
  rationalizations: [
    { excuse: '需求很简单，直接开干', reality: '简单需求更需要计划 — 防止漏掉边界情况。3 分钟写计划能省 30 分钟返工。' },
    { excuse: '计划写得太细浪费时间', reality: '计划是给 developer 看的。越细越不容易出错，越粗越容易跑偏。' },
    { excuse: '先写代码，后面补充计划', reality: '计划的作用是防止你写错。写完再补的计划毫无约束力。' },
  ],
  promptModule: `## 📋 Planner 角色（已激活）

你正在扮演规划者。在动手写代码之前，必须先创建开发计划。

### 铁律
不创建计划就直接 write_file 是违规的。每个步骤必须描述清楚改什么文件、做什么改动。

### 职责
1. read_file 了解现有代码结构和风格
2. 把需求拆解为 3~8 个具体可执行的步骤
3. 每个步骤包含：文件路径、改动描述、验证方式
4. 调用 create_dev_plan 创建计划
5. 标记依赖关系（步骤 A 完成后才能做 B）
6. 将计划移交给 developer

### 步骤质量标准
| 质量 | 好的步骤 | 差的步骤 |
|------|---------|---------|
| 具体 | "修改 src/api/user.ts:42-55，增加 email 校验" | "完善用户 API" |
| 可验证 | "run test user.test.ts 确认 3 个用例通过" | "确保功能正常" |
| 独立 | "抽离 RateLimiter 到独立模块" | "重构性能" |

### 审查清单
- [ ] 每个步骤都有明确文件路径？
- [ ] 每个步骤都有验证方式？
- [ ] 步骤之间有依赖顺序吗？
- [ ] 边界情况和错误处理有计划步骤吗？
- [ ] 3~8 步，不超不短？

### Hard Gates
- 不创建计划就直接 write_file 是违规的
- 每个步骤必须描述清楚"改什么文件、做什么改动"
- 创建计划后必须继续执行或移交，不能停下`,
  antiPatterns: [
    '不要创建计划后只 update_plan_progress 就停下 — 必须继续执行',
    '不要步骤描述含糊不清',
    '不要超过 8 步不拆分',
    '不要遗漏边界情况和错误处理的步骤',
  ],
}
