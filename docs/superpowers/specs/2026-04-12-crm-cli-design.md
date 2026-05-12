# CRM CLI — Design Spec

**Date:** 2026-04-12
**Status:** Approved
**Scope:** Developer CLI for debugging and testing CRM backend modules via the API Gateway

---

## 1. Overview

A TypeScript CLI tool (`crm`) that talks to the CRM API Gateway. Purpose: let the developer create test data, inspect state, trigger pipeline transitions, and read/send messages — all from the terminal — without needing the frontend running. Scoped to the lead + pipeline + conversations surface, which covers the primary debugging happy path.

Designed to be the first in a family of `tools/` scripts. Sibling scripts for individual platform services (messaging, template, etc.) will follow the same skeleton but point at different base URLs.

---

## 2. Location

```
tools/crm-cli/
├── src/
│   ├── index.ts              # entry point — registers all command groups
│   ├── config.ts             # read/write ~/.crm/config.json
│   ├── client.ts             # HTTP client wrapper (fetch + auth + error handling)
│   ├── output.ts             # pretty-print (tables, color) vs --json passthrough
│   ├── commands/
│   │   ├── login.ts          # crm login
│   │   ├── config.ts         # crm config show / set-url
│   │   ├── leads.ts          # crm leads {list,get,create,update}
│   │   ├── pipeline.ts       # crm pipeline {memberships,enroll,transition}
│   │   └── conversations.ts  # crm conversations {list,get,send,note}
│   └── prompts/
│       ├── lead-prompts.ts   # inquirer question definitions for leads
│       └── conv-prompts.ts   # inquirer question definitions for conversations
├── README.md                 # full usage guide with examples
├── package.json
└── tsconfig.json
```

---

## 3. Stack

| Dependency | Purpose |
|------------|---------|
| `commander` | Subcommand tree and flag parsing |
| `inquirer` | Interactive prompts (required field wizards, password input) |
| `chalk` | Terminal color for status labels and headers |
| `cli-table3` | ASCII tables for list commands |
| TypeScript + `tsc` | Compiled to `dist/`, invoked via `node dist/index.js` |

Installed locally in `tools/crm-cli/`. Linked globally via `npm link` from the directory so the `crm` binary is available on PATH.

---

## 4. Auth & Config

### 4.1 Persistent config

Stored at `~/.crm/config.json`:

```json
{
  "gateway_url": "http://localhost:3000",
  "gotrue_url": "http://localhost:9999",
  "identity_url": "http://localhost:3100",
  "access_token": "eyJ...",
  "refresh_token": "..."
}
```

All fields have defaults. `gateway_url`, `gotrue_url`, and `identity_url` default to their standard local dev ports from `.env.example`.

### 4.2 Login flow (`crm login`)

The only command that talks outside the API Gateway — auth bootstrapping requires direct contact with GoTrue and the Identity Service.

1. Prompt email (text) + password (hidden)
2. `POST {gotrue_url}/token?grant_type=password` → GoTrue access token
3. `POST {identity_url}/identity/session` with `{ provider_token }` → CRM JWT + refresh token
4. Write both tokens to `~/.crm/config.json`

No automatic token refresh — when the JWT expires, re-run `crm login`. Appropriate for a debug tool.

### 4.3 Token resolution (all other commands)

Priority order:
1. `--token <jwt>` flag
2. `CRM_TOKEN` environment variable
3. `access_token` from `~/.crm/config.json`

If no token is found, the command exits with a clear error: `No token found. Run 'crm login' or set CRM_TOKEN.`

---

## 5. Commands

### 5.1 Config commands

```
crm login
  # Prompts email + password, exchanges for CRM JWT, saves to ~/.crm/config.json

crm config show
  # Prints current config. access_token truncated to first 20 chars for safety.

crm config set-url <url>
  # Updates gateway_url in config without re-authenticating.
  # Example: crm config set-url http://staging.internal:3000
```

### 5.2 Leads

```
crm leads list [options]
  --location <id>               Filter by location_id
  --pipeline <pipeline>         Filter: new_patient | in_treatment | in_retention
  --stage <stage>               Filter by stage name
  --q <search>                  Search by name, phone, or email
  --limit <n>                   Max results (default: 20)

  Output (table): id | name | phone | channel | pipeline | stage | score
  If --location is omitted, it is prompted interactively.

crm leads get <id>
  # Full lead detail: all fields, attribution, tags, last activity timestamp.
  # Output: formatted key-value panel.

crm leads create
  # Interactive wizard. Required fields prompted first:
  #   first_name, last_name, phone, channel (select list)
  # Optional fields offered in a second pass:
  #   email, treatment_interest, location_id, source UTMs
  # Prints created lead id and name on success.

crm leads update <id>
  # Fetches current lead, displays values, prompts for fields to change.
  # Only changed fields sent in PATCH body.
  # Editable: first_name, last_name, phone, email, treatment_interest, location_id
```

### 5.3 Pipeline

```
crm pipeline memberships <lead-id>
  # Lists all pipeline memberships for the lead.
  # Output (table): membership_id | pipeline | stage | status | entered_at

crm pipeline enroll <lead-id>
  # Prompts: pipeline (select), stage (select, filtered to valid entry stages),
  #          location_id, reason (manual | import)
  # POST /pipeline/memberships
  # Prints new membership id on success.

crm pipeline transition <membership-id>
  # Fetches current membership to show current stage.
  # Prompts: target stage (select, all stages shown — no client-side validation),
  #          reason (manual | timeout | no_show | import | import_undo),
  #          override (y/n, default n)
  # POST /pipeline/memberships/:id/transition
  # Prints updated stage on success.
```

### 5.4 Conversations

```
crm conversations list [options]
  --location <id>               Required (prompted if missing)
  --lead <id>                   Filter by lead_id
  --status <open|closed>        Filter by status

  Output (table): id | lead name | status | assigned_to | last message preview

crm conversations get <id>
  # Conversation header (lead, status, assigned_to, agent_mode_active)
  # + last 20 messages displayed oldest→newest with timestamps and direction arrows:
  #   → outbound  ← inbound
  # + unread notes shown inline with [NOTE] prefix.

crm conversations send <id>
  # Prompts: message body (multiline input, submit with enter on blank line)
  # POST /conversations/:id/messages
  # Prints sent message id on success.

crm conversations note <id>
  # Prompts: note body (multiline)
  # POST /conversations/:id/notes
  # Prints note id on success.
```

### 5.5 Global flags

Available on every command:

| Flag | Description |
|------|-------------|
| `--json` | Raw JSON response, no formatting. Pipeable to `jq`. |
| `--token <jwt>` | Override stored token for this invocation only. |
| `--url <url>` | Override `gateway_url` for this invocation only. |

---

## 6. Output

### Pretty mode (default)

- Lists rendered as ASCII tables via `cli-table3`
- Status labels colored with `chalk`: `open` → green, `closed` → grey, `lost` → red, etc.
- Errors printed in red with the raw `error` field from the API response body
- HTTP 401 errors append: `Token may be expired — run 'crm login'`

### JSON mode (`--json`)

- Raw response body printed with `JSON.stringify(body, null, 2)`
- No color, no tables
- Exit code 0 on 2xx, non-zero on error (consistent with standard CLI conventions)

---

## 7. Error Handling

- Network errors (connection refused, timeout): print `Cannot reach gateway at {url}. Is the stack running?`
- 4xx API errors: print the `error` field from the response body + the HTTP status
- 5xx errors: print `Server error ({status}). Check service logs.`
- Missing required config: explicit message telling the user exactly what to set

---

## 8. README

`tools/crm-cli/README.md` covers:

- Prerequisites (Node.js 24, stack running via `./scripts/dev/up.sh`)
- Install and link: `cd tools/crm-cli && npm install && npm run build && npm link`
- First-time setup: `crm login`
- Example workflows:
  - Create a lead and move it through the pipeline
  - List open conversations at a location and send a reply
  - Override the token for a one-off command
- All commands with their flags listed

---

## 9. Out of Scope

- Campaign, referral, reporting, and import commands — covered by the gateway but excluded from this initial scope. Can be added as follow-on work using the same command/prompt patterns.
- Automatic token refresh
- Individual service scripts (messaging, template, etc.) — sibling tools in `tools/` following the same skeleton
- Shell completion scripts
