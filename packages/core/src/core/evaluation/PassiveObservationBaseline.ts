import type { PassiveObservationBaseline } from './PassiveObservationMonitor'

export const M57_PASSIVE_OBSERVATION_BASELINE: PassiveObservationBaseline = {
  sampleCount: 103,
  traceCount: 304,
  incompleteEvidenceCount: 201,
  fingerprintDistribution: {
    response: 93,
    'tool:file_management>response': 3,
    'tool:file_management>tool:file_management>tool:system_execution>response': 1,
    'tool:system_execution>response': 2,
    'tool:system_execution>tool:file_management>response': 1,
    'tool:system_execution>tool:system_execution>response': 3,
  },
}
