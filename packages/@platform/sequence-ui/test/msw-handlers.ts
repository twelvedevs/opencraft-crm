import { http, HttpResponse } from 'msw'
import type { SequenceSummary, SequenceDetail, SequenceStats, Enrollment, TemplateSummary } from '../src/types.js'

export const NURTURING_URL = 'http://nurturing.test'
export const GATEWAY_URL = 'http://gateway.test'

export const mockSequence: SequenceDetail = {
  sequence_id: 'seq-1',
  name: 'No Response Follow-up',
  status: 'active',
  active_version: 1,
  current_version: 1,
  active_hours: { start: '08:00', end: '20:00', timezone_field: 'context.timezone' },
  cancel_on_opt_out: true,
  steps: [
    {
      id: 'step-1',
      delay: { value: 24, unit: 'hours' },
      action: { type: 'send_message', params: { template_id: 'sms-1', to_field: 'context.phone', from_field: 'context.loc', context: 'context', dedup_key: '{{enrollment_id}}-step-1' } },
    },
    {
      id: 'step-2',
      delay: { value: 72, unit: 'hours' },
      action: { type: 'send_message', params: { template_id: 'sms-2', to_field: 'context.phone', from_field: 'context.loc', context: 'context', dedup_key: '{{enrollment_id}}-step-2' } },
    },
  ],
  ab_test: {
    enabled: true,
    split: { A: 50, B: 50 },
    tracked_event: 'lead.stage_changed',
    tracked_condition: { field: 'payload.new_stage', op: 'eq', value: 'exam_scheduled' },
  },
}

export const mockSummaries: SequenceSummary[] = [
  { sequence_id: 'seq-1', name: 'No Response Follow-up', status: 'active', active_version: 1, current_version: 1, step_count: 2, has_ab_test: true, updated_at: '2026-04-01T00:00:00Z' },
  { sequence_id: 'seq-2', name: 'Welcome Drip', status: 'draft', active_version: null, current_version: 1, step_count: 3, has_ab_test: false, updated_at: '2026-04-02T00:00:00Z' },
]

export const mockEnrollments: Enrollment[] = [
  { enrollment_id: 'enr-1', entity_type: 'lead', entity_id: 'lead-1', ab_variant: 'A', status: 'active', enrolled_at: '2026-04-01T10:00:00Z', completed_at: null, step_statuses: [] },
  { enrollment_id: 'enr-2', entity_type: 'lead', entity_id: 'lead-2', ab_variant: 'B', status: 'completed', enrolled_at: '2026-04-01T11:00:00Z', completed_at: '2026-04-03T11:00:00Z', step_statuses: [] },
]

export const mockStats: SequenceStats = {
  sequence_id: 'seq-1',
  total_enrollments: 200,
  completed_count: 120,
  unenrolled_count: 60,
  failed_count: 5,
  active_count: 15,
  completion_rate: 0.6,
  unenrollment_rate: 0.3,
  ab: {
    A: { enrollments: 100, completions: 62, completion_rate: 0.62, conversion_count: 24, conversion_rate: 0.24 },
    B: { enrollments: 100, completions: 58, completion_rate: 0.58, conversion_count: 17, conversion_rate: 0.17 },
    winner: 'A',
    significant: true,
    p_value: 0.031,
  },
}

export const mockTemplates: TemplateSummary[] = [
  { template_id: 'sms-1', name: 'contacted-followup-sms-1', channel: 'sms', preview: 'Hi {{first_name}}, just checking in...' },
  { template_id: 'sms-2', name: 'contacted-followup-sms-2', channel: 'sms', preview: 'Still interested?' },
]

export const handlers = [
  http.get(`${NURTURING_URL}/sequences`, () => HttpResponse.json({ data: mockSummaries, total: 2 })),
  http.post(`${NURTURING_URL}/sequences`, () => HttpResponse.json({ sequence_id: 'seq-new' }, { status: 201 })),
  http.get(`${NURTURING_URL}/sequences/seq-1`, () => HttpResponse.json(mockSequence)),
  http.put(`${NURTURING_URL}/sequences/seq-1`, () => HttpResponse.json({})),
  http.post(`${NURTURING_URL}/sequences/seq-1/activate`, () => HttpResponse.json({})),
  http.post(`${NURTURING_URL}/sequences/seq-2/activate`, () => HttpResponse.json({})),
  http.post(`${NURTURING_URL}/sequences/seq-1/disable`, () => HttpResponse.json({})),
  http.get(`${NURTURING_URL}/sequences/seq-1/enrollments`, () => HttpResponse.json({ data: mockEnrollments })),
  http.get(`${NURTURING_URL}/sequences/seq-1/stats`, () => HttpResponse.json(mockStats)),
  http.get(`${GATEWAY_URL}/templates`, () => HttpResponse.json(mockTemplates)),
]
