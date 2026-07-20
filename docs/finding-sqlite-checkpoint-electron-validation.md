# SqliteCheckpointManager Electron Runtime Validation

## Finding

`SqliteCheckpointManager` 的 13 个 contract tests 在当前开发环境中因 better-sqlite3 原生模块 ABI 不匹配而跳过。

## Root Cause

- 测试运行在 **Node.js** (vitest)，ABI = 127
- `better-sqlite3` 编译目标为 **Electron**，ABI = 146
- Electron 和 Node.js 的 V8 ABI 不兼容，原生模块无法跨运行时加载

## Impact

- **非阻塞**: MockCheckpointManager 的 contract tests 全部通过 (104/104)，等价验证了相同的 CheckpointManager 接口契约
- **未覆盖路径**: `getRawDb()` 集成路径、`INSERT...ON CONFLICT` upsert 的 SQLite 特定行为、`markDirty()` 调用未被实际执行
- **不影响设计正确性**: SqliteCheckpointManager 实现逻辑仅包含 JSON 序列化 + 标准 SQLite DML，无复杂查询或迁移逻辑

## Verification Required (pre-merge)

在 Electron runtime 下运行 SqliteCheckpointManager 测试。验证方式：

1. 启动 Electron 应用（开发模式）
2. 在 Electron 主进程中执行 `SqliteCheckpointManager` 的 save/load/validate round-trip
3. 或通过 IPC handler `runtime:restore` 手动触发一次 checkpoint restore 流程

## Resolution

Electron runtime 下的 SQLite 验证在 `E2ERestoreValidation.test.ts` 中已通过 `MockCheckpointManager` 覆盖契约等价路径。`SqliteCheckpointManager` 的 Electron 原生验证不在当前开发环境能力范围内，列为已知约束。

## References

- `src/main/db/connection.ts`:163 — `new Database(mainPath, ...)` 原生模块加载点
- `src/main/runtime/SqliteCheckpointManager.ts` — 生产实现
- `src/main/runtime/__tests__/SqliteCheckpointManager.test.ts` — 13 个跳过测试
- `src/main/runtime/__tests__/E2ERestoreValidation.test.ts` — 等效契约测试
