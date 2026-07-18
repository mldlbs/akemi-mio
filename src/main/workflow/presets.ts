// @ts-ignore - JSON module not in tsconfig
import devPipelineSimple from './definitions/dev-pipeline-simple.json'
// @ts-ignore - JSON module not in tsconfig
import devPipelineMedium from './definitions/dev-pipeline-medium.json'
// @ts-ignore - JSON module not in tsconfig
import devPipelineLarge from './definitions/dev-pipeline-large.json'
// @ts-ignore - JSON module not in tsconfig
import writingPipeline from './definitions/writing-pipeline.json'
import type { WorkflowDef } from './types'

export const PRESET_DEFINITIONS: WorkflowDef[] = [
  devPipelineSimple,
  devPipelineMedium,
  devPipelineLarge,
  writingPipeline,
] as WorkflowDef[]
