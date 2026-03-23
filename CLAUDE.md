# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

This is a **pre-sale planning repository** for **Ortho CRM** — an orthodontic-specific CRM platform. The repo currently contains only a PRD (Product Requirements Document). No implementation exists yet.

## Repository Contents

- `docs/202603232109-ortho-crm-prd-1.md` — Full PRD (v1.0, March 2026). The authoritative source of truth for all product decisions.

## Planned Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript, Tailwind CSS, React Query |
| Backend | Node.js + TypeScript (Fastify), REST API |
| Database | PostgreSQL (AWS RDS) — shared cluster with EHR, separate schema |
| Auth | Supabase Auth / Auth0, RBAC, SSO with EHR |
| SMS/Voice | Twilio (two-way SMS, call tracking) |
| Email | SendGrid API |
| AI | Claude Sonnet 4.6 / Haiku 4.5 (smart replies, personalization, AI agent) |
| Ads APIs | Google Ads API, Meta Marketing API |
| Infrastructure | AWS us-east-1 (ECS Fargate, RDS, S3, CloudFront) |
| CI/CD | GitHub Actions |

## Core Architecture (from PRD)

**Three Patient Pipelines:**
1. **New Patient Pipeline** (7 stages): New Lead → Contacted → Exam Scheduled → Exam Completed → Tx Presented → Contract Signed → Lost
2. **In Treatment Pipeline** (3 stages): New Patient → In Treatment → Treatment Complete
3. **In Retention Pipeline** (3 stages): Active Retention → Recall Due → Long-term Follow

**Key Design Decisions:**
- Browser-first (no desktop app)
- Multi-location native (designed for 34 locations)
- No PHI at launch — leads are prospective patients only, making it non-HIPAA initially
- AI-augmented communications using Claude API for smart reply drafts, objection handling, and conversation summarization
- Attribution-focused: every lead tagged with full UTM chain + call source + referral origin
- Primary KPI: Cost per case start

**Role-Based Access (4 roles):** Call Center Agent, Call Center Manager, Marketing Staff, Marketing Manager

**Lead Channels:** Website forms, Google Ads, Facebook/Instagram Lead Ads, Twilio call tracking, referral links, walk-in/manual, chat widgets, Google Business Profile, CSV bulk import

**Integrations:**
- Ortho2 CSV bridge (weekly patient imports, daily appointment sync) until EHR launches
- EHR integration via event streaming + API (future)
- Google Ads API + Meta Marketing API for real-time spend/lead attribution
