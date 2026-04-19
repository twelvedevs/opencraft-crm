export type SequenceStatus = 'draft' | 'active' | 'disabled'
export type StepActionType = 'send_message' | 'send_email' | 'call_ai' | 'emit_event'
export type DelayUnit = 'minutes' | 'hours' | 'days'
export type ABVariant = 'A' | 'B'
export type UserRole = 'marketing_staff' | 'marketing_manager' | 'super_admin'

export interface Delay {
  value: number
  unit: DelayUnit
}

export interface SendMessageParams {
  template_id: string
  to_field: string
  from_field: string
  context: string
  dedup_key: string
}

export interface SendEmailParams {
  template_id: string
  to_field: string
  from_field: string
  context: string
  dedup_key: string
}

export interface CallAIParams {
  system_prompt: string
  user_prompt: string
  model: string
  auto_send: boolean
}

export interface EmitEventParams {
  event_type: string
  payload: Record<string, string>
  include_context: boolean
}

export type StepAction =
  | { type: 'send_message'; params: SendMessageParams }
  | { type: 'send_email'; params: SendEmailParams }
  | { type: 'call_ai'; params: CallAIParams }
  | { type: 'emit_event'; params: EmitEventParams }

export interface StepDraft {
  id: string
  delay: Delay
  action: StepAction
  ab_variant_override?: { B: Record<string, unknown> }
}

export interface ActiveHours {
  start: string
  end: string
  timezone_field: string
}

export interface ABTestCondition {
  field: string
  op: string
  value: unknown
}

export interface ABTest {
  enabled: boolean
  split: { A: number; B: number }
  tracked_event: string
  tracked_condition: ABTestCondition
}

export interface SequenceSummary {
  sequence_id: string
  name: string
  status: SequenceStatus
  active_version: number | null
  current_version: number
  step_count: number
  has_ab_test: boolean
  updated_at: string
}

export interface SequenceDetail {
  sequence_id: string
  name: string
  status: SequenceStatus
  active_version: number | null
  current_version: number
  active_hours: ActiveHours | null
  cancel_on_opt_out: boolean
  steps: StepDraft[]
  ab_test: ABTest | null
}

export interface SequenceDraftPayload {
  name: string
  active_hours: ActiveHours | null
  cancel_on_opt_out: boolean
  steps: StepDraft[]
  ab_test: ABTest | null
}

export interface StepStatusSummary {
  step_id: string
  step_index: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  scheduled_at: string
  completed_at: string | null
}

export interface StepExecutionDetail extends StepStatusSummary {
  attempt: number
  output: unknown
  error: string | null
  started_at: string | null
}

export interface Enrollment {
  enrollment_id: string
  entity_type: string
  entity_id: string
  ab_variant: ABVariant | null
  status: 'active' | 'completed' | 'unenrolled' | 'failed'
  enrolled_at: string
  completed_at: string | null
  step_statuses: StepStatusSummary[]
}

export interface EnrollmentDetail extends Enrollment {
  context: Record<string, unknown>
  steps: StepExecutionDetail[]
}

export interface EnrollmentFilters {
  status?: 'active' | 'completed' | 'unenrolled' | 'failed'
  dateFrom?: string
  dateTo?: string
}

export interface VariantStats {
  enrollments: number
  completions: number
  completion_rate: number
  conversion_count: number
  conversion_rate: number
}

export interface ABStats {
  A: VariantStats
  B: VariantStats
  winner: 'A' | 'B' | null
  significant: boolean
  p_value: number
}

export interface SequenceStats {
  sequence_id: string
  total_enrollments: number
  completed_count: number
  unenrolled_count: number
  failed_count: number
  active_count: number
  completion_rate: number
  unenrollment_rate: number
  ab: ABStats | null
}

export interface TemplateSummary {
  template_id: string
  name: string
  channel: 'sms' | 'email'
  preview: string
}

export interface SequenceListProps {
  nurturingEngineUrl: string
  token: string
  userRole: UserRole
  onEdit: (sequenceId: string) => void
}

export interface SequenceBuilderProps {
  sequenceId: string
  nurturingEngineUrl: string
  crmGatewayUrl: string
  token: string
  userRole: UserRole
  onBack: () => void
}
