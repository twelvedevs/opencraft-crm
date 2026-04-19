// API clients
export { SequenceApiClient, ApiError } from './api/SequenceApiClient.js'
export { GatewayApiClient } from './api/GatewayApiClient.js'

// Hooks (exported for advanced consumers — components use these internally)
export { useSequenceList } from './hooks/useSequenceList.js'
export { useSequenceDetail } from './hooks/useSequenceDetail.js'
export { useStepEditor } from './hooks/useStepEditor.js'
export { useEnrollments } from './hooks/useEnrollments.js'
export { useABStats } from './hooks/useABStats.js'

// Types
export type {
  SequenceListProps,
  SequenceBuilderProps,
  SequenceSummary,
  SequenceDetail,
  SequenceDraftPayload,
  StepDraft,
  StepAction,
  Delay,
  DelayUnit,
  ActiveHours,
  ABTest,
  ABStats,
  SequenceStats,
  Enrollment,
  EnrollmentDetail,
  EnrollmentFilters,
  TemplateSummary,
  UserRole,
  SequenceStatus,
} from './types.js'

// Components
export { SequenceList } from './components/SequenceList.js'
export { SequenceBuilder } from './components/SequenceBuilder.js'
