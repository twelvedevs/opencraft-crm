# Ortho Prompts


`claude -p 'Load the prd-questions skill and generate questions for tasks explained in @docs/00-intro.md & @docs/01-architecture.md ' --dangerously-skip-permissions`


`claude -p "Load the ralph skill and convert tasks/prd-booking-paas.md to prd.json" --dangerously-skip-permissions`

`claude -p 'Load the prd-questions skill and generate questions for tasks explained in @docs/00-intro.md & @docs/01-architecture.md ' --dangerously-skip-permissions`



`claude -p 'Load the prd-questions skill and generate questions for tasks explained in @docs/00-intro.md & @docs/01-architecture.md ' --dangerously-skip-permissions`



`claude -p 'Load the prd-questions skill and generate questions for tasks explained in @docs/00-intro.md & @docs/01-architecture.md ' --dangerously-skip-permissions`




`claude -p "Load the ralph skill,  and convert tasks/prd-resource-filter-deduplication.md to prd.json" --dangerously-skip-permissions`



#### Automation engine

```
Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-24-automation-engine-design.md
```


```
Load superpowers:writing-plans skill.
Write plan for @docs/superpowers/specs/2026-03-24-automation-engine-design.md , take into account clarifying questions and answers in @tasks/prd-questions-automation-engine.md . Keep @platform/automation-ui React component aside for this phase, work only on backend.
```

```
Load superpowers:writing-plans skill.
Read docs:
- component architecture design @docs/superpowers/specs/2026-03-24-automation-engine-design.md
- clarifying questions and answers @tasks/prd-questions-automation-engine.md
- implementation phases @docs/superpowers/specs/2026-03-27-automation-engine-phases.md
Write implementation plan for Phase 1.
```


```
Read full spec of the component as @docs/superpowers/specs/2026-03-24-automation-engine-design.md , take into account clarifying questions and answers in @tasks/prd-questions-automation-engine.md . We need to plan implementation of this component in phases. Just suggest me list of phases with deliverables. No need to write detailed implementation plan yet.
Keep @platform/automation-ui React component aside for this phase, work only on backend.
```


```
Read full spec of the component as @docs/superpowers/specs/2026-03-25-email-service-design.md , take into account clarifying questions and answers in @tasks/prd-questions-automation-engine.md . We need to plan implementation of this component in phases. Just suggest me list of phases with deliverables. No need to write detailed implementation plan yet.
Keep @platform/automation-ui React component aside for this phase, work only on backend.
```



```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-24-automation-engine-design.md
- clarifying questions and answers @tasks/prd-questions-automation-engine.md
- implementation phases @docs/superpowers/specs/2026-03-27-automation-engine-phases.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Write implementation plan for Phase 1, store to prd.json
```



```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-24-automation-engine-design.md
- clarifying questions and answers @tasks/prd-questions-automation-engine.md
- implementation phases @docs/superpowers/specs/2026-03-27-automation-engine-phases.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Write implementation plan for Phase 3, store to prd.json
```



`claude -p 'Load the ralph skill. Read docs:  - overall platform & product architecture at @docs/01-platform-arch-design.md;  - component architecture design @docs/superpowers/specs/2026-03-24-automation-engine-design.md;  - clarifying questions and answers @tasks/prd-questions-automation-engine.md;  - implementation phases @docs/superpowers/specs/2026-03-27-automation-engine-phases.md .  Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest . Write implementation plan for Phase 7, store to prd.json.' --dangerously-skip-permissions ; git add . ; git ci -m 'preparing for Phase 7' ; ./scripts/ralph/ralph-cc.sh 20`






#### EventBus adapter

```
Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-29-event-bus-adapter-design.md
```

	claude -p " ... " --dangerously-skip-permissions

	claude -p "Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-29-event-bus-adapter-design.md" --dangerously-skip-permissions

	claude -p "Load the ralph skill and convert tasks/prd-questions-event-bus-adapter.md to prd.json" --dangerously-skip-permissions




#### Email Service


```
Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-email-service-design.md
```
1) `claude -p 'Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-email-service-design.md' --dangerously-skip-permissions`
2) ~~`claude -p "Load the ralph skill and convert tasks/prd-email-service.md (with original doc @docs/superpowers/specs/2026-03-25-email-service-design.md ) to prd.json" --dangerously-skip-permissions`~~


```
Read full spec of the component as @docs/superpowers/specs/2026-03-25-email-service-design.md 
Take into account clarifying questions and answers in @tasks/prd-email-service.md
Read spec of the event-bus adapter at @docs/superpowers/specs/2026-03-29-event-bus-adapter-design.md
We need to plan implementation of Email Service in phases. Just suggest me list of phases with deliverables. No need to write detailed implementation plan yet.
```




```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-25-email-service-design.md
- clarifying questions and answers @tasks/prd-email-service.md
- implementation phases @docs/superpowers/specs/2026-03-29-email-service-phases.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Write implementation plan for Phase 1, store to prd.json
```

```bash
claude -p 'Load the ralph skill. Read docs: - overall platform & product architecture at @docs/01-platform-arch-design.md ; - component architecture design @docs/superpowers/specs/2026-03-25-email-service-design.md ; - clarifying questions and answers @tasks/prd-email-service.md ; - implementation phases @docs/superpowers/specs/2026-03-29-email-service-phases.md . Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest . Write implementation plan for Phase 1, store to prd.json ' --dangerously-skip-permissions ; git add . ; git ci -m 'preparing for Phase 1' ; ./scripts/ralph/ralph-cc.sh 20
```



```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-29-email-service-updated-design.md
- implementation phases @docs/superpowers/specs/2026-03-29-email-service-phases.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Write implementation plan for Phase 2, store to prd.json
```



Parallel idea:
```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-25-email-service-design.md
- clarifying questions and answers @tasks/prd-email-service.md
- implementation phases @docs/superpowers/specs/2026-03-29-email-service-phases.md
- Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Update component architecture design @docs/superpowers/specs/2026-03-25-email-service-design.md with clarifications you got from  @tasks/prd-email-service.md
Store updated component arch design at file @docs/superpowers/specs/2026-03-29-email-service-updated-design.md
```

#### Packages


```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
Scan packages implementation in:
- packages/@ortho/event-bus
- packages/@ortho/logger
Write packages API description so that other consumers of these packages know how to use it. Provide several examples. Format should be similar to ADR.
Store documents in
- docs/arch/adr-logger.md
- docs/arch/adr-event-bus.md
```



#### Notification Service

```
Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-notification-service-design.md
```
- `claude -p 'Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-notification-service-design.md' --dangerously-skip-permissions`

```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-25-notification-service-design.md
- clarifying questions and answers @tasks/prd-notification-service.md
- Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Update component architecture design @docs/superpowers/specs/2026-03-25-notification-service-design.md with clarifications you got from  @tasks/prd-notification-service.md
Store updated component arch design at file @docs/superpowers/specs/2026-03-30-notification-service-updated-design.md
```

```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-30-notification-service-updated-design.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Write implementation plan, store to prd.json
```

