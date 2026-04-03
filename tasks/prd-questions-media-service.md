# Clarifying Questions: Media Service

> Original request: Generate PRD for the Media Service as specified in `docs/superpowers/specs/2026-03-25-media-service-design.md` — presigned PUT upload flow, proxy multipart upload, image processing with sharp, public/private S3 bucket access tiers, CloudFront delivery, and internal service-to-service endpoints.

## Questions

1. Which AWS SDK version should be used for S3 and presigned URL operations?
   A. AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) — current standard
   B. AWS SDK v2 (`aws-sdk`) — legacy, consistent with any existing services
   C. Other: [please specify]

   **Answer:** A

2. How should S3 interactions be tested in unit and integration tests?
   A. Mock the AWS SDK clients with `vi.mock` in unit tests; no real S3 calls
   B. Use a LocalStack Docker container for integration tests (real S3 API surface)
   C. Mock SDK in unit tests; a separate optional integration test suite using LocalStack
   D. Use `@aws-sdk/client-s3`'s built-in mock helpers only
   E. Use `@aws-sdk/client-s3`; Use a LocalStack Docker container for integration tests

   **Answer:** E

3. How should the `@ortho/db` package be used for database access?
   A. Use `@ortho/db` for the Knex instance and migration runner (consistent with other services)
   B. Instantiate Knex directly in the service (`apps/platform/media`) — `@ortho/db` is just a migration runner
   C. Use Drizzle ORM directly — skip Knex
   D. Other: [please specify]

   **Answer:** B

4. The spec requires Fastify multipart uploads for `POST /media/upload` and `POST /media/internal/store`. Which plugin should handle multipart parsing?
   A. `@fastify/multipart` — standard Fastify plugin, supports streaming
   B. `busboy` directly (without the Fastify wrapper)
   C. Other: [please specify]

   **Answer:** A

5. For `POST /media/upload` (proxy upload), how should the 20MB limit be enforced during streaming before the full file is buffered?
   A. Pass `limits: { fileSize: MAX_FILE_SIZE_BYTES }` to `@fastify/multipart` — plugin aborts and returns 413
   B. Manually track accumulated bytes in a `Transform` stream and abort when limit is exceeded
   C. Buffer the entire file first and check size before processing
   D. Other: [please specify]

   **Answer:** A

6. The spec says image processing runs synchronously on confirm/upload. If `sharp` fails on a corrupt file, the original is stored and `status = 'ready'` — no `500` returned. Should variant creation failure also roll back the `media_variants` inserts, or leave partial rows and let the service skip missing variants?
   A. On failure after partial variant inserts, roll back inserted `media_variants` rows in the same transaction; store original only
   B. Wrap the three S3 PUTs and two `media_variants` inserts in a single transaction — all-or-nothing
   C. No rollback — partial variant rows are acceptable; `GET /media/:file_id` omits urls for missing variants
   D. Other: [please specify]

   **Answer:** C

7. `sharp` requires native binaries. How should the Docker image handle this?
   A. Build `sharp` from source in the Dockerfile using the Node 24 Alpine base (add `build-essential`, `vips-dev`)
   B. Use `node:24-slim` (Debian-based) which supports prebuilt `sharp` binaries without extra build deps
   C. Pin `sharp` to a version that ships prebuilt binaries for `linux/amd64` and skip native compilation
   D. Other: [please specify]

   **Answer:** C

8. The spec uses `node-cron` for the hourly orphan cleanup job. Should `node-cron` be added as a production dependency, or is there a preferred alternative?
   A. `node-cron` — as specified, registered at Fastify startup
   B. `@fastify/schedule` plugin wrapping `toad-scheduler` (consistent Fastify ecosystem)
   C. A simple `setInterval` inside Fastify's `onReady` hook — no cron library needed
   D. Other: [please specify]

   **Answer:** A

9. For `POST /media/confirm/:upload_id`, the service downloads the original from S3 before processing. Should a download failure (S3 `NoSuchKey`, network error) return `404` or `502`?
   A. `404` — treat a missing S3 object as an invalid upload regardless of cause
   B. `502` — distinguish between "record not found" (`404`) and "S3 retrieval failure" (`502`)
   C. `500` — generic internal error; let the caller retry
   D. Other: [please specify]

   **Answer:** B

10. The presigned PUT URL response includes `upload_id` and `expires_at`. Should the `expires_at` value be computed from `PRESIGNED_PUT_TTL_SECONDS` and returned as an ISO 8601 string in the API response, or stored only in `media_upload_intents` and not surfaced to the caller?
    A. Compute and return `expires_at` in the response (caller can display a countdown or handle expiry gracefully)
    B. Store in DB only — do not return in the API response (spec shows it in the response, follow the spec exactly)
    C. Other: [please specify]

    **Answer:** A

11. For `GET /media/:file_id` on a public file, should the service return permanent CloudFront URLs for all variants, or only the variants that were successfully generated (omitting failed/missing ones)?
    A. Return only URLs for variants that exist in `media_variants` (original always included from `media_files.original_key`)
    B. Always return all three URL slots (`original`, `medium`, `thumb`); set to `null` for missing variants
    C. Return all three URL slots, omitting keys entirely for missing variants (consistent with confirm response spec)
    D. Other: [please specify]

    **Answer:** A

12. The spec specifies `SERVICE_AUTH_TOKEN` as a shared secret for internal endpoints. How should the `preHandler` check be structured?
    A. A standalone Fastify plugin (`fastify-service-auth`) that registers a `preHandler` for all `/media/internal/*` routes
    B. An inline `preHandler` on each internal route handler
    C. A shared `preHandler` function in `src/middleware/service-auth.ts` applied to the internal router prefix
    D. Other: [please specify]

    **Answer:** C

13. The spec's orphan cleanup deletes `media_files` first, then `media_upload_intents` in a single transaction. Should the cleanup also delete orphaned `media_variants` rows (children of deleted `media_files`), or rely on `ON DELETE CASCADE`?
    A. Add `ON DELETE CASCADE` to `media_variants.file_id` FK — DB handles cascade automatically
    B. Explicitly delete `media_variants` rows in the cleanup transaction before deleting `media_files`
    C. Orphaned variants cannot exist in practice (variants are only created after confirm, not during pending state) — no action needed
    D. Other: [please specify]

    **Answer:**  B

14. How should the `original_key` S3 key be derived for the presigned PUT flow? The spec says it's pre-computed from `upload_id` + `filename`.
    A. `{upload_id}/{original_filename}` for public; `{location_id}/{upload_id}/{original_filename}` for private (matches spec's private bucket key format)
    B. `{upload_id}/{sanitized_filename}` — strip non-ASCII/special characters from the filename before use in the key
    C. `{upload_id}/{uuid}.{extension}` — discard original filename, preserve extension only
    D. Other: [please specify]

    **Answer:** C

15. Should request body validation use TypeBox schemas registered with Fastify's schema compiler, or a manual validation approach?
    A. TypeBox schemas compiled with `@sinclair/typebox` and registered via `fastify.addSchema` / `schema: { body: ... }` on each route
    B. Manual validation in route handlers using `TypeCompiler` from TypeBox
    C. Zod (if used elsewhere in the monorepo)
    D. Other: [please specify]

    **Answer:** A

16. What test coverage level is expected for this service?
    A. Unit tests for image-processor, s3 helper, signed-url service, and repositories; integration tests for route handlers against a real DB + LocalStack S3
    B. Unit tests only (mocked DB and S3); no integration tests in this PRD
    C. Unit tests for business logic; integration tests for DB repositories only (no LocalStack)
    D. Other: [please specify]

    **Answer:** A

17. The spec says `@ortho/logger` (`createLogger`) should be used. What service name string should be passed to `createLogger`?
    A. `'media'`
    B. `'platform-media'`
    C. `'ortho-media'`
    D. Other: [please specify]

    **Answer:** B

18. The `@ortho/event-bus` is not mentioned in the spec (no events published). Should the service still wire up the event bus for future use (e.g. `publish-only` mode, start with zero subscriptions), or omit it entirely?
    A. Omit `@ortho/event-bus` entirely — the spec is explicit that no events are published
    B. Include it wired up in publish-only mode (`bus.start()` with zero subscriptions) so it's ready when needed
    C. Other: [please specify]

    **Answer:** B

19. The `@ortho/interpolator` and `@platform/filter-engine` packages are referenced in the ADRs but have no obvious role in the Media Service. Should they be excluded entirely?
    A. Yes — exclude both; Media Service has no template interpolation or filter evaluation needs
    B. Include `@ortho/interpolator` only if `purpose` field rendering or filename templating is needed (currently not in spec)
    C. Other: [please specify]

    **Answer:** A

20. How should the service handle concurrent `POST /media/confirm/:upload_id` calls for the same `upload_id` (e.g. double-tap from the browser)?
    A. Use a DB-level unique constraint + `ON CONFLICT DO NOTHING` to make the confirm idempotent; second call returns `404`
    B. Use a DB transaction with `SELECT ... FOR UPDATE` on the intent row to serialize concurrent confirms; second caller gets `404` after the first completes
    C. Return `404` immediately if `status != 'pending'` — rely on the status check as the concurrency guard (existing spec behavior)
    D. Other: [please specify]

    **Answer:** A
