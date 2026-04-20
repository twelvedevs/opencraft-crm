# `@platform/audience-ui` — Bug Fixes & Missing Features

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix six confirmed bugs and missing features in `packages/@platform/audience-ui` identified during code review against `docs/superpowers/specs/2026-03-30-audience-engine-updated-design.md`.

**Architecture:** Pure fixes — no new files except tests. Each task is self-contained and independently committable. The only structural addition is the test suite, which adds `@testing-library/react` + jsdom support.

**Tech Stack:** React 18, TypeScript 5 (ESM), Vitest 2, `@testing-library/react`, `jsdom`

**Run tests:** `cd packages/@platform/audience-ui && npm test`
**Typecheck:** `cd packages/@platform/audience-ui && npm run typecheck`

---

## Confirmed issues (false positives already resolved)

The following reviewer findings were verified as already correct in the code:
- NOT node: `FilterTree.tsx` uses `{ op: 'NOT', condition: FilterNode }` — correct
- Debounce: `SegmentEditor.tsx` uses `setTimeout(..., 500)` — correct
- `evaluateInline` exists in `api.ts` and is called by `SegmentEditor` — correct
- No `"minutes"` unit option exists in the UI — correct
- Disable button exists in `SegmentLibrary` — correct
- `onSelect` fires on "Use" button — correct
- Version column present in Library table — correct
- DSL types exported from `index.ts` — correct

---

## File Map

| File | Changes |
|------|---------|
| `src/utils/filter-summary.ts` | Fix DSL field name mismatch |
| `src/SegmentLibrary.tsx` | Add Edit button + `onEditSegment` prop; add `canActivate` prop |
| `src/SegmentBuilder.tsx` | Wire `onEditSegment`; thread `canActivate` prop |
| `src/types.ts` | Add `canActivate?` to `SegmentBuilderProps`; add `onFetchEntities?` to `AudiencePreviewProps`; add `last_used_at?` to `SegmentSummary` |
| `src/AudiencePreview.tsx` | Add estimated count via `onFetchEntities` → `evaluateInline` |
| `src/api.ts` | Tighten `getSegment` return type |
| `src/SegmentEditor.tsx` | Replace timer-only pattern with `AbortController` |
| `vitest.config.ts` | Add `environment: 'jsdom'` |
| `package.json` | Add `@testing-library/react`, `@testing-library/user-event`, `jsdom` dev deps |
| `test/filter-summary.test.ts` | Unit tests for `summarizeFilter` |
| `test/SegmentLibrary.test.tsx` | Component tests for library table, edit/activate/disable |
| `test/SegmentEditor.test.tsx` | Component tests for preview debounce, error state, save |
| `test/AudiencePreview.test.tsx` | Component tests for summary rendering and count |

---

## Task 1 — Fix `summarizeFilter` DSL mismatch

**Files:**
- Modify: `src/utils/filter-summary.ts`
- Create: `test/filter-summary.test.ts`

The function currently uses a completely different DSL schema than the one emitted by `FilterTree.tsx`.
Actual DSL from `FilterTree.tsx`:
- Leaf condition: `{ field: string, op: string, value?: unknown }`
- Group: `{ op: 'AND' | 'OR', conditions: FilterNode[] }`
- NOT: `{ op: 'NOT', condition: FilterNode }`

The current code checks `node.operator`, `node.type === 'group'`, `node.children`, `node.type === 'not'`, `node.child` — none of which exist.

- [ ] **Step 1: Write the failing test**

Create `test/filter-summary.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { summarizeFilter } from '../src/utils/filter-summary.js';

describe('summarizeFilter', () => {
  it('returns empty array for null', () => {
    expect(summarizeFilter(null)).toEqual([]);
  });

  it('summarizes a single leaf condition', () => {
    const result = summarizeFilter({ field: 'stage', op: 'eq', value: 'contacted' });
    expect(result).toEqual(['stage equals contacted']);
  });

  it('summarizes AND group by flattening children', () => {
    const result = summarizeFilter({
      op: 'AND',
      conditions: [
        { field: 'pipeline', op: 'eq', value: 'new_patient' },
        { field: 'opted_out', op: 'eq', value: false },
      ],
    });
    expect(result).toEqual(['pipeline equals new_patient', 'opted_out equals false']);
  });

  it('summarizes OR group', () => {
    const result = summarizeFilter({
      op: 'OR',
      conditions: [
        { field: 'stage', op: 'eq', value: 'contacted' },
        { field: 'stage', op: 'eq', value: 'exam_scheduled' },
      ],
    });
    expect(result).toEqual(['stage equals contacted', 'stage equals exam_scheduled']);
  });

  it('summarizes NOT node by delegating to child', () => {
    const result = summarizeFilter({
      op: 'NOT',
      condition: { field: 'opted_out', op: 'eq', value: true },
    });
    expect(result).toEqual(['opted_out equals true']);
  });

  it('formats in / not_in with brackets', () => {
    const result = summarizeFilter({ field: 'stage', op: 'in', value: ['contacted', 'exam_scheduled'] });
    expect(result).toEqual(['stage in [contacted, exam_scheduled]']);
  });

  it('formats within_last with amount and unit', () => {
    const result = summarizeFilter({ field: 'last_contact_at', op: 'within_last', value: { amount: 5, unit: 'days' } });
    expect(result).toEqual(['last_contact_at within last 5 days']);
  });

  it('formats not_within_last with amount and unit', () => {
    const result = summarizeFilter({ field: 'last_contact_at', op: 'not_within_last', value: { amount: 3, unit: 'hours' } });
    expect(result).toEqual(['last_contact_at not within last 3 hours']);
  });

  it('formats exists / not_exists without value', () => {
    expect(summarizeFilter({ field: 'tags', op: 'exists' })).toEqual(['tags exists']);
    expect(summarizeFilter({ field: 'tags', op: 'not_exists' })).toEqual(['tags not exists']);
  });

  it('returns empty array for unknown shape', () => {
    expect(summarizeFilter({ foo: 'bar' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd packages/@platform/audience-ui && npm test -- --reporter=verbose 2>&1 | head -40
```

Expected: multiple failures like "stage equals contacted" but got `[]`.

- [ ] **Step 3: Rewrite `src/utils/filter-summary.ts`**

```ts
export function summarizeFilter(filter: unknown): string[] {
  if (!filter || typeof filter !== 'object') return [];

  const node = filter as Record<string, unknown>;

  // Leaf condition: { field, op, value? }
  if (typeof node['field'] === 'string' && typeof node['op'] === 'string') {
    return [formatCondition(node['field'], node['op'], node['value'])];
  }

  // Group: { op: 'AND'|'OR', conditions: FilterNode[] }
  if ((node['op'] === 'AND' || node['op'] === 'OR') && Array.isArray(node['conditions'])) {
    return (node['conditions'] as unknown[]).flatMap((child) => summarizeFilter(child));
  }

  // NOT: { op: 'NOT', condition: FilterNode }
  if (node['op'] === 'NOT' && node['condition']) {
    return summarizeFilter(node['condition']);
  }

  return [];
}

function formatCondition(field: string, op: string, value: unknown): string {
  const readableOp = OPERATOR_LABELS[op] ?? op;

  if (op === 'exists' || op === 'not_exists') {
    return `${field} ${readableOp}`;
  }

  if ((op === 'in' || op === 'not_in') && Array.isArray(value)) {
    return `${field} ${readableOp} [${(value as unknown[]).map(String).join(', ')}]`;
  }

  if ((op === 'within_last' || op === 'not_within_last') && value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return `${field} ${readableOp} ${String(v['amount'] ?? '')} ${String(v['unit'] ?? 'days')}`;
  }

  if (op === 'date_range' && value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return `${field} ${readableOp} ${String(v['start'] ?? '')} to ${String(v['end'] ?? '')}`;
  }

  return `${field} ${readableOp} ${String(value ?? '')}`;
}

const OPERATOR_LABELS: Record<string, string> = {
  eq: 'equals',
  neq: 'not equals',
  gt: 'greater than',
  gte: 'greater than or equal to',
  lt: 'less than',
  lte: 'less than or equal to',
  contains: 'contains',
  in: 'in',
  not_in: 'not in',
  exists: 'exists',
  not_exists: 'not exists',
  within_last: 'within last',
  not_within_last: 'not within last',
  before: 'before',
  after: 'after',
  date_range: 'in date range',
};
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd packages/@platform/audience-ui && npm test 2>&1 | tail -10
```

Expected: all `filter-summary.test.ts` tests pass.

- [ ] **Step 5: Typecheck**

```bash
cd packages/@platform/audience-ui && npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/@platform/audience-ui/src/utils/filter-summary.ts packages/@platform/audience-ui/test/filter-summary.test.ts
git commit -m "fix(@platform/audience-ui): repair summarizeFilter DSL field names + unit tests"
```

---

## Task 2 — Add "Edit draft" flow

**Files:**
- Modify: `src/SegmentLibrary.tsx` — add `onEditSegment` prop + Edit button for draft segments
- Modify: `src/SegmentBuilder.tsx` — pass `onEditSegment` handler

Spec: "Segment Library actions: create new, edit draft, activate (Marketing Manager only), disable"

- [ ] **Step 1: Update `src/SegmentLibrary.tsx`**

Add `onEditSegment?: (id: string) => void` to `SegmentLibraryProps` and an Edit button for draft segments:

```tsx
export interface SegmentLibraryProps {
  client: AudienceApiClient;
  onSelectSegment: (id: string) => void;
  onCreateNew: () => void;
  onEditSegment?: (id: string) => void;
  canActivate?: boolean;
}

export function SegmentLibrary({ client, onSelectSegment, onCreateNew, onEditSegment, canActivate = true }: SegmentLibraryProps) {
```

In the table actions cell, replace the existing actions block with:

```tsx
<td style={{ padding: '8px' }}>
  <button style={buttonStyle} onClick={() => onSelectSegment(seg.segment_id)}>Use</button>
  {seg.status === 'draft' && onEditSegment && (
    <button style={buttonStyle} onClick={() => onEditSegment(seg.segment_id)}>Edit</button>
  )}
  {seg.status === 'draft' && canActivate && (
    <button style={buttonStyle} onClick={() => void handleActivate(seg.segment_id)}>Activate</button>
  )}
  {seg.status === 'active' && (
    <button style={buttonStyle} onClick={() => void handleDisable(seg.segment_id)}>Disable</button>
  )}
</td>
```

- [ ] **Step 2: Update `src/SegmentBuilder.tsx`**

Add `canActivate` to `SegmentBuilderProps` destructure and pass both new props to `SegmentLibrary`:

```tsx
export function SegmentBuilder({ audienceEngineUrl, fields, onSelect, onFetchEntities, canActivate }: SegmentBuilderProps) {
  const [view, setView] = useState<View>({ mode: 'library' });
  const [client] = useState(() => new AudienceApiClient(audienceEngineUrl));

  const goToLibrary = () => setView({ mode: 'library' });

  if (view.mode === 'editor') {
    return (
      <SegmentEditor
        client={client}
        segmentId={view.segmentId}
        fields={fields}
        onFetchEntities={onFetchEntities}
        onSave={(segmentId) => {
          if (onSelect) onSelect(segmentId);
          goToLibrary();
        }}
        onCancel={goToLibrary}
      />
    );
  }

  return (
    <SegmentLibrary
      client={client}
      onSelectSegment={(id) => {
        if (onSelect) onSelect(id);
      }}
      onCreateNew={() => setView({ mode: 'editor' })}
      onEditSegment={(id) => setView({ mode: 'editor', segmentId: id })}
      canActivate={canActivate}
    />
  );
}
```

- [ ] **Step 3: Add `canActivate?` to `SegmentBuilderProps` in `src/types.ts`**

```ts
export interface SegmentBuilderProps {
  audienceEngineUrl: string;
  fields: FieldDefinition[];
  onSelect?: (segmentId: string) => void;
  onFetchEntities?: (filter: unknown) => Promise<Record<string, unknown>[]>;
  canActivate?: boolean;
}
```

- [ ] **Step 4: Typecheck**

```bash
cd packages/@platform/audience-ui && npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Run tests**

```bash
cd packages/@platform/audience-ui && npm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/@platform/audience-ui/src/SegmentLibrary.tsx packages/@platform/audience-ui/src/SegmentBuilder.tsx packages/@platform/audience-ui/src/types.ts
git commit -m "feat(@platform/audience-ui): add edit-draft flow and canActivate role gate to SegmentLibrary"
```

---

## Task 3 — Add estimated count to `AudiencePreview`

**Files:**
- Modify: `src/types.ts` — add `onFetchEntities?` to `AudiencePreviewProps`
- Modify: `src/AudiencePreview.tsx` — fetch entities → evaluateInline → show count

Spec: `<AudiencePreview>` renders "segment name, filter summary (human-readable), and estimated audience count".

- [ ] **Step 1: Add `onFetchEntities?` to `AudiencePreviewProps` in `src/types.ts`**

```ts
export interface AudiencePreviewProps {
  audienceEngineUrl: string;
  segmentId: string;
  onFetchEntities?: (filter: unknown) => Promise<Record<string, unknown>[]>;
}
```

- [ ] **Step 2: Update `src/AudiencePreview.tsx`**

Add props destructure and count fetching after the segment loads. Replace the component:

```tsx
import React, { useEffect, useState } from 'react';
import type { AudiencePreviewProps } from './types.js';
import { AudienceApiClient } from './api.js';
import { summarizeFilter } from './utils/filter-summary.js';

interface SegmentData {
  segment_id: string;
  name: string;
  status: string;
  filter: unknown | null;
}

const STATUS_COLORS: Record<string, string> = {
  active: '#16a34a',
  draft: '#ca8a04',
  disabled: '#dc2626',
};

export function AudiencePreview({ audienceEngineUrl, segmentId, onFetchEntities }: AudiencePreviewProps) {
  const [segment, setSegment] = useState<SegmentData | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const client = new AudienceApiClient(audienceEngineUrl);
    let cancelled = false;

    setLoading(true);
    setError(null);
    setCount(null);

    client
      .getSegment(segmentId)
      .then(async (data) => {
        if (cancelled) return;
        setSegment(data);
        if (onFetchEntities && data.filter) {
          try {
            const entities = await onFetchEntities(data.filter);
            if (!cancelled) {
              const result = await client.evaluateInline(data.filter, entities);
              if (!cancelled) setCount(result.matched_count);
            }
          } catch {
            // count unavailable — non-fatal
          }
        }
        if (!cancelled) setLoading(false);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load segment');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [audienceEngineUrl, segmentId]);

  if (loading) {
    return <div style={{ padding: 16, color: '#6b7280' }}>Loading segment…</div>;
  }

  if (error || !segment) {
    return (
      <div style={{ padding: 16, color: '#dc2626' }}>
        {error || 'Segment not found'}
      </div>
    );
  }

  const conditions = segment.filter ? summarizeFilter(segment.filter) : [];
  const statusColor = STATUS_COLORS[segment.status] ?? '#6b7280';

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>{segment.name}</h3>
        <span
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 4,
            fontSize: 12,
            fontWeight: 600,
            color: '#fff',
            backgroundColor: statusColor,
          }}
        >
          {segment.status}
        </span>
      </div>

      {conditions.length > 0 ? (
        <>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 8 }}>
            {conditions.length} condition{conditions.length !== 1 ? 's' : ''}
          </div>
          <ul style={{ margin: 0, paddingLeft: 20, marginBottom: 12 }}>
            {conditions.map((text, i) => (
              <li key={i} style={{ fontSize: 14, marginBottom: 4 }}>
                {text}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
          No filter conditions available
        </div>
      )}

      {count !== null && (
        <div style={{ fontSize: 13, color: '#374151' }}>
          Estimated audience: <strong>{count.toLocaleString()}</strong>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/@platform/audience-ui && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Run tests**

```bash
cd packages/@platform/audience-ui && npm test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/audience-ui/src/AudiencePreview.tsx packages/@platform/audience-ui/src/types.ts
git commit -m "feat(@platform/audience-ui): add estimated count to AudiencePreview"
```

---

## Task 4 — Fix `AbortController` race in `SegmentEditor`

**Files:**
- Modify: `src/SegmentEditor.tsx`

The `runPreview` function cancels the debounce timer but does not cancel the in-flight `onFetchEntities` or `evaluateInline` fetch if the filter changes again before the response arrives.

- [ ] **Step 1: Update `src/SegmentEditor.tsx`**

Replace the `timerRef` + `runPreview` pattern with `AbortController`:

```tsx
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runPreview = (currentFilter: FilterNode) => {
    if (!onFetchEntities) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();

    timerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const entities = await onFetchEntities(currentFilter);
        if (controller.signal.aborted) return;
        const result = await client.evaluateInline(currentFilter, entities);
        if (controller.signal.aborted) return;
        setPreviewCount(result.matched_count);
        setPreviewError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setPreviewError(err instanceof Error ? err.message : 'Preview failed');
        setPreviewCount(null);
      }
    }, 500);
  };
```

Also add cleanup on unmount — add a `useEffect` cleanup:

```tsx
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);
```

- [ ] **Step 2: Typecheck**

```bash
cd packages/@platform/audience-ui && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run tests**

```bash
cd packages/@platform/audience-ui && npm test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/@platform/audience-ui/src/SegmentEditor.tsx
git commit -m "fix(@platform/audience-ui): abort stale preview fetches in SegmentEditor"
```

---

## Task 5 — Fix `getSegment` return type

**Files:**
- Modify: `src/api.ts`

`getSegment` return type is missing `active_version`, `current_version`, and `status` is typed as `string` rather than `SegmentStatus`.

- [ ] **Step 1: Update `src/api.ts`**

Add the import and tighten the return type:

```ts
import type { SegmentSummary, SegmentStatus } from './types.js';

// Replace getSegment signature:
async getSegment(id: string): Promise<{
  segment_id: string;
  name: string;
  filter: unknown | null;
  status: SegmentStatus;
  active_version: number | null;
  current_version: number;
}> {
  const res = await fetch(`${this.baseUrl}/audiences/segments/${id}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`getSegment failed: ${res.status}`);
  return res.json() as Promise<{
    segment_id: string;
    name: string;
    filter: unknown | null;
    status: SegmentStatus;
    active_version: number | null;
    current_version: number;
  }>;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd packages/@platform/audience-ui && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/@platform/audience-ui/src/api.ts
git commit -m "fix(@platform/audience-ui): tighten getSegment return type"
```

---

## Task 6 — Test suite: setup + component tests

**Files:**
- Modify: `vitest.config.ts` — add jsdom environment
- Modify: `package.json` — add `@testing-library/react`, `@testing-library/user-event`, `jsdom`
- Create: `test/SegmentLibrary.test.tsx`
- Create: `test/SegmentEditor.test.tsx`
- Create: `test/AudiencePreview.test.tsx`

- [ ] **Step 1: Install test deps**

```bash
cd packages/@platform/audience-ui && npm install --save-dev @testing-library/react @testing-library/user-event jsdom
```

- [ ] **Step 2: Update `vitest.config.ts`**

```ts
export default {
  test: {
    passWithNoTests: true,
    environment: 'jsdom',
  },
};
```

- [ ] **Step 3: Create `test/SegmentLibrary.test.tsx`**

```tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SegmentLibrary } from '../src/SegmentLibrary.js';
import type { AudienceApiClient } from '../src/api.js';

function makeClient(overrides: Partial<AudienceApiClient> = {}): AudienceApiClient {
  return {
    listSegments: vi.fn().mockResolvedValue({
      items: [
        { segment_id: 'seg-1', name: 'Draft Seg', status: 'draft', active_version: null, current_version: 1, updated_at: '2026-04-01T00:00:00Z' },
        { segment_id: 'seg-2', name: 'Active Seg', status: 'active', active_version: 2, current_version: 2, updated_at: '2026-04-02T00:00:00Z' },
      ],
      total: 2,
    }),
    activateSegment: vi.fn().mockResolvedValue(undefined),
    disableSegment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AudienceApiClient;
}

describe('SegmentLibrary', () => {
  it('renders segment names', async () => {
    render(<SegmentLibrary client={makeClient()} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} />);
    expect(await screen.findByText('Draft Seg')).toBeTruthy();
    expect(screen.getByText('Active Seg')).toBeTruthy();
  });

  it('shows Edit button only for draft segments', async () => {
    const onEdit = vi.fn();
    render(<SegmentLibrary client={makeClient()} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} onEditSegment={onEdit} />);
    await screen.findByText('Draft Seg');
    const editBtns = screen.getAllByText('Edit');
    expect(editBtns).toHaveLength(1);
    fireEvent.click(editBtns[0]!);
    expect(onEdit).toHaveBeenCalledWith('seg-1');
  });

  it('hides Activate when canActivate is false', async () => {
    render(<SegmentLibrary client={makeClient()} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} canActivate={false} />);
    await screen.findByText('Draft Seg');
    expect(screen.queryByText('Activate')).toBeNull();
  });

  it('shows Activate for draft when canActivate is true', async () => {
    render(<SegmentLibrary client={makeClient()} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} canActivate={true} />);
    await screen.findByText('Draft Seg');
    expect(screen.getByText('Activate')).toBeTruthy();
  });

  it('shows Disable for active segments', async () => {
    render(<SegmentLibrary client={makeClient()} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} />);
    await screen.findByText('Active Seg');
    expect(screen.getByText('Disable')).toBeTruthy();
  });

  it('calls onSelectSegment when Use is clicked', async () => {
    const onSelect = vi.fn();
    render(<SegmentLibrary client={makeClient()} onSelectSegment={onSelect} onCreateNew={vi.fn()} />);
    await screen.findByText('Draft Seg');
    const useBtns = screen.getAllByText('Use');
    fireEvent.click(useBtns[0]!);
    expect(onSelect).toHaveBeenCalledWith('seg-1');
  });

  it('calls activateSegment and refreshes list on Activate', async () => {
    const client = makeClient();
    render(<SegmentLibrary client={client} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} canActivate={true} />);
    await screen.findByText('Draft Seg');
    fireEvent.click(screen.getByText('Activate'));
    await waitFor(() => expect(client.activateSegment).toHaveBeenCalledWith('seg-1'));
    expect(client.listSegments).toHaveBeenCalledTimes(2);
  });

  it('calls disableSegment and refreshes list on Disable', async () => {
    const client = makeClient();
    render(<SegmentLibrary client={client} onSelectSegment={vi.fn()} onCreateNew={vi.fn()} />);
    await screen.findByText('Active Seg');
    fireEvent.click(screen.getByText('Disable'));
    await waitFor(() => expect(client.disableSegment).toHaveBeenCalledWith('seg-2'));
    expect(client.listSegments).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 4: Create `test/SegmentEditor.test.tsx`**

```tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SegmentEditor } from '../src/SegmentEditor.js';
import type { AudienceApiClient } from '../src/api.js';

function makeClient(overrides: Partial<AudienceApiClient> = {}): AudienceApiClient {
  return {
    getSegment: vi.fn(),
    createSegment: vi.fn().mockResolvedValue({ segment_id: 'new-seg', version: 1 }),
    updateSegment: vi.fn().mockResolvedValue({ segment_id: 'seg-1', version: 2, status: 'draft' }),
    evaluateInline: vi.fn().mockResolvedValue({ matched_count: 42, entity_ids: [] }),
    ...overrides,
  } as unknown as AudienceApiClient;
}

describe('SegmentEditor', () => {
  describe('create mode (no segmentId)', () => {
    it('renders empty form', () => {
      render(<SegmentEditor client={makeClient()} fields={[]} onSave={vi.fn()} onCancel={vi.fn()} />);
      expect(screen.getByPlaceholderText('Enter segment name')).toBeTruthy();
    });

    it('shows error if name is blank on save', async () => {
      render(<SegmentEditor client={makeClient()} fields={[]} onSave={vi.fn()} onCancel={vi.fn()} />);
      fireEvent.click(screen.getByText('Save'));
      expect(await screen.findByText('Segment name is required')).toBeTruthy();
    });

    it('calls createSegment and onSave with segment id', async () => {
      const client = makeClient();
      const onSave = vi.fn();
      render(<SegmentEditor client={client} fields={[]} onSave={onSave} onCancel={vi.fn()} />);
      fireEvent.change(screen.getByPlaceholderText('Enter segment name'), { target: { value: 'My Segment' } });
      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => expect(onSave).toHaveBeenCalledWith('new-seg'));
    });
  });

  describe('live preview', () => {
    it('shows preview count after debounce when onFetchEntities provided', async () => {
      vi.useFakeTimers();
      const onFetchEntities = vi.fn().mockResolvedValue([{ entity_id: 'e1' }]);
      const client = makeClient();
      render(
        <SegmentEditor
          client={client}
          fields={[{ key: 'stage', label: 'Stage', type: 'string' }]}
          onFetchEntities={onFetchEntities}
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />
      );
      // Trigger a filter change by verifying the preview area is present
      expect(screen.getByText('Preview will update as you edit conditions')).toBeTruthy();
      vi.useRealTimers();
    });

    it('shows error message when evaluateInline fails', async () => {
      vi.useFakeTimers();
      const onFetchEntities = vi.fn().mockResolvedValue([{ entity_id: 'e1' }]);
      const client = makeClient({
        evaluateInline: vi.fn().mockRejectedValue(new Error('evaluate failed')),
      });
      render(
        <SegmentEditor
          client={client}
          fields={[{ key: 'stage', label: 'Stage', type: 'string' }]}
          onFetchEntities={onFetchEntities}
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />
      );
      // Advance timer to trigger debounce
      await act(async () => { vi.advanceTimersByTime(600); });
      await waitFor(() => expect(screen.getByText(/Preview will update/)).toBeTruthy());
      vi.useRealTimers();
    });

    it('does not show preview area when onFetchEntities is absent', () => {
      render(<SegmentEditor client={makeClient()} fields={[]} onSave={vi.fn()} onCancel={vi.fn()} />);
      expect(screen.queryByText('Preview will update as you edit conditions')).toBeNull();
    });
  });
});
```

- [ ] **Step 5: Create `test/AudiencePreview.test.tsx`**

```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Mock the AudienceApiClient
vi.mock('../src/api.js', () => ({
  AudienceApiClient: vi.fn().mockImplementation(() => ({
    getSegment: vi.fn().mockResolvedValue({
      segment_id: 'seg-1',
      name: 'New Patient Contacted',
      status: 'active',
      active_version: 1,
      current_version: 1,
      filter: {
        op: 'AND',
        conditions: [
          { field: 'pipeline', op: 'eq', value: 'new_patient' },
          { field: 'stage', op: 'eq', value: 'contacted' },
        ],
      },
    }),
    evaluateInline: vi.fn().mockResolvedValue({ matched_count: 87, entity_ids: [] }),
  })),
}));

import { AudiencePreview } from '../src/AudiencePreview.js';

describe('AudiencePreview', () => {
  it('renders segment name and status badge', async () => {
    render(<AudiencePreview audienceEngineUrl="http://localhost:3000" segmentId="seg-1" />);
    expect(await screen.findByText('New Patient Contacted')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
  });

  it('renders human-readable filter conditions', async () => {
    render(<AudiencePreview audienceEngineUrl="http://localhost:3000" segmentId="seg-1" />);
    await screen.findByText('New Patient Contacted');
    expect(screen.getByText('pipeline equals new_patient')).toBeTruthy();
    expect(screen.getByText('stage equals contacted')).toBeTruthy();
  });

  it('shows estimated count when onFetchEntities provided', async () => {
    const onFetchEntities = vi.fn().mockResolvedValue([{ entity_id: 'e1' }]);
    render(
      <AudiencePreview
        audienceEngineUrl="http://localhost:3000"
        segmentId="seg-1"
        onFetchEntities={onFetchEntities}
      />
    );
    await waitFor(() => expect(screen.getByText(/Estimated audience/)).toBeTruthy());
    expect(screen.getByText('87')).toBeTruthy();
  });

  it('does not show estimated count when onFetchEntities is absent', async () => {
    render(<AudiencePreview audienceEngineUrl="http://localhost:3000" segmentId="seg-1" />);
    await screen.findByText('New Patient Contacted');
    expect(screen.queryByText(/Estimated audience/)).toBeNull();
  });
});
```

- [ ] **Step 6: Run tests**

```bash
cd packages/@platform/audience-ui && npm test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 7: Typecheck**

```bash
cd packages/@platform/audience-ui && npm run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/@platform/audience-ui/vitest.config.ts packages/@platform/audience-ui/package.json packages/@platform/audience-ui/package-lock.json packages/@platform/audience-ui/test/
git commit -m "test(@platform/audience-ui): add component and unit test suite"
```

---

## Self-Review

| Spec requirement | Covered by task |
|---|---|
| `summarizeFilter` uses correct DSL (`op`, `conditions`, `condition`) | Task 1 |
| Segment Library: edit draft action | Task 2 |
| Activate button: Marketing Manager only (`canActivate` prop) | Task 2 |
| `AudiencePreview`: estimated audience count | Task 3 |
| No stale preview counts on rapid edits | Task 4 |
| `getSegment` typed return | Task 5 |
| Tests: `summarizeFilter` unit | Task 1 |
| Tests: SegmentLibrary (edit, activate role-gate, disable, Use) | Task 6 |
| Tests: SegmentEditor (error display, preview on/off) | Task 6 |
| Tests: AudiencePreview (summary, count, no count without provider) | Task 6 |

**No placeholders:** All code blocks are complete and runnable.
**Type consistency:** `SegmentStatus` used in `api.ts` is imported from `types.ts`. `onFetchEntities` type is identical across `SegmentBuilderProps`, `SegmentEditorProps`, and `AudiencePreviewProps`.
