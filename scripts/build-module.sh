#!/usr/bin/env bash
# scripts/build-module.sh
# Full automated pipeline for a single service module:
#   Step 1: Generate + auto-answer PRD questions (if not already done)
#   Step 2: Generate updated design doc (if not already done)
#   Step 3: Generate prd.json
#   Step 4: Commit preparation files
#   Step 5: Run Ralph implementation loop
#   Step 6: Archive prd.json + progress.txt via git mv
#   Step 7: Code review + auto-fix issues found
#
# Usage: ./scripts/build-module.sh [options]
#   Required:
#     --service-name    Human-readable name (e.g. "Reporting Service")
#     --spec            Original spec filename under docs/superpowers/specs/
#     --updated-spec    Updated spec filename to produce under docs/superpowers/specs/
#     --tasks-file      PRD questions filename under tasks/
#     --app-dir         Application directory (e.g. apps/crm/reporting)
#   Optional:
#     --tech-stack      Comma-separated tech stack string (default: standard Node.js)
#     --extra-packages  Space-separated ADR docs to include in prompts
#     --max-iterations  Ralph max iterations (default: 20)
#     --skip-to         Skip to a specific step: 1|2|3|4|5|6|7

set -euo pipefail

TODAY=$(date +%Y-%m-%d)

TECH_STACK="Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 0.34, Vitest 2, BullMQ latest"
EXTRA_PACKAGES="docs/arch/adr-logger.md docs/arch/adr-event-bus.md docs/arch/adr-auth-middleware.md"
MAX_RALPH_ITERATIONS=20
SKIP_TO=1

while [[ $# -gt 0 ]]; do
  case $1 in
    --service-name)   SERVICE_NAME="$2";   shift 2 ;;
    --spec)           SPEC_FILE="$2";      shift 2 ;;
    --updated-spec)   UPDATED_SPEC="$2";   shift 2 ;;
    --tasks-file)     TASKS_FILE="$2";     shift 2 ;;
    --app-dir)        APP_DIR="$2";        shift 2 ;;
    --tech-stack)     TECH_STACK="$2";     shift 2 ;;
    --extra-packages) EXTRA_PACKAGES="$2"; shift 2 ;;
    --max-iterations) MAX_RALPH_ITERATIONS="$2"; shift 2 ;;
    --skip-to)        SKIP_TO="$2";        shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

for var in SERVICE_NAME SPEC_FILE UPDATED_SPEC TASKS_FILE APP_DIR; do
  if [ -z "${!var:-}" ]; then
    echo "Error: --$(echo "$var" | tr '_' '-' | tr '[:upper:]' '[:lower:]') is required"
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

TASKS_PATH="tasks/$TASKS_FILE"
SPEC_PATH="docs/superpowers/specs/$SPEC_FILE"
UPDATED_SPEC_PATH="docs/superpowers/specs/$UPDATED_SPEC"

echo ""
echo "================================================================"
echo "  Building: $SERVICE_NAME"
echo "================================================================"
echo "  Spec:         $SPEC_PATH"
echo "  Updated spec: $UPDATED_SPEC_PATH"
echo "  Tasks:        $TASKS_PATH"
echo "  App dir:      $APP_DIR"
echo "  Skip to:      step $SKIP_TO"
echo "================================================================"

# ─── Step 1: Generate + auto-answer PRD questions ────────────────────────────
if [ "$SKIP_TO" -le 1 ]; then
  if [ -f "$TASKS_PATH" ]; then
    echo "✓ Step 1: PRD questions already exist at $TASKS_PATH"
  else
    echo "▶ Step 1: Generating and answering PRD questions..."

    PACKAGES_REF=""
    for pkg in $EXTRA_PACKAGES; do
      if [ -f "$pkg" ]; then
        PACKAGES_REF="$PACKAGES_REF- @$pkg"$'\n'
      fi
    done

    claude -p "Load the prd-questions skill.
Read the following docs thoroughly:
- overall platform & product architecture: @docs/01-platform-arch-design.md
- component architecture design: @$SPEC_PATH
${PACKAGES_REF:+- essential packages:
$PACKAGES_REF}
Task: Generate clarifying questions for $SERVICE_NAME as the prd-questions skill normally would.
Then immediately answer each question based on the design document, architecture doc,
and your engineering judgment.
Format: for each question, write the question then the answer below it.
Save the complete result (questions + answers) to $TASKS_PATH" \
      --dangerously-skip-permissions

    echo "✓ Step 1: PRD questions generated and answered."
  fi
fi

# ─── Step 2: Generate updated design doc ─────────────────────────────────────
if [ "$SKIP_TO" -le 2 ]; then
  if [ -f "$UPDATED_SPEC_PATH" ]; then
    echo "✓ Step 2: Updated design already exists at $UPDATED_SPEC_PATH"
  else
    echo "▶ Step 2: Generating updated design doc..."
    claude -p "Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture: @docs/01-platform-arch-design.md
- component architecture design: @$SPEC_PATH
- clarifying questions and answers: @$TASKS_PATH
- Tech Stack: $TECH_STACK
Update the component architecture design with the clarifications from the Q&A.
Store the updated design at $UPDATED_SPEC_PATH" \
      --dangerously-skip-permissions
    echo "✓ Step 2: Updated design generated."
  fi
fi

# ─── Step 3: Generate prd.json ───────────────────────────────────────────────
if [ "$SKIP_TO" -le 3 ]; then
  echo "▶ Step 3: Generating prd.json..."
  claude -p "Load the ralph skill.
Read docs:
- overall platform & product architecture: @docs/01-platform-arch-design.md
- component architecture design: @$UPDATED_SPEC_PATH
Tech Stack: $TECH_STACK.
Write implementation plan, store to scripts/ralph/prd.json" \
    --dangerously-skip-permissions
  echo "✓ Step 3: prd.json generated."
fi

# ─── Step 4: Commit preparation files ────────────────────────────────────────
if [ "$SKIP_TO" -le 4 ]; then
  echo "▶ Step 4: Committing preparation files..."
  SLUG=$(echo "$SERVICE_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
  git add \
    "docs/superpowers/specs/$UPDATED_SPEC" \
    "$TASKS_PATH" \
    "scripts/ralph/progress.txt" \
    "scripts/ralph/prd.json" 2>/dev/null || true
  git diff --cached --quiet && echo "(nothing to commit)" || \
    git commit -m "chore($SLUG): prepare implementation plan"
  echo "✓ Step 4: Committed."
fi

# ─── Step 5: Ralph implementation loop (reruns until all tasks pass) ─────────
if [ "$SKIP_TO" -le 5 ]; then
  RALPH_ROUND=1
  while true; do
    REMAINING=$(grep '"passes"' scripts/ralph/prd.json | grep false | wc -l | tr -d ' ')
    if [ "$REMAINING" -eq 0 ]; then
      echo "✓ Step 5: All tasks complete."
      break
    fi

    echo "▶ Step 5 (round $RALPH_ROUND): $REMAINING task(s) remaining — running Ralph (max $MAX_RALPH_ITERATIONS iterations)..."
    ./scripts/ralph/ralph-cc.sh "$MAX_RALPH_ITERATIONS" || true

    REMAINING_AFTER=$(grep '"passes"' scripts/ralph/prd.json | grep false | wc -l | tr -d ' ')
    if [ "$REMAINING_AFTER" -eq "$REMAINING" ]; then
      echo "⚠️  Step 5: No progress after round $RALPH_ROUND ($REMAINING_AFTER task(s) still pending). Stopping to avoid infinite loop."
      echo "   Check scripts/ralph/progress.txt for details, then resume with: --skip-to 5"
      exit 1
    fi

    RALPH_ROUND=$((RALPH_ROUND + 1))
  done
fi

# ─── Step 6: Archive prd.json + progress.txt ─────────────────────────────────
if [ "$SKIP_TO" -le 6 ]; then
  echo "▶ Step 6: Archiving prd.json and progress.txt..."
  SLUG=$(echo "$SERVICE_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
  ARCHIVE_DIR="scripts/ralph/archive/${TODAY}-${SLUG}"

  if [ -d "$ARCHIVE_DIR" ]; then
    # If the folder already exists (e.g. multi-phase service), append a suffix
    SUFFIX=2
    while [ -d "${ARCHIVE_DIR}-${SUFFIX}" ]; do SUFFIX=$((SUFFIX + 1)); done
    ARCHIVE_DIR="${ARCHIVE_DIR}-${SUFFIX}"
  fi

  mkdir -p "$ARCHIVE_DIR"

  [ -f "scripts/ralph/prd.json" ]     && git mv "scripts/ralph/prd.json"     "$ARCHIVE_DIR/prd.json"
  [ -f "scripts/ralph/progress.txt" ] && git mv "scripts/ralph/progress.txt" "$ARCHIVE_DIR/progress.txt"

  git diff --cached --quiet && echo "(nothing to archive)" || \
    git commit -m "chore($SLUG): archive ralph run → $ARCHIVE_DIR"

  echo "✓ Step 6: Archived to $ARCHIVE_DIR"
fi

# ─── Step 7: Code review + fix ───────────────────────────────────────────────
if [ "$SKIP_TO" -le 7 ]; then
  echo "▶ Step 7: Running code review and fixing issues..."
  claude -p "Load superpowers:requesting-code-review skill.
Review the implementation at @$APP_DIR against the spec at @$UPDATED_SPEC_PATH.
For every issue found: categorise it (critical / major / minor), explain what is wrong and why,
then fix it in the code.
After all fixes are applied, run typecheck and tests to confirm everything passes.
Commit any fixes with an appropriate conventional commit message." \
    --dangerously-skip-permissions
  echo "✓ Step 7: Code review complete."
fi

echo ""
echo "✅  $SERVICE_NAME — DONE"
echo "================================================================"
