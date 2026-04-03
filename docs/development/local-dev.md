# Local Development Setup

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin) — v2.20+
- Node.js 24
- A terminal at the monorepo root

## First-Time Setup

### 1. Copy the environment template

```bash
cp .env.example .env
```

### 2. Generate crypto keys

```bash
./scripts/dev/gen-keys.sh
```

This writes three values into `.env`:
- `Identity__Private_Key` — RSA-2048 private key (signs JWTs issued by the Identity Service)
- `Identity__JWKS_Keys` — matching public key in JWK format (used by other services to verify JWTs)
- `GoTrue__Service_Role_Key` — HS256 JWT for Supabase admin SDK calls

### 3. Fill in real API keys (optional)

Open `.env` and replace `PLACEHOLDER` values for the services you intend to exercise:
- **Twilio** (`Twilio__Account_SID`, `Twilio__Auth_Token`) — for SMS sends
- **SendGrid** (`SendGrid__API_Key`) — for email sends
- **Google Ads / Meta** — for ad integration testing

Services with `PLACEHOLDER` values will start successfully but fail when they attempt real API calls.

### 4. Start infra

```bash
./scripts/dev/up.sh
```

| Service | URL |
|---------|-----|
| Postgres | `localhost:5432` |
| Redis | `localhost:6379` |
| GoTrue (Supabase Auth) | `http://localhost:9999` |
| MailHog (email UI) | `http://localhost:8025` |

### 5. Develop a single service

Run the service you're working on locally (hot reload):

```bash
cd apps/platform/identity
npm install
npm run migrate   # run once on first setup or after pulling new migrations
npm run dev
```

The service connects to compose infra on `localhost` ports. No other services need to be running.

### 6. Seed the super admin (once)

After the Identity Service starts for the first time:

```bash
cd apps/platform/identity
DATABASE_URL="postgresql://ortho:changeme@localhost:5432/ortho" \
  npx tsx scripts/seed-super-admin.ts
```

---

## Running the Full Platform Stack

Builds all 11 services and starts everything:

```bash
./scripts/dev/up-all.sh
```

Service ports:

| Service | Port |
|---------|------|
| Identity | 3100 |
| AI | 3101 |
| Template | 3102 |
| Notification | 3103 |
| Audience | 3104 |
| Analytics | 3105 |
| Messaging | 3106 |
| Email | 3107 |
| Nurturing | 3108 |
| Automation | 3109 |
| Integration Hub | 3110 |

**Note:** Automation won't receive domain events in local dev (its SQS consumer has no Redis fallback). Trigger automation rules manually via `POST /rules/:id/dry-run` or by direct API calls.

---

## Common Commands

```bash
./scripts/dev/down.sh             # stop everything
./scripts/dev/logs.sh identity    # tail logs for one service
./scripts/dev/reset.sh            # wipe volumes + restart (clean slate)
docker compose ps                 # check container status
```

---

## Troubleshooting

**`identity` service crashes with `Missing required env: IDENTITY_PRIVATE_KEY`**
Run `./scripts/dev/gen-keys.sh` — the crypto keys weren't generated yet.

**GoTrue healthcheck fails**
GoTrue runs its own DB migrations on startup. If postgres isn't fully ready, GoTrue may crash-loop for a few seconds then recover. Wait 30 seconds and check `docker compose ps`.

**Migration service exits non-zero**
Run `docker compose logs identity_migrations` to see the Knex error. Common cause: schema doesn't exist (check that `docker/init-db.sql` ran on the postgres container — it only runs on first start; if the `postgres_data` volume pre-exists, it won't re-run).

**Fresh start after a schema change**
```bash
./scripts/dev/reset.sh   # wipes postgres_data volume, re-runs init-db.sql
```
