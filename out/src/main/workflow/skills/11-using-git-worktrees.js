export const skill = {
    name: 'using-git-worktrees',
    description: '当需要在多个分支上并行开发、或隔离实验性修改时使用。适合有 git 基础的项目。',
    tiers: null,
    isStage: false,
    ironLaw: '只在已 git init 的 workspace 子目录内操作。不要操作项目根目录的 git 仓库。',
    redFlags: [
        '在 project root 直接 git worktree add',
        '忘记 worktree 需要清理',
        '在同一个 worktree 改不同分支的代码',
        '没有拉最新代码就创建 worktree',
        'worktree 创建后不 git pull 基线',
    ],
    rationalizations: [
        { excuse: '直接切分支就行，不用 worktree', reality: 'worktree 让你同时看两个分支的代码。切分支需要 stash 当前 WIP，来回切费时间。' },
        { excuse: '工作不大，就在当前分支做', reality: '实验性修改和主开发混在一起，提交历史一团糟。worktree 隔离 = 零成本隔离。' },
    ],
    promptModule: `## 🌳 Git Worktree 技能（已激活）

### 铁律
只在 workspace 子目录或专用目录内操作 worktree。不要污染 project root。

### 流程
1. 准备 — 确定目标分支名和基分支（main/master）
2. 创建 — run_command "git worktree add ../project-branch branch-name"
3. 独立开发 — 在新 worktree 中开发和测试
4. 合并 — 在主仓库 merge worktree 分支
5. 清理 — run_command "git worktree remove ../project-branch"

### 什么时候用 worktree
- 同时维护多个 PR
- 实验性修改不想污染主开发
- 需要对比两个分支的代码

### 什么时候不需要
- 快速修复 README
- 在 CI/CD 中
- 只改配置文件

### 审查清单
- [ ] worktree 建在子目录？
- [ ] 基线已拉最新？
- [ ] 开发完成后合并/清理？

### Hard Gates
- 只在已 git init 的 workspace 子目录内操作
- 不要操作项目根目录的 git 仓库
- 用完及时清理`,
    antiPatterns: ['不要在同一个 worktree 改不同分支的代码', '不要忘记清理 worktree', '不要在 project root 操作'],
};
