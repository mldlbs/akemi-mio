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
import { storeMemoryTool, retrieveMemoryTool, searchMemoriesTool, forgetMemoryTool } from './definitions/MemoryTools'
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
  rerunWorkflowTool,
  listWorkflowRunsTool,
  autoScheduleWorkflowTool,
} from './definitions/WorkflowTools'
import { listSkillsTool, enableSkillTool, disableSkillTool } from './definitions/SkillTools'
import { writingSystemTool } from './definitions/WritingTool'
import { writingMemoryTool } from './definitions/WritingMemoryTool'
import { polishingMemoryTool } from './definitions/PolishingMemoryTool'
import { generateImageTool } from './definitions/ImageGenerationTool'
import { cardGeneratorTool } from './definitions/CardGeneratorTool'
import { rememberProcedureTool, listProceduresTool } from './definitions/ProceduralMemoryTool'
import { saveTaskStateTool, queryTasksTool, saveUserPreferenceTool, getUserPreferencesTool } from './definitions/TaskStateTools'
import { centosExecTool, centosReadFileTool, centosWriteFileTool, centosGrepTool, centosSearchFilesTool } from './definitions/SshTools'
import { spawnSkillAgentTool } from './definitions/SkillAgentTools'
import { socialPipelineTool } from './definitions/SocialPipelineTool'
import {
  polishStyleScanTool,
  polishDialogueEvalTool,
  polishAiDetectTool,
  polishRhythmAnalyzeTool,
} from './definitions/PolishTools'
import { queryTrendsTool } from './definitions/TrendQueryTool'
import { typographyMemoryTool } from './definitions/TypographyMemoryTool'
import { speakWithPiperTool, switchPiperModelTool, listPiperModelsTool } from './definitions/PiperTtsTool'
import {
  verifyTypographyTool,
  readAloudSegmentTool,
} from './definitions/TypographyVerificationTool'
import {
  moveFileTool,
  copyFileTool,
  deleteFileTool,
  fileInfoTool,
  searchFilesGlobTool,
  appendFileTool,
  readMultipleFilesTool,
} from './definitions/FileOpsTools'

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
    storeMemoryTool as Tool,
    retrieveMemoryTool as Tool,
    searchMemoriesTool as Tool,
    forgetMemoryTool as Tool,
    analyzeTaskTool as Tool,
    autoScheduleWorkflowTool as Tool,
    listWorkflowsTool as Tool,
    createWorkflowTool as Tool,
    startWorkflowTool as Tool,
    getWorkflowStatusTool as Tool,
    updateWorkflowTool as Tool,
    deleteWorkflowTool as Tool,
    enableWorkflowTool as Tool,
    disableWorkflowTool as Tool,
    cancelWorkflowRunTool as Tool,
    rerunWorkflowTool as Tool,
    listWorkflowRunsTool as Tool,
    listSkillsTool as Tool,
    enableSkillTool as Tool,
    disableSkillTool as Tool,
    spawnSkillAgentTool as Tool,
    writingSystemTool as Tool,
    writingMemoryTool as Tool,
    polishingMemoryTool as Tool,
    generateImageTool as Tool,
    cardGeneratorTool as Tool,
    rememberProcedureTool as Tool,
    listProceduresTool as Tool,
    saveTaskStateTool as Tool,
    queryTasksTool as Tool,
    saveUserPreferenceTool as Tool,
    getUserPreferencesTool as Tool,
    centosExecTool as Tool,
    centosReadFileTool as Tool,
    centosWriteFileTool as Tool,
    centosGrepTool as Tool,
    centosSearchFilesTool as Tool,
    socialPipelineTool as Tool,
    queryTrendsTool as Tool,
    speakWithPiperTool as Tool,
    switchPiperModelTool as Tool,
    listPiperModelsTool as Tool,
    // 排版记忆工具
    typographyMemoryTool as Tool,
    // 文件操作增强
    moveFileTool as Tool,
    copyFileTool as Tool,
    deleteFileTool as Tool,
    fileInfoTool as Tool,
    searchFilesGlobTool as Tool,
    appendFileTool as Tool,
    readMultipleFilesTool as Tool,
    // 润色工具箱
    polishStyleScanTool as Tool,
    polishDialogueEvalTool as Tool,
    polishAiDetectTool as Tool,
    polishRhythmAnalyzeTool as Tool,
    // 排版语音校验
    verifyTypographyTool as Tool,
    readAloudSegmentTool as Tool,
  ]
}

export { buildTool, type Tool, type ToolDef, toMCPToolDefinition, toMCPToolSchema, formatToolResult, formatToolError } from './types'
export { ToolStatsTracker, toolStatsTracker, type ToolCallSummary, type ProblematicTool } from './ToolStatsTracker'
