const fs = require('fs');
const file = 'D:/work/code/akemi-mio/src/main/bootstrap/AppRuntime.ts';
let content = fs.readFileSync(file, 'utf8');

// Find the method using regex
const methodRegex = /private buildCreativitySources\(memoryService: MemoryService, pm: any\): any\[\] \{[\s\S]*?return sources[\s\S]*?\}\s*\n/;
const match = content.match(methodRegex);

if (!match) {
    console.error('Method not found');
    process.exit(1);
}

console.log('Found method at index:', match.index);

const newMethod = \  private buildCreativitySources(memoryService: MemoryService, pm: any): any[] {
    const recentTopics = memoryService?.summary?.getRecent?.(5) ?? []
    const entryCount = memoryService?.getInteractionCount?.() || 0
    const interactions = memoryService?.interactionTracker?.getRecent?.(10) ?? []

    // 从最近交互中提取用户关注点
    const userFocus = interactions
      .map((i: any) => i.userText ?? '')
      .filter(Boolean)
      .slice(0, 5)

    const sources: any[] = [
      // Memory: 包含实际记忆内容，而非仅计数
      {
        name: 'Memory',
        content: recentTopics.length > 0
          ? \\\对话记忆 \\\ 条。最近话题：\\\。用户近期关注：\\\\\\
          : \\\对话记忆 \\\ 条（暂无近期话题）\\\,
        type: 'knowledge',
        weight: 0.9,
      },
      // MCP + Agent: 合并为一个来源，避免重复
      {
        name: 'MCP-Agent',
        content: '工具集成与任务执行：支持多工具调用、任务编排、多轮对话。能力边界：可调用外部 API、执行代码、操作文件系统。',
        type: 'knowledge',
        weight: 0.85,
      },
      // ASR: 强调当前状态而非能力描述
      {
        name: 'ASR',
        content: \\\语音识别模块：支持中英文混合输入、实时流式转写。当前状态：\\\\\\,
        type: 'knowledge',
        weight: 0.7,
      },
      // TTS: 强调情感和多音色能力
      {
        name: 'TTS',
        content: '语音合成模块：多音色选择、情感语调可控。可为不同场景（叙述、对话、播报）切换不同声音风格。',
        type: 'knowledge',
        weight: 0.7,
      },
      // Evolution: 包含实际进化状态
      {
        name: 'Evolution',
        content: '自进化系统：代码分析与修改、计划执行、2 小时周期。可自动识别系统瓶颈并提出改进方案。',
        type: 'knowledge',
        weight: 0.8,
      },
    ]
    // 注入活跃计划作为行为来源
    try {
      const plans = pm.listPlans()
      if (plans.length > 0) {
        const plan = plans[0]
        sources.push({
          name: \\\Plan:\\\\\\,
          content: \\\当前执行计划：\\\。\\\\\\,
          type: 'behavior',
          weight: 0.6,
        })
      }
    } catch {}
    return sources
  }
\;

content = content.replace(methodRegex, newMethod);
fs.writeFileSync(file, content, 'utf8');
console.log('Method replaced successfully');
