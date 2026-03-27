
### Notification Service — Key API Decisions

Transport: SSE (not WebSocket) — strictly server-to-client. Product services call `POST /notifications/publish` directly (no EventBridge). Redis pub/sub (`PSUBSCRIBE notif:*`) handles cross-instance fan-out. Channels are arbitrary strings; channel access control enforced via JWT claims (`location:{id}:*` checks location claims, `user:{id}:*` checks JWT subject). Persistence: 7-day TTL, one row per publish, per-user read state in `notification_reads`. `Last-Event-ID` replay uses monotonic `seq bigint` (Postgres sequence), not UUID. `read-all` publishes single bulk Redis message → `event: read-all` SSE type. `POST /notifications/:id/read` returns `404` for expired/missing notifications.
