import type { Tool } from './types'
import { readFileTool } from './definitions/ReadFileTool'
import { writeFileTool } from './definitions/WriteFileTool'
import { editFileTool } from './definitions/EditFileTool'
import { grepTool } from './definitions/GrepTool'
import { listFilesTool } from './definitions/ListFilesTool'
import { runCommandTool } from './definitions/RunCommandTool'
import {
  createDevPlanTool,
  updatePlanProgressTool,
  listPlansTool,
  completePlanTool,
  abandonPlanTool,
  voiceUpdatePlanStepTool,
  voiceSwitchPlanFocusTool,
} from './definitions/PlanTools'
import { analyzeCodebaseTool } from './definitions/AnalyzeCodebaseTool'
import { getCredentialTool, setCredentialTool, listCredentialsTool } from './definitions/CredentialTools'
import { rememberFactTool } from './definitions/RememberFactTool'
import {
  storeMemoryTool,
  retrieveMemoryTool,
  searchMemoriesTool,
  forgetMemoryTool,
  summarizeMemoryTool,
  readResourceTool,
  configureMemoryTool,
} from './definitions/MemoryTools'
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
  approveWorkflowGateTool,
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
import { socialPublishTool } from './definitions/SocialPublishTools'
import { polishStyleScanTool, polishDialogueEvalTool, polishAiDetectTool, polishRhythmAnalyzeTool } from './definitions/PolishTools'
import { queryTrendsTool } from './definitions/TrendQueryTool'
import { typographyMemoryTool } from './definitions/TypographyMemoryTool'
import {
  speakWithPiperTool,
  switchPiperModelTool,
  listPiperModelsTool,
  listVoiceRolesTool,
  listVoiceSchemesTool,
  setVoiceSchemeTool,
} from './definitions/PiperTtsTool'
import { verifyTypographyTool, readAloudSegmentTool } from './definitions/TypographyVerificationTool'
import {
  learningQueryTool,
  oralCodeGenerateTool,
  learningSummaryTool,
  typeChallengeNewTool,
  typeChallengeSubmitTool,
  typeChallengeSolutionTool,
} from './definitions/LearningTools'
import { odeSolverTool } from './definitions/OdeSolverTool'
import {
  moveFileTool,
  copyFileTool,
  deleteFileTool,
  fileInfoTool,
  searchFilesGlobTool,
  appendFileTool,
  readMultipleFilesTool,
} from './definitions/FileOpsTools'
import { typeHealthTool } from './definitions/TypeHealthTool'
import { rememberFileRuleTool, listFileRulesTool, deleteFileRuleTool } from './definitions/FileRuleTools'
import { createReasoningChainTool } from './definitions/ReasoningChainTools'
import {
  blogStartSessionTool,
  blogSessionStatusTool,
  blogHandleInputTool,
  blogAdvanceStageTool,
  blogGetHabitsTool,
  blogGetSuggestionsTool,
  blogListSessionsTool,
  blogSetModeTool,
  blogGetModeTool,
} from './definitions/BlogTools'
import {
  blogMemorySearchTool,
  blogMemoryListTool,
  blogMemoryPinTool,
  blogMemoryDeleteTool,
  blogMemoryClearTool,
  blogMemoryStatsTool,
  blogMemoryRecordTool,
} from './definitions/ExperienceMemoryTools'
import {
  cicdTypecheckTool,
  cicdLintTool,
  cicdTestTool,
  cicdBuildTool,
  cicdBuildDocsTool,
  cicdDeployPreviewTool,
  cicdQualityGateTool,
} from './definitions/CicdTools'
import { ttsSpeakTool } from './definitions/TtsSpeakTool'
import { clearToolCacheTool, getToolCacheStatsTool } from './definitions/ToolCacheTools'
import {
  blogMdToHtmlTool,
  blogSeoAnalyzeTool,
  blogPlatformFormatTool,
  blogToolboxPipelineTool,
  blogToolboxInfoTool,
} from './definitions/BlogToolboxTools'
import { generatePodcastTool, generatePodcastPreviewTool } from './definitions/GeneratePodcastTool'
import { adaptiveOrchestrationTools } from './definitions/AdaptiveOrchestrationTools'
import {
  blogPreparePublishTool,
  blogPublishTool,
  blogApprovePublishTool,
  blogRejectPublishTool,
  blogPublishStatusTool,
  blogPublishRollbackTool,
  blogPublishCredentialCheckTool,
  blogPublishWorkflowTool,
} from './definitions/BlogPublishTools'
import { fanqiePublishNovelTool, fanqieAuthInspectTool } from './definitions/FanqiePublishTools'
import { solveOdeTool } from './definitions/OdeSolverTool'
import { browserAgentExecuteTool } from './definitions/BrowserAgentTools'
import { webSearchTool, webFetchTool } from './definitions/WebSearchTools'
import {
  planSchedulerStatusTool,
  planSchedulerPauseTool,
  planSchedulerResumeTool,
  planSchedulerSkipTaskTool,
  planSchedulerRetryTaskTool,
  planSchedulerConfirmTaskTool,
} from './definitions/PlanSchedulerTools'
import { toolChainOrchestratorTools } from './definitions/ToolChainOrchestratorTools'
import { injectAsrVocabularyTool, queryAsrVocabularyTool, clearAsrVocabularyTool } from './definitions/AsrVocabularyTool'

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
    voiceUpdatePlanStepTool as Tool,
    voiceSwitchPlanFocusTool as Tool,
    analyzeCodebaseTool as Tool,
    getCredentialTool as Tool,
    setCredentialTool as Tool,
    listCredentialsTool as Tool,
    rememberFactTool as Tool,
    storeMemoryTool as Tool,
    retrieveMemoryTool as Tool,
    searchMemoriesTool as Tool,
    forgetMemoryTool as Tool,
    summarizeMemoryTool as Tool,
    readResourceTool as Tool,
    configureMemoryTool as Tool,
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
    approveWorkflowGateTool as Tool,
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
    socialPublishTool as Tool,
    queryTrendsTool as Tool,
    speakWithPiperTool as Tool,
    switchPiperModelTool as Tool,
    listPiperModelsTool as Tool,
    listVoiceRolesTool as Tool,
    listVoiceSchemesTool as Tool,
    setVoiceSchemeTool as Tool,
    typographyMemoryTool as Tool,
    moveFileTool as Tool,
    copyFileTool as Tool,
    deleteFileTool as Tool,
    fileInfoTool as Tool,
    searchFilesGlobTool as Tool,
    appendFileTool as Tool,
    readMultipleFilesTool as Tool,
    polishStyleScanTool as Tool,
    polishDialogueEvalTool as Tool,
    polishAiDetectTool as Tool,
    polishRhythmAnalyzeTool as Tool,
    verifyTypographyTool as Tool,
    readAloudSegmentTool as Tool,
    learningQueryTool as Tool,
    oralCodeGenerateTool as Tool,
    learningSummaryTool as Tool,
    typeChallengeNewTool as Tool,
    typeChallengeSubmitTool as Tool,
    typeChallengeSolutionTool as Tool,
    typeHealthTool as Tool,
    rememberFileRuleTool as Tool,
    listFileRulesTool as Tool,
    deleteFileRuleTool as Tool,
    createReasoningChainTool as Tool,
    blogStartSessionTool as Tool,
    blogSessionStatusTool as Tool,
    blogHandleInputTool as Tool,
    blogAdvanceStageTool as Tool,
    blogGetHabitsTool as Tool,
    blogGetSuggestionsTool as Tool,
    blogListSessionsTool as Tool,
    blogSetModeTool as Tool,
    blogGetModeTool as Tool,
    blogMemorySearchTool as Tool,
    blogMemoryListTool as Tool,
    blogMemoryPinTool as Tool,
    blogMemoryDeleteTool as Tool,
    blogMemoryClearTool as Tool,
    blogMemoryStatsTool as Tool,
    blogMemoryRecordTool as Tool,
    cicdTypecheckTool as Tool,
    cicdLintTool as Tool,
    cicdTestTool as Tool,
    cicdBuildTool as Tool,
    cicdBuildDocsTool as Tool,
    cicdDeployPreviewTool as Tool,
    cicdQualityGateTool as Tool,
    ttsSpeakTool as Tool,
    clearToolCacheTool as Tool,
    getToolCacheStatsTool as Tool,

    // === BlogToolbox ===
    blogMdToHtmlTool as Tool,
    blogSeoAnalyzeTool as Tool,
    blogPlatformFormatTool as Tool,
    blogToolboxPipelineTool as Tool,
    blogToolboxInfoTool as Tool,

    // === Blog Audio Podcast ===
    generatePodcastTool as Tool,
    generatePodcastPreviewTool as Tool,

    // === 记忆驱动自适应编排 ===
    ...(adaptiveOrchestrationTools as Tool[]),

    // === BlogPublish 一键多平台发布工作流 ===
    blogPreparePublishTool as Tool,
    blogPublishTool as Tool,
    blogApprovePublishTool as Tool,
    blogRejectPublishTool as Tool,
    blogPublishStatusTool as Tool,
    blogPublishRollbackTool as Tool,
    blogPublishCredentialCheckTool as Tool,
    blogPublishWorkflowTool as Tool,

    // === FanqiePublish 番茄小说 CDP 发布 ===
    fanqiePublishNovelTool as Tool,
    fanqieAuthInspectTool as Tool,

    // === Browser Agent 浏览器智能操作 ===
    browserAgentExecuteTool as Tool,

    // === 联网搜索（Web Search）===
    webSearchTool as Tool,
    webFetchTool as Tool,

    // === 智能并行任务协调器 ===
    planSchedulerStatusTool as Tool,
    planSchedulerPauseTool as Tool,
    planSchedulerResumeTool as Tool,
    planSchedulerSkipTaskTool as Tool,
    planSchedulerRetryTaskTool as Tool,
    planSchedulerConfirmTaskTool as Tool,

    // === 常微分方程（ODE）数值求解 ===
    odeSolverTool as Tool,

    // === 工具链编排即服务 ===
    ...(toolChainOrchestratorTools as Tool[]),

    // === 记忆唤醒语音热词（ASR 领域词表注入） ===
    injectAsrVocabularyTool as Tool,
    queryAsrVocabularyTool as Tool,
    clearAsrVocabularyTool as Tool,
  ]
}
