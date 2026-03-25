# CRM Web App Design

**Date:** 2026-03-25
**Status:** Draft
**Scope:** `apps/crm/web` — React SPA shell, feature modules, state management, routing, platform UI embedding, real-time notifications

---

## 1. Overview

The CRM Web App is a single-page application at `apps/crm/web`. It is the sole frontend for all four staff roles (Call Center Agent, Call Center Manager, Marketing Staff, Marketing Manager). It hosts coordinator workflows (lead queue, SMS inbox), marketing workflows (campaigns, sequences, automation, analytics), and embeds four platform UI packages as full-page route sections.

**Key decisions:**
- Feature-module architecture — each sidebar section is a lazy-loaded module with its own routes, pages, components, and hooks
- Fixed left sidebar + top bar shell with role-adaptive navigation
- Global active location context — one location selected at a time, filters all views; marketing roles have "All Locations" option
- Inbox as a top-level nav item alongside Leads
- Platform UI packages (`@platform/sequence-ui`, `@platform/automation-ui`, `@platform/audience-ui`, `@platform/template-ui`) mount at full-page routes — no proxying through CRM API Gateway
- React Query for all server state; three React Contexts for global client state (Auth, Location, Notification)
- SSE connection for real-time notifications managed at `AppShell` level

---

## 2. Technology

| Concern | Choice |
|---|---|
| Framework | React 18 + TypeScript |
| Routing | React Router v6 |
| Styling | Tailwind CSS |
| Server state | React Query (TanStack Query v5) |
| Global client state | React Context (3 contexts — Auth, Location, Notification) |
| Build | Vite |
| Testing | Vitest + React Testing Library + MSW + Playwright |
| Monorepo | Turborepo (shared `@ortho/types`, `@ortho/testing`) |

---

## 3. Application Structure

```
apps/crm/web/
├── src/
│   ├── main.tsx                    # entry point
│   ├── App.tsx                     # router root, RequireAuth wrapper
│   ├── shell/
│   │   ├── AppShell.tsx            # sidebar + top bar layout
│   │   ├── Sidebar.tsx             # role-adaptive nav items
│   │   ├── TopBar.tsx              # location switcher, notification bell, user menu
│   │   ├── AuthContext.tsx         # user, role, permissions, logout
│   │   ├── LocationContext.tsx     # activeLocationId, locationList, setActiveLocation
│   │   └── NotificationProvider.tsx # SSE connection, unreadCount, toasts
│   ├── modules/
│   │   ├── leads/
│   │   ├── inbox/
│   │   ├── analytics/
│   │   ├── campaigns/
│   │   ├── sequences/              # mounts @platform/sequence-ui
│   │   ├── automation/             # mounts @platform/automation-ui
│   │   ├── audience/               # mounts @platform/audience-ui
│   │   ├── templates/              # mounts @platform/template-ui
│   │   ├── referrals/
│   │   ├── reports/
│   │   ├── import/
│   │   └── settings/
│   ├── lib/
│   │   ├── api/                    # typed API clients per service
│   │   ├── permissions.ts          # ROLE_PERMISSIONS map (mirrors auth-middleware)
│   │   ├── hooks/                  # usePermission, useLocation, useAuth
│   │   └── components/             # shared UI (RequirePermission, RequireLocation, skeletons)
│   └── pages/
│       ├── LoginPage.tsx
│       ├── ForbiddenPage.tsx
│       └── NotFoundPage.tsx
├── public/
├── index.html
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── package.json
```

### 3.1 Per-module layout

Each `src/modules/<name>/` follows:

```
<module>/
├── index.tsx          # lazy-loaded entry — exports route definitions
├── pages/             # full-page components (one per route)
├── components/        # module-local UI components
├── hooks/             # React Query hooks for this module's data
└── types.ts           # module-local types (supplementing @ortho/types)
```

---

## 4. Routing

React Router v6 with `createBrowserRouter`. All module routes are lazy-loaded via `React.lazy` + dynamic `import()`. Code splits at module boundaries.

### 4.1 Route tree

```
/login                          → LoginPage (public)
/                               → RequireAuth
  /                             → AppShell
    /                           → redirect (role-based: /leads or /analytics)
    /leads                      → LeadsModule (lazy)
      /leads/:id                → Lead detail
      /leads/:id/edit           → Lead edit
    /inbox                      → InboxModule (lazy)
      /inbox/:conversationId    → Conversation thread
    /analytics                  → AnalyticsModule (lazy)
      /analytics/channels       → Channel performance (default)
      /analytics/funnel         → Funnel chart
      /analytics/locations      → Location comparison
      /analytics/coordinators   → Coordinator metrics
    /campaigns                  → CampaignsModule (lazy) [perm: view:campaigns]
      /campaigns/new            → Campaign builder
      /campaigns/:id            → Campaign detail
      /campaigns/:id/edit       → Campaign editor
    /sequences                  → SequencesModule (lazy) [perm: view:sequences]
      /sequences/:id/edit       → Sequence editor (mounts @platform/sequence-ui)
    /automation                 → AutomationModule (lazy) [perm: view:automation]
    /audience                   → AudienceModule (lazy) [perm: view:audience]
    /templates                  → TemplatesModule (lazy)
    /referrals                  → ReferralsModule (lazy)
    /reports                    → ReportsModule (lazy)
    /import                     → ImportModule (lazy) [perm: import:csv]
    /settings                   → SettingsModule (lazy) [perm: view:settings]
      /settings/users           [perm: manage:users]
      /settings/locations       [perm: manage:locations]
      /settings/audit-log       [perm: view:audit_log]
    /403                        → ForbiddenPage
    /404                        → NotFoundPage
```

### 4.2 Role-based default redirect

```
call_center_agent   → /leads
call_center_manager → /leads
marketing_staff     → /analytics
marketing_manager   → /leads
```

### 4.3 Route guard pattern

```tsx
<RequireAuth>               {/* redirect to /login if no valid JWT */}
  <AppShell>                {/* shell, contexts, SSE */}
    <RequirePermission perm="import:csv" redirect="/403">
      <ImportModule />
    </RequirePermission>
  </AppShell>
</RequireAuth>
```

`<RequirePermission>` renders `<Navigate to="/403" />` if the user lacks the permission. Component-level `<RequirePermission>` renders `null` or a disabled fallback — never redirects. These are UX gates; API enforcement is in the backend.

---

## 5. Shell Components

### 5.1 Sidebar

Fixed left sidebar (~220px). Navigation items derived from the user's role at render time — no API call, computed from `AuthContext.permissions`.

| Role | Visible nav items |
|---|---|
| call_center_agent | Leads, Inbox, My Performance |
| call_center_manager | Leads, Inbox, Analytics, CSV Import, Settings |
| marketing_staff | Analytics, Campaigns, Sequences, Audience, Referrals, Settings |
| marketing_manager | Leads, Inbox, Analytics, Campaigns, Sequences, Automation, Audience, Templates, Referrals, Reports, CSV Import, Settings |

Active route is highlighted. Sidebar is always visible on desktop; collapses to icon-only on narrow viewports.

### 5.2 Top Bar

Fixed top bar. Contains (left to right):
- App logo / name
- Location switcher dropdown — shows `activeLocationId` label; options are `locationList` from `LocationContext` plus "All Locations" for marketing roles; coordinators see a non-interactive location label (no switcher)
- Notification bell — badge with `unreadCount` (capped at `99+`); click opens notification panel
- User avatar + dropdown — name, role label, "Change Password", "Sign Out"

When `activeLocationId` changes, `LocationContext` updates and React Query invalidates all queries that include `location_id` in their key.

### 5.3 `must_change_password` gate

If `AuthContext.user.must_change_password === true`, `AppShell` renders only the `/settings/password` route. All other routes render `<Navigate to="/settings/password" />`. This matches the Identity Service's `403 password_change_required` behavior.

---

## 6. State Management

### 6.1 AuthContext

```ts
interface AuthContextValue {
  user: {
    id: string
    name: string
    email: string
    role: Role
    locations: string[]          // location IDs from JWT; [] = all locations
    must_change_password: boolean
  }
  permissions: Set<string>       // derived from ROLE_PERMISSIONS[role] at login
  isAuthenticated: boolean
  logout: () => void
}
```

Populated on app load by verifying the stored JWT (or refreshing it). `permissions` is computed once from `ROLE_PERMISSIONS[role]` — no per-render API call.

### 6.2 LocationContext

```ts
interface LocationContextValue {
  activeLocationId: string | null  // null = "All Locations"
  locationList: Location[]
  setActiveLocation: (id: string | null) => void
  isAllLocations: boolean          // true when activeLocationId is null
}
```

`locationList` is fetched once after auth (from CRM API Gateway `/locations`). `activeLocationId` defaults to `user.locations[0]` for single-location roles, or `null` for marketing roles (all locations).

### 6.3 NotificationContext

```ts
interface NotificationContextValue {
  unreadCount: number
  notifications: Notification[]   // most recent 50
  markRead: (id: string) => void
  markAllRead: () => void
}
```

Fed by the SSE stream (see Section 7). Does not use React Query — push-only updates from SSE events.

### 6.4 Server state (React Query)

All data fetched from APIs is managed by React Query. Each module owns its query key namespace:

```ts
// Query key conventions
['leads', locationId, filters]
['leads', leadId]
['inbox', locationId, filters]
['inbox', conversationId]
['analytics', 'channels', locationId, period]
['campaigns', locationId]
// etc.
```

`activeLocationId` is included in all location-scoped query keys so that switching location triggers automatic re-fetches.

**Optimistic updates** used for high-frequency actions:
- Moving a lead's pipeline stage
- Marking a notification as read
- Sending a message (appears with `status: 'sending'` until confirmed)

---

## 7. Real-time Notifications (SSE)

`NotificationProvider` (child of `AppShell`) manages one `EventSource` connection per session.

**Connection:**
```
GET /notifications/stream?channels=user:{userId},location:{locationId}:*
Authorization: Bearer <JWT>
Last-Event-ID: <lastSeq>          // on reconnect, for replay
```

When `activeLocationId` changes, the provider closes and re-opens the stream with updated channel params.

**Reconnect:** exponential back-off (1s → 2s → 4s → max 30s). After 3 failed attempts, a subtle "Real-time updates paused — reconnecting…" banner appears in the top bar.

**SSE event handling:**

| event type | client action |
|---|---|
| `notification` | Prepend to `notifications[]`, increment `unreadCount`, show toast |
| `read` | Mark notification read in local state |
| `read-all` | Set `unreadCount = 0`, mark all read |

**Toast behavior:** Appears bottom-right, auto-dismisses after 4s. If `notification.type === 'inbound_message'`, toast includes a "Reply" button that navigates to `/inbox/:conversationId`.

---

## 8. API Client Layer

One typed client per backend service at `src/lib/api/`. All clients share a `apiFetch` wrapper that:
- Injects `Authorization: Bearer <JWT>` header
- Injects `location_id` as default query param (from `LocationContext.activeLocationId`) when present
- Handles 401 → calls `AuthContext.logout()`
- Throws typed `ApiError` on non-2xx responses

```
src/lib/api/
  crm-gateway.ts     # leads, pipeline, conversations, campaigns, referrals, import, reporting
  identity.ts        # current user, password change, API keys
  # Platform services (called directly — not proxied through CRM API Gateway):
  notification.ts    # SSE URL builder + POST /notifications/:id/read
  template.ts        # POST /templates/render
  sequence.ts        # sequences CRUD (passed as prop to @platform/sequence-ui)
  audience.ts        # segments, evaluate (passed as prop to @platform/audience-ui)
  automation.ts      # rules CRUD (passed as prop to @platform/automation-ui)
```

Platform UI packages receive their API client as a prop at mount — they never import from `src/lib/api` directly, keeping them platform-agnostic.

---

## 9. Permission System

### 9.1 Client-side permission map

```ts
// src/lib/permissions.ts — mirrors ROLE_PERMISSIONS in @ortho/auth-middleware
export const ROLE_PERMISSIONS: Record<Role, Set<string>> = {
  call_center_agent:   new Set(['view:leads', 'edit:leads', 'send:sms',
                                 'view:inbox', 'view:analytics:own']),
  call_center_manager: new Set(['view:leads', 'edit:leads', 'send:sms', 'send:bulk_sms',
                                 'view:inbox', 'view:analytics', 'import:csv',
                                 'manage:referrals', 'view:settings']),
  marketing_staff:     new Set(['view:leads:readonly', 'view:analytics',
                                 'create:campaigns', 'publish:campaigns:draft',
                                 'view:sequences', 'create:sequences',
                                 'view:audience', 'build:audience',
                                 'manage:referrals', 'view:reports', 'view:settings']),
  marketing_manager:   new Set(['*']),
  super_admin:         new Set(['*']),
}
```

### 9.2 Gate components

```tsx
// Route gate — redirects to /403
<RequirePermission perm="import:csv" redirect="/403">
  <ImportModule />
</RequirePermission>

// UI gate — renders null or fallback
<RequirePermission perm="publish:campaigns">
  <PublishButton />
</RequirePermission>

// Location gate — guards actions on entities from other locations
<RequireLocation locationId={lead.location_id}>
  <EditLeadButton />
</RequireLocation>

// Hook — for conditional logic
const canPublish = usePermission('publish:campaigns')
```

---

## 10. Core Module Designs

### 10.1 Leads module

Two-panel layout within the main content area (queue list left ~280px, detail right).

**Lead queue (left panel):**
- Sorted by priority score descending, then time-in-stage descending
- Left-border color encodes priority: red (high), amber (medium), none (low)
- Stage filter chips above list (All, New Lead, Contacted, Exam Scheduled, …)
- Search input (debounced, calls `GET /leads?q=`)
- Clicking a lead pushes `/leads/:id` and opens the detail panel

**Lead detail (right panel):**
- Header: name, contact info, location, stage badge, "Move Stage" button
- Tabs: Overview, Activity, Messages, Notes
- Overview: attribution fields, pipeline state (time in stage colored amber/red when near limit), priority score
- Activity: timeline of all events (stage changes, messages sent/received, notes, calls logged)
- Messages: conversation thread (read-only here; reply from Inbox)
- Notes: coordinator notes with timestamps
- Quick Actions bar (always visible, no scroll required): Send SMS, Log Call, Book Exam, Add Note, Mark Lost

### 10.2 Inbox module

Two-panel layout (conversation list left ~260px, thread right).

**Conversation list (left panel):**
- Sorted by last message time descending
- Unread conversations: bold name, accent left border, unread dot
- Filter tabs: All, Unread, Mine (assigned to current user)
- Clicking a conversation pushes `/inbox/:conversationId`

**Thread view (right panel):**
- Header: lead name, stage, location; "View Lead →" deep-link; Assign, Escalate buttons
- Message bubbles: outbound right-aligned (indigo), inbound left-aligned (neutral)
- STOP/UNSTOP messages displayed as system events inline in thread
- AI draft strip (above composer): 1 suggested reply; clicking populates composer
- Composer: text input + Send button; schedule send via "⏰" icon

### 10.3 Analytics module

Sub-navigation tabs within the section: Channel Performance (default), Funnel, Locations, Coordinators, Reports.

**Channel Performance tab:**
- KPI cards row: Cost per Case Start (hero), ROAS, Leads, Case Conversion Rate, Avg Response Time — each with period-over-period delta
- Channel table: rows per source (Google Ads, Facebook, Referral, Website, …), columns: Leads, Ad Spend, Cost/Lead, Exams, Cases, Cost/Case
- Network average column visible only to `marketing_staff+` roles; `null` for location-scoped roles

**Funnel tab:** Funnel visualization — leads → contacted → exam scheduled → exam completed → contract signed. Drop-off rates between stages.

**Locations tab:** Side-by-side location comparison table, sortable by any metric. Visible to `marketing_staff+` only.

**Coordinators tab:** Per-coordinator metrics — exams booked, avg response time, case conversion rate.

**Reports tab:** Saved report list, scheduled deliveries, run history.

All analytics data sourced from Reporting Service via `ANALYTICS_API_KEY` — no direct Analytics Service calls from the frontend.

### 10.4 Campaigns module

Campaign list with status badges (draft, pending_review, approved, scheduled, sending, completed). Campaign builder: audience picker (embeds `<AudiencePreview segmentId />` from `@platform/audience-ui`), template selector (calls Template Service for preview), A/B subject line config, schedule picker. Approval workflow: comment thread visible on campaign detail; approve/reject restricted to `marketing_manager`.

### 10.5 Platform UI modules (sequences, automation, audience, templates)

Each is a thin wrapper that mounts the platform package at full content-area height, passing:
- `apiClient` — the typed API client for that service
- `canPublish` — derived from `usePermission`
- `locationId` — from `LocationContext.activeLocationId`

The platform package owns its internal routing and state. The CRM shell is responsible only for mounting and unmounting it.

### 10.6 Import module

Ortho2 CSV upload workflow: drag-and-drop zone → column mapping preview (auto-detected column names) → validation report (match counts, no-matches, duplicates) → preview mode → confirm. Import history log with undo button (available within 2 hours of import). Restricted to `import:csv` permission.

### 10.7 Settings module

Gated to `marketing_manager` role (except password change, accessible to all). Sub-sections: Users (create/edit/deactivate staff accounts), Locations (phone numbers, coordinator assignments, AI agent settings), Audit Log (all system actions, timestamp, user).

---

## 11. Error Handling & Loading States

### 11.1 Loading

- **Skeleton screens** (not spinners) for lead queue, conversation list, analytics cards/table — built with Tailwind's `animate-pulse`
- **Suspense boundaries** at module entry points catch lazy-load delays: `<Suspense fallback={<ModuleSkeleton />}>`

### 11.2 Error boundaries

- One `ErrorBoundary` per module route — a module crash doesn't affect the shell or other modules
- Module error UI: "Something went wrong — try refreshing" with a Retry button
- Root `ErrorBoundary` catches shell crashes with a full-page error state

### 11.3 API errors

- **Mutations (React Query):** `onError` shows a toast notification — "Failed to [action] — please try again"
- **Queries:** Failed queries show inline error states within the component (not toasts) — "Couldn't load leads" + Retry
- **401:** Any API client 401 response calls `AuthContext.logout()` → redirects to `/login`
- **403:** Inline "You don't have permission to do this" message — no redirect (preserves context)
- **React Query retries:** 3× with exponential back-off before surfacing error state

### 11.4 Optimistic updates

Used for high-frequency coordinator actions:
- Moving a lead's stage — queue updates instantly; rolls back with error toast on failure
- Marking a notification as read
- Sending a message — appears in thread with `status: 'sending'` until server confirms

---

## 12. Testing Strategy

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest | `ROLE_PERMISSIONS` map, `usePermission` hook, priority score display logic, `apiFetch` wrapper |
| Component | React Testing Library | `<RequirePermission>`, `<LeadCard>`, `<QuickActions>`, `<NotificationBell>` — with mocked `AuthContext` |
| Integration | RTL + MSW | Full page renders with mocked API responses: LeadQueuePage loads and filters, move-stage mutation fires and optimistically updates, inbox reply sends |
| E2E | Playwright | Critical flows: login → view lead queue → move stage → send SMS; login → view inbox → reply; marketing manager → publish campaign |
| Platform UI | Per-package | `@platform/*` packages maintain their own test suites; CRM shell only tests correct prop passing and mount/unmount |

Shared test utilities from `@ortho/testing`: auth context factories for all 4 roles, location context factory, MSW handlers for all CRM Gateway endpoints, lead/conversation/campaign fixtures.

---

## 13. Key Constraints

- **No PHI.** No clinical data displayed. Lead records contain only marketing and contact data.
- **Multi-location native.** `activeLocationId` from `LocationContext` is injected into every API call. Location switching is zero-reload — React Query re-fetches with the new key.
- **Platform UI isolation.** `@platform/*` packages call their own service APIs directly from the browser using the same Identity Service JWT. They are never proxied through the CRM API Gateway. CORS is configured on each platform service for the CRM domain.
- **RBAC is backend-enforced.** Client-side permission gates are UX only. Every action is re-checked at the API level.
- **EHR-ready.** Lead data model and pipeline stage display are designed to cleanly accept EHR-originated events when EHR integration ships. No CSV-import-specific UI assumptions baked into lead detail.
