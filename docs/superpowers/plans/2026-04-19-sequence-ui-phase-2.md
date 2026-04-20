# @platform/sequence-ui — Phase 2: React Components

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build all React components for `@platform/sequence-ui`: SequenceList, SequenceBuilder (with Builder/Enrollments/A/B tabs), StepList (dnd-kit), StepEditor + action forms, TemplatePicker modal, EnrollmentLog, ABResults. Ends with all component tests passing and a clean typecheck.

**Architecture:** Thin components that call Phase 1 hooks. Two top-level entry points: `SequenceList` (mounts at `/sequences`) and `SequenceBuilder` (mounts at `/sequences/:id/edit`). Master-detail layout inside the Builder tab. Inline styles for layout; `.sq-*` CSS classes (from `styles.css`) for hover/focus/drag states.

**Tech Stack:** React 18, TypeScript 5, `@dnd-kit/core` + `@dnd-kit/sortable`, Vitest 2 + React Testing Library + MSW 2, inline styles + `styles.css`

**Prerequisites:** Phase 1 complete (`npm test` passes, `npm run typecheck` clean).

**Spec:** `docs/superpowers/specs/2026-04-19-sequence-ui-design.md`

---

## File Map

| File | Responsibility |
|---|---|
| `src/components/utils.ts` | Shared style helpers and status badge logic |
| `src/components/SequenceList.tsx` | Top-level list page |
| `src/components/action-forms/SendMessageForm.tsx` | Step editor sub-form |
| `src/components/action-forms/SendEmailForm.tsx` | Step editor sub-form |
| `src/components/action-forms/CallAIForm.tsx` | Step editor sub-form |
| `src/components/action-forms/EmitEventForm.tsx` | Step editor sub-form |
| `src/components/TemplatePicker.tsx` | Modal: search templates via GatewayApiClient |
| `src/components/StepList.tsx` | dnd-kit sortable step list (left panel) |
| `src/components/ActiveHoursConfig.tsx` | Sequence-level active hours section |
| `src/components/ABConfig.tsx` | A/B split + conversion event config |
| `src/components/StepEditor.tsx` | Right panel: delay + action type + sub-form |
| `src/components/EnrollmentLog.tsx` | Enrollments tab content |
| `src/components/ABResults.tsx` | A/B Results tab content |
| `src/components/SequenceBuilder.tsx` | Top-level builder page with 3 tabs |
| `test/component/SequenceList.test.tsx` | Component tests |
| `test/component/TemplatePicker.test.tsx` | Component tests |
| `test/component/StepEditor.test.tsx` | Component tests |
| `test/component/EnrollmentLog.test.tsx` | Component tests |
| `test/component/ABResults.test.tsx` | Component tests |
| `test/component/SequenceBuilder.test.tsx` | Component tests |
| `test/msw-handlers.ts` | Shared MSW request handlers |

---

### Task 1: Component test infrastructure

**Files:**
- Create: `test/msw-handlers.ts`
- Modify: `test/setup.ts`
- Create: `test/component/` directory

- [ ] **Step 1: Install MSW and user-event**

```bash
cd packages/@platform/sequence-ui
npm install --save-dev msw@^2.0.0 @testing-library/user-event@^14.0.0
```

- [ ] **Step 2: Update `test/setup.ts`**

```ts
import { afterEach, beforeAll, afterAll } from 'vitest'
import { cleanup } from '@testing-library/react'
import { server } from './msw-server.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => { server.resetHandlers(); cleanup() })
afterAll(() => server.close())
```

- [ ] **Step 3: Create `test/msw-server.ts`**

```ts
import { setupServer } from 'msw/node'
import { handlers } from './msw-handlers.js'

export const server = setupServer(...handlers)
```

- [ ] **Step 4: Create `test/msw-handlers.ts`**

```ts
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
```

- [ ] **Step 5: Create `test/component/` directory**

```bash
mkdir -p packages/@platform/sequence-ui/test/component
```

- [ ] **Step 6: Commit**

```bash
git add packages/@platform/sequence-ui/test/
git commit -m "test(@platform/sequence-ui): add MSW infrastructure for component tests"
```

---

### Task 2: Shared utils + SequenceList component

**Files:**
- Create: `packages/@platform/sequence-ui/src/components/utils.ts`
- Create: `packages/@platform/sequence-ui/src/components/SequenceList.tsx`
- Create: `packages/@platform/sequence-ui/test/component/SequenceList.test.tsx`

- [ ] **Step 1: Write failing tests**

`test/component/SequenceList.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { server } from '../msw-server.js'
import { http, HttpResponse } from 'msw'
import { NURTURING_URL } from '../msw-handlers.js'
import { SequenceList } from '../../src/components/SequenceList.js'

function renderList(overrides: Partial<React.ComponentProps<typeof SequenceList>> = {}) {
  const props = {
    nurturingEngineUrl: NURTURING_URL,
    token: 'tok',
    userRole: 'marketing_manager' as const,
    onEdit: vi.fn(),
    ...overrides,
  }
  return { ...render(<SequenceList {...props} />), props }
}

describe('SequenceList', () => {
  it('renders sequence names after loading', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('No Response Follow-up')).toBeInTheDocument())
    expect(screen.getByText('Welcome Drip')).toBeInTheDocument()
  })

  it('shows status badges', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument())
    expect(screen.getByText('draft')).toBeInTheDocument()
  })

  it('calls onEdit when Edit button is clicked', async () => {
    const { props } = renderList()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    expect(props.onEdit).toHaveBeenCalledWith('seq-1')
  })

  it('shows Activate/Disable for marketing_manager', async () => {
    renderList({ userRole: 'marketing_manager' })
    await waitFor(() => screen.getByText('No Response Follow-up'))
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument() // seq-1 is active
    expect(screen.getByRole('button', { name: 'Activate' })).toBeInTheDocument() // seq-2 is draft
  })

  it('hides Activate/Disable for marketing_staff', async () => {
    renderList({ userRole: 'marketing_staff' })
    await waitFor(() => screen.getByText('No Response Follow-up'))
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()
  })

  it('calls onEdit with new sequence id after New Sequence button click', async () => {
    const { props } = renderList()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    await userEvent.click(screen.getByRole('button', { name: 'New Sequence' }))
    await waitFor(() => expect(props.onEdit).toHaveBeenCalledWith('seq-new'))
  })

  it('shows error state when API fails', async () => {
    server.use(http.get(`${NURTURING_URL}/sequences`, () => HttpResponse.json({}, { status: 500 })))
    renderList()
    await waitFor(() => expect(screen.getByText(/failed/i)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/component/SequenceList.test.tsx
```

Expected: `Cannot find module '../../src/components/SequenceList.js'`

- [ ] **Step 3: Create `src/components/utils.ts`**

```ts
import React from 'react'
import type { SequenceStatus } from '../types.js'

export const btn: React.CSSProperties = {
  padding: '4px 12px', border: '1px solid #ccc', borderRadius: 4,
  background: '#fff', cursor: 'pointer', fontSize: 13, marginRight: 4,
}

export const primaryBtn: React.CSSProperties = {
  ...btn, background: '#0066cc', color: '#fff', border: '1px solid #0066cc',
}

export const dangerBtn: React.CSSProperties = {
  ...btn, background: '#dc3545', color: '#fff', border: '1px solid #dc3545',
}

export const inputStyle: React.CSSProperties = {
  padding: '4px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: 13, width: '100%',
}

export const selectStyle: React.CSSProperties = { ...inputStyle }

export const label: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
  color: '#6c757d', display: 'block', marginBottom: 4,
}

const statusColors: Record<SequenceStatus, { bg: string; color: string }> = {
  active: { bg: '#d4edda', color: '#155724' },
  draft: { bg: '#fff3cd', color: '#856404' },
  disabled: { bg: '#f8d7da', color: '#721c24' },
}

export function StatusBadge({ status }: { status: SequenceStatus }) {
  const { bg, color } = statusColors[status]
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600, background: bg, color }}>
      {status}
    </span>
  )
}
```

- [ ] **Step 4: Create `src/components/SequenceList.tsx`**

```tsx
import React, { useState } from 'react'
import { SequenceApiClient } from '../api/SequenceApiClient.js'
import { useSequenceList } from '../hooks/useSequenceList.js'
import type { SequenceListProps } from '../types.js'
import { btn, primaryBtn, StatusBadge } from './utils.js'

const th: React.CSSProperties = { textAlign: 'left', padding: '8px', fontWeight: 600, fontSize: 13 }
const td: React.CSSProperties = { padding: '8px', fontSize: 13 }

export function SequenceList({ nurturingEngineUrl, token, userRole, onEdit }: SequenceListProps) {
  const [client] = useState(() => new SequenceApiClient(nurturingEngineUrl, token))
  const { sequences, loading, error, activate, disable } = useSequenceList(client)
  const [actionError, setActionError] = useState<string | null>(null)

  const canManage = userRole === 'marketing_manager' || userRole === 'super_admin'

  const handleNew = async () => {
    try {
      const { sequence_id } = await client.createSequence('New Sequence')
      onEdit(sequence_id)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to create sequence')
    }
  }

  if (loading) return <div style={{ padding: 16 }}>Loading sequences...</div>
  if (error) return <div style={{ padding: 16, color: '#721c24' }}>{error}</div>

  return (
    <div style={{ padding: 16 }}>
      {actionError && <div style={{ color: '#721c24', marginBottom: 8 }}>{actionError}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Sequences</h2>
        <button style={primaryBtn} onClick={() => void handleNew()}>New Sequence</button>
      </div>
      {sequences.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#6c757d', padding: 32 }}>No sequences yet.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #dee2e6' }}>
              <th style={th}>Name</th>
              <th style={th}>Status</th>
              <th style={th}>Steps</th>
              <th style={th}>A/B</th>
              <th style={th}>Version</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sequences.map((seq) => (
              <tr key={seq.sequence_id} style={{ borderBottom: '1px solid #dee2e6' }}>
                <td style={td}>{seq.name}</td>
                <td style={td}><StatusBadge status={seq.status} /></td>
                <td style={td}>{seq.step_count}</td>
                <td style={td}>{seq.has_ab_test ? 'A/B' : '—'}</td>
                <td style={td}>v{seq.current_version}</td>
                <td style={td}>
                  <button style={btn} onClick={() => onEdit(seq.sequence_id)}>Edit</button>
                  {canManage && seq.status === 'draft' && (
                    <button style={btn} onClick={() => void activate(seq.sequence_id)}>Activate</button>
                  )}
                  {canManage && seq.status === 'active' && (
                    <button style={btn} onClick={() => void disable(seq.sequence_id)}>Disable</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/component/SequenceList.test.tsx
```

Expected: all 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/@platform/sequence-ui/src/components/
git commit -m "feat(@platform/sequence-ui): add SequenceList component with tests"
```

---

### Task 3: Action forms

No separate tests — action forms are thin form fragments tested via `StepEditor` tests in Task 7.

**Files:**
- Create: `src/components/action-forms/SendMessageForm.tsx`
- Create: `src/components/action-forms/SendEmailForm.tsx`
- Create: `src/components/action-forms/CallAIForm.tsx`
- Create: `src/components/action-forms/EmitEventForm.tsx`

- [ ] **Step 1: Create `src/components/action-forms/SendMessageForm.tsx`**

```tsx
import React from 'react'
import type { SendMessageParams, StepDraft } from '../../types.js'
import { label, inputStyle } from '../utils.js'

interface Props {
  params: SendMessageParams
  abOverride?: Record<string, unknown>
  onParamsChange: (p: SendMessageParams) => void
  onAbOverrideChange: (o: Record<string, unknown> | undefined) => void
  onBrowseTemplate: () => void
}

export function SendMessageForm({ params, abOverride, onParamsChange, onAbOverrideChange, onBrowseTemplate }: Props) {
  const set = (patch: Partial<SendMessageParams>) => onParamsChange({ ...params, ...patch })
  const hasABOverride = abOverride !== undefined

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Template ID</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input style={{ ...inputStyle, flex: 1 }} value={params.template_id} onChange={(e) => set({ template_id: e.target.value })} placeholder="template-id" />
          <button type="button" onClick={onBrowseTemplate} style={{ padding: '4px 10px', border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}>Browse</button>
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>To field (context path)</span>
        <input style={inputStyle} value={params.to_field} onChange={(e) => set({ to_field: e.target.value })} placeholder="context.phone" />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>From field (context path)</span>
        <input style={inputStyle} value={params.from_field} onChange={(e) => set({ from_field: e.target.value })} placeholder="context.location_number" />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Dedup key</span>
        <input style={inputStyle} value={params.dedup_key} onChange={(e) => set({ dedup_key: e.target.value })} placeholder="{{enrollment_id}}-step-1" />
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={hasABOverride} onChange={(e) => onAbOverrideChange(e.target.checked ? {} : undefined)} />
          A/B variant B template override
        </label>
        {hasABOverride && (
          <div style={{ marginTop: 8, padding: 10, background: '#f8f9fa', borderRadius: 4 }}>
            <span style={label}>Variant B — Template ID</span>
            <input
              style={inputStyle}
              value={String((abOverride as Record<string, string>).template_id ?? '')}
              onChange={(e) => onAbOverrideChange({ ...abOverride, template_id: e.target.value })}
              placeholder="template-id-variant-b"
            />
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `src/components/action-forms/SendEmailForm.tsx`**

```tsx
import React from 'react'
import type { SendEmailParams } from '../../types.js'
import { label, inputStyle } from '../utils.js'

interface Props {
  params: SendEmailParams
  onParamsChange: (p: SendEmailParams) => void
  onBrowseTemplate: () => void
}

export function SendEmailForm({ params, onParamsChange, onBrowseTemplate }: Props) {
  const set = (patch: Partial<SendEmailParams>) => onParamsChange({ ...params, ...patch })
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Template ID</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input style={{ ...inputStyle, flex: 1 }} value={params.template_id} onChange={(e) => set({ template_id: e.target.value })} placeholder="template-id" />
          <button type="button" onClick={onBrowseTemplate} style={{ padding: '4px 10px', border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}>Browse</button>
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>To field (context path)</span>
        <input style={inputStyle} value={params.to_field} onChange={(e) => set({ to_field: e.target.value })} placeholder="context.email" />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>From field (context path)</span>
        <input style={inputStyle} value={params.from_field} onChange={(e) => set({ from_field: e.target.value })} placeholder="context.from_email" />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Dedup key</span>
        <input style={inputStyle} value={params.dedup_key} onChange={(e) => set({ dedup_key: e.target.value })} placeholder="{{enrollment_id}}-step-1" />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create `src/components/action-forms/CallAIForm.tsx`**

```tsx
import React from 'react'
import type { CallAIParams } from '../../types.js'
import { label, inputStyle } from '../utils.js'

const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']

interface Props {
  params: CallAIParams
  onParamsChange: (p: CallAIParams) => void
}

export function CallAIForm({ params, onParamsChange }: Props) {
  const set = (patch: Partial<CallAIParams>) => onParamsChange({ ...params, ...patch })
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>System prompt</span>
        <textarea style={{ ...inputStyle, height: 72, resize: 'vertical' }} value={params.system_prompt} onChange={(e) => set({ system_prompt: e.target.value })} placeholder="You are a helpful orthodontic assistant." />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>User prompt</span>
        <textarea style={{ ...inputStyle, height: 72, resize: 'vertical' }} value={params.user_prompt} onChange={(e) => set({ user_prompt: e.target.value })} placeholder="Draft a follow-up SMS for {{context.first_name}}..." />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Model</span>
        <select style={inputStyle} value={params.model} onChange={(e) => set({ model: e.target.value })}>
          {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={params.auto_send} onChange={(e) => set({ auto_send: e.target.checked })} />
          Auto-send output as message (requires manager approval)
        </label>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Create `src/components/action-forms/EmitEventForm.tsx`**

```tsx
import React from 'react'
import type { EmitEventParams } from '../../types.js'
import { label, inputStyle, btn } from '../utils.js'

interface Props {
  params: EmitEventParams
  onParamsChange: (p: EmitEventParams) => void
}

export function EmitEventForm({ params, onParamsChange }: Props) {
  const set = (patch: Partial<EmitEventParams>) => onParamsChange({ ...params, ...patch })

  const setPayloadKey = (oldKey: string, newKey: string) => {
    const entries = Object.entries(params.payload)
    const updated = Object.fromEntries(entries.map(([k, v]) => [k === oldKey ? newKey : k, v]))
    set({ payload: updated })
  }

  const setPayloadValue = (key: string, val: string) => {
    set({ payload: { ...params.payload, [key]: val } })
  }

  const addPayloadEntry = () => set({ payload: { ...params.payload, '': '' } })

  const removePayloadEntry = (key: string) => {
    const next = { ...params.payload }
    delete next[key]
    set({ payload: next })
  }

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Event type</span>
        <input style={inputStyle} value={params.event_type} onChange={(e) => set({ event_type: e.target.value })} placeholder="nurturing.no_response_escalation" />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Payload fields</span>
        {Object.entries(params.payload).map(([key, val]) => (
          <div key={key} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <input style={{ ...inputStyle, flex: 1 }} value={key} onChange={(e) => setPayloadKey(key, e.target.value)} placeholder="field" />
            <input style={{ ...inputStyle, flex: 1 }} value={val} onChange={(e) => setPayloadValue(key, e.target.value)} placeholder="context.entity_id" />
            <button type="button" style={{ ...btn, padding: '2px 8px', color: '#dc3545' }} onClick={() => removePayloadEntry(key)}>✕</button>
          </div>
        ))}
        <button type="button" style={btn} onClick={addPayloadEntry}>+ Add field</button>
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={params.include_context} onChange={(e) => set({ include_context: e.target.checked })} />
          Include full enrollment context in payload
        </label>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Typecheck**

```bash
cd packages/@platform/sequence-ui && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/@platform/sequence-ui/src/components/action-forms/
git commit -m "feat(@platform/sequence-ui): add action form sub-components"
```

---

### Task 4: TemplatePicker modal

**Files:**
- Create: `src/components/TemplatePicker.tsx`
- Create: `test/component/TemplatePicker.test.tsx`

- [ ] **Step 1: Write failing tests**

`test/component/TemplatePicker.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { server } from '../msw-server.js'
import { http, HttpResponse } from 'msw'
import { GATEWAY_URL, mockTemplates } from '../msw-handlers.js'
import { GatewayApiClient } from '../../src/api/GatewayApiClient.js'
import { TemplatePicker } from '../../src/components/TemplatePicker.js'

function renderPicker(overrides: Partial<React.ComponentProps<typeof TemplatePicker>> = {}) {
  const client = new GatewayApiClient(GATEWAY_URL, 'tok')
  const props = { client, channel: 'sms' as const, onSelect: vi.fn(), onClose: vi.fn(), ...overrides }
  return { ...render(<TemplatePicker {...props} />), props }
}

describe('TemplatePicker', () => {
  it('renders modal overlay', () => {
    renderPicker()
    expect(document.querySelector('.sq-modal-overlay')).toBeInTheDocument()
  })

  it('loads and displays templates on mount', async () => {
    renderPicker()
    await waitFor(() => expect(screen.getByText('contacted-followup-sms-1')).toBeInTheDocument())
    expect(screen.getByText('contacted-followup-sms-2')).toBeInTheDocument()
  })

  it('calls onSelect and onClose when template is clicked', async () => {
    const { props } = renderPicker()
    await waitFor(() => screen.getByText('contacted-followup-sms-1'))
    await userEvent.click(screen.getByText('contacted-followup-sms-1'))
    expect(props.onSelect).toHaveBeenCalledWith('sms-1')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('calls onClose when close button is clicked', async () => {
    const { props } = renderPicker()
    await userEvent.click(screen.getByRole('button', { name: '✕' }))
    expect(props.onClose).toHaveBeenCalled()
  })

  it('sends search query to API after typing', async () => {
    let capturedUrl = ''
    server.use(
      http.get(`${GATEWAY_URL}/templates`, ({ request }) => {
        capturedUrl = request.url
        return HttpResponse.json([])
      }),
    )
    renderPicker()
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'followup')
    await waitFor(() => expect(capturedUrl).toContain('q=followup'), { timeout: 1000 })
  })

  it('filters by channel=email when channel prop is email', async () => {
    let capturedUrl = ''
    server.use(http.get(`${GATEWAY_URL}/templates`, ({ request }) => { capturedUrl = request.url; return HttpResponse.json([]) }))
    renderPicker({ channel: 'email' })
    await waitFor(() => expect(capturedUrl).toContain('channel=email'))
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/component/TemplatePicker.test.tsx
```

Expected: `Cannot find module '../../src/components/TemplatePicker.js'`

- [ ] **Step 3: Create `src/components/TemplatePicker.tsx`**

```tsx
import React, { useState, useEffect, useRef } from 'react'
import type { GatewayApiClient } from '../api/GatewayApiClient.js'
import type { TemplateSummary } from '../types.js'
import { btn } from './utils.js'

interface Props {
  client: GatewayApiClient
  channel: 'sms' | 'email'
  onSelect: (templateId: string) => void
  onClose: () => void
}

export function TemplatePicker({ client, channel, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const search = (q: string) => {
    setLoading(true)
    client
      .searchTemplates(channel, q)
      .then((res) => { setTemplates(res); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { search('') }, [])

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value
    setQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(q), 300)
  }

  const handleSelect = (t: TemplateSummary) => {
    setSelectedId(t.template_id)
    onSelect(t.template_id)
    onClose()
  }

  return (
    <div className="sq-modal-overlay" onClick={onClose}>
      <div
        style={{ background: '#fff', borderRadius: 8, padding: 20, width: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,.2)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong style={{ fontSize: 15 }}>Choose Template</strong>
          <button style={btn} onClick={onClose}>✕</button>
        </div>
        <input
          role="searchbox"
          style={{ padding: '6px 10px', border: '1px solid #ccc', borderRadius: 4, fontSize: 13, marginBottom: 10 }}
          placeholder="Search templates..."
          value={query}
          onChange={handleQueryChange}
        />
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading && <div style={{ padding: 12, color: '#6c757d', fontSize: 13 }}>Loading...</div>}
          {!loading && templates.length === 0 && <div style={{ padding: 12, color: '#6c757d', fontSize: 13 }}>No templates found.</div>}
          {templates.map((t) => (
            <div
              key={t.template_id}
              className={`sq-template-item${selectedId === t.template_id ? ' selected' : ''}`}
              onClick={() => handleSelect(t)}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{t.name}</div>
              <div style={{ fontSize: 12, color: '#6c757d', marginTop: 2 }}>{t.preview}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/component/TemplatePicker.test.tsx
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/sequence-ui/src/components/TemplatePicker.tsx \
        packages/@platform/sequence-ui/test/component/TemplatePicker.test.tsx
git commit -m "feat(@platform/sequence-ui): add TemplatePicker modal with tests"
```

---

### Task 5: StepList (dnd-kit sortable)

No separate tests — tested via SequenceBuilder tests in Task 10.

**Files:**
- Create: `src/components/StepList.tsx`

- [ ] **Step 1: Create `src/components/StepList.tsx`**

```tsx
import React from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { StepDraft } from '../types.js'

interface SortableStepProps {
  step: StepDraft
  index: number
  isSelected: boolean
  onClick: () => void
}

function SortableStep({ step, index, isSelected, onClick }: SortableStepProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    background: '#fff',
    border: `${isSelected ? 2 : 1}px solid ${isSelected ? '#0066cc' : '#dee2e6'}`,
    borderRadius: 6,
    padding: '10px 10px 10px 6px',
    marginBottom: 6,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    cursor: 'pointer',
    userSelect: 'none',
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`sq-step-item${isSelected ? ' selected' : ''}${isDragging ? ' dragging' : ''}`}
      onClick={onClick}
    >
      <span className="sq-drag-handle" {...attributes} {...listeners} style={{ fontSize: 16, lineHeight: 1, paddingTop: 2 }}>⠿</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, color: '#6c757d', marginBottom: 2 }}>
          Step {index + 1} · {step.delay.value} {step.delay.unit}
        </div>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{step.action.type.replace('_', ' ')}</div>
        {step.action.type === 'send_message' || step.action.type === 'send_email'
          ? <div style={{ fontSize: 12, color: '#495057' }}>{step.action.params.template_id || '(no template)'}</div>
          : step.action.type === 'emit_event'
          ? <div style={{ fontSize: 12, color: '#495057' }}>{step.action.params.event_type || '(no event type)'}</div>
          : null}
      </div>
      {step.ab_variant_override && (
        <span style={{ fontSize: 11, background: '#cfe2ff', color: '#084298', padding: '1px 6px', borderRadius: 3, alignSelf: 'center' }}>A/B</span>
      )}
    </div>
  )
}

interface StepListProps {
  steps: StepDraft[]
  selectedStepId: string | null
  onSelectStep: (id: string) => void
  onAddStep: () => void
  onReorder: (event: DragEndEvent) => void
}

export function StepList({ steps, selectedStepId, onSelectStep, onAddStep, onReorder }: StepListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 12, background: '#f8f9fa' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6c757d', marginBottom: 8 }}>Steps</div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onReorder}>
        <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          {steps.map((step, i) => (
            <SortableStep
              key={step.id}
              step={step}
              index={i}
              isSelected={step.id === selectedStepId}
              onClick={() => onSelectStep(step.id)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <button
        onClick={onAddStep}
        style={{ width: '100%', padding: '8px', border: '2px dashed #dee2e6', borderRadius: 6, background: 'transparent', color: '#6c757d', fontSize: 12, cursor: 'pointer', marginTop: 4 }}
      >
        + Add Step
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
cd packages/@platform/sequence-ui && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/@platform/sequence-ui/src/components/StepList.tsx
git commit -m "feat(@platform/sequence-ui): add StepList with dnd-kit drag-to-reorder"
```

---

### Task 6: ActiveHoursConfig + ABConfig

No separate tests — tested via SequenceBuilder tests in Task 10.

**Files:**
- Create: `src/components/ActiveHoursConfig.tsx`
- Create: `src/components/ABConfig.tsx`

- [ ] **Step 1: Create `src/components/ActiveHoursConfig.tsx`**

```tsx
import React from 'react'
import type { ActiveHours } from '../types.js'
import { label, inputStyle } from './utils.js'

interface Props {
  activeHours: ActiveHours | null
  onChange: (v: ActiveHours | null) => void
}

const DEFAULT: ActiveHours = { start: '08:00', end: '20:00', timezone_field: 'context.location_timezone' }

export function ActiveHoursConfig({ activeHours, onChange }: Props) {
  const enabled = activeHours !== null
  const value = activeHours ?? DEFAULT

  return (
    <div style={{ borderTop: '1px solid #dee2e6', paddingTop: 12, marginTop: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 10 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked ? DEFAULT : null)} />
        <strong style={{ fontSize: 13 }}>Restrict to active hours</strong>
      </label>
      {enabled && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 100 }}>
            <span style={label}>Start (HH:MM)</span>
            <input style={inputStyle} type="time" value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} />
          </div>
          <div style={{ flex: 1, minWidth: 100 }}>
            <span style={label}>End (HH:MM)</span>
            <input style={inputStyle} type="time" value={value.end} onChange={(e) => onChange({ ...value, end: e.target.value })} />
          </div>
          <div style={{ flex: 2, minWidth: 160 }}>
            <span style={label}>Timezone field (context path)</span>
            <input style={inputStyle} value={value.timezone_field} onChange={(e) => onChange({ ...value, timezone_field: e.target.value })} placeholder="context.location_timezone" />
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create `src/components/ABConfig.tsx`**

```tsx
import React from 'react'
import type { ABTest } from '../types.js'
import { label, inputStyle } from './utils.js'

interface Props {
  abTest: ABTest | null
  onChange: (v: ABTest | null) => void
}

const DEFAULT: ABTest = {
  enabled: true,
  split: { A: 50, B: 50 },
  tracked_event: '',
  tracked_condition: { field: '', op: 'eq', value: '' },
}

const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains']

export function ABConfig({ abTest, onChange }: Props) {
  const enabled = abTest !== null
  const value = abTest ?? DEFAULT

  const setSplit = (aVal: number) => {
    const clamped = Math.max(0, Math.min(100, aVal))
    onChange({ ...value, split: { A: clamped, B: 100 - clamped } })
  }

  const setCond = (patch: Partial<ABTest['tracked_condition']>) =>
    onChange({ ...value, tracked_condition: { ...value.tracked_condition, ...patch } })

  return (
    <div style={{ borderTop: '1px solid #dee2e6', paddingTop: 12, marginTop: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 10 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked ? DEFAULT : null)} />
        <strong style={{ fontSize: 13 }}>A/B test</strong>
      </label>
      {enabled && (
        <div>
          <div style={{ marginBottom: 10 }}>
            <span style={label}>Traffic split — Variant A: {value.split.A}% / B: {value.split.B}%</span>
            <input type="range" min={0} max={100} value={value.split.A} onChange={(e) => setSplit(Number(e.target.value))} style={{ width: '100%' }} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <span style={label}>Tracked event type</span>
            <input style={inputStyle} value={value.tracked_event} onChange={(e) => onChange({ ...value, tracked_event: e.target.value })} placeholder="lead.stage_changed" />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 2 }}>
              <span style={label}>Condition field</span>
              <input style={inputStyle} value={value.tracked_condition.field} onChange={(e) => setCond({ field: e.target.value })} placeholder="payload.new_stage" />
            </div>
            <div style={{ flex: 1 }}>
              <span style={label}>Operator</span>
              <select style={inputStyle} value={value.tracked_condition.op} onChange={(e) => setCond({ op: e.target.value })}>
                {OPS.map((op) => <option key={op} value={op}>{op}</option>)}
              </select>
            </div>
            <div style={{ flex: 2 }}>
              <span style={label}>Value</span>
              <input style={inputStyle} value={String(value.tracked_condition.value)} onChange={(e) => setCond({ value: e.target.value })} placeholder="exam_scheduled" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/@platform/sequence-ui && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/@platform/sequence-ui/src/components/ActiveHoursConfig.tsx \
        packages/@platform/sequence-ui/src/components/ABConfig.tsx
git commit -m "feat(@platform/sequence-ui): add ActiveHoursConfig and ABConfig components"
```

---

### Task 7: StepEditor component

**Files:**
- Create: `src/components/StepEditor.tsx`
- Create: `test/component/StepEditor.test.tsx`

- [ ] **Step 1: Write failing tests**

`test/component/StepEditor.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GatewayApiClient } from '../../src/api/GatewayApiClient.js'
import { GATEWAY_URL, mockSequence } from '../msw-handlers.js'
import { StepEditor } from '../../src/components/StepEditor.js'
import type { StepDraft } from '../../src/types.js'

const step1 = mockSequence.steps[0] as StepDraft
const step2: StepDraft = {
  id: 'step-x',
  delay: { value: 48, unit: 'hours' },
  action: { type: 'send_email', params: { template_id: 'em-1', to_field: 'context.email', from_field: 'context.from', dedup_key: 'dk' } },
}

function renderEditor(step: StepDraft, overrides: Partial<React.ComponentProps<typeof StepEditor>> = {}) {
  const gatewayClient = new GatewayApiClient(GATEWAY_URL, 'tok')
  const props = {
    step,
    gatewayClient,
    onUpdate: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  }
  return { ...render(<StepEditor {...props} />), props }
}

describe('StepEditor', () => {
  it('renders delay value and unit', () => {
    renderEditor(step1)
    expect(screen.getByDisplayValue('24')).toBeInTheDocument()
    expect(screen.getByDisplayValue('hours')).toBeInTheDocument()
  })

  it('renders send_message action type selected', () => {
    renderEditor(step1)
    expect((screen.getByRole('combobox', { name: /action type/i }) as HTMLSelectElement).value).toBe('send_message')
  })

  it('renders send_email form when action type is send_email', () => {
    renderEditor(step2)
    expect((screen.getByRole('combobox', { name: /action type/i }) as HTMLSelectElement).value).toBe('send_email')
    expect(screen.getByDisplayValue('em-1')).toBeInTheDocument()
  })

  it('switching action type updates form area', async () => {
    renderEditor(step1)
    const select = screen.getByRole('combobox', { name: /action type/i })
    await userEvent.selectOptions(select, 'emit_event')
    expect(screen.getByPlaceholderText('nurturing.no_response_escalation')).toBeInTheDocument()
  })

  it('calls onUpdate when delay value changes', async () => {
    const { props } = renderEditor(step1)
    const delayInput = screen.getByDisplayValue('24')
    await userEvent.clear(delayInput)
    await userEvent.type(delayInput, '48')
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalled())
  })

  it('calls onRemove when Remove Step button is clicked', async () => {
    const { props } = renderEditor(step1)
    await userEvent.click(screen.getByRole('button', { name: /remove step/i }))
    expect(props.onRemove).toHaveBeenCalled()
  })

  it('opens TemplatePicker when Browse button is clicked for send_message', async () => {
    renderEditor(step1)
    await userEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(document.querySelector('.sq-modal-overlay')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/component/StepEditor.test.tsx
```

Expected: `Cannot find module '../../src/components/StepEditor.js'`

- [ ] **Step 3: Create `src/components/StepEditor.tsx`**

```tsx
import React, { useState } from 'react'
import type { StepDraft, StepAction, SendMessageParams, SendEmailParams, CallAIParams, EmitEventParams } from '../types.js'
import type { GatewayApiClient } from '../api/GatewayApiClient.js'
import { label, inputStyle, selectStyle, dangerBtn } from './utils.js'
import { SendMessageForm } from './action-forms/SendMessageForm.js'
import { SendEmailForm } from './action-forms/SendEmailForm.js'
import { CallAIForm } from './action-forms/CallAIForm.js'
import { EmitEventForm } from './action-forms/EmitEventForm.js'
import { TemplatePicker } from './TemplatePicker.js'

const DELAY_UNITS = ['minutes', 'hours', 'days'] as const
const ACTION_TYPES = ['send_message', 'send_email', 'call_ai', 'emit_event'] as const

function defaultAction(type: StepAction['type']): StepAction {
  if (type === 'send_message') return { type, params: { template_id: '', to_field: '', from_field: '', context: 'context', dedup_key: '' } }
  if (type === 'send_email') return { type, params: { template_id: '', to_field: '', from_field: '', dedup_key: '' } }
  if (type === 'call_ai') return { type, params: { system_prompt: '', user_prompt: '', model: 'claude-haiku-4-5-20251001', output_field: 'context.ai_output', auto_send: false } }
  return { type: 'emit_event', params: { event_type: '', payload: {}, include_context: true } }
}

interface Props {
  step: StepDraft
  gatewayClient: GatewayApiClient
  onUpdate: (updated: StepDraft) => void
  onRemove: () => void
}

export function StepEditor({ step, gatewayClient, onUpdate, onRemove }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerChannel, setPickerChannel] = useState<'sms' | 'email'>('sms')

  const setDelay = (patch: Partial<StepDraft['delay']>) =>
    onUpdate({ ...step, delay: { ...step.delay, ...patch } })

  const setActionType = (type: StepAction['type']) =>
    onUpdate({ ...step, action: defaultAction(type) })

  const setParams = (params: StepAction['params']) =>
    onUpdate({ ...step, action: { ...step.action, params } as StepAction })

  const setAbOverride = (override: Record<string, unknown> | undefined) =>
    onUpdate({ ...step, ab_variant_override: override })

  const openPicker = (channel: 'sms' | 'email') => { setPickerChannel(channel); setPickerOpen(true) }
  const onTemplateSelect = (templateId: string) => {
    const p = step.action.params as Record<string, unknown>
    setParams({ ...p, template_id: templateId } as StepAction['params'])
  }

  const renderForm = () => {
    const { type, params } = step.action
    if (type === 'send_message') {
      return (
        <SendMessageForm
          params={params as SendMessageParams}
          abOverride={step.ab_variant_override}
          onParamsChange={(p) => setParams(p)}
          onAbOverrideChange={setAbOverride}
          onBrowseTemplate={() => openPicker('sms')}
        />
      )
    }
    if (type === 'send_email') {
      return (
        <SendEmailForm
          params={params as SendEmailParams}
          onParamsChange={(p) => setParams(p)}
          onBrowseTemplate={() => openPicker('email')}
        />
      )
    }
    if (type === 'call_ai') {
      return <CallAIForm params={params as CallAIParams} onParamsChange={(p) => setParams(p)} />
    }
    return <EmitEventForm params={params as EmitEventParams} onParamsChange={(p) => setParams(p)} />
  }

  return (
    <div style={{ padding: 16, height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <strong style={{ fontSize: 14 }}>Edit Step</strong>
        <button style={dangerBtn} onClick={onRemove}>Remove Step</button>
      </div>

      <div style={{ marginBottom: 16, padding: 12, background: '#f8f9fa', borderRadius: 6 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <span style={label}>Delay</span>
            <input
              style={inputStyle}
              type="number"
              min={0}
              value={step.delay.value}
              onChange={(e) => setDelay({ value: Number(e.target.value) })}
            />
          </div>
          <div style={{ flex: 1 }}>
            <span style={label}>Unit</span>
            <select style={selectStyle} value={step.delay.unit} onChange={(e) => setDelay({ unit: e.target.value as StepDraft['delay']['unit'] })}>
              {DELAY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={label} id="action-type-label">Action type</label>
        <select
          aria-labelledby="action-type-label"
          style={selectStyle}
          value={step.action.type}
          onChange={(e) => setActionType(e.target.value as StepAction['type'])}
        >
          {ACTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {renderForm()}

      {pickerOpen && (
        <TemplatePicker
          client={gatewayClient}
          channel={pickerChannel}
          onSelect={onTemplateSelect}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/component/StepEditor.test.tsx
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/sequence-ui/src/components/StepEditor.tsx \
        packages/@platform/sequence-ui/test/component/StepEditor.test.tsx
git commit -m "feat(@platform/sequence-ui): add StepEditor component with tests"
```

---

### Task 8: EnrollmentLog component

**Files:**
- Create: `src/components/EnrollmentLog.tsx`
- Create: `test/component/EnrollmentLog.test.tsx`

- [ ] **Step 1: Write failing tests**

`test/component/EnrollmentLog.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { server } from '../msw-server.js'
import { http, HttpResponse } from 'msw'
import { NURTURING_URL, mockEnrollments } from '../msw-handlers.js'
import { SequenceApiClient } from '../../src/api/SequenceApiClient.js'
import { EnrollmentLog } from '../../src/components/EnrollmentLog.js'

function renderLog(sequenceId = 'seq-1') {
  const client = new SequenceApiClient(NURTURING_URL, 'tok')
  return render(<EnrollmentLog sequenceId={sequenceId} client={client} />)
}

describe('EnrollmentLog', () => {
  it('loads and renders enrollment rows', async () => {
    renderLog()
    await waitFor(() => expect(screen.getByText('enr-1')).toBeInTheDocument())
    expect(screen.getByText('enr-2')).toBeInTheDocument()
  })

  it('shows variant badge for each enrollment', async () => {
    renderLog()
    await waitFor(() => screen.getByText('enr-1'))
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
  })

  it('shows status for each enrollment', async () => {
    renderLog()
    await waitFor(() => screen.getByText('enr-1'))
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.getByText('completed')).toBeInTheDocument()
  })

  it('shows error message when API fails', async () => {
    server.use(http.get(`${NURTURING_URL}/sequences/seq-1/enrollments`, () => HttpResponse.json({}, { status: 500 })))
    renderLog()
    await waitFor(() => expect(screen.getByText(/failed/i)).toBeInTheDocument())
  })

  it('shows empty state when no enrollments', async () => {
    server.use(http.get(`${NURTURING_URL}/sequences/seq-1/enrollments`, () => HttpResponse.json({ data: [] })))
    renderLog()
    await waitFor(() => expect(screen.getByText(/no enrollments/i)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/component/EnrollmentLog.test.tsx
```

Expected: `Cannot find module '../../src/components/EnrollmentLog.js'`

- [ ] **Step 3: Create `src/components/EnrollmentLog.tsx`**

```tsx
import React from 'react'
import { useEnrollments } from '../hooks/useEnrollments.js'
import type { SequenceApiClient } from '../api/SequenceApiClient.js'

const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontWeight: 600, fontSize: 12, borderBottom: '2px solid #dee2e6' }
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 13, borderBottom: '1px solid #f0f0f0' }

const variantColors: Record<string, { bg: string; color: string }> = {
  A: { bg: '#cfe2ff', color: '#084298' },
  B: { bg: '#d1e7dd', color: '#0f5132' },
}

interface Props {
  sequenceId: string
  client: SequenceApiClient
}

export function EnrollmentLog({ sequenceId, client }: Props) {
  const { enrollments, loading, error } = useEnrollments(client, sequenceId)

  if (loading) return <div style={{ padding: 20, color: '#6c757d', fontSize: 13 }}>Loading enrollments...</div>
  if (error) return <div style={{ padding: 20, color: '#721c24', fontSize: 13 }}>{error}</div>
  if (enrollments.length === 0) return <div style={{ padding: 20, color: '#6c757d', fontSize: 13 }}>No enrollments yet.</div>

  return (
    <div style={{ overflowX: 'auto', padding: 16 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>ID</th>
            <th style={th}>Entity</th>
            <th style={th}>Variant</th>
            <th style={th}>Status</th>
            <th style={th}>Enrolled</th>
            <th style={th}>Completed</th>
          </tr>
        </thead>
        <tbody>
          {enrollments.map((e) => {
            const vc = e.ab_variant ? variantColors[e.ab_variant] : null
            return (
              <tr key={e.enrollment_id}>
                <td style={td}>{e.enrollment_id}</td>
                <td style={td}>{e.entity_type}/{e.entity_id}</td>
                <td style={td}>
                  {vc && e.ab_variant ? (
                    <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 3, fontSize: 12, fontWeight: 700, background: vc.bg, color: vc.color }}>
                      {e.ab_variant}
                    </span>
                  ) : '—'}
                </td>
                <td style={td}>{e.status}</td>
                <td style={td}>{new Date(e.enrolled_at).toLocaleString()}</td>
                <td style={td}>{e.completed_at ? new Date(e.completed_at).toLocaleString() : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/component/EnrollmentLog.test.tsx
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/sequence-ui/src/components/EnrollmentLog.tsx \
        packages/@platform/sequence-ui/test/component/EnrollmentLog.test.tsx
git commit -m "feat(@platform/sequence-ui): add EnrollmentLog component with tests"
```

---

### Task 9: ABResults component

**Files:**
- Create: `src/components/ABResults.tsx`
- Create: `test/component/ABResults.test.tsx`

- [ ] **Step 1: Write failing tests**

`test/component/ABResults.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { server } from '../msw-server.js'
import { http, HttpResponse } from 'msw'
import { NURTURING_URL, mockStats } from '../msw-handlers.js'
import { SequenceApiClient } from '../../src/api/SequenceApiClient.js'
import { ABResults } from '../../src/components/ABResults.js'

function renderResults(sequenceId = 'seq-1') {
  const client = new SequenceApiClient(NURTURING_URL, 'tok')
  return render(<ABResults sequenceId={sequenceId} client={client} />)
}

describe('ABResults', () => {
  it('renders A and B variant stats after loading', async () => {
    renderResults()
    await waitFor(() => expect(screen.getByText('Variant A')).toBeInTheDocument())
    expect(screen.getByText('Variant B')).toBeInTheDocument()
  })

  it('shows winner badge when stats include a winner', async () => {
    renderResults()
    await waitFor(() => expect(screen.getByText(/winner/i)).toBeInTheDocument())
    expect(screen.getByText('Variant A')).toBeInTheDocument()
  })

  it('shows conversion rates', async () => {
    renderResults()
    await waitFor(() => expect(screen.getByText('24%')).toBeInTheDocument())
    expect(screen.getByText('17%')).toBeInTheDocument()
  })

  it('shows error when API fails', async () => {
    server.use(http.get(`${NURTURING_URL}/sequences/seq-1/stats`, () => HttpResponse.json({}, { status: 500 })))
    renderResults()
    await waitFor(() => expect(screen.getByText(/failed/i)).toBeInTheDocument())
  })

  it('shows "no data" when stats have no ab field', async () => {
    server.use(
      http.get(`${NURTURING_URL}/sequences/seq-1/stats`, () =>
        HttpResponse.json({ ...mockStats, ab: null }),
      ),
    )
    renderResults()
    await waitFor(() => expect(screen.getByText(/no a\/b data/i)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/component/ABResults.test.tsx
```

Expected: `Cannot find module '../../src/components/ABResults.js'`

- [ ] **Step 3: Create `src/components/ABResults.tsx`**

```tsx
import React from 'react'
import { useABStats } from '../hooks/useABStats.js'
import type { SequenceApiClient } from '../api/SequenceApiClient.js'

const card: React.CSSProperties = {
  flex: 1, minWidth: 200, background: '#f8f9fa', border: '1px solid #dee2e6',
  borderRadius: 8, padding: 20,
}

const metricLabel: React.CSSProperties = { fontSize: 12, color: '#6c757d', marginBottom: 2 }
const metricValue: React.CSSProperties = { fontSize: 22, fontWeight: 700, marginBottom: 8 }

interface Props {
  sequenceId: string
  client: SequenceApiClient
}

export function ABResults({ sequenceId, client }: Props) {
  const { stats, loading, error } = useABStats(client, sequenceId)

  if (loading) return <div style={{ padding: 20, color: '#6c757d', fontSize: 13 }}>Loading A/B results...</div>
  if (error) return <div style={{ padding: 20, color: '#721c24', fontSize: 13 }}>{error}</div>
  if (!stats?.ab) return <div style={{ padding: 20, color: '#6c757d', fontSize: 13 }}>No A/B data available.</div>

  const { A, B, winner, significant, p_value } = stats.ab

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 4px' }}>A/B Test Results</h3>
        {significant && winner && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', background: '#d4edda', color: '#155724', borderRadius: 20, fontSize: 13, fontWeight: 600 }}>
            Winner: Variant {winner}
            {p_value != null && <span style={{ fontWeight: 400 }}>(p={p_value.toFixed(3)})</span>}
          </div>
        )}
        {!significant && <div style={{ fontSize: 13, color: '#6c757d' }}>No statistically significant winner yet.</div>}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {([['A', A], ['B', B]] as const).map(([variant, data]) => (
          <div key={variant} style={{ ...card, ...(winner === variant ? { borderColor: '#198754', boxShadow: '0 0 0 2px #19875433' } : {}) }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Variant {variant}</div>
            <div style={metricLabel}>Enrollments</div>
            <div style={metricValue}>{data.enrollments}</div>
            <div style={metricLabel}>Completion rate</div>
            <div style={metricValue}>{Math.round(data.completion_rate * 100)}%</div>
            <div style={metricLabel}>Conversion rate</div>
            <div style={{ ...metricValue, color: '#0f5132' }}>{Math.round(data.conversion_rate * 100)}%</div>
            <div style={{ fontSize: 12, color: '#6c757d' }}>{data.conversion_count} conversions</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 20, padding: 12, background: '#f0f4ff', borderRadius: 6 }}>
        <div style={{ fontSize: 12, color: '#6c757d' }}>Overall: {stats.total_enrollments} enrolled · {stats.completed_count} completed · {stats.failed_count} failed</div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/component/ABResults.test.tsx
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/sequence-ui/src/components/ABResults.tsx \
        packages/@platform/sequence-ui/test/component/ABResults.test.tsx
git commit -m "feat(@platform/sequence-ui): add ABResults component with tests"
```

---

### Task 10: SequenceBuilder component

**Files:**
- Create: `src/components/SequenceBuilder.tsx`
- Create: `test/component/SequenceBuilder.test.tsx`

- [ ] **Step 1: Write failing tests**

`test/component/SequenceBuilder.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { server } from '../msw-server.js'
import { http, HttpResponse } from 'msw'
import { NURTURING_URL, GATEWAY_URL, mockSequence } from '../msw-handlers.js'
import { SequenceBuilder } from '../../src/components/SequenceBuilder.js'

function renderBuilder(overrides: Partial<React.ComponentProps<typeof SequenceBuilder>> = {}) {
  const props = {
    sequenceId: 'seq-1',
    nurturingEngineUrl: NURTURING_URL,
    crmGatewayUrl: GATEWAY_URL,
    token: 'tok',
    userRole: 'marketing_manager' as const,
    onBack: vi.fn(),
    ...overrides,
  }
  return { ...render(<SequenceBuilder {...props} />), props }
}

describe('SequenceBuilder', () => {
  it('renders sequence name after loading', async () => {
    renderBuilder()
    await waitFor(() => expect(screen.getByText('No Response Follow-up')).toBeInTheDocument())
  })

  it('shows Builder, Enrollments tabs', async () => {
    renderBuilder()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    expect(screen.getByRole('tab', { name: 'Builder' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Enrollments' })).toBeInTheDocument()
  })

  it('shows A/B Results tab when ab_test is set', async () => {
    renderBuilder()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    expect(screen.getByRole('tab', { name: 'A/B Results' })).toBeInTheDocument()
  })

  it('does not show A/B Results tab when ab_test is null', async () => {
    server.use(
      http.get(`${NURTURING_URL}/sequences/seq-1`, () =>
        HttpResponse.json({ ...mockSequence, ab_test: null }),
      ),
    )
    renderBuilder()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    expect(screen.queryByRole('tab', { name: 'A/B Results' })).not.toBeInTheDocument()
  })

  it('switches to Enrollments tab on click', async () => {
    renderBuilder()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    await userEvent.click(screen.getByRole('tab', { name: 'Enrollments' }))
    await waitFor(() => expect(screen.getByText('enr-1')).toBeInTheDocument())
  })

  it('disables Activate button for marketing_staff', async () => {
    renderBuilder({ userRole: 'marketing_staff' })
    await waitFor(() => screen.getByText('No Response Follow-up'))
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument()
  })

  it('calls onBack when Back button is clicked', async () => {
    const { props } = renderBuilder()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    await userEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(props.onBack).toHaveBeenCalled()
  })

  it('Save Draft button calls PUT endpoint and clears dirty state', async () => {
    let putCalled = false
    server.use(http.put(`${NURTURING_URL}/sequences/seq-1`, () => { putCalled = true; return HttpResponse.json({}) }))
    renderBuilder()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    // make a change to create dirty state by clicking Add Step
    await userEvent.click(screen.getByRole('button', { name: '+ Add Step' }))
    const saveBtn = screen.getByRole('button', { name: /save draft/i })
    await userEvent.click(saveBtn)
    await waitFor(() => expect(putCalled).toBe(true))
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/component/SequenceBuilder.test.tsx
```

Expected: `Cannot find module '../../src/components/SequenceBuilder.js'`

- [ ] **Step 3: Create `src/components/SequenceBuilder.tsx`**

```tsx
import React, { useState } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { SequenceApiClient } from '../api/SequenceApiClient.js'
import { GatewayApiClient } from '../api/GatewayApiClient.js'
import { useSequenceDetail } from '../hooks/useSequenceDetail.js'
import { useStepEditor } from '../hooks/useStepEditor.js'
import type { SequenceBuilderProps, StepDraft } from '../types.js'
import { btn, primaryBtn, dangerBtn } from './utils.js'
import { StepList } from './StepList.js'
import { StepEditor } from './StepEditor.js'
import { ActiveHoursConfig } from './ActiveHoursConfig.js'
import { ABConfig } from './ABConfig.js'
import { EnrollmentLog } from './EnrollmentLog.js'
import { ABResults } from './ABResults.js'

type Tab = 'builder' | 'enrollments' | 'ab_results'

const tabBtn = (active: boolean): React.CSSProperties => ({
  padding: '8px 18px', border: 'none', borderBottom: active ? '2px solid #0066cc' : '2px solid transparent',
  background: 'transparent', cursor: 'pointer', fontWeight: active ? 700 : 400, color: active ? '#0066cc' : '#495057', fontSize: 13,
})

export function SequenceBuilder({ sequenceId, nurturingEngineUrl, crmGatewayUrl, token, userRole, onBack }: SequenceBuilderProps) {
  const [seqClient] = useState(() => new SequenceApiClient(nurturingEngineUrl, token))
  const [gwClient] = useState(() => new GatewayApiClient(crmGatewayUrl, token))

  const { sequence, loading, error, saveDraft, activate, disable, reload } = useSequenceDetail(seqClient, sequenceId)

  const [tab, setTab] = useState<Tab>('builder')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const canManage = userRole === 'marketing_manager' || userRole === 'super_admin'

  const {
    steps, selectedStepId, isDirty,
    selectStep, addStep, removeStep, updateStep,
    reorderSteps, setActiveHours, setAbTest,
    activeHours, abTest,
  } = useStepEditor(sequence)

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = steps.findIndex((s) => s.id === active.id)
    const newIndex = steps.findIndex((s) => s.id === over.id)
    reorderSteps(arrayMove(steps, oldIndex, newIndex))
  }

  const handleSaveDraft = async () => {
    if (!sequence) return
    setSaving(true); setActionError(null)
    try {
      await saveDraft({ steps, active_hours: activeHours, ab_test: abTest })
      await reload()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleActivate = async () => {
    setSaving(true); setActionError(null)
    try { await activate() } catch (e) { setActionError(e instanceof Error ? e.message : 'Activate failed') }
    finally { setSaving(false) }
  }

  const handleDisable = async () => {
    setSaving(true); setActionError(null)
    try { await disable() } catch (e) { setActionError(e instanceof Error ? e.message : 'Disable failed') }
    finally { setSaving(false) }
  }

  const selectedStep = steps.find((s) => s.id === selectedStepId) ?? null

  if (loading) return <div style={{ padding: 20 }}>Loading sequence...</div>
  if (error || !sequence) return <div style={{ padding: 20, color: '#721c24' }}>{error ?? 'Sequence not found'}</div>

  const showABTab = sequence.ab_test !== null || abTest !== null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #dee2e6', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button style={btn} onClick={onBack}>← Back</button>
        <h2 style={{ margin: 0, flex: 1, fontSize: 16 }}>{sequence.name}</h2>
        {actionError && <span style={{ color: '#721c24', fontSize: 13 }}>{actionError}</span>}
        {isDirty && (
          <button style={primaryBtn} disabled={saving} onClick={() => void handleSaveDraft()}>
            {saving ? 'Saving…' : 'Save Draft'}
          </button>
        )}
        {canManage && sequence.status === 'draft' && !isDirty && (
          <button style={primaryBtn} disabled={saving} onClick={() => void handleActivate()}>Activate</button>
        )}
        {canManage && sequence.status === 'active' && (
          <button style={dangerBtn} disabled={saving} onClick={() => void handleDisable()}>Disable</button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ borderBottom: '1px solid #dee2e6', display: 'flex', flexShrink: 0 }}>
        <button role="tab" style={tabBtn(tab === 'builder')} onClick={() => setTab('builder')}>Builder</button>
        <button role="tab" style={tabBtn(tab === 'enrollments')} onClick={() => setTab('enrollments')}>Enrollments</button>
        {showABTab && (
          <button role="tab" style={tabBtn(tab === 'ab_results')} onClick={() => setTab('ab_results')}>A/B Results</button>
        )}
      </div>

      {/* Tab content */}
      {tab === 'builder' && (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Left: step list */}
          <div style={{ width: '35%', borderRight: '1px solid #dee2e6', overflowY: 'auto' }}>
            <StepList
              steps={steps}
              selectedStepId={selectedStepId}
              onSelectStep={selectStep}
              onAddStep={addStep}
              onReorder={handleDragEnd}
            />
            <div style={{ padding: '0 12px 12px' }}>
              <ActiveHoursConfig activeHours={activeHours} onChange={setActiveHours} />
              <ABConfig abTest={abTest} onChange={setAbTest} />
            </div>
          </div>

          {/* Right: step editor */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {selectedStep ? (
              <StepEditor
                step={selectedStep}
                gatewayClient={gwClient}
                onUpdate={(updated) => updateStep(updated.id, updated)}
                onRemove={() => removeStep(selectedStep.id)}
              />
            ) : (
              <div style={{ padding: 32, textAlign: 'center', color: '#6c757d', fontSize: 14 }}>
                Select a step to edit, or add a new step.
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'enrollments' && (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <EnrollmentLog sequenceId={sequenceId} client={seqClient} />
        </div>
      )}

      {tab === 'ab_results' && showABTab && (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <ABResults sequenceId={sequenceId} client={seqClient} />
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/component/SequenceBuilder.test.tsx
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/sequence-ui/src/components/SequenceBuilder.tsx \
        packages/@platform/sequence-ui/test/component/SequenceBuilder.test.tsx
git commit -m "feat(@platform/sequence-ui): add SequenceBuilder component with tests"
```

---

### Task 11: Export components from index.ts + build verification

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update `src/index.ts` to export components**

Add the following exports to `src/index.ts` (after the existing hook/type/client exports):

```ts
// Components
export { SequenceList } from './components/SequenceList.js'
export { SequenceBuilder } from './components/SequenceBuilder.js'
```

The full index after update:

```ts
// Types
export type {
  SequenceListProps,
  SequenceBuilderProps,
  SequenceSummary,
  SequenceDetail,
  SequenceStats,
  Enrollment,
  StepDraft,
  StepAction,
  SendMessageParams,
  SendEmailParams,
  CallAIParams,
  EmitEventParams,
  ActiveHours,
  ABTest,
  TemplateSummary,
  SequenceStatus,
} from './types.js'

// API clients
export { SequenceApiClient } from './api/SequenceApiClient.js'
export { GatewayApiClient } from './api/GatewayApiClient.js'

// Hooks
export { useSequenceList } from './hooks/useSequenceList.js'
export { useSequenceDetail } from './hooks/useSequenceDetail.js'
export { useStepEditor } from './hooks/useStepEditor.js'
export { useEnrollments } from './hooks/useEnrollments.js'
export { useABStats } from './hooks/useABStats.js'

// Components
export { SequenceList } from './components/SequenceList.js'
export { SequenceBuilder } from './components/SequenceBuilder.js'
```

- [ ] **Step 2: Run full test suite**

```bash
cd packages/@platform/sequence-ui && npm test
```

Expected: all unit tests (Phase 1) + all component tests (Phase 2) pass. Zero failures.

- [ ] **Step 3: Run typecheck**

```bash
cd packages/@platform/sequence-ui && npm run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Run build**

```bash
cd packages/@platform/sequence-ui && npm run build
```

Expected: `dist/` populated with `.js` + `.d.ts` files for all exports. Zero TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/sequence-ui/src/index.ts
git commit -m "feat(@platform/sequence-ui): export SequenceList and SequenceBuilder from index"
```

---

## Summary

| Task | Files | Tests |
|---|---|---|
| 1 — MSW infrastructure | `test/msw-server.ts`, `test/msw-handlers.ts`, `test/setup.ts` | — |
| 2 — utils + SequenceList | `utils.ts`, `SequenceList.tsx`, `SequenceList.test.tsx` | 7 |
| 3 — Action forms | `SendMessageForm`, `SendEmailForm`, `CallAIForm`, `EmitEventForm` | (via Task 7) |
| 4 — TemplatePicker | `TemplatePicker.tsx`, `TemplatePicker.test.tsx` | 6 |
| 5 — StepList | `StepList.tsx` | (via Task 10) |
| 6 — ActiveHoursConfig + ABConfig | `ActiveHoursConfig.tsx`, `ABConfig.tsx` | (via Task 10) |
| 7 — StepEditor | `StepEditor.tsx`, `StepEditor.test.tsx` | 7 |
| 8 — EnrollmentLog | `EnrollmentLog.tsx`, `EnrollmentLog.test.tsx` | 5 |
| 9 — ABResults | `ABResults.tsx`, `ABResults.test.tsx` | 5 |
| 10 — SequenceBuilder | `SequenceBuilder.tsx`, `SequenceBuilder.test.tsx` | 8 |
| 11 — index.ts + build | `src/index.ts` | (full suite) |

**Total component tests: 38** | **Exit criteria: `npm test` passes, `npm run typecheck` clean, `npm run build` produces `dist/`**
