# Media / File Service — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Component:** `apps/platform/media` — platform layer service
**DB Schema:** `platform_media`

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
- CloudFront URL format: `https://media.ortho.app/{upload_id}/{filename}.webp`
- Objects are immutable once written — no in-place updates, only new uploads
- Cache-Control: `max-age=31536000, immutable`

**`ortho-media-private`** — No public access. Accessed exclusively via S3 presigned GET URLs with 15-minute TTL.

- Stores: before-after consent photos, generated PDF reports, any file requiring location-scoped access
- S3 key format: `{location_id}/{upload_id}/{filename}` — `location_id` prefix is enforced server-side, not just stored as metadata

### 2.2 Image Variants

When an image upload is processed, three S3 objects are written (both public and private buckets):

| Variant | Max Width | Format | Quality |
|---|---|---|---|
| `original` | unchanged | original format | lossless |
| `medium` | 800px | WebP | 85 |
| `thumb` | 200px | WebP | 80 |

Aspect ratio is always preserved. Non-image files (PDFs, etc.) are stored as a single object with no variants.

### 2.3 CloudFront Distribution

A single CloudFront distribution sits in front of the public bucket only. The private bucket is never behind CloudFront — signed S3 URLs are issued directly.

---

## 3. API Design

All endpoints require a valid JWT (via `@ortho/auth-middleware`) except internal service-to-service endpoints, which require a shared service auth token.

### 3.1 Upload Flow — Presigned PUT (preferred for large files)

**`POST /media/upload-url`**

Issues a presigned S3 PUT URL. Creates a `media_files` record in `pending` status.

Request:
```json
{
  "filename": "logo.png",
  "mime_type": "image/png",
  "tier": "public",
  "location_id": "uuid",
  "purpose": "brand_logo"
}
```

- `tier`: `"public"` or `"private"`. Required.
- `location_id`: optional. Stored on the file record; required for private files that need location-scoped access control.
- `purpose`: optional opaque string stored as metadata — Media Service does not interpret it.

Response:
```json
{
  "upload_id": "uuid",
  "upload_url": "https://s3.amazonaws.com/...",
  "expires_at": "2026-03-25T10:15:00Z"
}
```

Returns `413` if `Content-Length` header indicates file exceeds 20MB limit.

---

**`POST /media/confirm/:upload_id`**

Caller invokes after the browser has completed the S3 PUT. Media Service downloads the original from S3, runs image processing if applicable, writes variants, and marks the record `ready`.

Response (same shape as proxy upload):
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
  "created_at": "2026-03-25T10:00:00Z"
}
```

- For private files, all URLs in the response are presigned S3 GET URLs (15-min TTL), not permanent CloudFront URLs.
- `medium` and `thumb` are omitted for non-image files.
- Returns `404` if `upload_id` not found or already confirmed.
- Returns `410` if presigned PUT URL has expired.

---

### 3.2 Upload Flow — Proxy (callers preferring single call)

**`POST /media/upload`**

Accepts `multipart/form-data`. Streams file to S3, processes inline, returns complete file record immediately. Same response shape as `POST /media/confirm`.

Form fields: `file` (binary), `tier`, `location_id` (optional), `purpose` (optional).

Returns `413` if file exceeds 20MB.

---

### 3.3 File Access

**`GET /media/:file_id`**

Returns file metadata and URL(s).

- **Public files:** returns permanent CloudFront URL(s). No location check.
- **Private files:** validates JWT `location_id` claim matches `file.location_id`, then issues fresh presigned S3 GET URLs (15-min TTL). Returns `403` if claim does not match.

Returns `404` if file not found or `status = 'deleted'`.

Response:
```json
{
  "file_id": "uuid",
  "tier": "public",
  "mime_type": "image/png",
  "purpose": "brand_logo",
  "location_id": "uuid",
  "urls": {
    "original": "...",
    "medium": "...",
    "thumb": "..."
  },
  "created_at": "2026-03-25T10:00:00Z"
}
```

---

**`DELETE /media/:file_id`**

Soft-delete. Sets `deleted_at`, does not remove S3 object. Requires JWT `location_id` claim to match `file.location_id`. Returns `204` on success.

---

### 3.4 Internal Service-to-Service Endpoints

Require `Authorization: Bearer <SERVICE_AUTH_TOKEN>` (shared secret). No user JWT. No `location_id` enforcement — calling service is trusted to have already authorized the user.

**`POST /media/internal/store`**

Used by Reporting Service to store a generated PDF. Accepts raw bytes + metadata, bypasses presigned flow.

Request: `multipart/form-data` with fields `file`, `tier` (`"private"`), `location_id` (optional), `purpose` (e.g. `"report_pdf"`).

Response: `{ file_id, urls: { original } }`

---

**`GET /media/internal/:file_id/signed-url`**

Issues a presigned S3 GET URL for a private file without checking `location_id`. Used when Reporting Service emails a PDF link to a marketing manager (all-location access, no single `location_id` claim).

Response: `{ signed_url, expires_at }`

---

## 4. Data Model

### `media_files`

One row per upload. Created at `POST /media/upload-url` (pending) or `POST /media/upload` (ready).

```sql
CREATE TABLE platform_media.media_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id       uuid UNIQUE NOT NULL,
  tier            text NOT NULL CHECK (tier IN ('public', 'private')),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'ready', 'deleted')),
  mime_type       text NOT NULL,
  original_key    text NOT NULL,       -- S3 object key
  location_id     uuid,                -- null for future global assets
  purpose         text,                -- opaque caller-supplied tag
  uploaded_by     uuid NOT NULL,       -- JWT sub
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  deleted_at      timestamptz
);

CREATE INDEX ON platform_media.media_files (location_id);
CREATE INDEX ON platform_media.media_files (status, created_at)
  WHERE status = 'pending';
```

### `media_variants`

One row per processed image variant. Only created for image `mime_type` files.

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

**Orphan cleanup:** A simple hourly cron job deletes expired intents and their associated `pending` file records:

```sql
DELETE FROM platform_media.media_upload_intents
WHERE expires_at < now();

DELETE FROM platform_media.media_files
WHERE status = 'pending'
  AND created_at < now() - interval '1 hour';
```

No BullMQ required — a Fastify startup cron via `node-cron` is sufficient.

---

## 5. Image Processing

### 5.1 Library

`sharp` — Node.js binding to libvips. Fast, low-memory, no ImageMagick dependency.

### 5.2 Processing Pipeline

Triggered by `POST /media/confirm/:upload_id` (downloads original from S3 first) and `POST /media/upload` (uses buffered stream). Both paths call the same `processImage()` function in `src/services/image-processor.ts`.

1. Detect actual image dimensions via `sharp.metadata()`
2. Generate `medium` variant: resize to max 800px width (preserve aspect ratio), convert to WebP, quality 85
3. Generate `thumb` variant: resize to max 200px width, convert to WebP, quality 80
4. Write all three S3 objects in parallel (`Promise.all`)
5. Insert rows into `media_variants`
6. Update `media_files`: `status = 'ready'`, `confirmed_at = now()`

### 5.3 Supported Image Types

`image/jpeg`, `image/png`, `image/gif`, `image/webp`. Any other `mime_type` is treated as a binary — stored as-is, no variants generated.

### 5.4 Size Limit

20MB per file. Enforced at `POST /media/upload-url` and at the proxy endpoint. Returns `413` with `{ "error": "File exceeds 20MB limit" }`.

### 5.5 Error Handling

If `sharp` processing fails (corrupt file, unsupported encoding): store original as-is, mark `status = 'ready'`, omit variants from response. Log warning to Datadog. No `500` returned to caller — original URL is always usable.

---

## 6. Access Control

### 6.1 Public Files

No auth check on the CloudFront URL — objects are publicly accessible once written. Auth is enforced only at upload time (valid JWT required). Callers must use `tier: "public"` only for assets safe to be publicly reachable (logos, email images).

### 6.2 Private Files — User-Facing

On `GET /media/:file_id`:

1. Validate JWT via `@ortho/auth-middleware`
2. Load `media_files` row — `404` if not found or `status = 'deleted'`
3. If `file.location_id IS NOT NULL`: verify JWT claims contain a matching `location_id` — `403` if not
4. If `file.location_id IS NULL`: any authenticated user may access (reserved for future global assets)
5. Issue presigned S3 GET URL with 15-minute TTL via AWS SDK
6. Return signed URL in response — Media Service does not redirect; caller fetches S3 directly

### 6.3 Private Files — Service-to-Service

`GET /media/internal/:file_id/signed-url` requires `Authorization: Bearer <SERVICE_AUTH_TOKEN>`. No `location_id` check. Used by Reporting Service when emailing PDF links to marketing managers (all-location access).

### 6.4 Upload Authorization

Any authenticated user may upload. The `location_id` on the file is taken from the request body — Media Service does not infer it from the JWT. The calling service is responsible for passing the correct `location_id`. This keeps the Media Service domain-agnostic.

---

## 7. Integration Map

The Media Service publishes no EventBridge events. All integration is synchronous REST.

| Caller | Endpoint | Purpose |
|---|---|---|
| CRM Web App (browser) | `POST /media/upload-url` + `POST /media/confirm/:id` | Upload brand logos, before-after photos via email designer |
| CRM Web App (browser) | `GET /media/:file_id` | Retrieve signed URL to display a private image |
| Reporting Service | `POST /media/internal/store` | Store a generated PDF report |
| Reporting Service | `GET /media/internal/:file_id/signed-url` | Get signed URL to embed in email delivery |
| Any server-side service | `POST /media/upload` | Proxy upload (simpler single-call integration) |

---

## 8. Configuration

| Env Var | Description | Default |
|---|---|---|
| `AWS_REGION` | AWS region | `us-east-1` |
| `S3_PUBLIC_BUCKET` | Public bucket name | — |
| `S3_PRIVATE_BUCKET` | Private bucket name | — |
| `CLOUDFRONT_BASE_URL` | e.g. `https://media.ortho.app` | — |
| `PRESIGNED_URL_TTL_SECONDS` | TTL for presigned PUT and GET URLs | `900` |
| `SERVICE_AUTH_TOKEN` | Shared secret for internal endpoints | — |
| `DATABASE_URL` | Postgres connection string | — |
| `MAX_FILE_SIZE_BYTES` | Upload size limit | `20971520` |

AWS credentials are supplied via ECS task role in production (no `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` needed).

---

## 9. Service Structure

```
apps/platform/media/
├── src/
│   ├── routes/
│   │   ├── upload.ts          # POST /media/upload-url, /media/upload, /media/confirm/:id
│   │   ├── files.ts           # GET /media/:file_id, DELETE /media/:file_id
│   │   └── internal.ts        # POST /media/internal/store, GET /media/internal/:id/signed-url
│   ├── services/
│   │   ├── image-processor.ts # sharp resize + WebP conversion
│   │   ├── s3.ts              # AWS SDK upload, download, presign helpers
│   │   └── signed-url.ts      # presigned GET URL issuance + TTL
│   ├── repositories/
│   │   ├── media-files.ts
│   │   ├── media-variants.ts
│   │   └── upload-intents.ts
│   ├── jobs/
│   │   └── cleanup.ts         # hourly cron: delete expired intents + pending files
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

---

## 10. Key Decisions Summary

| Decision | Choice | Rationale |
|---|---|---|
| Upload flow | Presigned PUT + confirm (primary), proxy (secondary) | No memory pressure during upload; both paths converge on same processing logic |
| Access tiers | Two S3 buckets — public (CloudFront) + private (signed URLs) | Email assets need permanent stable URLs; consent photos need location-gated access |
| Image processing | `sharp`, synchronous on confirm/upload | Avoids BullMQ; image sizes are small enough that sync processing adds negligible latency |
| Private URL TTL | 15 minutes | Short enough to prevent URL sharing, long enough for normal UI interactions |
| Access enforcement | JWT `location_id` claim vs file metadata | Consistent with Notification and Audience Engine patterns; no Identity Service call per request |
| Internal endpoints | Shared service auth token, no `location_id` check | Reporting Service operates across all locations; trusts calling service to have authorized the user |
| Orphan cleanup | Hourly `node-cron` job | No BullMQ needed for a simple time-based sweep |
| Events published | None | All callers are synchronous; no downstream service needs to react to file uploads |
