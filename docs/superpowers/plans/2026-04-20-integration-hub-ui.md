# @platform/integration-hub-ui Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/@platform/integration-hub-ui` — a React package that provides a full-page Integration Hub settings UI for managing Google Ads and Meta ad account connections.

**Architecture:** Hook-driven pattern (consistent with `@platform/sequence-ui`): three hooks own all async state (`useIntegrationAccounts`, `useCampaignMapper`, `useBackfillStatus`), thin components are pure renderers that receive state as props. `IntegrationHub` is the single exported page component; `OAuthCallbackHandler` handles the post-OAuth SPA route.

**Tech Stack:** React 18, TypeScript 5 (ESM NodeNext), Vitest 2 + jsdom + React Testing Library 16, inline styles + `.ih-` namespaced CSS file.

**Spec:** `docs/superpowers/specs/2026-04-20-integration-hub-ui-design.md`

---

## File Map

| File | Role |
|------|------|
| `src/types.ts` | All shared TypeScript interfaces |
| `src/api/IntegrationHubApiClient.ts` | Fetch wrapper for all backend endpoints |
| `src/hooks/useIntegrationAccounts.ts` | Account list state + select/disconnect |
| `src/hooks/useCampaignMapper.ts` | Campaign list + mapping state + save |
| `src/hooks/useBackfillStatus.ts` | Backfill trigger + one-shot status load |
| `src/components/StatusBadge.tsx` | Reusable status chip (active/error/etc.) |
| `src/components/AccountSidebar.tsx` | Left panel: account list + connect buttons |
| `src/components/CampaignRow.tsx` | Single campaign → location `<select>` row |
| `src/components/AccountDetail.tsx` | Right panel: header + mapper + backfill controls |
| `src/components/IntegrationHub.tsx` | Top-level exported component, calls all hooks |
| `src/components/OAuthCallbackHandler.tsx` | Post-OAuth callback route component |
| `src/styles.css` | `.ih-*` hover/transition states only |
| `src/index.ts` | Public exports |
| `test/unit/IntegrationHubApiClient.test.ts` | API client unit tests |
| `test/unit/useIntegrationAccounts.test.ts` | Hook unit tests |
| `test/unit/useCampaignMapper.test.ts` | Hook unit tests |
| `test/unit/useBackfillStatus.test.ts` | Hook unit tests |
| `test/components/IntegrationHub.test.tsx` | Component integration tests |
| `test/components/OAuthCallbackHandler.test.tsx` | Callback handler tests |

---

## Task 1: Package scaffold

**Files:**
- Create: `packages/@platform/integration-hub-ui/package.json`
- Create: `packages/@platform/integration-hub-ui/tsconfig.json`
- Create: `packages/@platform/integration-hub-ui/vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@platform/integration-hub-ui",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./dist/styles.css": "./dist/styles.css"
  },
  "engines": {
    "node": ">=24"
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
  "devDependencies": {
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.1",
    "@types/node": "^22.0.0",
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0",
    "jsdom": "^29.0.2",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

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

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
export default {
  test: {
    passWithNoTests: true,
    environment: 'jsdom',
    globals: true,
  },
};
```

- [ ] **Step 4: Install dependencies**

Run from `packages/@platform/integration-hub-ui/`:
```bash
npm install
```

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/integration-hub-ui/package.json \
        packages/@platform/integration-hub-ui/tsconfig.json \
        packages/@platform/integration-hub-ui/vitest.config.ts \
        packages/@platform/integration-hub-ui/package-lock.json
git commit -m "chore(@platform/integration-hub-ui): scaffold package"
```

---

## Task 2: Types

**Files:**
- Create: `packages/@platform/integration-hub-ui/src/types.ts`

- [ ] **Step 1: Create `src/types.ts`**

```typescript
export interface Location {
  id: string
  name: string
}

export interface IntegrationAccount {
  id: string
  platform: 'google_ads' | 'facebook_ads'
  account_id: string
  account_name: string | null
  status: 'active' | 'paused' | 'error'
  last_error: string | null
  last_polled_at: string | null
}

export interface CampaignSummary {
  campaign_id: string
  campaign_name: string
  location_id: string | null
}

export interface BackfillJob {
  job_id: string
  status: 'active' | 'completed' | 'failed'
  from_date: string
  to_date: string
  progress: {
    chunks_done: number
    chunks_total: number
  }
  error?: string
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/@platform/integration-hub-ui/src/types.ts
git commit -m "feat(@platform/integration-hub-ui): add shared types"
```

---

## Task 3: API client (TDD)

**Files:**
- Create: `packages/@platform/integration-hub-ui/test/unit/IntegrationHubApiClient.test.ts`
- Create: `packages/@platform/integration-hub-ui/src/api/IntegrationHubApiClient.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/IntegrationHubApiClient.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IntegrationHubApiClient } from '../../src/api/IntegrationHubApiClient.js'

const BASE = 'http://localhost:3000'
const TOKEN = 'test-token'

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  })
}

describe('IntegrationHubApiClient', () => {
  let client: IntegrationHubApiClient

  beforeEach(() => {
    client = new IntegrationHubApiClient(BASE, TOKEN)
  })

  afterEach(() => vi.unstubAllGlobals())

  describe('listAccounts', () => {
    it('GET /integrations/accounts with auth header', async () => {
      const accounts = [{ id: '1', platform: 'google_ads', status: 'active' }]
      vi.stubGlobal('fetch', mockFetch(accounts))

      const result = await client.listAccounts()

      expect(fetch).toHaveBeenCalledWith(`${BASE}/integrations/accounts`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
      })
      expect(result).toEqual(accounts)
    })

    it('throws on non-ok response', async () => {
      vi.stubGlobal('fetch', mockFetch(null, false, 401))
      await expect(client.listAccounts()).rejects.toThrow('401')
    })
  })

  describe('deleteAccount', () => {
    it('DELETE /integrations/accounts/:id', async () => {
      vi.stubGlobal('fetch', mockFetch(null))
      await client.deleteAccount('abc')
      expect(fetch).toHaveBeenCalledWith(`${BASE}/integrations/accounts/abc`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
      })
    })

    it('throws on non-ok response', async () => {
      vi.stubGlobal('fetch', mockFetch(null, false, 404))
      await expect(client.deleteAccount('missing')).rejects.toThrow('404')
    })
  })

  describe('getConnectUrl', () => {
    it('builds backend URL with platform and redirect_uri', () => {
      const url = client.getConnectUrl('google_ads', '/settings/integrations/callback')
      expect(url).toBe(
        `${BASE}/integrations/connect/google_ads?redirect_uri=%2Fsettings%2Fintegrations%2Fcallback`,
      )
    })

    it('handles facebook_ads platform', () => {
      const url = client.getConnectUrl('facebook_ads', '/cb')
      expect(url).toContain('/integrations/connect/facebook_ads')
    })
  })

  describe('getCampaigns', () => {
    it('GET /integrations/accounts/:id/campaigns', async () => {
      const campaigns = [{ campaign_id: 'c1', campaign_name: 'Spring', location_id: null }]
      vi.stubGlobal('fetch', mockFetch(campaigns))

      const result = await client.getCampaigns('acc1')

      expect(fetch).toHaveBeenCalledWith(`${BASE}/integrations/accounts/acc1/campaigns`, {
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
      })
      expect(result).toEqual(campaigns)
    })
  })

  describe('saveMappings', () => {
    it('PUT /integrations/accounts/:id/mappings with mappings body', async () => {
      vi.stubGlobal('fetch', mockFetch(null))
      const mappings = [{ campaign_id: 'c1', location_id: 'loc1' }]

      await client.saveMappings('acc1', mappings)

      expect(fetch).toHaveBeenCalledWith(`${BASE}/integrations/accounts/acc1/mappings`, {
        method: 'PUT',
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
        body: JSON.stringify({ mappings }),
      })
    })
  })

  describe('triggerBackfill', () => {
    it('POST /integrations/accounts/:id/backfill with from/to body', async () => {
      vi.stubGlobal('fetch', mockFetch({ job_id: 'job-1' }))

      const result = await client.triggerBackfill('acc1', '2026-01-01', '2026-03-31')

      expect(result).toEqual({ job_id: 'job-1' })
      expect(fetch).toHaveBeenCalledWith(`${BASE}/integrations/accounts/acc1/backfill`, {
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
        body: JSON.stringify({ from: '2026-01-01', to: '2026-03-31' }),
      })
    })
  })

  describe('getBackfillStatus', () => {
    it('GET /integrations/accounts/:id/backfill/:job_id', async () => {
      const job = {
        job_id: 'job-1',
        status: 'completed',
        from_date: '2026-01-01',
        to_date: '2026-03-31',
        progress: { chunks_done: 13, chunks_total: 13 },
      }
      vi.stubGlobal('fetch', mockFetch(job))

      const result = await client.getBackfillStatus('acc1', 'job-1')

      expect(result).toEqual(job)
      expect(fetch).toHaveBeenCalledWith(
        `${BASE}/integrations/accounts/acc1/backfill/job-1`,
        expect.any(Object),
      )
    })
  })
})
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
cd packages/@platform/integration-hub-ui && npm test
```
Expected: `Cannot find module '../../src/api/IntegrationHubApiClient.js'`

- [ ] **Step 3: Implement `src/api/IntegrationHubApiClient.ts`**

```typescript
import type { IntegrationAccount, CampaignSummary, BackfillJob } from '../types.js'

export class IntegrationHubApiClient {
  private readonly headers: Record<string, string>

  constructor(
    private readonly baseUrl: string,
    token?: string,
  ) {
    this.headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  async listAccounts(): Promise<IntegrationAccount[]> {
    const res = await fetch(`${this.baseUrl}/integrations/accounts`, { headers: this.headers })
    if (!res.ok) throw new Error(`listAccounts failed: ${res.status}`)
    return res.json()
  }

  async deleteAccount(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/integrations/accounts/${id}`, {
      method: 'DELETE',
      headers: this.headers,
    })
    if (!res.ok) throw new Error(`deleteAccount failed: ${res.status}`)
  }

  getConnectUrl(platform: 'google_ads' | 'facebook_ads', redirectUri: string): string {
    const params = new URLSearchParams({ redirect_uri: redirectUri })
    return `${this.baseUrl}/integrations/connect/${platform}?${params}`
  }

  async getCampaigns(accountId: string): Promise<CampaignSummary[]> {
    const res = await fetch(`${this.baseUrl}/integrations/accounts/${accountId}/campaigns`, {
      headers: this.headers,
    })
    if (!res.ok) throw new Error(`getCampaigns failed: ${res.status}`)
    return res.json()
  }

  async saveMappings(
    accountId: string,
    mappings: { campaign_id: string; location_id: string }[],
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/integrations/accounts/${accountId}/mappings`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ mappings }),
    })
    if (!res.ok) throw new Error(`saveMappings failed: ${res.status}`)
  }

  async triggerBackfill(
    accountId: string,
    from: string,
    to: string,
  ): Promise<{ job_id: string }> {
    const res = await fetch(`${this.baseUrl}/integrations/accounts/${accountId}/backfill`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ from, to }),
    })
    if (!res.ok) throw new Error(`triggerBackfill failed: ${res.status}`)
    return res.json()
  }

  async getBackfillStatus(accountId: string, jobId: string): Promise<BackfillJob> {
    const res = await fetch(
      `${this.baseUrl}/integrations/accounts/${accountId}/backfill/${jobId}`,
      { headers: this.headers },
    )
    if (!res.ok) throw new Error(`getBackfillStatus failed: ${res.status}`)
    return res.json()
  }
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
npm test
```
Expected: all 10 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/integration-hub-ui/src/api/IntegrationHubApiClient.ts \
        packages/@platform/integration-hub-ui/test/unit/IntegrationHubApiClient.test.ts
git commit -m "feat(@platform/integration-hub-ui): add API client"
```

---

## Task 4: useIntegrationAccounts (TDD)

**Files:**
- Create: `packages/@platform/integration-hub-ui/test/unit/useIntegrationAccounts.test.ts`
- Create: `packages/@platform/integration-hub-ui/src/hooks/useIntegrationAccounts.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/useIntegrationAccounts.test.ts`:

```typescript
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useIntegrationAccounts } from '../../src/hooks/useIntegrationAccounts.js'
import type { IntegrationHubApiClient } from '../../src/api/IntegrationHubApiClient.js'

const ACCOUNT_1 = {
  id: 'acc-1',
  platform: 'google_ads' as const,
  account_id: 'g-123',
  account_name: 'My Google Ads',
  status: 'active' as const,
  last_error: null,
  last_polled_at: null,
}

const ACCOUNT_2 = {
  id: 'acc-2',
  platform: 'facebook_ads' as const,
  account_id: 'f-456',
  account_name: 'My Meta',
  status: 'error' as const,
  last_error: 'Token expired',
  last_polled_at: null,
}

function makeClient(overrides: Partial<InstanceType<typeof IntegrationHubApiClient>> = {}) {
  return {
    listAccounts: vi.fn().mockResolvedValue([ACCOUNT_1, ACCOUNT_2]),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as InstanceType<typeof IntegrationHubApiClient>
}

describe('useIntegrationAccounts', () => {
  it('loads accounts on mount and auto-selects first', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useIntegrationAccounts(client))

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.accounts).toEqual([ACCOUNT_1, ACCOUNT_2])
    expect(result.current.selectedId).toBe('acc-1')
    expect(result.current.error).toBeNull()
  })

  it('sets error when load fails', async () => {
    const client = makeClient({
      listAccounts: vi.fn().mockRejectedValue(new Error('Network error')),
    })
    const { result } = renderHook(() => useIntegrationAccounts(client))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('Network error')
    expect(result.current.accounts).toEqual([])
  })

  it('selectAccount updates selectedId', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useIntegrationAccounts(client))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.selectAccount('acc-2'))
    expect(result.current.selectedId).toBe('acc-2')
  })

  it('disconnect: calls deleteAccount, clears selection if current, reloads', async () => {
    const listAccounts = vi.fn()
      .mockResolvedValueOnce([ACCOUNT_1, ACCOUNT_2])  // initial load
      .mockResolvedValueOnce([ACCOUNT_2])              // after disconnect
    const deleteAccount = vi.fn().mockResolvedValue(undefined)
    const client = makeClient({ listAccounts, deleteAccount })

    const { result } = renderHook(() => useIntegrationAccounts(client))
    await waitFor(() => expect(result.current.loading).toBe(false))
    // selectedId is acc-1 (auto-selected)

    await act(async () => { await result.current.disconnect('acc-1') })

    expect(deleteAccount).toHaveBeenCalledWith('acc-1')
    expect(result.current.selectedId).toBeNull()
    expect(result.current.accounts).toEqual([ACCOUNT_2])
  })

  it('disconnect: preserves selection when disconnecting a different account', async () => {
    const listAccounts = vi.fn()
      .mockResolvedValueOnce([ACCOUNT_1, ACCOUNT_2])
      .mockResolvedValueOnce([ACCOUNT_1])
    const client = makeClient({ listAccounts, deleteAccount: vi.fn().mockResolvedValue(undefined) })

    const { result } = renderHook(() => useIntegrationAccounts(client))
    await waitFor(() => expect(result.current.loading).toBe(false))
    // selectedId is acc-1

    await act(async () => { await result.current.disconnect('acc-2') })
    expect(result.current.selectedId).toBe('acc-1')
  })
})
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
npm test
```
Expected: `Cannot find module '../../src/hooks/useIntegrationAccounts.js'`

- [ ] **Step 3: Implement `src/hooks/useIntegrationAccounts.ts`**

```typescript
import { useState, useEffect, useCallback } from 'react'
import type { IntegrationHubApiClient } from '../api/IntegrationHubApiClient.js'
import type { IntegrationAccount } from '../types.js'

export interface UseIntegrationAccountsResult {
  accounts: IntegrationAccount[]
  selectedId: string | null
  loading: boolean
  error: string | null
  selectAccount: (id: string) => void
  disconnect: (id: string) => Promise<void>
  reload: () => Promise<void>
}

export function useIntegrationAccounts(client: IntegrationHubApiClient): UseIntegrationAccountsResult {
  const [accounts, setAccounts] = useState<IntegrationAccount[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await client.listAccounts()
      setAccounts(data)
      setSelectedId(prev => {
        if (prev !== null && data.some(a => a.id === prev)) return prev
        return data.length > 0 ? data[0]!.id : null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounts')
      setAccounts([])
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => { void load() }, [load])

  const selectAccount = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  const disconnect = useCallback(async (id: string) => {
    await client.deleteAccount(id)
    setSelectedId(prev => (prev === id ? null : prev))
    await load()
  }, [client, load])

  return { accounts, selectedId, loading, error, selectAccount, disconnect, reload: load }
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
npm test
```
Expected: all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/integration-hub-ui/src/hooks/useIntegrationAccounts.ts \
        packages/@platform/integration-hub-ui/test/unit/useIntegrationAccounts.test.ts
git commit -m "feat(@platform/integration-hub-ui): add useIntegrationAccounts hook"
```

---

## Task 5: useCampaignMapper (TDD)

**Files:**
- Create: `packages/@platform/integration-hub-ui/test/unit/useCampaignMapper.test.ts`
- Create: `packages/@platform/integration-hub-ui/src/hooks/useCampaignMapper.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/useCampaignMapper.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useCampaignMapper } from '../../src/hooks/useCampaignMapper.js'
import type { IntegrationHubApiClient } from '../../src/api/IntegrationHubApiClient.js'

const CAMPAIGNS = [
  { campaign_id: 'c1', campaign_name: 'Spring', location_id: 'loc-1' },
  { campaign_id: 'c2', campaign_name: 'Summer', location_id: null },
]

function makeClient(overrides: Partial<InstanceType<typeof IntegrationHubApiClient>> = {}) {
  return {
    getCampaigns: vi.fn().mockResolvedValue(CAMPAIGNS),
    saveMappings: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as InstanceType<typeof IntegrationHubApiClient>
}

describe('useCampaignMapper', () => {
  it('loads campaigns when accountId is set, pre-fills mapped location_ids', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useCampaignMapper(client, 'acc-1'))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.campaigns).toEqual(CAMPAIGNS)
    expect(result.current.mappings).toEqual({ c1: 'loc-1' })  // c2 is null, excluded
  })

  it('resets when accountId changes to null', async () => {
    const client = makeClient()
    const { result, rerender } = renderHook(
      ({ id }) => useCampaignMapper(client, id),
      { initialProps: { id: 'acc-1' as string | null } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    rerender({ id: null })
    expect(result.current.campaigns).toEqual([])
    expect(result.current.mappings).toEqual({})
  })

  it('reloads when accountId changes', async () => {
    const getCampaigns = vi.fn()
      .mockResolvedValueOnce(CAMPAIGNS)
      .mockResolvedValueOnce([{ campaign_id: 'c3', campaign_name: 'Fall', location_id: null }])
    const client = makeClient({ getCampaigns })

    const { result, rerender } = renderHook(
      ({ id }) => useCampaignMapper(client, id),
      { initialProps: { id: 'acc-1' as string | null } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.campaigns).toEqual(CAMPAIGNS)

    rerender({ id: 'acc-2' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.campaigns).toEqual([{ campaign_id: 'c3', campaign_name: 'Fall', location_id: null }])
  })

  it('setMapping adds or updates a campaign mapping', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useCampaignMapper(client, 'acc-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setMapping('c2', 'loc-2'))
    expect(result.current.mappings).toEqual({ c1: 'loc-1', c2: 'loc-2' })
  })

  it('setMapping with null removes the campaign from mappings', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useCampaignMapper(client, 'acc-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setMapping('c1', null))
    expect(result.current.mappings).toEqual({})
  })

  it('save: calls saveMappings with only mapped campaigns', async () => {
    const saveMappings = vi.fn().mockResolvedValue(undefined)
    const client = makeClient({ saveMappings })
    const { result } = renderHook(() => useCampaignMapper(client, 'acc-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setMapping('c2', 'loc-3'))
    await act(async () => { await result.current.save() })

    expect(saveMappings).toHaveBeenCalledWith('acc-1', [
      { campaign_id: 'c1', location_id: 'loc-1' },
      { campaign_id: 'c2', location_id: 'loc-3' },
    ])
    expect(result.current.saving).toBe(false)
  })

  it('sets error on load failure', async () => {
    const client = makeClient({
      getCampaigns: vi.fn().mockRejectedValue(new Error('API error')),
    })
    const { result } = renderHook(() => useCampaignMapper(client, 'acc-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('API error')
  })
})
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
npm test
```
Expected: `Cannot find module '../../src/hooks/useCampaignMapper.js'`

- [ ] **Step 3: Implement `src/hooks/useCampaignMapper.ts`**

```typescript
import { useState, useEffect, useCallback } from 'react'
import type { IntegrationHubApiClient } from '../api/IntegrationHubApiClient.js'
import type { CampaignSummary } from '../types.js'

export interface UseCampaignMapperResult {
  campaigns: CampaignSummary[]
  mappings: Record<string, string>  // campaign_id → location_id
  loading: boolean
  saving: boolean
  error: string | null
  setMapping: (campaignId: string, locationId: string | null) => void
  save: () => Promise<void>
}

export function useCampaignMapper(
  client: IntegrationHubApiClient,
  accountId: string | null,
): UseCampaignMapperResult {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([])
  const [mappings, setMappings] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!accountId) {
      setCampaigns([])
      setMappings({})
      return
    }
    setLoading(true)
    setError(null)
    client.getCampaigns(accountId).then(data => {
      setCampaigns(data)
      const m: Record<string, string> = {}
      for (const c of data) {
        if (c.location_id) m[c.campaign_id] = c.location_id
      }
      setMappings(m)
    }).catch(err => {
      setError(err instanceof Error ? err.message : 'Failed to load campaigns')
    }).finally(() => setLoading(false))
  }, [client, accountId])

  const setMapping = useCallback((campaignId: string, locationId: string | null) => {
    setMappings(prev => {
      if (!locationId) {
        const next = { ...prev }
        delete next[campaignId]
        return next
      }
      return { ...prev, [campaignId]: locationId }
    })
  }, [])

  const save = useCallback(async () => {
    if (!accountId) return
    setSaving(true)
    setError(null)
    try {
      const mapped = Object.entries(mappings).map(([campaign_id, location_id]) => ({
        campaign_id,
        location_id,
      }))
      await client.saveMappings(accountId, mapped)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save mappings')
    } finally {
      setSaving(false)
    }
  }, [client, accountId, mappings])

  return { campaigns, mappings, loading, saving, error, setMapping, save }
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
npm test
```
Expected: all 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/integration-hub-ui/src/hooks/useCampaignMapper.ts \
        packages/@platform/integration-hub-ui/test/unit/useCampaignMapper.test.ts
git commit -m "feat(@platform/integration-hub-ui): add useCampaignMapper hook"
```

---

## Task 6: useBackfillStatus (TDD)

**Files:**
- Create: `packages/@platform/integration-hub-ui/test/unit/useBackfillStatus.test.ts`
- Create: `packages/@platform/integration-hub-ui/src/hooks/useBackfillStatus.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/useBackfillStatus.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useBackfillStatus } from '../../src/hooks/useBackfillStatus.js'
import type { IntegrationHubApiClient } from '../../src/api/IntegrationHubApiClient.js'

const JOB = {
  job_id: 'job-1',
  status: 'active' as const,
  from_date: '2026-01-01',
  to_date: '2026-03-31',
  progress: { chunks_done: 0, chunks_total: 13 },
}

function makeClient(overrides: Partial<InstanceType<typeof IntegrationHubApiClient>> = {}) {
  return {
    triggerBackfill: vi.fn().mockResolvedValue({ job_id: 'job-1' }),
    getBackfillStatus: vi.fn().mockResolvedValue(JOB),
    ...overrides,
  } as unknown as InstanceType<typeof IntegrationHubApiClient>
}

describe('useBackfillStatus', () => {
  it('starts with no job', () => {
    const client = makeClient()
    const { result } = renderHook(() => useBackfillStatus(client, 'acc-1'))
    expect(result.current.latestJob).toBeNull()
    expect(result.current.triggering).toBe(false)
  })

  it('resets latestJob when accountId changes', async () => {
    const client = makeClient()
    const { result, rerender } = renderHook(
      ({ id }) => useBackfillStatus(client, id),
      { initialProps: { id: 'acc-1' as string | null } },
    )

    // trigger a backfill to set latestJob
    await act(async () => { await result.current.triggerBackfill('2026-01-01', '2026-03-31') })
    expect(result.current.latestJob).toEqual(JOB)

    rerender({ id: 'acc-2' })
    expect(result.current.latestJob).toBeNull()
  })

  it('triggerBackfill: calls triggerBackfill then getBackfillStatus and sets latestJob', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useBackfillStatus(client, 'acc-1'))

    await act(async () => {
      await result.current.triggerBackfill('2026-01-01', '2026-03-31')
    })

    expect(client.triggerBackfill).toHaveBeenCalledWith('acc-1', '2026-01-01', '2026-03-31')
    expect(client.getBackfillStatus).toHaveBeenCalledWith('acc-1', 'job-1')
    expect(result.current.latestJob).toEqual(JOB)
    expect(result.current.triggering).toBe(false)
  })

  it('does nothing when accountId is null', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useBackfillStatus(client, null))

    await act(async () => {
      await result.current.triggerBackfill('2026-01-01', '2026-03-31')
    })

    expect(client.triggerBackfill).not.toHaveBeenCalled()
    expect(result.current.latestJob).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
npm test
```
Expected: `Cannot find module '../../src/hooks/useBackfillStatus.js'`

- [ ] **Step 3: Implement `src/hooks/useBackfillStatus.ts`**

```typescript
import { useState, useEffect, useCallback } from 'react'
import type { IntegrationHubApiClient } from '../api/IntegrationHubApiClient.js'
import type { BackfillJob } from '../types.js'

export interface UseBackfillStatusResult {
  latestJob: BackfillJob | null
  triggering: boolean
  triggerBackfill: (from: string, to: string) => Promise<void>
}

export function useBackfillStatus(
  client: IntegrationHubApiClient,
  accountId: string | null,
): UseBackfillStatusResult {
  const [latestJob, setLatestJob] = useState<BackfillJob | null>(null)
  const [triggering, setTriggering] = useState(false)

  useEffect(() => {
    setLatestJob(null)
  }, [accountId])

  const triggerBackfill = useCallback(async (from: string, to: string) => {
    if (!accountId) return
    setTriggering(true)
    try {
      const { job_id } = await client.triggerBackfill(accountId, from, to)
      const job = await client.getBackfillStatus(accountId, job_id)
      setLatestJob(job)
    } finally {
      setTriggering(false)
    }
  }, [client, accountId])

  return { latestJob, triggering, triggerBackfill }
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
npm test
```
Expected: all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/integration-hub-ui/src/hooks/useBackfillStatus.ts \
        packages/@platform/integration-hub-ui/test/unit/useBackfillStatus.test.ts
git commit -m "feat(@platform/integration-hub-ui): add useBackfillStatus hook"
```

---

## Task 7: Internal components

No separate tests — these are covered by the `IntegrationHub` integration test in Task 9.

**Files:**
- Create: `packages/@platform/integration-hub-ui/src/components/StatusBadge.tsx`
- Create: `packages/@platform/integration-hub-ui/src/components/CampaignRow.tsx`
- Create: `packages/@platform/integration-hub-ui/src/components/AccountSidebar.tsx`
- Create: `packages/@platform/integration-hub-ui/src/components/AccountDetail.tsx`

- [ ] **Step 1: Create `src/components/StatusBadge.tsx`**

```tsx
import React from 'react'

type StatusBadgeStatus = 'active' | 'paused' | 'error' | 'completed' | 'failed'

interface StatusBadgeProps {
  status: StatusBadgeStatus
}

const CONFIG: Record<StatusBadgeStatus, { bg: string; color: string }> = {
  active:    { bg: '#e8f5e9', color: '#2e7d32' },
  completed: { bg: '#e8f5e9', color: '#2e7d32' },
  paused:    { bg: '#fff3e0', color: '#e65100' },
  error:     { bg: '#ffebee', color: '#c62828' },
  failed:    { bg: '#ffebee', color: '#c62828' },
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const { bg, color } = CONFIG[status] ?? CONFIG.error
  return (
    <span style={{
      background: bg,
      color,
      padding: '2px 8px',
      borderRadius: 10,
      fontSize: 11,
      fontWeight: 500,
    }}>
      {status}
    </span>
  )
}
```

- [ ] **Step 2: Create `src/components/CampaignRow.tsx`**

```tsx
import React from 'react'
import type { CampaignSummary, Location } from '../types.js'

interface CampaignRowProps {
  campaign: CampaignSummary
  locationId: string | null
  locations: Location[]
  onChange: (campaignId: string, locationId: string | null) => void
}

export function CampaignRow({ campaign, locationId, locations, onChange }: CampaignRowProps) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 24px 1fr',
      gap: 8,
      alignItems: 'center',
      marginBottom: 6,
    }}>
      <div style={{
        background: '#f5f5f5',
        padding: '5px 8px',
        borderRadius: 3,
        fontSize: 12,
      }}>
        {campaign.campaign_name}
      </div>
      <div style={{ color: '#bbb', textAlign: 'center', fontSize: 14 }}>→</div>
      <select
        className="ih-select"
        value={locationId ?? ''}
        onChange={e => onChange(campaign.campaign_id, e.target.value || null)}
        style={{
          padding: '5px 6px',
          borderRadius: 3,
          border: '1px solid #ddd',
          fontSize: 12,
          background: '#fff',
          width: '100%',
        }}
      >
        <option value="">— unassigned —</option>
        {locations.map(loc => (
          <option key={loc.id} value={loc.id}>{loc.name}</option>
        ))}
      </select>
    </div>
  )
}
```

- [ ] **Step 3: Create `src/components/AccountSidebar.tsx`**

```tsx
import React from 'react'
import type { IntegrationAccount } from '../types.js'
import type { IntegrationHubApiClient } from '../api/IntegrationHubApiClient.js'
import { StatusBadge } from './StatusBadge.js'

const PLATFORMS: Array<{ id: 'google_ads' | 'facebook_ads'; label: string }> = [
  { id: 'google_ads', label: 'Google Ads' },
  { id: 'facebook_ads', label: 'Meta' },
]

interface AccountSidebarProps {
  accounts: IntegrationAccount[]
  selectedId: string | null
  client: IntegrationHubApiClient
  connectReturnUrl: string
  onSelect: (id: string) => void
}

export function AccountSidebar({
  accounts,
  selectedId,
  client,
  connectReturnUrl,
  onSelect,
}: AccountSidebarProps) {
  const connectedPlatforms = new Set(accounts.map(a => a.platform))
  const unconnectedPlatforms = PLATFORMS.filter(p => !connectedPlatforms.has(p.id))

  return (
    <div style={{ width: 200, borderRight: '1px solid #ddd', display: 'flex', flexDirection: 'column' }}>
      {accounts.length > 0 && (
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #eee' }}>
          <div style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            color: '#888',
            letterSpacing: '.5px',
            marginBottom: 8,
          }}>
            Connected Accounts
          </div>
          {accounts.map(account => {
            const selected = account.id === selectedId
            return (
              <div
                key={account.id}
                className={`ih-account-item${selected ? ' selected' : ''}`}
                onClick={() => onSelect(account.id)}
                style={{
                  padding: '8px 10px',
                  marginBottom: 4,
                  borderRadius: 4,
                  borderLeft: `3px solid ${selected ? '#1976d2' : 'transparent'}`,
                  background: selected ? '#e3f2fd' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>
                  {account.platform === 'google_ads' ? 'Google Ads' : 'Meta'}
                </div>
                <StatusBadge status={account.status} />
                {account.last_polled_at && (
                  <div style={{ color: '#888', fontSize: 10, marginTop: 2 }}>
                    polled {new Date(account.last_polled_at).toLocaleDateString()}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {unconnectedPlatforms.length > 0 && (
        <div style={{ padding: '10px 12px' }}>
          <div style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            color: '#888',
            letterSpacing: '.5px',
            marginBottom: 8,
          }}>
            Add Integration
          </div>
          {unconnectedPlatforms.map(p => (
            <a
              key={p.id}
              href={client.getConnectUrl(p.id, connectReturnUrl)}
              className="ih-connect-btn"
              style={{
                display: 'block',
                padding: '6px 8px',
                marginBottom: 4,
                borderRadius: 3,
                border: '1px solid #ddd',
                fontSize: 12,
                color: '#1976d2',
                textDecoration: 'none',
                cursor: 'pointer',
              }}
            >
              + Connect {p.label}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Create `src/components/AccountDetail.tsx`**

```tsx
import React, { useState } from 'react'
import type { IntegrationAccount, CampaignSummary, BackfillJob, Location } from '../types.js'
import { StatusBadge } from './StatusBadge.js'
import { CampaignRow } from './CampaignRow.js'

interface AccountDetailProps {
  account: IntegrationAccount
  campaigns: CampaignSummary[]
  mappings: Record<string, string>
  locations: Location[]
  saving: boolean
  latestJob: BackfillJob | null
  triggering: boolean
  onSetMapping: (campaignId: string, locationId: string | null) => void
  onSave: () => void
  onDisconnect: (id: string) => void
  onTriggerBackfill: (from: string, to: string) => Promise<void>
}

export function AccountDetail({
  account,
  campaigns,
  mappings,
  locations,
  saving,
  latestJob,
  triggering,
  onSetMapping,
  onSave,
  onDisconnect,
  onTriggerBackfill,
}: AccountDetailProps) {
  const [backfillFrom, setBackfillFrom] = useState('')
  const [backfillTo, setBackfillTo] = useState('')
  const [backfillError, setBackfillError] = useState<string | null>(null)

  const platformLabel = account.platform === 'google_ads' ? 'Google Ads' : 'Meta'

  async function handleTrigger() {
    setBackfillError(null)
    try {
      await onTriggerBackfill(backfillFrom, backfillTo)
    } catch (err) {
      setBackfillError(err instanceof Error ? err.message : 'Backfill failed')
    }
  }

  return (
    <div className="ih-detail-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Account header */}
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid #eee',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <span style={{ fontWeight: 600, marginRight: 8 }}>{platformLabel}</span>
          <StatusBadge status={account.status} />
          <div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>
            Account #{account.account_id}
            {account.last_polled_at && ` · last polled ${new Date(account.last_polled_at).toLocaleString()}`}
          </div>
          {account.last_error && (
            <div style={{ color: '#c62828', fontSize: 11, marginTop: 2 }}>{account.last_error}</div>
          )}
        </div>
        <button
          onClick={() => onDisconnect(account.id)}
          style={{
            padding: '4px 12px',
            fontSize: 12,
            background: '#ffebee',
            color: '#c62828',
            border: '1px solid #ef9a9a',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          Disconnect
        </button>
      </div>

      {/* Campaign mapper + backfill */}
      <div style={{ padding: '14px 16px', flex: 1, overflowY: 'auto' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Campaign → Location Mapping</div>
        <div style={{ color: '#666', fontSize: 12, marginBottom: 12 }}>
          Campaigns with no location assigned are tracked but spend data is not published.
        </div>

        {campaigns.length === 0 ? (
          <div style={{ color: '#999', fontSize: 12, fontStyle: 'italic' }}>No campaigns found.</div>
        ) : (
          <>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 24px 1fr',
              gap: 8,
              marginBottom: 4,
              fontSize: 10,
              fontWeight: 600,
              color: '#888',
              textTransform: 'uppercase',
              letterSpacing: '.4px',
            }}>
              <div>Campaign</div>
              <div />
              <div>Location</div>
            </div>
            {campaigns.map(c => (
              <CampaignRow
                key={c.campaign_id}
                campaign={c}
                locationId={mappings[c.campaign_id] ?? null}
                locations={locations}
                onChange={onSetMapping}
              />
            ))}
            <button
              onClick={onSave}
              disabled={saving}
              style={{
                marginTop: 8,
                padding: '5px 16px',
                fontSize: 12,
                background: '#1976d2',
                color: '#fff',
                border: '1px solid #1976d2',
                borderRadius: 3,
                cursor: saving ? 'not-allowed' : 'pointer',
                opacity: saving ? .7 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save Mappings'}
            </button>
          </>
        )}

        {/* Backfill */}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #eee' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Ad Spend Backfill</div>
          <div style={{ color: '#666', fontSize: 12, marginBottom: 12 }}>
            Import historical spend data. Publishes <code>ad_spend.synced</code> events to Analytics Service.
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 3 }}>From</div>
              <input
                type="date"
                value={backfillFrom}
                onChange={e => setBackfillFrom(e.target.value)}
                style={{ padding: '5px 6px', border: '1px solid #ddd', borderRadius: 3, fontSize: 12 }}
              />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 3 }}>To</div>
              <input
                type="date"
                value={backfillTo}
                onChange={e => setBackfillTo(e.target.value)}
                style={{ padding: '5px 6px', border: '1px solid #ddd', borderRadius: 3, fontSize: 12 }}
              />
            </div>
            <button
              onClick={() => void handleTrigger()}
              disabled={triggering || !backfillFrom || !backfillTo}
              style={{
                padding: '5px 14px',
                fontSize: 12,
                background: '#fff',
                border: '1px solid #ddd',
                borderRadius: 3,
                cursor: triggering ? 'not-allowed' : 'pointer',
                opacity: triggering ? .7 : 1,
              }}
            >
              {triggering ? 'Starting…' : 'Run Backfill'}
            </button>
          </div>

          {backfillError && (
            <div style={{ color: '#c62828', fontSize: 12, marginTop: 6 }}>{backfillError}</div>
          )}

          {latestJob && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{ color: '#666' }}>Last job:</span>
              <StatusBadge status={latestJob.status} />
              <span style={{ color: '#888' }}>
                {latestJob.from_date} – {latestJob.to_date} · {latestJob.progress.chunks_done}/{latestJob.progress.chunks_total} chunks
              </span>
            </div>
          )}
          {latestJob && (
            <div style={{ color: '#aaa', fontSize: 11, marginTop: 3 }}>Refresh page to update status.</div>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/integration-hub-ui/src/components/StatusBadge.tsx \
        packages/@platform/integration-hub-ui/src/components/CampaignRow.tsx \
        packages/@platform/integration-hub-ui/src/components/AccountSidebar.tsx \
        packages/@platform/integration-hub-ui/src/components/AccountDetail.tsx
git commit -m "feat(@platform/integration-hub-ui): add internal components"
```

---

## Task 8: OAuthCallbackHandler (TDD)

**Files:**
- Create: `packages/@platform/integration-hub-ui/test/components/OAuthCallbackHandler.test.tsx`
- Create: `packages/@platform/integration-hub-ui/src/components/OAuthCallbackHandler.tsx`

- [ ] **Step 1: Write the failing tests**

Create `test/components/OAuthCallbackHandler.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { OAuthCallbackHandler } from '../../src/components/OAuthCallbackHandler.js'

function setSearch(params: Record<string, string>) {
  const search = new URLSearchParams(params).toString()
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...window.location, search: `?${search}` },
  })
}

describe('OAuthCallbackHandler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows success message for google_ads', () => {
    setSearch({ platform: 'google_ads', status: 'success' })
    render(<OAuthCallbackHandler onSuccess={vi.fn()} onError={vi.fn()} />)
    expect(screen.getByText(/Google Ads connected/i)).toBeTruthy()
    expect(screen.getByText(/redirecting/i)).toBeTruthy()
  })

  it('shows success message for facebook_ads as Meta', () => {
    setSearch({ platform: 'facebook_ads', status: 'success' })
    render(<OAuthCallbackHandler onSuccess={vi.fn()} onError={vi.fn()} />)
    expect(screen.getByText(/Meta connected/i)).toBeTruthy()
  })

  it('calls onSuccess after 1.5s delay', async () => {
    setSearch({ platform: 'google_ads', status: 'success' })
    const onSuccess = vi.fn()
    render(<OAuthCallbackHandler onSuccess={onSuccess} onError={vi.fn()} />)
    expect(onSuccess).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(onSuccess).toHaveBeenCalledOnce()
  })

  it('shows error message and calls onError after 1.5s', async () => {
    setSearch({ platform: 'google_ads', status: 'error', message: 'Access denied' })
    const onError = vi.fn()
    render(<OAuthCallbackHandler onSuccess={vi.fn()} onError={onError} />)
    expect(screen.getByText(/Connection failed/i)).toBeTruthy()
    expect(screen.getByText(/Access denied/i)).toBeTruthy()
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(onError).toHaveBeenCalledWith('Access denied')
  })

  it('calls onError with default message when message param is absent', async () => {
    setSearch({ platform: 'google_ads', status: 'error' })
    const onError = vi.fn()
    render(<OAuthCallbackHandler onSuccess={vi.fn()} onError={onError} />)
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(onError).toHaveBeenCalledWith('Connection failed')
  })
})
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
npm test
```
Expected: `Cannot find module '../../src/components/OAuthCallbackHandler.js'`

- [ ] **Step 3: Implement `src/components/OAuthCallbackHandler.tsx`**

```tsx
import React, { useEffect, useState } from 'react'

export interface OAuthCallbackHandlerProps {
  onSuccess: () => void
  onError: (message: string) => void
}

export function OAuthCallbackHandler({ onSuccess, onError }: OAuthCallbackHandlerProps) {
  const [state, setState] = useState<{ ok: boolean; platformLabel: string; message: string } | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const platform = params.get('platform') ?? ''
    const status = params.get('status')
    const message = params.get('message') ?? 'Connection failed'
    const ok = status === 'success'
    const platformLabel = platform === 'facebook_ads' ? 'Meta' : 'Google Ads'

    setState({ ok, platformLabel, message })

    const timer = setTimeout(() => {
      if (ok) onSuccess()
      else onError(message)
    }, 1500)

    return () => clearTimeout(timer)
  }, [onSuccess, onError])

  if (!state) return null

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div style={{
        padding: '24px 32px',
        border: `1px solid ${state.ok ? '#c8e6c9' : '#ffcdd2'}`,
        borderRadius: 8,
        background: state.ok ? '#f9fff9' : '#fff9f9',
        textAlign: 'center',
        maxWidth: 360,
      }}>
        <div style={{
          fontWeight: 600,
          color: state.ok ? '#2e7d32' : '#c62828',
          marginBottom: 8,
          fontSize: 15,
        }}>
          {state.ok ? `✓ ${state.platformLabel} connected` : 'Connection failed'}
        </div>
        <div style={{ color: '#666', fontSize: 13 }}>
          {state.ok
            ? 'Redirecting to integrations…'
            : `${state.message} — redirecting…`}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
npm test
```
Expected: all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/integration-hub-ui/src/components/OAuthCallbackHandler.tsx \
        packages/@platform/integration-hub-ui/test/components/OAuthCallbackHandler.test.tsx
git commit -m "feat(@platform/integration-hub-ui): add OAuthCallbackHandler"
```

---

## Task 9: IntegrationHub + integration test (TDD)

**Files:**
- Create: `packages/@platform/integration-hub-ui/test/components/IntegrationHub.test.tsx`
- Create: `packages/@platform/integration-hub-ui/src/components/IntegrationHub.tsx`

- [ ] **Step 1: Write the failing tests**

Create `test/components/IntegrationHub.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { IntegrationHub } from '../../src/components/IntegrationHub.js'
import type { IntegrationHubApiClient } from '../../src/api/IntegrationHubApiClient.js'

const LOCATIONS = [
  { id: 'loc-1', name: 'North Seattle' },
  { id: 'loc-2', name: 'Bellevue' },
]

const ACCOUNT_GOOGLE = {
  id: 'acc-1',
  platform: 'google_ads' as const,
  account_id: 'g-123',
  account_name: 'My Google Ads',
  status: 'active' as const,
  last_error: null,
  last_polled_at: null,
}

const CAMPAIGNS = [
  { campaign_id: 'c1', campaign_name: 'Spring Promo', location_id: null },
  { campaign_id: 'c2', campaign_name: 'Summer Sale', location_id: 'loc-1' },
]

function makeClient(overrides: Partial<InstanceType<typeof IntegrationHubApiClient>> = {}) {
  return {
    listAccounts: vi.fn().mockResolvedValue([ACCOUNT_GOOGLE]),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
    getConnectUrl: vi.fn().mockReturnValue('http://localhost:3000/integrations/connect/facebook_ads?redirect_uri=%2Fcb'),
    getCampaigns: vi.fn().mockResolvedValue(CAMPAIGNS),
    saveMappings: vi.fn().mockResolvedValue(undefined),
    triggerBackfill: vi.fn().mockResolvedValue({ job_id: 'job-1' }),
    getBackfillStatus: vi.fn().mockResolvedValue({
      job_id: 'job-1',
      status: 'active',
      from_date: '2026-01-01',
      to_date: '2026-03-31',
      progress: { chunks_done: 0, chunks_total: 13 },
    }),
    ...overrides,
  } as unknown as InstanceType<typeof IntegrationHubApiClient>
}

describe('IntegrationHub', () => {
  it('renders loading state then shows accounts', async () => {
    const client = makeClient()
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText('Google Ads')).toBeTruthy())
  })

  it('auto-selects first account and loads its campaigns', async () => {
    const client = makeClient()
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText('Spring Promo')).toBeTruthy())
    expect(screen.getByText('Summer Sale')).toBeTruthy()
  })

  it('shows Connect Meta button for unconnected platform', async () => {
    const client = makeClient()
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText(/Connect Meta/i)).toBeTruthy())
  })

  it('does not show Connect Google Ads button when already connected', async () => {
    const client = makeClient()
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText('Google Ads')).toBeTruthy())
    expect(screen.queryByText(/Connect Google Ads/i)).toBeNull()
  })

  it('saves mappings when Save Mappings is clicked', async () => {
    const saveMappings = vi.fn().mockResolvedValue(undefined)
    const client = makeClient({ saveMappings })
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText('Spring Promo')).toBeTruthy())

    fireEvent.click(screen.getByText('Save Mappings'))
    await waitFor(() => expect(saveMappings).toHaveBeenCalledWith('acc-1', [
      { campaign_id: 'c2', location_id: 'loc-1' },
    ]))
  })

  it('shows empty state when no accounts connected', async () => {
    const client = makeClient({ listAccounts: vi.fn().mockResolvedValue([]) })
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText(/Connect your first/i)).toBeTruthy())
  })

  it('disconnects account and reloads', async () => {
    const deleteAccount = vi.fn().mockResolvedValue(undefined)
    const listAccounts = vi.fn()
      .mockResolvedValueOnce([ACCOUNT_GOOGLE])
      .mockResolvedValueOnce([])
    const client = makeClient({ deleteAccount, listAccounts, getCampaigns: vi.fn().mockResolvedValue(CAMPAIGNS) })
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())

    fireEvent.click(screen.getByText('Disconnect'))
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith('acc-1'))
    await waitFor(() => expect(screen.getByText(/Connect your first/i)).toBeTruthy())
  })
})
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
npm test
```
Expected: `Cannot find module '../../src/components/IntegrationHub.js'`

- [ ] **Step 3: Implement `src/components/IntegrationHub.tsx`**

```tsx
import React from 'react'
import type { IntegrationHubApiClient } from '../api/IntegrationHubApiClient.js'
import type { Location } from '../types.js'
import { useIntegrationAccounts } from '../hooks/useIntegrationAccounts.js'
import { useCampaignMapper } from '../hooks/useCampaignMapper.js'
import { useBackfillStatus } from '../hooks/useBackfillStatus.js'
import { AccountSidebar } from './AccountSidebar.js'
import { AccountDetail } from './AccountDetail.js'

export interface IntegrationHubProps {
  client: IntegrationHubApiClient
  locations: Location[]
  connectReturnUrl: string
}

export function IntegrationHub({ client, locations, connectReturnUrl }: IntegrationHubProps) {
  const { accounts, selectedId, loading, error, selectAccount, disconnect } =
    useIntegrationAccounts(client)

  const selectedAccount = accounts.find(a => a.id === selectedId) ?? null

  const { campaigns, mappings, saving, setMapping, save } =
    useCampaignMapper(client, selectedId)

  const { latestJob, triggering, triggerBackfill } =
    useBackfillStatus(client, selectedId)

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200, color: '#888', fontSize: 13 }}>
        Loading…
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 16, color: '#c62828', fontSize: 13 }}>
        Failed to load integrations: {error}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', minHeight: 400, border: '1px solid #eee', borderRadius: 4, overflow: 'hidden' }}>
      <AccountSidebar
        accounts={accounts}
        selectedId={selectedId}
        client={client}
        connectReturnUrl={connectReturnUrl}
        onSelect={selectAccount}
      />

      <div style={{ flex: 1, display: 'flex', alignItems: 'stretch' }}>
        {!selectedAccount ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 13, padding: 24, textAlign: 'center' }}>
            Connect your first ad account to get started.
          </div>
        ) : (
          <AccountDetail
            account={selectedAccount}
            campaigns={campaigns}
            mappings={mappings}
            locations={locations}
            saving={saving}
            latestJob={latestJob}
            triggering={triggering}
            onSetMapping={setMapping}
            onSave={() => void save()}
            onDisconnect={id => void disconnect(id)}
            onTriggerBackfill={triggerBackfill}
          />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
npm test
```
Expected: all 7 tests pass, total suite ≥ 28 passing

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/integration-hub-ui/src/components/IntegrationHub.tsx \
        packages/@platform/integration-hub-ui/test/components/IntegrationHub.test.tsx
git commit -m "feat(@platform/integration-hub-ui): add IntegrationHub component"
```

---

## Task 10: styles.css + index.ts + NAVIGATOR.md

**Files:**
- Create: `packages/@platform/integration-hub-ui/src/styles.css`
- Create: `packages/@platform/integration-hub-ui/src/index.ts`
- Modify: `docs/NAVIGATOR.md`

- [ ] **Step 1: Create `src/styles.css`**

```css
/* @platform/integration-hub-ui — interactive states only */

.ih-account-item {
  transition: background 0.1s ease;
}

.ih-account-item:hover {
  background: #f5f5f5;
}

.ih-account-item.selected {
  background: #e3f2fd;
  border-left-color: #1976d2 !important;
}

.ih-connect-btn {
  transition: background 0.1s ease, color 0.1s ease;
}

.ih-connect-btn:hover {
  background: #e3f2fd;
  border-color: #1976d2;
}

.ih-detail-panel {
  transition: opacity 0.12s ease;
}

.ih-select:focus {
  outline: 2px solid #1976d2;
  outline-offset: 1px;
  border-color: #1976d2;
}
```

- [ ] **Step 2: Create `src/index.ts`**

```typescript
export { IntegrationHub } from './components/IntegrationHub.js'
export type { IntegrationHubProps } from './components/IntegrationHub.js'
export { OAuthCallbackHandler } from './components/OAuthCallbackHandler.js'
export type { OAuthCallbackHandlerProps } from './components/OAuthCallbackHandler.js'
export { IntegrationHubApiClient } from './api/IntegrationHubApiClient.js'
export type { IntegrationAccount, CampaignSummary, BackfillJob, Location } from './types.js'
```

- [ ] **Step 3: Run typecheck and tests**

```bash
npm run typecheck && npm test
```
Expected: no type errors, all tests pass

- [ ] **Step 4: Update `docs/NAVIGATOR.md`**

In the Platform Layer table under Component Design Specs, add after the integration-hub-updated-design.md row:

```markdown
| [integration-hub-ui-design.md](superpowers/specs/2026-04-20-integration-hub-ui-design.md) | [memories/integration-hub.md](memories/integration-hub.md) |
```

Also add to the Implementation Plans table:

```markdown
| [2026-04-20-integration-hub-ui.md](superpowers/plans/2026-04-20-integration-hub-ui.md) | @platform/integration-hub-ui — settings page, OAuth callback, campaign mapper, backfill controls |
```

- [ ] **Step 5: Commit**

```bash
git add packages/@platform/integration-hub-ui/src/styles.css \
        packages/@platform/integration-hub-ui/src/index.ts \
        docs/NAVIGATOR.md
git commit -m "feat(@platform/integration-hub-ui): wire exports, styles, and update docs"
```
