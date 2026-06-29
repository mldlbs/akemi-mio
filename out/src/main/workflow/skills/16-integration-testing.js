export const skill = {
    name: 'integration-testing',
    description: '当需要验证多个模块协同工作、端到端流程、或外部依赖集成时使用。',
    tiers: null,
    isStage: false,
    ironLaw: '集成测试必须真实调用依赖（数据库/API/文件系统），不 mock 外部依赖。',
    redFlags: ['集成测试 mock 了数据库', '只测了 happy path 没测错误路径', '测试没有清理测试数据', '测试依赖执行顺序', '测试用了生产环境'],
    rationalizations: [
        { excuse: 'mock 数据库更快更稳定', reality: 'mock 数据库的集成测试只测了 mock 的行为，不是真实行为。' },
        { excuse: '先测 happy path，错误路径后面补', reality: '集成测试中错误路径比 happy path 更容易出问题。一起测。' },
    ],
    promptModule: `## 🔗 集成测试技能（已激活）

### 铁律
集成测试调用真实依赖。不 mock 数据库/API/文件系统。

### 测试策略
- **单元测试** — mock 外部依赖，测逻辑正确性
- **集成测试** — 真实调用，测模块协同
- **E2E 测试** — 用户视角，测完整流程

### 集成测试要点
1. **测试环境** — 独立的测试数据库/测试服务
2. **数据准备** — 测试前 set up，测试后 tear down
3. **覆盖范围**：
   - 模块间接口
   - 数据库读写
   - 外部 API 调用（测试桩）
   - 文件系统操作
4. **验证**：
   - 状态变更
   - 返回结果
   - 副作用

### 审查清单
- [ ] 测试调用真实依赖？
- [ ] 测试环境独立？
- [ ] 测试数据清理？
- [ ] 错误路径覆盖？
- [ ] 不依赖执行顺序？

### Hard Gates
- 不 mock 数据库/API/文件系统
- 测试必须自包含（setup + exercise + verify + teardown）`,
    antiPatterns: ['不要在集成测试中 mock 数据库', '不要跳过测试数据清理', '不要依赖测试执行顺序', '不要只测 happy path'],
};
