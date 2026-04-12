# CRM CLI

Developer CLI for debugging and testing CRM backend modules via the API Gateway.

## Prerequisites

- Node.js 24+
- CRM stack running: `./scripts/dev/up-all.sh` (or at minimum the API Gateway + relevant services)

## Install & Link

```bash
cd tools/crm-cli
npm install
npm run build
npm link
```

After `npm link`, the `crm` binary is available globally in your shell.

## First-Time Setup

```bash
crm login
# Prompts for email + password
# Exchanges credentials with GoTrue + Identity Service
# Saves JWT to ~/.crm/config.json
```

## Configuration

```bash
crm config show                            # Show current config (token truncated)
crm config set-url http://staging:3000     # Point at a different gateway
```

Override per-command without changing config:

```bash
crm leads list --token eyJ... --url http://staging:3000
CRM_TOKEN=eyJ... crm leads list           # Via env var
```

---

## Commands

### Leads

```bash
# List leads (prompts for location if omitted)
crm leads list
crm leads list --location <location-uuid>
crm leads list --pipeline new_patient --stage new_lead
crm leads list --q "john smith" --limit 10

# Get full lead detail
crm leads get <lead-uuid>

# Create a lead (interactive wizard)
crm leads create

# Update a lead (shows current values, prompts for changes)
crm leads update <lead-uuid>
```

### Pipeline

```bash
# List all pipeline memberships for a lead
crm pipeline memberships <lead-uuid>

# Enroll a lead in a pipeline (interactive)
crm pipeline enroll <lead-uuid>

# Transition a membership to a new stage (interactive)
crm pipeline transition <membership-uuid>
```

### Conversations

```bash
# List conversations at a location (prompts for location if omitted)
crm conversations list
crm conversations list --location <location-uuid>
crm conversations list --location <uuid> --status open
crm conversations list --location <uuid> --lead <lead-uuid>

# Show conversation header + last 20 messages
crm conversations get <conversation-uuid>

# Send a message (opens $EDITOR)
crm conversations send <conversation-uuid>

# Add an internal note (opens $EDITOR)
crm conversations note <conversation-uuid>
```

---

## Global Flags

Available on every command:

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON, no formatting. Pipeable to `jq`. |
| `--token <jwt>` | Override stored token for this call only. |
| `--url <url>` | Override `gateway_url` for this call only. |

---

## Example Workflows

### Create a lead and move it through the pipeline

```bash
# 1. Create the lead
crm leads create
# → wizard: enter name, phone, select channel, optional UTMs
# → prints: ✓ Lead created: Jane Doe (uuid)

# 2. Check pipeline membership
crm pipeline memberships <lead-uuid>
# → table shows: new_patient / new_lead

# 3. Transition to 'contacted'
crm pipeline transition <membership-uuid>
# → select target stage: contacted
# → select reason: manual
# → prints: ✓ Transitioned to contacted

# 4. Inspect the lead
crm leads get <lead-uuid>
```

### Read and reply to a conversation

```bash
# 1. Find open conversations at a location
crm conversations list --location <location-uuid> --status open

# 2. Read the conversation thread
crm conversations get <conversation-uuid>

# 3. Send a reply (opens $EDITOR — write message, save, close)
crm conversations send <conversation-uuid>
# → prints: ✓ Message sent (uuid)
```

### Pipe output to jq for inspection

```bash
crm leads list --json | jq '.leads[0]'
crm leads get <uuid> --json | jq '.first_touch_source'
crm pipeline memberships <uuid> --json | jq '.memberships[].stage'
```

---

## Config File

`~/.crm/config.json` — auto-created on first `crm login`:

```json
{
  "gateway_url": "http://localhost:3000",
  "gotrue_url":  "http://localhost:9999",
  "identity_url": "http://localhost:3100",
  "access_token": "eyJ...",
  "refresh_token": "..."
}
```

When the JWT expires, run `crm login` again.
