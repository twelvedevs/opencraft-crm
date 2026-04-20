# @platform/integration-hub-ui — Design Spec

**Date:** 2026-04-20
**Status:** Approved
**Package:** `packages/@platform/integration-hub-ui`
**Backend spec:** `docs/superpowers/specs/2026-04-02-integration-hub-updated-design.md`

---

## 1. Overview

`@platform/integration-hub-ui` is a React component package that provides a settings page for managing advertising platform integrations (Google Ads, Meta). It is consumed by the CRM Web App (`apps/crm/web`) and follows the same platform package conventions as `@platform/audience-ui` and `@platform/sequence-ui`.

**Responsibilities:**
- Display and manage connected ad accounts (list, status, disconnect)
- Initiate OAuth connect flows for Google Ads and Meta
- Handle the post-OAuth callback route
- Map campaigns to Ortho office locations
- Trigger and display status of historical ad spend backfills

**Out of scope:**
- Routing logic — the CRM web app owns route definitions
- Location data fetching — locations are passed as a prop
- Real-time backfill progress polling — status is loaded once on account select

---

## 2. Public API

### Exports

```typescript
// Components
export { IntegrationHub } from './components/IntegrationHub'
export { OAuthCallbackHandler } from './components/OAuthCallbackHandler'

// API client
export { IntegrationHubApiClient } from './api/IntegrationHubApiClient'

// Types
export type { IntegrationAccount, CampaignSummary, BackfillJob, Location } from './types'
```

### Component Props

```typescript
interface IntegrationHubProps {
  client: IntegrationHubApiClient
  locations: Location[]       // { id: string; name: string }[] — provided by CRM web app
  connectReturnUrl: string    // SPA callback URL, e.g. "/settings/integrations/callback"
                              // passed to backend as redirect_uri
}

interface OAuthCallbackHandlerProps {
  onSuccess: () => void             // called after brief feedback delay; redirect to settings page
  onError: (message: string) => void
}
```

### Types

```typescript
interface Location {
  id: string
  name: string
}

interface IntegrationAccount {
  id: string
  platform: 'google_ads' | 'facebook_ads'
  account_id: string
  account_name: string | null
  status: 'active' | 'paused' | 'error'
  last_error: string | null
  last_polled_at: string | null   // ISO timestamp
}

interface CampaignSummary {
  campaign_id: string
  campaign_name: string
  location_id: string | null       // null if unmapped
}

interface BackfillJob {
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

---

## 3. Architecture

### Pattern

Hook-driven, consistent with `@platform/sequence-ui`:
- **Hooks** own all state and async logic — one hook per state domain
- **Components** are thin renderers — JSX + event handlers only, no data fetching
- **`IntegrationHub`** calls all hooks, passes state + handlers down as props
- **`IntegrationHubApiClient`** is constructed once by the consumer and injected as a prop (enables testing without mocking module imports)

### Component Tree

```
IntegrationHub (exported)
├── AccountSidebar (internal)
│   ├── AccountListItem (internal) × N accounts
│   └── ConnectButton (internal) × unconnected platforms
└── AccountDetail (internal)
    ├── CampaignRow (internal) × N campaigns
    ├── StatusBadge (internal)
    └── BackfillControls (internal)

OAuthCallbackHandler (exported — separate SPA route)
```

### Hook Layer

| Hook | State | Triggers |
|------|-------|----------|
| `useIntegrationAccounts(client)` | `accounts`, `selectedId`, `loading`, `error` | mount, after disconnect |
| `useCampaignMapper(client, accountId)` | `campaigns`, `mappings`, `saving`, `error` | `accountId` change |
| `useBackfillStatus(client, accountId)` | `latestJob`, `triggering` | `accountId` change, after trigger |

---

## 4. API Client

`IntegrationHubApiClient` wraps all Integration Hub backend endpoints. The consumer constructs one instance and passes it to all components.

```typescript
class IntegrationHubApiClient {
  constructor(baseUrl: string, token?: string)

  // Accounts
  listAccounts(): Promise<IntegrationAccount[]>
  deleteAccount(id: string): Promise<void>

  // OAuth — pure helper, no fetch
  getConnectUrl(platform: 'google_ads' | 'facebook_ads', redirectUri: string): string

  // Campaign mapping
  getCampaigns(accountId: string): Promise<CampaignSummary[]>
  saveMappings(
    accountId: string,
    mappings: { campaign_id: string; location_id: string }[]  // unmapped campaigns omitted — backend replaces all mappings
  ): Promise<void>

  // Backfill
  triggerBackfill(accountId: string, from: string, to: string): Promise<{ job_id: string }>
  getBackfillStatus(accountId: string, jobId: string): Promise<BackfillJob>
}
```

All `fetch` calls include `Authorization: Bearer ${token}` and `Content-Type: application/json`. Errors throw with the HTTP status code available on the error object.

---

## 5. Page Layout

`IntegrationHub` renders a two-panel layout:

### Empty State (no accounts)

When `accounts` is empty, the detail panel shows a prompt ("Connect your first ad account to get started") and the sidebar shows only the Add Integration section.

### Sidebar (left, fixed width)

- **Connected Accounts** section: one `AccountListItem` per account. Clicking selects it (highlights with left border accent). Each item shows: platform name, status badge, last polled time. Accounts with `status: 'error'` are selectable — the user can still view/edit mappings and reconnect.
- **Add Integration** section: one `ConnectButton` per platform not yet connected. Clicking calls `window.location.href = client.getConnectUrl(platform, connectReturnUrl)` — full navigation to the backend OAuth initiation URL.

### Detail Panel (right, flex)

Shown when an account is selected. Three sub-sections:

**Account header:** Platform name, status badge, account ID, last polled timestamp, Disconnect button. Disconnect triggers `client.deleteAccount(id)` then reloads the account list; no confirmation dialog.

**Campaign → Location Mapping:**
- Column headers: Campaign | → | Location
- One `CampaignRow` per campaign: campaign name (read-only) + location `<select>` (options from `locations` prop + "— unassigned —" option)
- `useCampaignMapper` tracks the current mapping state locally; the consumer calls `saveMappings` on Save
- Save button disabled while saving

**Ad Spend Backfill:**
- From / To date inputs (YYYY-MM-DD)
- Run Backfill button — calls `triggerBackfill`, stores returned `job_id` in `useBackfillStatus`
- Status row: "Last job: [status badge] [date range] · [chunks_done]/[chunks_total] chunks"
- "Refresh page to update status." note — no polling

---

## 6. OAuth Callback Handler

`OAuthCallbackHandler` is mounted at the `/settings/integrations/callback` SPA route. It:

1. Reads `window.location.search` — expects `?platform=&status=success|error&message=`
2. Shows a brief feedback screen:
   - Success: "✓ [Platform] connected — redirecting…"
   - Error: "Connection failed — [message] — redirecting…"
3. After 1.5 seconds calls `onSuccess()` or `onError(message)`

The backend Integration Hub's OAuth callback handler (`GET /integrations/oauth/:platform/callback`) redirects to this SPA route after storing tokens.

---

## 7. Styling

- **Inline styles** for all layout, spacing, typography, and color
- **`styles.css`** (`.ih-` namespace, ~40 lines) for states that inline styles cannot express:
  - `.ih-account-item:hover` — subtle background on hover
  - `.ih-account-item.selected` — blue left border + tinted background
  - `.ih-connect-btn:hover` — darken
  - `.ih-detail-panel` — smooth transition when switching selected account

Consumer imports once:
```ts
import '@platform/integration-hub-ui/dist/styles.css'
```

---

## 8. File Structure

```
packages/@platform/integration-hub-ui/
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── styles.css
│   ├── api/
│   │   └── IntegrationHubApiClient.ts
│   ├── hooks/
│   │   ├── useIntegrationAccounts.ts
│   │   ├── useCampaignMapper.ts
│   │   └── useBackfillStatus.ts
│   └── components/
│       ├── IntegrationHub.tsx
│       ├── OAuthCallbackHandler.tsx
│       ├── AccountSidebar.tsx
│       ├── AccountDetail.tsx
│       ├── CampaignRow.tsx
│       └── StatusBadge.tsx
├── test/
│   ├── unit/
│   │   ├── IntegrationHubApiClient.test.ts
│   │   ├── useIntegrationAccounts.test.ts
│   │   ├── useCampaignMapper.test.ts
│   │   └── useBackfillStatus.test.ts
│   └── components/
│       ├── IntegrationHub.test.tsx
│       └── OAuthCallbackHandler.test.tsx
├── package.json
└── tsconfig.json
```

---

## 9. Package Configuration

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
    "@testing-library/react": "^16.0.0",
    "@testing-library/user-event": "^14.0.0",
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

---

## 10. Test Scope

| File | Coverage |
|------|----------|
| `IntegrationHubApiClient.test.ts` | All methods: correct URLs, headers, error propagation |
| `useIntegrationAccounts.test.ts` | Initial load, account selection, disconnect + reload |
| `useCampaignMapper.test.ts` | Load on accountId change, local mapping updates, save |
| `useBackfillStatus.test.ts` | Load on accountId change, trigger + job_id storage |
| `IntegrationHub.test.tsx` | Renders account list, selects account, renders campaigns, saves mappings |
| `OAuthCallbackHandler.test.tsx` | Success params → onSuccess after delay; error params → onError |

---

## 11. CRM Web App Integration

Typical usage in `apps/crm/web`:

```tsx
// Route: /settings/integrations
const ihClient = new IntegrationHubApiClient(
  import.meta.env.VITE_INTEGRATION_HUB_URL,
  authToken
)

<IntegrationHub
  client={ihClient}
  locations={locations}   // fetched from Lead Service / CRM API Gateway
  connectReturnUrl="/settings/integrations/callback"
/>

// Route: /settings/integrations/callback
<OAuthCallbackHandler
  onSuccess={() => navigate('/settings/integrations')}
  onError={(msg) => { setError(msg); navigate('/settings/integrations') }}
/>
```
