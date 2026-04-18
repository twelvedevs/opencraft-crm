# @platform/sequence-ui Design Spec

**Date:** 2026-04-19
**Status:** Approved
**Scope:** `packages/@platform/sequence-ui` — React component package for building and monitoring drip sequences in the Nurturing Engine.

---

## 1. Overview

`@platform/sequence-ui` is a platform-layer React package that provides the staff UI for the Nurturing Engine. It is consumed by the CRM Web App's `sequences` module, mounted at two routes:

- `/sequences` — sequence list (create, activate, disable)
- `/sequences/:id/edit` — sequence builder with step editor, enrollment log, and A/B results

The package calls the Nurturing Engine API directly from the browser (not proxied through the CRM API Gateway). The only exception is the template picker, which calls the Template Service through the CRM API Gateway to avoid hardcoding the Template Service URL in a platform package.

Auth uses the same Identity Service JWT the CRM shell holds. The token is passed as a prop to each top-level component.

**Design decisions:**
- Two top-level components: `SequenceList` and `SequenceBuilder` (matching the two CRM routes)
- `SequenceBuilder` has three tabs: **Builder** | **Enrollments** | **A/B Results**
- Builder tab uses a master-detail layout: step list (left ~35%) + step editor panel (right ~65%)
- Hooks-based internal architecture — custom hooks encapsulate state and API calls; components are thin renderers
- Styling: inline styles for layout/spacing + a single bundled `styles.css` for interactive states (hover, drag handles, tab underlines, modal overlay)
- Drag-to-reorder steps via `@dnd-kit/core` + `@dnd-kit/sortable`
- Template picker: modal with debounced search, filtered by action channel

---

## 2. Package Structure

```
packages/@platform/sequence-ui/
├── src/
│   ├── index.ts                        # public exports
│   ├── styles.css                      # bundled CSS (~60 lines, .sq- namespace)
│   ├── api/
│   │   ├── SequenceApiClient.ts        # all Nurturing Engine calls
│   │   └── GatewayApiClient.ts         # Template Service via CRM API Gateway
│   ├── hooks/
│   │   ├── useSequenceList.ts          # list + activate/disable
│   │   ├── useSequenceDetail.ts        # load + save draft + activate
│   │   ├── useStepEditor.ts            # selected step state, step CRUD, dnd reorder
│   │   ├── useEnrollments.ts           # enrollment log, pagination, filters
│   │   └── useABStats.ts               # stats + significance display
│   ├── components/
│   │   ├── SequenceList.tsx            # top-level: /sequences
│   │   ├── SequenceBuilder.tsx         # top-level: /sequences/:id/edit
│   │   ├── StepList.tsx                # dnd-kit sortable step list, left panel
│   │   ├── StepEditor.tsx              # right panel, renders action-specific sub-form
│   │   ├── ActiveHoursConfig.tsx       # sequence-level active hours (start/end/timezone)
│   │   ├── ABConfig.tsx                # A/B split slider + conversion event config
│   │   ├── EnrollmentLog.tsx           # Enrollments tab content
│   │   ├── ABResults.tsx               # A/B Results tab content
│   │   ├── TemplatePicker.tsx          # modal: search + preview + select
│   │   └── action-forms/
│   │       ├── SendMessageForm.tsx     # template_id, to_field, from_field, dedup_key, A/B override
│   │       ├── SendEmailForm.tsx        # template_id, to_field, from_field, dedup_key
│   │       ├── CallAIForm.tsx           # system_prompt, user_prompt, model, auto_send
│   │       └── EmitEventForm.tsx        # event_type, payload editor, include_context toggle
│   └── types.ts                        # internal + re-exported types
├── package.json
└── tsconfig.json
```

**Public exports (`index.ts`):**

```ts
export { SequenceList } from './components/SequenceList.js'
export { SequenceBuilder } from './components/SequenceBuilder.js'
export { SequenceApiClient } from './api/SequenceApiClient.js'
export { GatewayApiClient } from './api/GatewayApiClient.js'
export type { SequenceListProps, SequenceBuilderProps } from './types.js'
```

The CRM sequences module imports the stylesheet once at its entry point:

```ts
// apps/crm/web/src/modules/sequences/index.tsx
import '@platform/sequence-ui/dist/styles.css'
```

---

## 3. Component Props

### 3.1 `SequenceList`

```ts
interface SequenceListProps {
  nurturingEngineUrl: string
  token: string
  userRole: 'marketing_staff' | 'marketing_manager' | 'super_admin'
  onEdit: (sequenceId: string) => void   // CRM router: navigate('/sequences/:id/edit')
}
```

Renders a table: name, status badge (Draft / Active / Disabled), step count, A/B indicator, current version. Activate and Disable buttons are rendered only when `userRole` is `marketing_manager` or `super_admin`. The "New Sequence" button is internal to the component — it calls `POST /sequences` via `SequenceApiClient`, then calls `onEdit(newId)` with the returned ID.

### 3.2 `SequenceBuilder`

```ts
interface SequenceBuilderProps {
  sequenceId: string
  nurturingEngineUrl: string
  crmGatewayUrl: string          // for TemplatePicker → Template Service
  token: string
  userRole: 'marketing_staff' | 'marketing_manager' | 'super_admin'
  onBack: () => void             // navigate back to /sequences
}
```

Renders: page header (sequence name, status badge, Save Draft button, Activate button, Back link), three tabs (Builder / Enrollments / A/B Results), and the active tab content.

- **Save Draft** is enabled when `isDirty === true`.
- **Activate** is enabled when `isDirty === false` and `userRole` is `marketing_manager` or `super_admin`.
- **Builder tab**: master-detail layout — `StepList` (left) + `StepEditor` (right) + `ActiveHoursConfig` + `ABConfig` below the split.
- **Enrollments tab**: `EnrollmentLog` — lazy-initialized on first tab open.
- **A/B Results tab**: `ABResults` — lazy-initialized on first tab open. The tab is not rendered in the tab bar at all when `sequence.ab_test === null` (not disabled — completely absent).

---

## 4. API Clients

### 4.1 `SequenceApiClient`

Wraps all Nurturing Engine REST endpoints. Constructor takes `(baseUrl: string, token: string)`. Every request adds `Authorization: Bearer ${token}` and `Content-Type: application/json`. Errors throw `ApiError { status: number; message: string }`.

```ts
class SequenceApiClient {
  listSequences(): Promise<{ data: SequenceSummary[]; total: number }>
  getSequence(id: string): Promise<SequenceDetail>
  createSequence(name: string): Promise<{ sequence_id: string }>
  saveDraft(id: string, payload: SequenceDraftPayload): Promise<void>
  activate(id: string): Promise<void>
  disable(id: string): Promise<void>
  listEnrollments(id: string, params: EnrollmentFilters): Promise<{ data: Enrollment[]; nextCursor?: string }>
  getEnrollmentDetail(sequenceId: string, enrollmentId: string): Promise<EnrollmentDetail>
  getStats(id: string): Promise<SequenceStats>
}
```

`SequenceDraftPayload` matches the Nurturing Engine's `PUT /sequences/:id` body: `{ name, active_hours, cancel_on_opt_out, steps, ab_test }`. The `useStepEditor` hook owns converting the component's internal step state into the DSL step shape before passing to `saveDraft`.

### 4.2 `GatewayApiClient`

```ts
class GatewayApiClient {
  constructor(baseUrl: string, token: string) {}
  searchTemplates(channel: 'sms' | 'email', q: string): Promise<TemplateSummary[]>
}
```

Calls `GET /templates?channel={channel}&q={q}` via CRM API Gateway. Used only by `TemplatePicker`.

---

## 5. Hooks

### 5.1 `useSequenceList(baseUrl, token)`

```ts
{
  sequences: SequenceSummary[]
  loading: boolean
  error: string | null
  activate: (id: string) => Promise<void>
  disable: (id: string) => Promise<void>
  refresh: () => void
}
```

Loads on mount. `activate` and `disable` call the API then `refresh()`. No optimistic updates.

### 5.2 `useSequenceDetail(baseUrl, token, sequenceId)`

```ts
{
  sequence: SequenceDetail | null
  loading: boolean
  error: string | null
  isDirty: boolean
  update: (patch: Partial<SequenceDraftPayload>) => void   // sets isDirty = true
  saveDraft: () => Promise<void>
  activate: () => Promise<void>
}
```

Holds the local editable copy of the sequence. `update(patch)` merges `patch` into local state and sets `isDirty = true`. `saveDraft()` serializes and calls `PUT /sequences/:id`, then clears `isDirty`.

### 5.3 `useStepEditor(steps, onChange)`

```ts
{
  steps: StepDraft[]
  selectedStepId: string | null
  selectStep: (id: string) => void
  addStep: () => void
  removeStep: (id: string) => void
  updateStep: (id: string, patch: Partial<StepDraft>) => void
  reorderSteps: (event: DragEndEvent) => void
}
```

Pure local state — no API calls. Receives the sequence's `steps` array as initial state. Calls `onChange(newSteps)` on every mutation, which propagates to `useSequenceDetail.update({ steps })` and sets `isDirty`. `reorderSteps` takes the dnd-kit `DragEndEvent` and produces the new ordered array. `addStep` inserts a new step with defaults (`delay: { value: 24, unit: 'hours' }`, `action.type: 'send_message'`).

Re-initialization after save: `SequenceBuilder` renders its inner content with `key={sequenceId}` so that a full remount resets hook state whenever the sequence changes. After `saveDraft()` resolves, `useSequenceDetail` re-fetches the sequence definition and the component re-initializes from the fresh data.

### 5.4 `useEnrollments(baseUrl, token, sequenceId)`

```ts
{
  enrollments: Enrollment[]
  loading: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
  filters: EnrollmentFilters
  setFilters: (f: EnrollmentFilters) => void
}
```

Keyset pagination via `nextCursor`. `setFilters` resets cursor and re-fetches. Not initialized until `EnrollmentLog` mounts (which only happens when the Enrollments tab is first activated).

### 5.5 `useABStats(baseUrl, token, sequenceId)`

```ts
{
  stats: SequenceStats | null
  loading: boolean
  error: string | null
}
```

Loads once when `ABResults` mounts (lazy — tab must be activated first). If `stats.ab === null`, `ABResults` renders an "A/B test not configured" empty state.

---

## 6. StepEditor & Action Forms

`StepEditor` renders the right panel of the master-detail layout. It shows the delay field (value + unit select: minutes / hours / days) and an action type select. Switching action type replaces the form below with the appropriate action-specific sub-form.

| Action Type | Sub-form fields |
|---|---|
| `send_message` | `template_id` (with Browse button → TemplatePicker, channel: sms), `to_field`, `from_field`, `dedup_key`, A/B variant override toggle + variant B template_id |
| `send_email` | `template_id` (Browse → TemplatePicker, channel: email), `to_field`, `from_field`, `dedup_key` |
| `call_ai` | `system_prompt` (textarea), `user_prompt` (textarea), `model` select (haiku/sonnet), `auto_send` toggle |
| `emit_event` | `event_type` (text input), `payload` (key-value pair editor), `include_context` toggle |

All fields call `updateStep(selectedStepId, patch)` on change.

---

## 7. TemplatePicker

An internal modal (not exported). Triggered by the "Browse" button in `SendMessageForm` and `SendEmailForm`. Props: `{ crmGatewayUrl, token, channel, onSelect, onClose }`.

**Behavior:**
- Opens centered modal overlay (`.sq-modal-overlay`)
- Search input with 300ms debounce → calls `GatewayApiClient.searchTemplates(channel, q)`
- Results list: template ID + first 80 chars of preview text
- Selecting a row calls `onSelect(templateId)` and closes modal
- `channel` pre-filters results (SMS templates shown for `send_message` actions, Email templates for `send_email`)
- Empty query loads the first 20 templates with no filter (browse mode)

---

## 8. Styling

`styles.css` uses a `.sq-` prefix namespace to avoid collisions with the CRM app's Tailwind classes. It handles only what inline styles cannot express:

```css
.sq-step-item:hover           { background: #f0f4ff; }
.sq-step-item.selected        { border-color: #0066cc; background: #fff; }
.sq-step-item.dragging        { opacity: 0.5; box-shadow: 0 4px 16px rgba(0,0,0,.15); }
.sq-drag-handle               { cursor: grab; color: #adb5bd; }
.sq-drag-handle:active        { cursor: grabbing; }
.sq-tab                       { cursor: pointer; border-bottom: 2px solid transparent; transition: border-color 0.15s; }
.sq-tab.active                { border-bottom-color: #0066cc; color: #0066cc; font-weight: 600; }
.sq-tab:hover:not(.active)    { color: #495057; }
.sq-modal-overlay             { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.sq-template-item:hover       { background: #e8f0fe; cursor: pointer; }
```

All layout, spacing, typography, and color are inline styles — consistent with `@platform/audience-ui`.

---

## 9. CRM Integration

The CRM sequences module wires the two components to the router:

```ts
// apps/crm/web/src/modules/sequences/index.tsx
import '@platform/sequence-ui/dist/styles.css'
import { SequenceList, SequenceBuilder } from '@platform/sequence-ui'
import { useAuth } from '../../shell/AuthContext.js'
import { useNavigate, useParams } from 'react-router-dom'

// /sequences route
function SequencesPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  return (
    <SequenceList
      nurturingEngineUrl={import.meta.env.VITE_NURTURING_URL}
      token={user.token}
      userRole={user.role}
      onEdit={(id) => navigate(`/sequences/${id}/edit`)}
      // onNew is handled internally — SequenceList calls createSequence then onEdit(newId)
    />
  )
}

// /sequences/:id/edit route
function SequenceEditorPage() {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()
  const navigate = useNavigate()
  return (
    <SequenceBuilder
      sequenceId={id!}
      nurturingEngineUrl={import.meta.env.VITE_NURTURING_URL}
      crmGatewayUrl={import.meta.env.VITE_GATEWAY_URL}
      token={user.token}
      userRole={user.role}
      onBack={() => navigate('/sequences')}
    />
  )
}
```

---

## 10. Testing Strategy

### Unit tests (Vitest, no DOM)

- `useStepEditor` — add/remove/reorder steps, DSL serialization shape, `onChange` called on every mutation
- `useABStats` — `winner: null` when not significant, correct variant comparison logic
- `SequenceApiClient` — each method: correct URL construction, correct headers, `ApiError` thrown on non-2xx
- `GatewayApiClient` — correct query params for channel + search term

### Component tests (Vitest + React Testing Library + MSW)

- `SequenceList` — rows render correctly; Activate/Disable buttons absent for `marketing_staff`; `onEdit` called with correct id on row click
- `SequenceBuilder` — tab switching; Save Draft button enabled only when dirty; Activate disabled when dirty; Activate hidden for `marketing_staff`
- `StepEditor` — switching action type to `send_message` shows template field; to `call_ai` shows prompt textareas; to `emit_event` shows payload editor
- `TemplatePicker` — search input debounced; selecting a template calls `onSelect`; modal closes on select and on ✕
- `EnrollmentLog` — API not called until Enrollments tab first activated; "Load more" triggers `loadMore()`
- `ABResults` — renders empty state when `stats.ab === null`; renders winner badge when significant

No Playwright tests in this package — the CRM web app's E2E suite covers sequence flows end-to-end.

---

## 11. Package Configuration

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
    "vitest": "^2.0.0",
    "@testing-library/react": "^14.0.0",
    "msw": "^2.0.0"
  },
  "scripts": {
    "build": "tsc && cp src/styles.css dist/styles.css",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

The `styles.css` is copied to `dist/` as part of the build step since `tsc` only compiles TypeScript — CSS must be copied explicitly.
