import type { Tool } from './types'
import { readFileTool } from './definitions/ReadFileTool'
import { writeFileTool } from './definitions/WriteFileTool'
import { editFileTool } from './definitions/EditFileTool'
import { grepTool } from './definitions/GrepTool'
import { listFilesTool } from './definitions/ListFilesTool'
import { runCommandTool } from './definitions/RunCommandTool'
import { createDevPlanTool, updatePlanProgressTool, listPlansTool, completePlanTool, abandonPlanTool } from './definitions/PlanTools'
import { analyzeCodebaseTool } from './definitions/AnalyzeCodebaseTool'
import { getCredentialTool, setCredentialTool, listCredentialsTool } from './definitions/CredentialTools'
import { rememberFactTool } from './definitions/RememberFactTool'
import {
  analyzeTaskTool,
  listWorkflowsTool,
  createWorkflowTool,
  startWorkflowTool,
  getWorkflowStatusTool,
  updateWorkflowTool,
  deleteWorkflowTool,
  enableWorkflowTool,
  disableWorkflowTool,
  cancelWorkflowRunTool,
  listWorkflowRunsTool,
} from './definitions/WorkflowTools'
import { listSkillsTool, enableSkillTool, disableSkillTool } from './definitions/SkillTools'
import { writingSystemTool } from './definitions/WritingTool'
import { generateImageTool } from './definitions/ImageGenerationTool'
import { cardGeneratorTool } from './definitions/CardGeneratorTool'
import { rememberProcedureTool, listProceduresTool } from './definitions/ProceduralMemoryTool'
import { centosExecTool, centosReadFileTool, centosWriteFileTool, centosGrepTool, centosSearchFilesTool } from './definitions/SshTools'
import { spawnSkillAgentTool } from './definitions/SkillAgentTools'
import { socialPipelineTool } from './definitions/SocialPipelineTool'
import { queryTrendsTool } from './definitions/TrendQueryTool'
import { createGoalTool, listGoalsTool, updateGoalTool } from './definitions/GoalTools'
import { listStrategiesTool, createStrategyTool } from './definitions/StrategyTools'
import { getTokenStatusTool } from './definitions/TokenTool'
import { getIdentityTool } from './definitions/IdentityTool'
import { getPersonaStateTool } from './definitions/PersonaTool'
import { runSelfReviewTool } from './definitions/SelfReviewTool'
import { getSystemHealthTool } from './definitions/HealthTool'
import { triggerCreativityTool, triggerDreamCycleTool, listIdeasTool } from './definitions/CreativityTools'
import { triggerInsightAnalysisTool, listInsightsTool } from './definitions/InsightTools'
import { getEvolutionStatusTool, triggerEvolutionTool, setEvolutionSafetyModeTool } from './definitions/EvolutionTools'
import { spawnAgentTool, listAgentsTool, interruptAgentTool } from './definitions/AgentPoolTools'
import { runLocalModelTool } from './definitions/LocalModelTool'
import { triggerCollectTool, triggerFermentTool, triggerDeepResearchTool } from './definitions/ObserverTools'
import { githubTrendsTool } from './definitions/GitHubTool'

export function getAllTools(): Tool[] {
  return [
    readFileTool as Tool,
    writeFileTool as Tool,
    editFileTool as Tool,
    grepTool as Tool,
    listFilesTool as Tool,
    runCommandTool as Tool,
    createDevPlanTool as Tool,
    updatePlanProgressTool as Tool,
    listPlansTool as Tool,
    completePlanTool as Tool,
    abandonPlanTool as Tool,
    analyzeCodebaseTool as Tool,
    getCredentialTool as Tool,
    setCredentialTool as Tool,
    listCredentialsTool as Tool,
    rememberFactTool as Tool,
    analyzeTaskTool as Tool,
    listWorkflowsTool as Tool,
    createWorkflowTool as Tool,
    startWorkflowTool as Tool,
    getWorkflowStatusTool as Tool,
    updateWorkflowTool as Tool,
    deleteWorkflowTool as Tool,
    enableWorkflowTool as Tool,
    disableWorkflowTool as Tool,
    cancelWorkflowRunTool as Tool,
    listWorkflowRunsTool as Tool,
    listSkillsTool as Tool,
    enableSkillTool as Tool,
    disableSkillTool as Tool,
    spawnSkillAgentTool as Tool,
    writingSystemTool as Tool,
    generateImageTool as Tool,
    cardGeneratorTool as Tool,
    rememberProcedureTool as Tool,
    listProceduresTool as Tool,
    centosExecTool as Tool,
    centosReadFileTool as Tool,
    centosWriteFileTool as Tool,
    centosGrepTool as Tool,
    centosSearchFilesTool as Tool,
    socialPipelineTool as Tool,
    queryTrendsTool as Tool,
    // Phase 1: 认知与内省
    createGoalTool as Tool,
    listGoalsTool as Tool,
    updateGoalTool as Tool,
    listStrategiesTool as Tool,
    createStrategyTool as Tool,
    getTokenStatusTool as Tool,
    getIdentityTool as Tool,
    getPersonaStateTool as Tool,
    runSelfReviewTool as Tool,
    getSystemHealthTool as Tool,
    // Phase 2: 创意、洞察与进化
    triggerCreativityTool as Tool,
    triggerDreamCycleTool as Tool,
    listIdeasTool as Tool,
    triggerInsightAnalysisTool as Tool,
    listInsightsTool as Tool,
    getEvolutionStatusTool as Tool,
    triggerEvolutionTool as Tool,
    setEvolutionSafetyModeTool as Tool,
    // Phase 3: 扩展能力
    spawnAgentTool as Tool,
    listAgentsTool as Tool,
    interruptAgentTool as Tool,
    runLocalModelTool as Tool,
    triggerCollectTool as Tool,
    triggerFermentTool as Tool,
    triggerDeepResearchTool as Tool,
    githubTrendsTool as Tool,
  ]
}

export { buildTool, type Tool, type ToolDef, toMCPToolDefinition, toMCPToolSchema, formatToolResult, formatToolError } from './types'
