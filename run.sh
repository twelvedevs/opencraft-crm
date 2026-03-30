#!/bin/bash

echo "* Starting Phase 1"

# claude -p 'Load the ralph skill. Read docs: - overall platform & product architecture at @docs/01-platform-arch-design.md ; - component architecture design @docs/superpowers/specs/2026-03-30-template-service-updated-design.md ; - implementation phases @docs/superpowers/specs/2026-03-30-template-service-phases.md . Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest. Write implementation plan for Phase 1, save to ./scripts/ralph/prd.json ' --dangerously-skip-permissions
# git add .
# git ci -m 'preparing for Phase 1'
./scripts/ralph/ralph-cc.sh 20

echo "* Phase 1 Finished"

echo "* * * * * * * * * * * * * * * * * * * * * * * *"


echo "* Starting Phase 2"

claude -p 'Load the ralph skill. Read docs: - overall platform & product architecture at @docs/01-platform-arch-design.md ; - component architecture design @docs/superpowers/specs/2026-03-30-template-service-updated-design.md ; - implementation phases @docs/superpowers/specs/2026-03-30-template-service-phases.md . Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest. Write implementation plan for Phase 2, save to ./scripts/ralph/prd.json ' --dangerously-skip-permissions
git add .
git ci -m 'preparing for Phase 2'
./scripts/ralph/ralph-cc.sh 20

echo "* Phase 2 Finished"

echo "* * * * * * * * * * * * * * * * * * * * * * * *"


echo "* Starting Phase 3"

claude -p 'Load the ralph skill. Read docs: - overall platform & product architecture at @docs/01-platform-arch-design.md ; - component architecture design @docs/superpowers/specs/2026-03-30-template-service-updated-design.md ; - implementation phases @docs/superpowers/specs/2026-03-30-template-service-phases.md . Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest. Write implementation plan for Phase 3, save to ./scripts/ralph/prd.json ' --dangerously-skip-permissions
git add .
git ci -m 'preparing for Phase 3'
./scripts/ralph/ralph-cc.sh 20

echo "* Phase 3 Finished"

echo "* * * * * * * * * * * * * * * * * * * * * * * *"


echo "* Starting Phase 4"

claude -p 'Load the ralph skill. Read docs: - overall platform & product architecture at @docs/01-platform-arch-design.md ; - component architecture design @docs/superpowers/specs/2026-03-30-template-service-updated-design.md ; - implementation phases @docs/superpowers/specs/2026-03-30-template-service-phases.md . Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest. Write implementation plan for Phase 4, save to ./scripts/ralph/prd.json ' --dangerously-skip-permissions
git add .
git ci -m 'preparing for Phase 4'
./scripts/ralph/ralph-cc.sh 20

echo "* Phase 4 Finished"

echo "* * * * * * * * * * * * * * * * * * * * * * * *"


echo "* Starting Phase 5"

claude -p 'Load the ralph skill. Read docs: - overall platform & product architecture at @docs/01-platform-arch-design.md ; - component architecture design @docs/superpowers/specs/2026-03-30-template-service-updated-design.md ; - implementation phases @docs/superpowers/specs/2026-03-30-template-service-phases.md . Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest. Write implementation plan for Phase 5, save to ./scripts/ralph/prd.json ' --dangerously-skip-permissions
git add .
git ci -m 'preparing for Phase 5'
./scripts/ralph/ralph-cc.sh 20

echo "* Phase 5 Finished"

echo "* * * * * * * * * * * * * * * * * * * * * * * *"

echo "* * * * * * * *  ALL DONE  * * * * * * * * * * * *"
