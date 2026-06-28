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
  ]
}

export { buildTool, type Tool, type ToolDef, toMCPToolDefinition, toMCPToolSchema, formatToolResult, formatToolError } from './types'
