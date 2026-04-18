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

### Imports

Drive the CSV data import pipeline end-to-end: upload → preview → confirm → execute → (optional) undo.

```bash
# Upload a CSV (multipart POST). --wait blocks until preview is ready.
crm imports upload \
  --file /tmp/import-500.csv \
  --location <location-uuid> \
  --type active_patients \
  --wait

# List imports for a location, with optional filters
crm imports list --location <location-uuid>
crm imports list --location <uuid> --status preview_ready
crm imports list --location <uuid> --type scheduled_appointments

# Show full import detail (counts, column mapping, undo deadline, error)
crm imports get <import-uuid>

# Inspect parsed rows before confirming (status: matched | unmatched | ambiguous | failed | pending)
crm imports rows <import-uuid>
crm imports rows <import-uuid> --status unmatched --limit 20

# Confirm and execute (interactive prompt shows column mapping; --wait blocks until completed)
crm imports confirm <import-uuid> --wait

# Cancel a preview_ready import (before confirming)
crm imports cancel <import-uuid>

# Undo a completed import (within the 2-hour undo window)
crm imports undo <import-uuid> --wait
```

**Valid `--type` values:** `active_patients`, `completed_patients`, `scheduled_appointments`, `no_shows`.

**`--wait` behavior:** polls every 2s, prints a dot per tick, returns when the import reaches the terminal state. A `failed` status always throws, printing the server's `error_message`.

**`--json` on `confirm`:** skips the interactive "confirm mapping?" prompt and POSTs immediately — useful for scripted runs.

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

### Import a batch of test patients end-to-end

```bash
# 1. Generate a fake 500-row CSV (see "Fake CSV Generator" below)
cd tools/crm-cli
npx tsx scripts/gen-csv.ts --count=500 --type=active_patients --out=/tmp/import-500.csv

# 2. Upload it and wait for the parse_match phase to finish
LOC_ID=<location-uuid>
crm imports upload \
  --file /tmp/import-500.csv \
  --location "$LOC_ID" \
  --type active_patients \
  --wait
# → prints: ✓ Upload accepted  id: <uuid>  status: uploading
# → dots while parsing
# → Import Preview table with matched/unmatched/ambiguous counts + column mapping
# → Run: crm imports confirm <uuid>  (or cancel to abort)

# 3. (Optional) Peek at the unmatched rows before confirming
crm imports rows <import-uuid> --status unmatched --limit 20

# 4. Confirm and wait for execute to complete
crm imports confirm <import-uuid> --wait
# → shows column mapping
# → interactive: "Confirm and start execution?" → Yes
# → dots while executing
# → Completed table: executed, failed, undo_by

# 5. Verify via leads list
crm leads list --location "$LOC_ID" --limit 20

# 6. (Optional) Undo within the 2-hour window
crm imports undo <import-uuid> --wait
```

### Pipe output to jq for inspection

```bash
crm leads list --json | jq '.leads[0]'
crm leads get <uuid> --json | jq '.first_touch_source'
crm pipeline memberships <uuid> --json | jq '.memberships[].stage'
```

---

## Fake CSV Generator

`scripts/gen-csv.ts` produces Ortho2-format CSV files full of fake patient rows. Use it to feed the `crm imports upload` command without needing real data.

**Run directly with `tsx` — no build step needed:**

```bash
cd tools/crm-cli
npx tsx scripts/gen-csv.ts [options]
```

**Options (all `--key=value`; defaults in parens):**

| Option | Values | Default |
|--------|--------|---------|
| `--count=<n>` | any positive integer | `500` |
| `--type=<t>` | `active_patients` \| `completed_patients` \| `scheduled_appointments` \| `no_shows` | `active_patients` |
| `--out=<path>` | any writable file path | `test-import.csv` |

**Examples:**

```bash
# 500-row active-patients file (the default matches this)
npx tsx scripts/gen-csv.ts --count=500 --type=active_patients --out=/tmp/import-500.csv

# 100-row scheduled-appointments file (populates ApptDate + ApptTime columns)
npx tsx scripts/gen-csv.ts --count=100 --type=scheduled_appointments --out=/tmp/import-appt-100.csv

# Small file to sanity-check output
npx tsx scripts/gen-csv.ts --count=10 --out=/tmp/sample.csv
head -5 /tmp/sample.csv
```

**Output format** — 8 columns matching the Ortho2 export schema the import pipeline auto-detects:

```
PatFirst,PatLast,CellPhone,Email,HomePhone,Birthdate,ApptDate,ApptTime
Mary,Smith,(555) 234-5678,mary.smith42@gmail.com,,03/15/1978,,
...
```

- `Email` is blank on ~1/3 of rows (simulates missing-email records).
- `HomePhone` is always blank (the generator only produces cell numbers).
- `ApptDate` / `ApptTime` are populated only when `--type=scheduled_appointments`.
- `Birthdate` years range 1950–2007.

**Pairing with `crm imports upload`:** generate first, then upload:

```bash
npx tsx scripts/gen-csv.ts --count=500 --out=/tmp/batch.csv
crm imports upload --file /tmp/batch.csv --location "$LOC_ID" --type active_patients --wait
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
