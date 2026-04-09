#!/usr/bin/env bash
# scripts/build-remaining.sh
# Orchestrates the full build pipeline for the 4 remaining unimplemented CRM services.
#
# Usage:
#   ./scripts/build-remaining.sh              — build all 4 remaining services in sequence
#   ./scripts/build-remaining.sh reporting    — build only Reporting Service
#   ./scripts/build-remaining.sh data-import  — build only Data Import Service
#   ./scripts/build-remaining.sh api-gateway  — build only CRM API Gateway
#   ./scripts/build-remaining.sh web          — build only CRM Web App
#
# To resume a service from a specific step (e.g. skip Q&A that's already done):
#   ./scripts/build-remaining.sh reporting --skip-to 3
#
# Services build order matters: reporting and data-import have no inter-dependencies,
# api-gateway depends on all services being ready, web depends on api-gateway.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TODAY=$(date +%Y-%m-%d)

# Extra args forwarded to build-module.sh (e.g. --skip-to 3 --max-iterations 30)
EXTRA_ARGS=()
SERVICE_FILTER="${1:-all}"
shift 2>/dev/null || true
while [[ $# -gt 0 ]]; do EXTRA_ARGS+=("$1"); shift; done

build_reporting() {
  "$SCRIPT_DIR/build-module.sh" \
    --service-name "Reporting Service" \
    --spec "2026-03-25-reporting-service-design.md" \
    --updated-spec "${TODAY}-reporting-service-updated-design.md" \
    --tasks-file "prd-questions-reporting-service.md" \
    --app-dir "apps/crm/reporting" \
    "${EXTRA_ARGS[@]}"
}

build_data_import() {
  "$SCRIPT_DIR/build-module.sh" \
    --service-name "Data Import Service" \
    --spec "2026-03-25-data-import-service-design.md" \
    --updated-spec "${TODAY}-data-import-service-updated-design.md" \
    --tasks-file "prd-questions-data-import-service.md" \
    --app-dir "apps/crm/import" \
    "${EXTRA_ARGS[@]}"
}

build_api_gateway() {
  "$SCRIPT_DIR/build-module.sh" \
    --service-name "CRM API Gateway" \
    --spec "2026-03-25-crm-api-gateway-design.md" \
    --updated-spec "${TODAY}-crm-api-gateway-updated-design.md" \
    --tasks-file "prd-questions-crm-api-gateway.md" \
    --app-dir "apps/crm/api-gateway" \
    --extra-packages "docs/arch/adr-logger.md docs/arch/adr-auth-middleware.md" \
    "${EXTRA_ARGS[@]}"
}

build_web_app() {
  "$SCRIPT_DIR/build-module.sh" \
    --service-name "CRM Web App" \
    --spec "2026-03-25-crm-web-app-design.md" \
    --updated-spec "${TODAY}-crm-web-app-updated-design.md" \
    --tasks-file "prd-questions-crm-web-app.md" \
    --app-dir "apps/crm/web" \
    --tech-stack "React 18, TypeScript 5, Tailwind CSS 3, React Query 5, Vite 5" \
    --extra-packages "docs/arch/adr-auth-middleware.md" \
    "${EXTRA_ARGS[@]}"
}

case "$SERVICE_FILTER" in
  reporting)
    build_reporting
    ;;
  data-import)
    build_data_import
    ;;
  api-gateway)
    build_api_gateway
    ;;
  web)
    build_web_app
    ;;
  all)
    echo "================================================================"
    echo "  Building all remaining CRM services"
    echo "  Order: reporting → data-import → api-gateway → web"
    echo "================================================================"
    build_reporting
    build_data_import
    build_api_gateway
    build_web_app
    echo ""
    echo "🎉  All remaining CRM services built!"
    ;;
  *)
    echo "Unknown service: $SERVICE_FILTER"
    echo "Available: reporting | data-import | api-gateway | web | all"
    exit 1
    ;;
esac
