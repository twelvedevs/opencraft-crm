# Media / File Service — Updated Design Spec

**Date:** 2026-04-03
**Status:** Approved
**Component:** `apps/platform/media` — platform layer service
**DB Schema:** `platform_media`
**Supersedes:** `docs/superpowers/specs/2026-03-25-media-service-design.md`

---

## Changelog from Original Spec

Decisions locked down via clarifying Q&A (see `tasks/prd-questions-media-service.md`):

| # | Topic | Decision |
|---|---|---|
| Q1 | AWS SDK version | SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) |
| Q2 | S3 test strategy | Mock SDK in unit tests; LocalStack Docker for integration tests |
| Q3 | DB access | Instantiate Knex directly in the service (not via `@ortho/db` Knex instance) |
| Q4 | Multipart plugin | `@fastify/multipart` |
| Q5 | 20MB proxy limit | `limits: { fileSize: MAX_FILE_SIZE_BYTES }` passed to `@fastify/multipart` |
| Q6 | Variant failure rollback | No rollback — partial variant rows acceptable; `GET /media/:file_id` omits URLs for missing variants |
| Q7 | `sharp` Docker strategy | Pin `sharp` to a version shipping prebuilt binaries for `linux/amd64`; no native compilation |
| Q8 | Cron library | `node-cron` registered at Fastify startup |
| Q9 | S3 download failure on confirm | `502` (distinct from `404` record-not-found) |
| Q10 | `expires_at` in response | Computed from `PRESIGNED_PUT_TTL_SECONDS` and returned as ISO 8601 in API response |
| Q11 | Public file variant URLs | Return only URLs for variants that exist in `media_variants` (no null slots) |
| Q12 | Service auth structure | Shared `preHandler` in `src/middleware/service-auth.ts` applied to the `/media/internal/*` router prefix |
| Q13 | Orphan cleanup cascade | Explicitly delete `media_variants` rows before `media_files` in cleanup transaction (no `ON DELETE CASCADE`) |
| Q14 | S3 key derivation | `{upload_id}/{uuid}.{ext}` for public; `{location_id}/{upload_id}/{uuid}.{ext}` for private — original filename discarded, extension preserved |
| Q15 | Request validation | TypeBox schemas (`@sinclair/typebox`) registered via `fastify.addSchema` / `schema: { body: ... }` on each route |
| Q16 | Test coverage | Unit tests for image-processor, s3 helper, signed-url service, repositories; integration tests for route handlers against real DB + LocalStack S3 |
| Q17 | Logger service name | `'platform-media'` passed to `createLogger` |
| Q18 | Event bus | `@ortho/event-bus` included, wired in publish-only mode (zero subscriptions) |
| Q19 | Interpolator / filter-engine | Both excluded entirely |
| Q20 | Concurrent confirms | `ON CONFLICT DO NOTHING` on `upload_id` unique constraint; second call returns `404` |

---

## 1. Overview

The Media Service is a domain-agnostic platform service responsible for file upload handling, S3 storage, CDN delivery, image optimization, and access-controlled asset URL issuance. It has no knowledge of leads, campaigns, or business entities — it knows only files, access tiers, and owner metadata supplied by callers.

### 1.1 Responsibilities

- Issue presigned S3 PUT URLs for direct browser-to-S3 uploads
- Accept proxy multipart uploads for callers preferring a single HTTP call
- Process images on upload confirmation: resize to standard sizes and convert to WebP
- Serve public assets via stable CloudFront URLs (brand logos, email images)
- Serve private assets via short-lived signed S3 URLs (before-after consent photos, generated PDF reports)
- Store file metadata, access tier, owner context, and variant URLs in `platform_media` schema
- Enforce private file access by checking JWT `location_id` claim against file's stored `location_id`

### 1.2 Explicitly Out of Scope

- **Call recordings** — Messaging Service stores the Twilio-hosted recording URL directly; no re-hosting
- **CSV import files** — Data Import Service manages its own S3 interaction; ephemeral processing artifacts do not go through this service
- **PDF generation** — Reporting Service generates PDFs; Media Service only stores and serves them
- **Consent tracking for patient photos** — Lead Service responsibility; Media Service stores files, not consent state
- **Physical S3 object deletion** — soft-delete only at launch

---

## 2. Storage Architecture

### 2.1 Two S3 Buckets

**`ortho-media-public`** — CloudFront-fronted, no S3 auth on objects.

- Stores: brand logos, email template images, any asset embedded in outbound emails or public web pages
- CloudFront URL format: `https://media.ortho.app/{upload_id}/{uuid}.{ext}`
- Objects are immutable once written — no in-place updates, only new uploads
- Cache-Control: `max-age=31536000, immutable`

**`ortho-media-private`** — No public access. Accessed exclusively via S3 presigned GET URLs with 15-minute TTL.

- Stores: before-after consent photos, generated PDF reports, any file requiring location-scoped access
- S3 key format: `{location_id}/{upload_id}/{uuid}.{ext}` — `location_id` prefix is enforced server-side

### 2.2 S3 Key Derivation

The `original_key` is pre-computed at record creation time (for the presigned PUT flow) or at upload time (proxy/internal flows). The original filename is discarded; only the file extension is preserved:

- **Public files:** `{upload_id}/{uuid}.{ext}`
- **Private files:** `{location_id}/{upload_id}/{uuid}.{ext}`

`uuid` is a newly generated UUID (separate from `upload_id`). Extension is extracted from the `filename` field using a simple path split; if no extension is present, the key has no extension suffix.

Derived variant keys append the variant name before the extension: `{upload_id}/{uuid}-medium.webp`, `{upload_id}/{uuid}-thumb.webp`.

### 2.3 Image Variants

When an image upload is processed, the original plus two derived variants are written to S3. The original is tracked in `media_files.original_key`; derived variants are tracked in `media_variants` (one row each for `medium` and `thumb`).

| Variant | Tracked in | Max Width | Format | Quality |
|---|---|---|---|---|
| `original` | `media_files.original_key` | unchanged | original format | lossless |
| `medium` | `media_variants` | 800px | WebP | 85 |
| `thumb` | `media_variants` | 200px | WebP | 80 |

Aspect ratio is always preserved. Non-image files (PDFs, etc.) are stored as a single object with no variants.

### 2.4 CloudFront Distribution

A single CloudFront distribution sits in front of the public bucket only. The private bucket is never behind CloudFront — signed S3 URLs are issued directly.

---

## 3. API Design

All endpoints require a valid JWT (via `@ortho/auth-middleware`) except internal service-to-service endpoints, which require the shared service auth token enforced by the `src/middleware/service-auth.ts` preHandler.

Request body validation uses TypeBox schemas (`@sinclair/typebox 0.34`) compiled and registered via `fastify.addSchema` / `schema: { body: ... }` on each route. Fastify's built-in AJV compiler handles schema validation automatically before the handler runs.

### 3.1 Upload Flow — Presigned PUT (preferred for large files)

**`POST /media/upload-url`**

Issues a presigned S3 PUT URL. Creates a `media_files` record in `pending` status. The S3 key is pre-computed deterministically (see §2.2) at this step — `original_key` is populated immediately, before the browser performs the PUT.

Request:
```json
{
  "filename": "logo.png",
  "mime_type": "image/png",
  "tier": "public",
  "location_id": "uuid",
  "purpose": "brand_logo",
  "file_size_bytes": 204800
}
```

- `filename`: required. Stored as `original_filename`; extension used to derive S3 key.
- `mime_type`: required. Determines whether image processing runs on confirm.
- `tier`: required. `"public"` or `"private"`.
- `location_id`: optional. Stored on the file record; required for private files. Used in S3 key prefix for private files.
- `purpose`: optional opaque string stored as metadata — Media Service does not interpret it.
- `file_size_bytes`: optional. If provided and exceeds `MAX_FILE_SIZE_BYTES`, returns `413` immediately. The presigned PUT URL always includes a `content-length-range` S3 condition capping at `MAX_FILE_SIZE_BYTES` regardless.

Response:
```json
{
  "upload_id": "uuid",
  "upload_url": "https://s3.amazonaws.com/...",
  "expires_at": "2026-04-03T10:15:00Z"
}
```

`expires_at` is computed as `now() + PRESIGNED_PUT_TTL_SECONDS` and returned as an ISO 8601 UTC string. It is also stored in `media_upload_intents.expires_at`.

Note: `upload_id` and `file_id` (returned by the confirm step) are **different identifiers**. Callers must retain the `file_id` from the confirm response for all subsequent access.

Error responses:
- `400` — missing required fields or invalid `tier` value (TypeBox schema rejection)
- `413` — `file_size_bytes` provided and exceeds `MAX_FILE_SIZE_BYTES`

---

**`POST /media/confirm/:upload_id`**

Caller invokes after the browser has completed the S3 PUT. Authorization: the JWT `sub` must match the `uploaded_by` field on the pending file record — returns `403` if not.

The confirm operation uses `ON CONFLICT DO NOTHING` on the `upload_id` unique constraint to handle concurrent double-taps. A second concurrent call for the same `upload_id` finds the record already confirmed and returns `404`.

Media Service downloads the original from S3, runs image processing if applicable, writes derived variants, and marks the record `ready`.

Response:
```json
{
  "file_id": "uuid",
  "tier": "public",
  "urls": {
    "original": "https://media.ortho.app/...",
    "medium": "https://media.ortho.app/...",
    "thumb": "https://media.ortho.app/..."
  },
  "location_id": "uuid",
  "created_at": "2026-04-03T10:00:00Z"
}
```

- For private files, all URLs in the response are presigned S3 GET URLs (15-min TTL), not permanent CloudFront URLs.
- `medium` and `thumb` are omitted for non-image files or when variant generation failed (see §5.5).
- Returns `403` if JWT `sub` does not match `uploaded_by`.
- Returns `404` if `upload_id` not found, already confirmed, or second concurrent confirm call.
- Returns `410` if presigned PUT URL has expired.
- Returns `502` if the original S3 object cannot be downloaded (S3 `NoSuchKey`, network error) — distinct from the `404` record-not-found case.

---

### 3.2 Upload Flow — Proxy (callers preferring single call)

**`POST /media/upload`**

Accepts `multipart/form-data` via `@fastify/multipart`. Streams file to S3, processes inline, returns complete file record immediately. Same response shape as `POST /media/confirm`.

Multipart is registered with `limits: { fileSize: MAX_FILE_SIZE_BYTES }`. When the limit is hit, `@fastify/multipart` aborts the stream and the handler returns `413`.

Form fields: `file` (binary), `tier`, `location_id` (optional), `purpose` (optional).

Error responses:
- `400` — missing `file` field, missing `tier`, or invalid `tier` value
- `413` — file exceeds `MAX_FILE_SIZE_BYTES`

---

### 3.3 File Access

**`GET /media/:file_id`**

Returns file metadata and URL(s).

- **Public files:** returns permanent CloudFront URL(s). No location check.
- **Private files:** validates JWT `location_id` claim matches `file.location_id`, then issues fresh presigned S3 GET URLs (15-min TTL). Returns `403` if claim does not match.

Only URLs for variants that exist in `media_variants` are included in the response — no `null` slots for missing variants. The `original` URL is always present (from `media_files.original_key`).

Returns `404` if file not found or `status = 'deleted'`.

Response:
```json
{
  "file_id": "uuid",
  "tier": "public",
  "mime_type": "image/png",
  "original_filename": "logo.png",
  "file_size_bytes": 204800,
  "purpose": "brand_logo",
  "location_id": "uuid",
  "urls": {
    "original": "...",
    "medium": "...",
    "thumb": "..."
  },
  "created_at": "2026-04-03T10:00:00Z"
}
```

---

**`DELETE /media/:file_id`**

Soft-delete. Sets `deleted_at`, does not remove S3 object. Returns `204` on success.

Authorization rules:
- **Private files with `location_id`:** JWT `location_id` claim must match `file.location_id`. Returns `403` if not.
- **Public files or files with `location_id IS NULL`:** user-facing deletion returns `403`. Deletion of global/public assets requires the internal service auth token via `POST /media/internal/delete/:file_id` (future endpoint, out of scope at launch).

---

### 3.4 Internal Service-to-Service Endpoints

All `/media/internal/*` routes share a single `preHandler` defined in `src/middleware/service-auth.ts`. It checks `Authorization: Bearer <SERVICE_AUTH_TOKEN>` against the `SERVICE_AUTH_TOKEN` env var. Returns `401` if missing or invalid. No user JWT. No `location_id` enforcement — calling service is trusted to have already authorized the user.

**`POST /media/internal/store`**

Used by Reporting Service to store a generated PDF. Accepts `multipart/form-data` via `@fastify/multipart` (same plugin instance, same `limits` configuration). Bypasses presigned flow; returns complete file record immediately.

Request fields: `file` (binary), `tier` (`"private"`), `location_id` (optional), `purpose` (e.g. `"report_pdf"`).

Response: `{ file_id, urls: { original } }`

`uploaded_by` is set to `SERVICE_CALLER_ID` sentinel UUID. No image processing for PDFs.

Error responses:
- `400` — missing `file` or `tier` field
- `413` — file exceeds `MAX_FILE_SIZE_BYTES`

---

**`GET /media/internal/:file_id/signed-url`**

Issues a presigned S3 GET URL for a **private** file without checking `location_id`. Used when Reporting Service emails a PDF link to a marketing manager (all-location access, no single `location_id` claim).

Response: `{ signed_url, expires_at }`

Error responses:
- `404` — file not found or `status = 'deleted'`
- `400` — file `tier` is `"public"` (use the CloudFront URL from `GET /media/:file_id` instead)

---

## 4. Data Model

### `media_files`

One row per upload. Created at `POST /media/upload-url` (status `pending`) or `POST /media/upload` / `POST /media/internal/store` (status `ready`). The S3 key in `original_key` is pre-computed at record creation — it is always populated, never null.

```sql
CREATE TABLE platform_media.media_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id         uuid UNIQUE NOT NULL,
  tier              text NOT NULL CHECK (tier IN ('public', 'private')),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'ready', 'deleted')),
  mime_type         text NOT NULL,
  original_key      text NOT NULL,       -- S3 object key, pre-computed at creation
  original_filename text NOT NULL,       -- original filename supplied by caller
  file_size_bytes   bigint,              -- null until confirm/upload; measured from actual bytes
  location_id       uuid,                -- null for global/internal assets
  purpose           text,                -- opaque caller-supplied tag
  uploaded_by       uuid NOT NULL,       -- JWT sub, or SERVICE_CALLER_ID sentinel for internal calls
  created_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_at      timestamptz,
  deleted_at        timestamptz
);

CREATE INDEX ON platform_media.media_files (location_id);
CREATE INDEX ON platform_media.media_files (status, created_at)
  WHERE status = 'pending';
```

### `media_variants`

One row per derived image variant. Only created for image `mime_type` files. No `ON DELETE CASCADE` — orphan cleanup is handled explicitly in the cleanup transaction (see §4.3).

```sql
CREATE TABLE platform_media.media_variants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     uuid NOT NULL REFERENCES platform_media.media_files(id),
  variant     text NOT NULL CHECK (variant IN ('medium', 'thumb')),
  s3_key      text NOT NULL,
  width_px    int NOT NULL,
  size_bytes  bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (file_id, variant)
);
```

### `media_upload_intents`

Short-lived tracking for presigned PUT flow. Cleaned up after confirm or expiry.

```sql
CREATE TABLE platform_media.media_upload_intents (
  id            uuid PRIMARY KEY,      -- this is the upload_id
  file_id       uuid NOT NULL REFERENCES platform_media.media_files(id),
  presigned_url text NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON platform_media.media_upload_intents (expires_at);
```

### 4.3 Orphan Cleanup

An hourly `node-cron` job (registered at Fastify startup in `src/jobs/cleanup.ts`) deletes expired pending records. The cleanup explicitly deletes `media_variants` rows before `media_files` to satisfy the FK constraint (no `ON DELETE CASCADE`). Both statements run in a single transaction scoped to expired intents only.

```sql
BEGIN;

-- Step 1: delete any variants belonging to pending files with expired intents
DELETE FROM platform_media.media_variants
WHERE file_id IN (
  SELECT file_id
  FROM platform_media.media_upload_intents
  WHERE expires_at < now()
);

-- Step 2: delete the pending files whose upload intents have expired
DELETE FROM platform_media.media_files
WHERE status = 'pending'
  AND id IN (
    SELECT file_id
    FROM platform_media.media_upload_intents
    WHERE expires_at < now()
  );

-- Step 3: delete the expired intents
DELETE FROM platform_media.media_upload_intents
WHERE expires_at < now();

COMMIT;
```

> Note: variants are only created after a successful confirm, not during the `pending` state. In practice Step 1 will delete zero rows. It is included explicitly to maintain FK safety if that assumption ever changes.

---

## 5. Image Processing

### 5.1 Library

`sharp` — Node.js binding to libvips. Pinned to a version that ships prebuilt binaries for `linux/amd64` (no native compilation in the Dockerfile, no `build-essential` or `vips-dev` build deps required). The `node:24-slim` base image is used.

### 5.2 Processing Pipeline

Triggered by `POST /media/confirm/:upload_id` (downloads original from S3 first) and `POST /media/upload` (uses buffered stream). Both paths call the same `processImage()` function in `src/services/image-processor.ts`.

1. Detect actual image dimensions via `sharp.metadata()`
2. Generate `medium` variant: resize to max 800px width (preserve aspect ratio), convert to WebP, quality 85
3. Generate `thumb` variant: resize to max 200px width, convert to WebP, quality 80
4. Write original + two derived variants to S3 in parallel (`Promise.all`) — three S3 PUTs total
5. Insert two rows into `media_variants` (one per derived variant) using `INSERT ... ON CONFLICT DO NOTHING`
6. Update `media_files`: `status = 'ready'`, `confirmed_at = now()`, `file_size_bytes` (from actual byte count)

### 5.3 Supported Image Types

`image/jpeg`, `image/png`, `image/gif`, `image/webp`. Any other `mime_type` is treated as a binary — stored as-is, no variants generated, no `media_variants` rows inserted.

### 5.4 Size Limit

`MAX_FILE_SIZE_BYTES` (default `20971520` = 20MB). Enforced in two ways:

- `POST /media/upload-url`: if `file_size_bytes` is provided in request body and exceeds limit, returns `413` immediately. The presigned PUT URL always includes an S3 `content-length-range` condition as a hard backstop.
- `POST /media/upload` and `POST /media/internal/store` (proxy): `@fastify/multipart` is registered with `limits: { fileSize: MAX_FILE_SIZE_BYTES }`. When the limit is hit, the plugin aborts the stream and the handler returns `413`.

Error body: `{ "error": "File exceeds 20MB limit" }`.

### 5.5 Error Handling

If `sharp` processing fails (corrupt file, unsupported encoding): store original as-is, mark `status = 'ready'`, omit variants from response. Log warning to Datadog. No `500` returned to caller — original URL is always usable.

Partial variant rows from a partially completed run (e.g. medium written but sharp crashed before thumb) are left in place. `GET /media/:file_id` returns only URLs for variants that exist in `media_variants`, so a partial set is surfaced correctly.

---

## 6. Access Control

### 6.1 Public Files

No auth check on the CloudFront URL — objects are publicly accessible once written. Auth is enforced only at upload time (valid JWT required). Callers must use `tier: "public"` only for assets safe to be publicly reachable (logos, email images).

### 6.2 Private Files — User-Facing

On `GET /media/:file_id`:

1. Validate JWT via `@ortho/auth-middleware`
2. Load `media_files` row — `404` if not found or `status = 'deleted'`
3. If `file.location_id IS NOT NULL`: verify JWT claims contain a matching `location_id` — `403` if not
4. If `file.location_id IS NULL`: any authenticated user may access (reserved for global/internal assets)
5. Issue presigned S3 GET URL with TTL of `PRESIGNED_GET_TTL_SECONDS` via AWS SDK v3 `getSignedUrl`
6. Return signed URL in response — Media Service does not redirect; caller fetches S3 directly

### 6.3 Private Files — Service-to-Service

`GET /media/internal/:file_id/signed-url` requires the `service-auth.ts` preHandler. No `location_id` check. Used by Reporting Service when emailing PDF links to marketing managers (all-location access).

### 6.4 Upload Authorization

Any authenticated user may upload. The `location_id` on the file is taken from the request body — Media Service does not infer it from the JWT. The calling service is responsible for passing the correct `location_id`.

### 6.5 Confirm Authorization

`POST /media/confirm/:upload_id` requires the JWT `sub` to match the `uploaded_by` field on the pending file record. Returns `403` if `sub` does not match. Concurrent double-taps are handled via `ON CONFLICT DO NOTHING`; second call returns `404`.

### 6.6 Delete Authorization

- Private files with `location_id`: JWT `location_id` claim must match `file.location_id` → `403` if not.
- Public files or files with `location_id IS NULL`: user-facing delete returns `403`. Internal service token required (future scope).

---

## 7. Integration Map

The Media Service publishes no EventBridge events. All integration is synchronous REST. `@ortho/event-bus` is wired in publish-only mode (zero subscriptions) to enable future event publishing without structural changes.

| Caller | Endpoint | Purpose |
|---|---|---|
| CRM Web App (browser) | `POST /media/upload-url` + `POST /media/confirm/:id` | Upload brand logos, before-after photos, email template images directly from browser |
| CRM Web App (browser) | `GET /media/:file_id` | Retrieve URL to display a file |
| Reporting Service | `POST /media/internal/store` | Store a generated PDF report |
| Reporting Service | `GET /media/internal/:file_id/signed-url` | Get signed URL to embed in email delivery to marketing managers |
| Any server-side service | `POST /media/upload` | Proxy upload (simpler single-call integration) |

**Template Service and email designer images:** All image uploads for email templates are performed directly from the browser using the presigned PUT flow. The Template Service backend does not call the Media Service — it only stores `file_id` references returned after confirm.

---

## 8. Configuration

| Env Var | Description | Default |
|---|---|---|
| `AWS_REGION` | AWS region | `us-east-1` |
| `S3_PUBLIC_BUCKET` | Public bucket name | — |
| `S3_PRIVATE_BUCKET` | Private bucket name | — |
| `CLOUDFRONT_BASE_URL` | e.g. `https://media.ortho.app` | — |
| `PRESIGNED_PUT_TTL_SECONDS` | TTL for presigned S3 PUT URLs | `900` |
| `PRESIGNED_GET_TTL_SECONDS` | TTL for presigned S3 GET URLs | `900` |
| `SERVICE_AUTH_TOKEN` | Shared secret for `/media/internal/*` endpoints | — |
| `SERVICE_CALLER_ID` | Sentinel UUID stored as `uploaded_by` for internal calls | — |
| `DATABASE_URL` | Postgres connection string | — |
| `MAX_FILE_SIZE_BYTES` | Upload size limit in bytes | `20971520` |

AWS credentials are supplied via ECS task role in production (no `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` needed).

---

## 9. Dependencies

### Production

| Package | Version | Purpose |
|---|---|---|
| `fastify` | 5.x | HTTP server |
| `@fastify/multipart` | latest | Multipart form-data parsing for proxy + internal upload |
| `@aws-sdk/client-s3` | 3.x | S3 object operations |
| `@aws-sdk/s3-request-presigner` | 3.x | Presigned PUT + GET URL generation |
| `sharp` | pinned (prebuilt `linux/amd64`) | Image resizing and WebP conversion |
| `knex` | 3.x | Query builder; instantiated directly in service |
| `pg` | latest | PostgreSQL driver |
| `node-cron` | latest | Hourly orphan cleanup job |
| `@sinclair/typebox` | 0.34 | TypeBox schema definitions for route validation |
| `@ortho/auth-middleware` | workspace | JWT validation + RBAC preHandler |
| `@ortho/event-bus` | workspace | EventBridge client (publish-only, zero subscriptions) |
| `@ortho/logger` | workspace | `createLogger('platform-media')` — Pino/Datadog |

### Excluded

- `@ortho/db` Knex instance — Knex is instantiated directly in the service
- `@ortho/interpolator` — no template interpolation needed
- `@platform/filter-engine` — no filter evaluation needed
- `bullmq` — no queue needed; sync processing + `node-cron` is sufficient

---

## 10. Testing Strategy

### Unit Tests (`test/unit/`)

Each of the following modules has a dedicated unit test file. S3 is mocked via `vi.mock` on `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`. DB is mocked via repository stubs.

| Module | What to test |
|---|---|
| `src/services/image-processor.ts` | Resize dimensions, WebP output, variant key derivation, corrupt file fallback |
| `src/services/s3.ts` | Upload, download, presign helper parameter construction (mocked SDK) |
| `src/services/signed-url.ts` | TTL computation, URL format, private-only guard |
| `src/repositories/media-files.ts` | Insert, update status, find by `upload_id` / `file_id`, soft-delete |
| `src/repositories/media-variants.ts` | Insert, find by `file_id` |
| `src/repositories/upload-intents.ts` | Insert, find, delete expired |
| `src/middleware/service-auth.ts` | Valid token passes, missing/invalid token returns `401` |

### Integration Tests (`test/integration/`)

Route handler integration tests run against:
- **Real PostgreSQL** via a test database (using `@ortho/testing` fixtures and the service's own migrations)
- **LocalStack S3** via Docker Compose — both public and private buckets created at test suite setup

| Route group | Coverage |
|---|---|
| `POST /media/upload-url` | Creates DB records, returns presigned URL, `413` on size, `400` on invalid tier |
| `POST /media/confirm/:id` | Downloads from LocalStack, runs image processing, writes variants, `403` sub mismatch, `502` on S3 error, `404` on double confirm |
| `POST /media/upload` | Streams to LocalStack, processes, returns URLs, `413` on oversized |
| `GET /media/:file_id` | Public CloudFront URLs, private presigned URLs, `403` location mismatch, `404` deleted |
| `DELETE /media/:file_id` | Soft-delete, `403` public file, `403` location mismatch |
| `POST /media/internal/store` | Service token auth, stores PDF, `401` on bad token |
| `GET /media/internal/:file_id/signed-url` | Issues presigned URL, `400` on public file, `401` on bad token |

---

## 11. Service Structure

```
apps/platform/media/
├── src/
│   ├── routes/
│   │   ├── upload.ts          # POST /media/upload-url, /media/upload, /media/confirm/:id
│   │   ├── files.ts           # GET /media/:file_id, DELETE /media/:file_id
│   │   └── internal.ts        # POST /media/internal/store, GET /media/internal/:id/signed-url
│   ├── services/
│   │   ├── image-processor.ts # sharp resize + WebP conversion
│   │   ├── s3.ts              # AWS SDK v3 upload, download, presign helpers
│   │   └── signed-url.ts      # presigned GET URL issuance + TTL
│   ├── repositories/
│   │   ├── media-files.ts
│   │   ├── media-variants.ts
│   │   └── upload-intents.ts
│   ├── middleware/
│   │   └── service-auth.ts    # preHandler for all /media/internal/* routes
│   ├── jobs/
│   │   └── cleanup.ts         # hourly node-cron: delete expired intents + pending files + variants
│   └── index.ts
├── migrations/
├── test/
│   ├── unit/
│   └── integration/
├── Dockerfile
├── package.json
└── tsconfig.json
```

---

## 12. Key Decisions Summary

| Decision | Choice | Rationale |
|---|---|---|
| Upload flow | Presigned PUT + confirm (primary), proxy (secondary) | No memory pressure during upload; both paths converge on same processing logic |
| Access tiers | Two S3 buckets — public (CloudFront) + private (signed URLs) | Email assets need permanent stable URLs; consent photos need location-gated access |
| S3 key format | `{upload_id}/{uuid}.{ext}` / `{location_id}/{upload_id}/{uuid}.{ext}` | Discards original filename (avoids special-char issues); preserves extension; deterministic pre-computation |
| AWS SDK | v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) | Current standard; modular bundles |
| Image processing | `sharp`, synchronous on confirm/upload, pinned prebuilt binary | Avoids BullMQ; image sizes are small; no native compilation in Docker |
| Multipart parsing | `@fastify/multipart` with `limits: { fileSize }` | Standard Fastify plugin; plugin-level abort avoids manual stream tracking |
| Private URL TTL | 15 minutes (`PRESIGNED_GET_TTL_SECONDS`) | Short enough to prevent URL sharing, long enough for normal UI interactions |
| Confirm concurrency | `ON CONFLICT DO NOTHING` on `upload_id` unique constraint | Idempotent; second call returns `404`; no row-level lock needed |
| S3 download failure | `502` on confirm | Distinguishes "record not found" (`404`) from "S3 retrieval failure" (`502`) |
| Variant failure | No rollback; partial rows OK; `GET` omits missing URLs | Simple; original is always usable; avoids complexity of compensating transactions |
| Variant URL response | Return only existing variants (no null slots) | Callers can branch on presence/absence without null checks |
| Access enforcement | JWT `location_id` claim vs file metadata | Consistent with other platform services; no Identity Service call per request |
| Confirm authorization | JWT `sub` must match `uploaded_by` | Prevents one user from confirming another user's pending upload |
| Internal auth | Shared `preHandler` in `service-auth.ts` applied to prefix | Single auth point for all internal routes; consistent pattern |
| DB access | Knex instantiated directly in service | `@ortho/db` is used as migration runner only per project convention |
| Orphan cleanup | `node-cron` hourly, explicit variant delete before file delete | No `ON DELETE CASCADE`; no BullMQ; transactional safety; scoped to expired intents only |
| Event bus | `@ortho/event-bus` wired publish-only (zero subscriptions) | No events at launch; ready for future use without structural change |
| Logger | `createLogger('platform-media')` | Consistent with platform service naming convention |
| Validation | TypeBox schemas via `fastify.addSchema` | Consistent with stack; compile-time type inference + runtime AJV validation |
| Testing | Unit (mocked S3/DB) + integration (LocalStack + real DB) | Validates real S3 API surface and DB behaviour without full infra |
