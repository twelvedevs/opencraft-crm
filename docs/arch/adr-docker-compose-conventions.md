# ADR: Docker Compose Local Dev Conventions

**Date:** 2026-04-12
**Status:** Accepted

---

## Context

The project runs 21+ services locally via Docker Compose. Two recurring pain points emerged during setup:

1. **Environment variable legibility** — standard `UPPER_SNAKE_CASE` vars bleed into the compose file indistinguishably from the vars the services themselves receive, making it hard to trace where a value originates.
2. **Migration ordering** — database migrations must complete before a service starts. Using `depends_on: condition: service_healthy` on the main service is insufficient because migrations are a one-shot run, not a long-lived process with a health endpoint.

---

## Decisions

### 1. CamelCase + double-underscore namespacing in `.env.example`

All compose-level variables use `PascalCase_Namespace__VarName` format:

```
Namespace__VarName       # plain setting
Namespace__URL           # composed from other vars (see below)
```

**Rules:**

| Rule | Example |
|------|---------|
| Leading word is PascalCase (service name or infra group) | `Postgres__`, `Redis__`, `Identity_Service__` |
| Double underscore separates namespace from field | `GoTrue__JWT_Secret` |
| URL vars are composed via shell substitution in `.env` | `Identity_Service__URL=http://${Identity_Service__Host}:${Identity_Service__Port}` |
| Infra groups (Postgres, Redis, GoTrue, MailHog) are defined first | — |
| Custom service groups follow, one group per service | — |

**Why CamelCase?**  
Inside a compose `environment:` block, compose-level vars appear alongside the env vars the container actually receives (e.g. `PORT: "3100"`, `DATABASE_URL: ...`). `UPPER_SNAKE_CASE` is visually identical for both. CamelCase vars stand out immediately — you can see at a glance which values are indirected from `.env` and which are literals.

**Why double-underscore?**  
A single underscore is common in service env var names. Double underscore is a strong visual separator that signals "this is a namespaced compose variable", without conflicting with any service convention.

**Why no `env_file:` in service definitions?**  
All vars are declared explicitly under `environment:` in the compose file. This keeps the full configuration of every service visible in one place — no need to open a separate file to understand what a service receives. The `.env` file is loaded automatically by Docker Compose at the project level.

### 2. Separate migration services per main service

Each service that owns a database schema gets a companion migration service:

```yaml
service_a_migrations:
  image: ortho-service-a          # same image as the main service
  command: npm run migrate         # overrides the default entrypoint
  profiles: [services]            # same profile as the parent
  environment:
    DATABASE_URL: ${Service_A__DB_URL}
  depends_on:
    postgres:
      condition: service_healthy

service_a:
  image: ortho-service-a
  profiles: [services]
  depends_on:
    service_a_migrations:
      condition: service_completed_successfully
    ...
```

**Key properties:**

- **Same image, different command.** No extra Dockerfile. Migrations run `npm run migrate` (defined in the service's `package.json`). The image is built once and reused.
- **Exits 0 on success.** `service_completed_successfully` means the main service only starts after migrations finish cleanly. If migrations fail, the main service never starts — the correct failure mode.
- **Same profile as the parent.** Migration services use the same `profiles` value as their main service so they activate together. They do not run in the infrastructure-only profile.
- **Naming convention:** `<service_name>_migrations` matches the main service name exactly, making the relationship self-documenting.

---

## Consequences

- `.env.example` serves as the canonical reference for all configurable values, with variables grouped by service and composed URLs derived from host/port primitives.
- The compose file is self-contained: reading a service's `environment:` block gives the full picture of its runtime config.
- Migration failures are surfaced immediately at startup rather than causing cryptic runtime errors inside a running container.
- Each service's `package.json` must expose a `migrate` script (typically `knex migrate:latest`).
- The convention requires discipline: new services must add both a `_migrations` service and a `migrate` npm script.

---

## Examples

### `.env.example` — namespaced vars with composition

```dotenv
# ── Postgres ──────────────────────────────────────────────────────────────────
Postgres__Host=postgres
Postgres__Port=5432
Postgres__User=ortho
Postgres__Password=SecretPass123
Postgres__DB=ortho

# ── Identity Service ──────────────────────────────────────────────────────────
Identity_Service__Host=identity
Identity_Service__Port=3100
Identity_Service__URL=http://${Identity_Service__Host}:${Identity_Service__Port}
Identity_Service__DB_URL=postgresql://${Postgres__User}:${Postgres__Password}@${Postgres__Host}:${Postgres__Port}/${Postgres__DB}
```

### `docker-compose.yml` — migration companion + explicit environment

```yaml
identity_migrations:
  image: ortho-identity
  command: npm run migrate
  profiles: [services]
  environment:
    DATABASE_URL: ${Identity_Service__DB_URL}
  depends_on:
    postgres:
      condition: service_healthy

identity:
  image: ortho-identity
  profiles: [services]
  ports:
    - "${Identity_Service__Port}:3100"
  environment:
    PORT: "3100"
    DATABASE_URL: ${Identity_Service__DB_URL}
    REDIS_URL: ${Redis__URL}
  depends_on:
    identity_migrations:
      condition: service_completed_successfully
    redis:
      condition: service_healthy
```

The `PORT: "3100"` literal and `DATABASE_URL: ${Identity_Service__DB_URL}` substitution are visually distinct — literals are what the container receives; CamelCase vars are sourced from `.env`.
