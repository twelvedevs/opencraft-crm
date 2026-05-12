# @platform/sequence-ui — Phase 1: Infrastructure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data layer for `@platform/sequence-ui` — package scaffolding, TypeScript types, two API clients, five custom hooks, styles.css, and public exports. No React components. Ends with `npm run typecheck` and unit tests passing.

**Architecture:** Hooks-based — custom hooks encapsulate state + API calls; components (Phase 2) are thin renderers that call hooks. Two API clients: `SequenceApiClient` (Nurturing Engine) and `GatewayApiClient` (CRM API Gateway for template search). All hooks receive constructed client instances as arguments for easy unit-testing.

**Tech Stack:** TypeScript 5, React 18 (peer dep only), `@dnd-kit/core` + `@dnd-kit/sortable` (for `useStepEditor`), Vitest 2

**Spec:** `docs/superpowers/specs/2026-04-19-sequence-ui-design.md`

---

### Task 1: Package scaffolding

**Files:**
- Create: `packages/@platform/sequence-ui/package.json`
- Create: `packages/@platform/sequence-ui/tsconfig.json`
- Create: `packages/@platform/sequence-ui/vitest.config.ts`
- Create: `packages/@platform/sequence-ui/test/setup.ts`

- [ ] **Step 1: Create the package directory**

```bash
mkdir -p packages/@platform/sequence-ui/src/api
mkdir -p packages/@platform/sequence-ui/src/hooks
mkdir -p packages/@platform/sequence-ui/src/components/action-forms
mkdir -p packages/@platform/sequence-ui/test/unit
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "@platform/sequence-ui",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./dist/styles.css": "./dist/styles.css"
  },
  "scripts": {
    "build": "tsc && cp src/styles.css dist/styles.css",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "peerDependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "dependencies": {
    "@dnd-kit/core": "^6.0.0",
    "@dnd-kit/sortable": "^7.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0",
    "@types/node": "^22.0.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "jsx": "react-jsx"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
```

- [ ] **Step 5: Create `test/setup.ts`** (empty placeholder for future global setup)

```ts
// Global test setup — extend here as needed
```

- [ ] **Step 6: Install dependencies**

```bash
cd packages/@platform/sequence-ui
npm install
```

- [ ] **Step 7: Commit**

```bash
git add packages/@platform/sequence-ui/
git commit -m "chore(@platform/sequence-ui): scaffold package"
```

---

### Task 2: Types

**Files:**
- Create: `packages/@platform/sequence-ui/src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
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
```

- [ ] **Step 2: Verify types compile**

```bash
cd packages/@platform/sequence-ui && npx tsc --noEmit --allowJs false 2>&1 | head -20
```

Expected: no errors (or only "no input files" since no other src files yet).

- [ ] **Step 3: Commit**

```bash
git add packages/@platform/sequence-ui/src/types.ts
git commit -m "feat(@platform/sequence-ui): add TypeScript types"
```

---

### Task 3: SequenceApiClient

**Files:**
- Create: `packages/@platform/sequence-ui/src/api/SequenceApiClient.ts`
- Create: `packages/@platform/sequence-ui/test/unit/SequenceApiClient.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/unit/SequenceApiClient.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SequenceApiClient, ApiError } from '../../src/api/SequenceApiClient.js'

const BASE = 'http://nurturing.test'
const TOKEN = 'tok-abc'

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
}

describe('SequenceApiClient', () => {
  let client: SequenceApiClient

  beforeEach(() => {
    client = new SequenceApiClient(BASE, TOKEN)
  })

  it('listSequences: GET /sequences with auth header', async () => {
    const payload = { data: [], total: 0 }
    global.fetch = mockFetch(200, payload)
    const result = await client.listSequences()
    expect(result).toEqual(payload)
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/sequences`)
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('getSequence: GET /sequences/:id', async () => {
    const payload = { sequence_id: 'seq-1', name: 'Test' }
    global.fetch = mockFetch(200, payload)
    const result = await client.getSequence('seq-1')
    expect(result).toEqual(payload)
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toBe(`${BASE}/sequences/seq-1`)
  })

  it('createSequence: POST /sequences with name', async () => {
    global.fetch = mockFetch(201, { sequence_id: 'seq-new' })
    const result = await client.createSequence('My Sequence')
    expect(result).toEqual({ sequence_id: 'seq-new' })
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'My Sequence' })
  })

  it('saveDraft: PUT /sequences/:id', async () => {
    global.fetch = mockFetch(200, {})
    const payload = { name: 'X', active_hours: null, cancel_on_opt_out: true, steps: [], ab_test: null }
    await client.saveDraft('seq-1', payload)
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/sequences/seq-1`)
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual(payload)
  })

  it('activate: POST /sequences/:id/activate', async () => {
    global.fetch = mockFetch(200, {})
    await client.activate('seq-1')
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/sequences/seq-1/activate`)
    expect(init.method).toBe('POST')
  })

  it('disable: POST /sequences/:id/disable', async () => {
    global.fetch = mockFetch(200, {})
    await client.disable('seq-1')
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toBe(`${BASE}/sequences/seq-1/disable`)
  })

  it('listEnrollments: appends query params', async () => {
    global.fetch = mockFetch(200, { data: [], nextCursor: undefined })
    await client.listEnrollments('seq-1', { status: 'active', limit: 50 })
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toContain('status=active')
    expect(url).toContain('limit=50')
    expect(url).toContain('/sequences/seq-1/enrollments')
  })

  it('getStats: GET /sequences/:id/stats', async () => {
    const stats = { sequence_id: 'seq-1', total_enrollments: 10, ab: null }
    global.fetch = mockFetch(200, stats)
    const result = await client.getStats('seq-1')
    expect(result).toEqual(stats)
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toBe(`${BASE}/sequences/seq-1/stats`)
  })

  it('throws ApiError on non-2xx response', async () => {
    global.fetch = mockFetch(404, { message: 'not found' })
    await expect(client.getSequence('missing')).rejects.toBeInstanceOf(ApiError)
    await expect(client.getSequence('missing')).rejects.toMatchObject({ status: 404 })
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/unit/SequenceApiClient.test.ts
```

Expected: `Cannot find module '../../src/api/SequenceApiClient.js'`

- [ ] **Step 3: Implement `src/api/SequenceApiClient.ts`**

```ts
import type {
  SequenceSummary, SequenceDetail, SequenceDraftPayload,
  Enrollment, EnrollmentDetail, EnrollmentFilters, SequenceStats,
} from '../types.js'

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export class SequenceApiClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new ApiError(res.status, text)
    }
    return res.json() as Promise<T>
  }

  listSequences(): Promise<{ data: SequenceSummary[]; total: number }> {
    return this.request('/sequences')
  }

  getSequence(id: string): Promise<SequenceDetail> {
    return this.request(`/sequences/${id}`)
  }

  createSequence(name: string): Promise<{ sequence_id: string }> {
    return this.request('/sequences', { method: 'POST', body: JSON.stringify({ name }) })
  }

  saveDraft(id: string, payload: SequenceDraftPayload): Promise<void> {
    return this.request(`/sequences/${id}`, { method: 'PUT', body: JSON.stringify(payload) })
  }

  activate(id: string): Promise<void> {
    return this.request(`/sequences/${id}/activate`, { method: 'POST' })
  }

  disable(id: string): Promise<void> {
    return this.request(`/sequences/${id}/disable`, { method: 'POST' })
  }

  listEnrollments(
    id: string,
    params: EnrollmentFilters & { cursor?: string; limit?: number },
  ): Promise<{ data: Enrollment[]; nextCursor?: string }> {
    const qs = new URLSearchParams()
    if (params.status) qs.set('status', params.status)
    if (params.dateFrom) qs.set('date_from', params.dateFrom)
    if (params.dateTo) qs.set('date_to', params.dateTo)
    if (params.cursor) qs.set('cursor', params.cursor)
    if (params.limit) qs.set('limit', String(params.limit))
    const q = qs.toString()
    return this.request(`/sequences/${id}/enrollments${q ? `?${q}` : ''}`)
  }

  getEnrollmentDetail(sequenceId: string, enrollmentId: string): Promise<EnrollmentDetail> {
    return this.request(`/sequences/${sequenceId}/enrollments/${enrollmentId}`)
  }

  getStats(id: string): Promise<SequenceStats> {
    return this.request(`/sequences/${id}/stats`)
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/unit/SequenceApiClient.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/sequence-ui/src/api/SequenceApiClient.ts \
        packages/@platform/sequence-ui/test/unit/SequenceApiClient.test.ts
git commit -m "feat(@platform/sequence-ui): add SequenceApiClient with unit tests"
```

---

### Task 4: GatewayApiClient

**Files:**
- Create: `packages/@platform/sequence-ui/src/api/GatewayApiClient.ts`
- Create: `packages/@platform/sequence-ui/test/unit/GatewayApiClient.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/unit/GatewayApiClient.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewayApiClient } from '../../src/api/GatewayApiClient.js'
import { ApiError } from '../../src/api/SequenceApiClient.js'

const BASE = 'http://gateway.test'
const TOKEN = 'tok-gw'

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(String(body)),
  })
}

describe('GatewayApiClient', () => {
  let client: GatewayApiClient

  beforeEach(() => {
    client = new GatewayApiClient(BASE, TOKEN)
  })

  it('searchTemplates: GET /templates with channel and q params', async () => {
    const templates = [{ template_id: 't1', name: 'T1', channel: 'sms', preview: 'Hi' }]
    global.fetch = mockFetch(200, templates)
    const result = await client.searchTemplates('sms', 'followup')
    expect(result).toEqual(templates)
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/templates')
    expect(url).toContain('channel=sms')
    expect(url).toContain('q=followup')
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('searchTemplates: filters by email channel', async () => {
    global.fetch = mockFetch(200, [])
    await client.searchTemplates('email', '')
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toContain('channel=email')
  })

  it('throws ApiError on non-2xx', async () => {
    global.fetch = mockFetch(500, 'server error')
    await expect(client.searchTemplates('sms', 'x')).rejects.toBeInstanceOf(ApiError)
    await expect(client.searchTemplates('sms', 'x')).rejects.toMatchObject({ status: 500 })
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/unit/GatewayApiClient.test.ts
```

Expected: `Cannot find module '../../src/api/GatewayApiClient.js'`

- [ ] **Step 3: Implement `src/api/GatewayApiClient.ts`**

```ts
import type { TemplateSummary } from '../types.js'
import { ApiError } from './SequenceApiClient.js'

export class GatewayApiClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async searchTemplates(channel: 'sms' | 'email', q: string): Promise<TemplateSummary[]> {
    const qs = new URLSearchParams({ channel, q })
    const res = await fetch(`${this.baseUrl}/templates?${qs.toString()}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new ApiError(res.status, text)
    }
    return res.json() as Promise<TemplateSummary[]>
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/unit/GatewayApiClient.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/sequence-ui/src/api/GatewayApiClient.ts \
        packages/@platform/sequence-ui/test/unit/GatewayApiClient.test.ts
git commit -m "feat(@platform/sequence-ui): add GatewayApiClient with unit tests"
```

---

### Task 5: useStepEditor hook

**Files:**
- Create: `packages/@platform/sequence-ui/src/hooks/useStepEditor.ts`
- Create: `packages/@platform/sequence-ui/test/unit/useStepEditor.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/unit/useStepEditor.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useStepEditor } from '../../src/hooks/useStepEditor.js'
import type { StepDraft } from '../../src/types.js'

// NOTE: renderHook requires @testing-library/react — add to devDependencies if not present

const smsAction = (): StepDraft['action'] => ({
  type: 'send_message',
  params: { template_id: 'tmpl-1', to_field: 'context.phone', from_field: 'context.loc', context: 'context', dedup_key: 'key-1' },
})

function makeStep(id: string): StepDraft {
  return { id, delay: { value: 24, unit: 'hours' }, action: smsAction() }
}

describe('useStepEditor', () => {
  it('initializes with provided steps and selects first step', () => {
    const steps = [makeStep('s1'), makeStep('s2')]
    const { result } = renderHook(() => useStepEditor(steps, vi.fn()))
    expect(result.current.steps).toHaveLength(2)
    expect(result.current.selectedStepId).toBe('s1')
  })

  it('selectStep updates selectedStepId', () => {
    const steps = [makeStep('s1'), makeStep('s2')]
    const { result } = renderHook(() => useStepEditor(steps, vi.fn()))
    act(() => result.current.selectStep('s2'))
    expect(result.current.selectedStepId).toBe('s2')
  })

  it('addStep appends a default step and selects it', () => {
    const onChange = vi.fn()
    const steps = [makeStep('s1')]
    const { result } = renderHook(() => useStepEditor(steps, onChange))
    act(() => result.current.addStep())
    expect(result.current.steps).toHaveLength(2)
    expect(result.current.selectedStepId).toBe(result.current.steps[1].id)
    expect(onChange).toHaveBeenCalledWith(result.current.steps)
  })

  it('addStep default: 24h send_message', () => {
    const { result } = renderHook(() => useStepEditor([], vi.fn()))
    act(() => result.current.addStep())
    const step = result.current.steps[0]
    expect(step.delay).toEqual({ value: 24, unit: 'hours' })
    expect(step.action.type).toBe('send_message')
  })

  it('removeStep removes the step and calls onChange', () => {
    const onChange = vi.fn()
    const steps = [makeStep('s1'), makeStep('s2')]
    const { result } = renderHook(() => useStepEditor(steps, onChange))
    act(() => result.current.removeStep('s1'))
    expect(result.current.steps.map((s) => s.id)).toEqual(['s2'])
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 's2' })])
  })

  it('removeStep resets selectedStepId to next step when selected is removed', () => {
    const steps = [makeStep('s1'), makeStep('s2')]
    const { result } = renderHook(() => useStepEditor(steps, vi.fn()))
    act(() => result.current.removeStep('s1'))
    expect(result.current.selectedStepId).toBe('s2')
  })

  it('removeStep sets selectedStepId to null when last step removed', () => {
    const steps = [makeStep('s1')]
    const { result } = renderHook(() => useStepEditor(steps, vi.fn()))
    act(() => result.current.removeStep('s1'))
    expect(result.current.selectedStepId).toBeNull()
  })

  it('updateStep patches the correct step and calls onChange', () => {
    const onChange = vi.fn()
    const steps = [makeStep('s1'), makeStep('s2')]
    const { result } = renderHook(() => useStepEditor(steps, onChange))
    act(() => result.current.updateStep('s1', { delay: { value: 48, unit: 'hours' } }))
    expect(result.current.steps[0].delay).toEqual({ value: 48, unit: 'hours' })
    expect(result.current.steps[1].delay).toEqual({ value: 24, unit: 'hours' }) // unchanged
    expect(onChange).toHaveBeenCalled()
  })

  it('reorderSteps moves step from old index to new index', () => {
    const onChange = vi.fn()
    const steps = [makeStep('s1'), makeStep('s2'), makeStep('s3')]
    const { result } = renderHook(() => useStepEditor(steps, onChange))
    act(() =>
      result.current.reorderSteps({
        active: { id: 's1' },
        over: { id: 's3' },
      } as never),
    )
    expect(result.current.steps.map((s) => s.id)).toEqual(['s2', 's3', 's1'])
    expect(onChange).toHaveBeenCalled()
  })

  it('reorderSteps is a no-op when active === over', () => {
    const onChange = vi.fn()
    const steps = [makeStep('s1'), makeStep('s2')]
    const { result } = renderHook(() => useStepEditor(steps, onChange))
    act(() =>
      result.current.reorderSteps({
        active: { id: 's1' },
        over: { id: 's1' },
      } as never),
    )
    expect(onChange).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Add `@testing-library/react` to devDependencies and update vitest config for jsdom**

Update `package.json` devDependencies (add):
```json
"@testing-library/react": "^14.0.0",
"@vitejs/plugin-react": "^4.0.0",
"jsdom": "^24.0.0"
```

Update `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
  },
})
```

Run `npm install` again:
```bash
cd packages/@platform/sequence-ui && npm install
```

- [ ] **Step 3: Run tests — expect FAIL**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/unit/useStepEditor.test.ts
```

Expected: `Cannot find module '../../src/hooks/useStepEditor.js'`

- [ ] **Step 4: Implement `src/hooks/useStepEditor.ts`**

```ts
import { useState, useCallback } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import type { StepDraft } from '../types.js'

function newStepId(): string {
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function defaultStep(): StepDraft {
  return {
    id: newStepId(),
    delay: { value: 24, unit: 'hours' },
    action: {
      type: 'send_message',
      params: { template_id: '', to_field: '', from_field: '', context: 'context', dedup_key: '' },
    },
  }
}

export interface UseStepEditorResult {
  steps: StepDraft[]
  selectedStepId: string | null
  selectStep: (id: string) => void
  addStep: () => void
  removeStep: (id: string) => void
  updateStep: (id: string, patch: Partial<StepDraft>) => void
  reorderSteps: (event: DragEndEvent) => void
}

export function useStepEditor(
  initialSteps: StepDraft[],
  onChange: (steps: StepDraft[]) => void,
): UseStepEditorResult {
  const [steps, setSteps] = useState<StepDraft[]>(initialSteps)
  const [selectedStepId, setSelectedStepId] = useState<string | null>(
    initialSteps[0]?.id ?? null,
  )

  const update = useCallback(
    (next: StepDraft[]) => {
      setSteps(next)
      onChange(next)
    },
    [onChange],
  )

  const selectStep = useCallback((id: string) => setSelectedStepId(id), [])

  const addStep = useCallback(() => {
    const step = defaultStep()
    const next = [...steps, step]
    setSteps(next)
    onChange(next)
    setSelectedStepId(step.id)
  }, [steps, onChange])

  const removeStep = useCallback(
    (id: string) => {
      const next = steps.filter((s) => s.id !== id)
      setSteps(next)
      onChange(next)
      if (selectedStepId === id) {
        setSelectedStepId(next[0]?.id ?? null)
      }
    },
    [steps, selectedStepId, onChange],
  )

  const updateStep = useCallback(
    (id: string, patch: Partial<StepDraft>) => {
      update(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)))
    },
    [steps, update],
  )

  const reorderSteps = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const oldIndex = steps.findIndex((s) => s.id === active.id)
      const newIndex = steps.findIndex((s) => s.id === over.id)
      if (oldIndex === -1 || newIndex === -1) return
      update(arrayMove(steps, oldIndex, newIndex))
    },
    [steps, update],
  )

  return { steps, selectedStepId, selectStep, addStep, removeStep, updateStep, reorderSteps }
}
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/unit/useStepEditor.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/@platform/sequence-ui/src/hooks/useStepEditor.ts \
        packages/@platform/sequence-ui/test/unit/useStepEditor.test.ts \
        packages/@platform/sequence-ui/vitest.config.ts \
        packages/@platform/sequence-ui/package.json
git commit -m "feat(@platform/sequence-ui): add useStepEditor hook with unit tests"
```

---

### Task 6: useABStats hook

**Files:**
- Create: `packages/@platform/sequence-ui/src/hooks/useABStats.ts`
- Create: `packages/@platform/sequence-ui/test/unit/useABStats.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/unit/useABStats.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useABStats } from '../../src/hooks/useABStats.js'
import type { SequenceApiClient } from '../../src/api/SequenceApiClient.js'
import type { SequenceStats } from '../../src/types.js'

function makeClient(stats: SequenceStats): Pick<SequenceApiClient, 'getStats'> {
  return { getStats: vi.fn().mockResolvedValue(stats) }
}

const statsWithAB: SequenceStats = {
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

const statsNoAB: SequenceStats = { ...statsWithAB, ab: null }

describe('useABStats', () => {
  it('starts in loading state', () => {
    const client = makeClient(statsWithAB)
    const { result } = renderHook(() =>
      useABStats(client as SequenceApiClient, 'seq-1'),
    )
    expect(result.current.loading).toBe(true)
    expect(result.current.stats).toBeNull()
  })

  it('loads stats and sets loading false', async () => {
    const client = makeClient(statsWithAB)
    const { result } = renderHook(() =>
      useABStats(client as SequenceApiClient, 'seq-1'),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.stats).toEqual(statsWithAB)
    expect(result.current.error).toBeNull()
  })

  it('stats.ab is null when sequence has no A/B test', async () => {
    const client = makeClient(statsNoAB)
    const { result } = renderHook(() =>
      useABStats(client as SequenceApiClient, 'seq-1'),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.stats?.ab).toBeNull()
  })

  it('sets error on API failure', async () => {
    const client = {
      getStats: vi.fn().mockRejectedValue(new Error('network error')),
    }
    const { result } = renderHook(() =>
      useABStats(client as unknown as SequenceApiClient, 'seq-1'),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('network error')
    expect(result.current.stats).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/unit/useABStats.test.ts
```

Expected: `Cannot find module '../../src/hooks/useABStats.js'`

- [ ] **Step 3: Implement `src/hooks/useABStats.ts`**

```ts
import { useState, useEffect } from 'react'
import type { SequenceApiClient } from '../api/SequenceApiClient.js'
import type { SequenceStats } from '../types.js'

export interface UseABStatsResult {
  stats: SequenceStats | null
  loading: boolean
  error: string | null
}

export function useABStats(
  client: Pick<SequenceApiClient, 'getStats'>,
  sequenceId: string,
): UseABStatsResult {
  const [stats, setStats] = useState<SequenceStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    client
      .getStats(sequenceId)
      .then((s) => {
        if (!cancelled) {
          setStats(s)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load stats')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, sequenceId])

  return { stats, loading, error }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd packages/@platform/sequence-ui && npx vitest run test/unit/useABStats.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/sequence-ui/src/hooks/useABStats.ts \
        packages/@platform/sequence-ui/test/unit/useABStats.test.ts
git commit -m "feat(@platform/sequence-ui): add useABStats hook with unit tests"
```

---

### Task 7: useSequenceList, useSequenceDetail, useEnrollments hooks

These hooks have no logic worth unit-testing in isolation (they are thin wrappers around API client calls with standard loading/error state). They are tested via component tests in Phase 2. Implement all three here.

**Files:**
- Create: `packages/@platform/sequence-ui/src/hooks/useSequenceList.ts`
- Create: `packages/@platform/sequence-ui/src/hooks/useSequenceDetail.ts`
- Create: `packages/@platform/sequence-ui/src/hooks/useEnrollments.ts`

- [ ] **Step 1: Implement `src/hooks/useSequenceList.ts`**

```ts
import { useState, useEffect, useCallback } from 'react'
import type { SequenceApiClient } from '../api/SequenceApiClient.js'
import type { SequenceSummary } from '../types.js'

export interface UseSequenceListResult {
  sequences: SequenceSummary[]
  loading: boolean
  error: string | null
  activate: (id: string) => Promise<void>
  disable: (id: string) => Promise<void>
  refresh: () => void
}

export function useSequenceList(client: SequenceApiClient): UseSequenceListResult {
  const [sequences, setSequences] = useState<SequenceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    client
      .listSequences()
      .then((res) => {
        if (!cancelled) {
          setSequences(res.data)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load sequences')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, tick])

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  const activate = useCallback(
    async (id: string) => {
      await client.activate(id)
      refresh()
    },
    [client, refresh],
  )

  const disable = useCallback(
    async (id: string) => {
      await client.disable(id)
      refresh()
    },
    [client, refresh],
  )

  return { sequences, loading, error, activate, disable, refresh }
}
```

- [ ] **Step 2: Implement `src/hooks/useSequenceDetail.ts`**

```ts
import { useState, useEffect, useCallback, useRef } from 'react'
import type { SequenceApiClient } from '../api/SequenceApiClient.js'
import type { SequenceDetail, SequenceDraftPayload } from '../types.js'

export interface UseSequenceDetailResult {
  sequence: SequenceDetail | null
  loading: boolean
  error: string | null
  isDirty: boolean
  update: (patch: Partial<SequenceDraftPayload>) => void
  saveDraft: () => Promise<void>
  activate: () => Promise<void>
}

export function useSequenceDetail(
  client: SequenceApiClient,
  sequenceId: string,
): UseSequenceDetailResult {
  const [sequence, setSequence] = useState<SequenceDetail | null>(null)
  const [draft, setDraft] = useState<Partial<SequenceDraftPayload>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const draftRef = useRef(draft)
  draftRef.current = draft

  const load = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    client
      .getSequence(sequenceId)
      .then((s) => {
        if (!cancelled) {
          setSequence(s)
          setDraft({})
          setIsDirty(false)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load sequence')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, sequenceId])

  useEffect(() => load(), [load])

  const update = useCallback((patch: Partial<SequenceDraftPayload>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setIsDirty(true)
  }, [])

  const saveDraft = useCallback(async () => {
    if (!sequence) return
    const payload: SequenceDraftPayload = {
      name: sequence.name,
      active_hours: sequence.active_hours,
      cancel_on_opt_out: sequence.cancel_on_opt_out,
      steps: sequence.steps,
      ab_test: sequence.ab_test,
      ...draftRef.current,
    }
    await client.saveDraft(sequenceId, payload)
    load()
  }, [client, sequenceId, sequence, load])

  const activate = useCallback(async () => {
    await client.activate(sequenceId)
    load()
  }, [client, sequenceId, load])

  return { sequence, loading, error, isDirty, update, saveDraft, activate }
}
```

- [ ] **Step 3: Implement `src/hooks/useEnrollments.ts`**

```ts
import { useState, useEffect, useCallback } from 'react'
import type { SequenceApiClient } from '../api/SequenceApiClient.js'
import type { Enrollment, EnrollmentFilters } from '../types.js'

export interface UseEnrollmentsResult {
  enrollments: Enrollment[]
  loading: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
  filters: EnrollmentFilters
  setFilters: (f: EnrollmentFilters) => void
}

export function useEnrollments(
  client: SequenceApiClient,
  sequenceId: string,
): UseEnrollmentsResult {
  const [enrollments, setEnrollments] = useState<Enrollment[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFiltersState] = useState<EnrollmentFilters>({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setEnrollments([])
    setCursor(undefined)
    client
      .listEnrollments(sequenceId, { ...filters, limit: 50 })
      .then((res) => {
        if (!cancelled) {
          setEnrollments(res.data)
          setCursor(res.nextCursor)
          setHasMore(!!res.nextCursor)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load enrollments')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, sequenceId, filters])

  const loadMore = useCallback(() => {
    if (!cursor || loading) return
    setLoading(true)
    client
      .listEnrollments(sequenceId, { ...filters, cursor, limit: 50 })
      .then((res) => {
        setEnrollments((prev) => [...prev, ...res.data])
        setCursor(res.nextCursor)
        setHasMore(!!res.nextCursor)
        setLoading(false)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load more')
        setLoading(false)
      })
  }, [client, sequenceId, filters, cursor, loading])

  const setFilters = useCallback((f: EnrollmentFilters) => setFiltersState(f), [])

  return { enrollments, loading, error, hasMore, loadMore, filters, setFilters }
}
```

- [ ] **Step 4: Typecheck all three hooks**

```bash
cd packages/@platform/sequence-ui && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/sequence-ui/src/hooks/
git commit -m "feat(@platform/sequence-ui): add useSequenceList, useSequenceDetail, useEnrollments hooks"
```

---

### Task 8: styles.css and index.ts

**Files:**
- Create: `packages/@platform/sequence-ui/src/styles.css`
- Create: `packages/@platform/sequence-ui/src/index.ts`

- [ ] **Step 1: Create `src/styles.css`**

```css
/* @platform/sequence-ui — interactive state styles
   All layout/spacing/color are inline styles on components.
   This file handles only what inline styles cannot: hover, active, transitions. */

.sq-step-item:hover { background: #f0f4ff; }
.sq-step-item.selected { border-color: #0066cc; background: #fff; }
.sq-step-item.dragging { opacity: 0.5; box-shadow: 0 4px 16px rgba(0,0,0,.15); }

.sq-drag-handle { cursor: grab; color: #adb5bd; user-select: none; }
.sq-drag-handle:active { cursor: grabbing; }

.sq-tab { cursor: pointer; border-bottom: 2px solid transparent; transition: border-color 0.15s, color 0.15s; }
.sq-tab.active { border-bottom-color: #0066cc; color: #0066cc; font-weight: 600; }
.sq-tab:hover:not(.active) { color: #495057; }

.sq-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.4);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sq-template-item { padding: 8px 12px; border-radius: 4px; cursor: pointer; }
.sq-template-item:hover { background: #e8f0fe; }
.sq-template-item.selected { background: #cfe2ff; }

.sq-enrollment-row { cursor: pointer; }
.sq-enrollment-row:hover td { background: #f8f9fa; }
```

- [ ] **Step 2: Create `src/index.ts`**

```ts
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

// Components are added in Phase 2
// export { SequenceList } from './components/SequenceList.js'
// export { SequenceBuilder } from './components/SequenceBuilder.js'
```

- [ ] **Step 3: Final typecheck**

```bash
cd packages/@platform/sequence-ui && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run all unit tests**

```bash
cd packages/@platform/sequence-ui && npm test
```

Expected output:
```
✓ test/unit/SequenceApiClient.test.ts (8)
✓ test/unit/GatewayApiClient.test.ts (3)
✓ test/unit/useStepEditor.test.ts (9)
✓ test/unit/useABStats.test.ts (4)

Test Files  4 passed (4)
Tests       24 passed (24)
```

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/sequence-ui/src/styles.css \
        packages/@platform/sequence-ui/src/index.ts
git commit -m "feat(@platform/sequence-ui): add styles.css and public index.ts exports"
```

---

### Task 9: Update NAVIGATOR.md

**Files:**
- Modify: `docs/NAVIGATOR.md`

- [ ] **Step 1: Add Phase 1 plan to the Implementation Plans section**

In `docs/NAVIGATOR.md`, under `## Implementation Plans`, add:

```markdown
| [2026-04-19-sequence-ui-phase-1.md](superpowers/plans/2026-04-19-sequence-ui-phase-1.md) | @platform/sequence-ui — Phase 1: package scaffold, types, API clients, hooks |
| [2026-04-19-sequence-ui-phase-2.md](superpowers/plans/2026-04-19-sequence-ui-phase-2.md) | @platform/sequence-ui — Phase 2: React components (pending) |
```

- [ ] **Step 2: Commit**

```bash
git add docs/NAVIGATOR.md
git commit -m "docs: add sequence-ui phase plans to NAVIGATOR"
```

---

## Phase 1 Complete

Run the full verification:

```bash
cd packages/@platform/sequence-ui
npm test && npx tsc --noEmit && echo "Phase 1 complete ✓"
```

Expected: 24 tests pass, 0 type errors.

**Phase 2** (`2026-04-19-sequence-ui-phase-2.md`) covers all React components: `SequenceList`, `SequenceBuilder`, `StepList` (dnd-kit), `StepEditor`, action forms, `TemplatePicker`, `EnrollmentLog`, `ABResults`.
