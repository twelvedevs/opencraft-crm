# Ortho Prompts

#### Claude Code Docker container

https://code.claude.com/docs/en/devcontainer

#### Prompts

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

Code review:
```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- @docs/superpowers/specs/2026-03-30-nurturing-engine-updated-design.md
- @docs/superpowers/specs/2026-03-24-automation-engine-design.md

Do code-review of the package "interpolator" ( packages/@ortho/interpolator ) either it completely satisfies requirements of the Automation Engine and Nurturing Engine.
```

Docs:
```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- @docs/superpowers/specs/2026-03-30-nurturing-engine-updated-design.md
- @docs/superpowers/specs/2026-03-24-automation-engine-design.md

Scan packages implementation in:
- packages/@ortho/interpolator

Write package API description so that other consumers of these packages know how to use it. Provide several examples. Format should be similar to ADR.
Store document in
- docs/arch/adr-interpolator.md

Update docs NAVIGATOR
```

packages/@platform/filter-engine

Code review:
```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- @docs/superpowers/specs/2026-03-30-audience-engine-updated-design.md

Do code-review of the package "filter-engine" ( packages/@platform/filter-engine ) either it completely satisfies requirements of the Audience Engine.
```

Docs:
```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- @docs/superpowers/specs/2026-03-30-audience-engine-updated-design.md

Scan packages implementation in:
- packages/@platform/filter-engine

Write package API description so that other consumers of these packages know how to use it. Provide several examples. Format should be similar to ADR.
Store document in
- docs/arch/adr-filter-engine.md

Update docs NAVIGATOR
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


#### Template Service

```
Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-template-service-design.md
```
- `claude -p 'Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-template-service-design.md' --dangerously-skip-permissions`

```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-25-template-service-design.md
- clarifying questions and answers @tasks/prd-questions-template-service.md
- Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Update component architecture design @docs/superpowers/specs/2026-03-25-template-service-design.md with clarifications you got from  @tasks/prd-questions-template-service.md
Store updated component arch design at file @docs/superpowers/specs/2026-03-30-template-service-updated-design.md
```

```
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-30-template-service-updated-design.md
We need to plan implementation of this component in phases. Just suggest me list of phases with deliverables. No need to write detailed implementation plan yet.
Keep UI / React component aside, work only on backend.
Write resultting list of phases into docs/superpowers/specs/2026-03-30-template-service-phases.md
```


```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-30-template-service-updated-design.md
- implementation phases @docs/superpowers/specs/2026-03-30-template-service-phases.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest.
Write implementation plan for Phase 1, store to prd.json 
```
- For loop:
- `claude -p 'Load the ralph skill. Read docs: - overall platform & product architecture at @docs/01-platform-arch-design.md ; - component architecture design @docs/superpowers/specs/2026-03-30-template-service-updated-design.md ; - implementation phases @docs/superpowers/specs/2026-03-30-template-service-phases.md . Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest. Write implementation plan for Phase 1, store to ./scripts/ralph/prd.json ' --dangerously-skip-permissions`



---
#### Nurturing Engine

```
Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-nurturing-engine-design.md
```
- `claude -p 'Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-nurturing-engine-design.md' --dangerously-skip-permissions`

```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-25-nurturing-engine-design.md
- clarifying questions and answers @tasks/prd-questions-nurturing-engine.md
- Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Update component architecture design @docs/superpowers/specs/2026-03-25-nurturing-engine-design.md with clarifications you got from @tasks/prd-questions-nurturing-engine.md
Store updated component arch design at file @docs/superpowers/specs/2026-03-30-nurturing-engine-updated-design.md
```

```
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-30-nurturing-engine-updated-design.md
We need to plan implementation of this component in phases. Just suggest me list of phases with deliverables. No need to write detailed implementation plan yet.
Keep UI / React component aside, work only on backend.
Write resulting list of phases into docs/superpowers/specs/2026-03-30-nurturing-engine-phases.md
```


```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-30-nurturing-engine-updated-design.md
- implementation phases @docs/superpowers/specs/2026-03-30-nurturing-engine-phases.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest.
Write implementation plan for Phase 1, store to prd.json 
```
- For loop:
- `claude -p 'Load the ralph skill. Read docs: - overall platform & product architecture at @docs/01-platform-arch-design.md ; - component architecture design @docs/superpowers/specs/2026-03-30-nurturing-engine-updated-design.md ; - implementation phases @docs/superpowers/specs/2026-03-30-nurturing-engine-phases.md . Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest. Write implementation plan for Phase 1, store to ./scripts/ralph/prd.json ' --dangerously-skip-permissions`

Alternative:
```bash
time claude -p 'Load the ralph skill. \
Read docs: \
- overall platform & product architecture at @docs/01-platform-arch-design.md ; \
- component architecture design @docs/superpowers/specs/2026-03-30-nurturing-engine-updated-design.md ; \
- implementation phases @docs/superpowers/specs/2026-03-30-nurturing-engine-phases.md . \
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest. \
Write implementation plan for Phase 2, store to ./scripts/ralph/prd-phase-2.json \
' --dangerously-skip-permissions
```


Script for PRD combining:
```
Load the ralph skill. We have number of PRD files scripts/ralph/prd-phase-*.json for the same specification. Implement me javascript code that:
- combines all stories from all PRD files into single combined json file
- keeps sequential number of stories across all PRD files so that all tasks will be executed in correct order
- produces combined PRD file and stores it in scripts/ralph/prd-combined.json
- store resulting javascript file in scripts/combine-prd-files.js
```


---
#### Messaging Service

```
Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-messaging-service-design.md
```
- `claude -p 'Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-messaging-service-design.md' --dangerously-skip-permissions`

```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-25-messaging-service-design.md
- clarifying questions and answers @tasks/prd-questions-messaging-service.md
- Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Update component architecture design @docs/superpowers/specs/2026-03-25-messaging-service-design.md with clarifications you got from @tasks/prd-questions-messaging-service.md
Store updated component arch design at file @docs/superpowers/specs/2026-03-30-messaging-service-updated-design.md
```

V1
```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-30-messaging-service-updated-design.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest.
Write implementation plan, store to prd.json 
```

V2 -- if V1 failed
```
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-30-messaging-service-updated-design.md
We need to plan implementation of this component in phases. Just suggest me list of phases with deliverables. No need to write detailed implementation plan yet.
Keep UI / React component aside, work only on backend.
Write resulting list of phases into docs/superpowers/specs/2026-03-30-messaging-service-phases.md
```
For loop:
```bash
time claude -p 'Load the ralph skill. \
Read docs: \
- overall platform & product architecture at @docs/01-platform-arch-design.md ; \
- component architecture design @docs/superpowers/specs/2026-03-30-messaging-service-updated-design.md ; \
- implementation phases @docs/superpowers/specs/2026-03-30-messaging-service-phases.md . \
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest. \
Write implementation plan for Phase 2, store to ./scripts/ralph/prd-phase-2.json \
' --dangerously-skip-permissions
```

---
#### Audience Engine

```
Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-audience-engine-design.md
```
- `claude -p 'Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-audience-engine-design.md' --dangerously-skip-permissions`

```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-25-audience-engine-design.md
- clarifying questions and answers @tasks/prd-questions-audience-engine.md
- Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Update component architecture design @docs/superpowers/specs/2026-03-25-audience-engine-design.md with clarifications you got from @tasks/prd-questions-audience-engine.md
Store updated component arch design at file @docs/superpowers/specs/2026-03-30-audience-engine-updated-design.md
```

V1
```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-30-audience-engine-updated-design.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest.
Write implementation plan, store to prd.json 
```

V2 -- if V1 failed
```
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-30-audience-engine-updated-design.md
We need to plan implementation of this component in phases. Just suggest me list of phases with deliverables. No need to write detailed implementation plan yet.
Keep UI / React component aside, work only on backend.
Write resulting list of phases into docs/superpowers/specs/2026-03-30-audience-engine-phases.md
```

For loop:
```bash
time claude -p 'Load the ralph skill. \
Read docs: \
- overall platform & product architecture at @docs/01-platform-arch-design.md ; \
- component architecture design @docs/superpowers/specs/2026-03-30-audience-engine-updated-design.md ; \
- implementation phases @docs/superpowers/specs/2026-03-30-audience-engine-phases.md . \
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest. \
Write implementation plan for Phase 2, store to ./scripts/ralph/prd-phase-2.json \
' --dangerously-skip-permissions
```

---
#### AI Service

1. Find what is origin design spec doc
2. Use skill 'prd-questions' to generate questions
3. Answer questions
4. Use skill 'superpowers:brainstorming' to generated updated design spec doc
5. Use skill 'ralph' to generate prd.json
6. Run script ralph-cc.sh to implement by the plan
7. 

```
Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-ai-service-design.md
```
- `claude -p 'Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-ai-service-design.md' --dangerously-skip-permissions`

```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-25-ai-service-design.md
- clarifying questions and answers @tasks/prd-questions-ai-service.md
- Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Update component architecture design @docs/superpowers/specs/2026-03-25-ai-service-design.md with clarifications you got from @tasks/prd-questions-ai-service.md
Store updated component arch design at file @docs/superpowers/specs/2026-04-02-ai-service-updated-design.md
```

V1
```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-04-02-ai-service-updated-design.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest.
Write implementation plan, store to prd.json 
```

V2 -- if V1 failed
```
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-30-audience-engine-updated-design.md
We need to plan implementation of this component in phases. Just suggest me list of phases with deliverables. No need to write detailed implementation plan yet.
Keep UI / React component aside, work only on backend.
Write resulting list of phases into docs/superpowers/specs/2026-03-30-audience-engine-phases.md
```

For loop:
```bash
time claude -p 'Load the ralph skill. \
Read docs: \
- overall platform & product architecture at @docs/01-platform-arch-design.md ; \
- component architecture design @docs/superpowers/specs/2026-03-30-audience-engine-updated-design.md ; \
- implementation phases @docs/superpowers/specs/2026-03-30-audience-engine-phases.md . \
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest. \
Write implementation plan for Phase 2, store to ./scripts/ralph/prd-phase-2.json \
' --dangerously-skip-permissions
```

#### Analytics Service


```
Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-analytics-service-design.md
Refer to essential package implementation docs/arch/adr-event-bus.md , and it's original spec in case of ambiguity docs/superpowers/specs/2026-03-29-event-bus-adapter-design.md
```
- `claude -p 'Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-analytics-service-design.md' --dangerously-skip-permissions`

```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-25-analytics-service-design.md
- clarifying questions and answers @tasks/prd-questions-analytics-service.md
- Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Update component architecture design @docs/superpowers/specs/2026-03-25-analytics-service-design.md with clarifications you got from @tasks/prd-questions-analytics-service.md
Store updated component arch design at file @docs/superpowers/specs/2026-04-02-analytics-service-updated-design.md
```

V1
```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-04-02-analytics-service-updated-design.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest.
Write implementation plan, store to prd.json 
```

#### Integration Hub

```
Load the prd-questions skill. Load superpowers:brainstorming skill. Read docs/superpowers/specs/2026-03-25-integration-hub-design.md . Check which common packages can be used for the Integration hub
```

```
Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-integration-hub-design.md .
Refer to essential packages implementation docs/arch/adr-event-bus.md , docs/arch/adr-logger.md 
```
- `claude -p 'Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-integration-hub-design.md . Refer to essential packages implementation docs/arch/adr-event-bus.md , docs/arch/adr-logger.md' --dangerously-skip-permissions`

```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-25-integration-hub-design.md
- clarifying questions and answers @tasks/prd-questions-integration-hub.md
- Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest
Update component architecture design @docs/superpowers/specs/2026-03-25-integration-hub-design.md with clarifications you got from @tasks/prd-questions-integration-hub.md
Store updated component arch design at file @docs/superpowers/specs/2026-04-02-integration-hub-updated-design.md
```

V1
```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-04-02-integration-hub-updated-design.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest, BullMQ latest.
Write implementation plan, store to prd-integration-hub.json 
```

```
Load codereview skill. Please do review of implementation of apps/platform/integration-hub against spec in @docs/superpowers/specs/2026-04-02-integration-hub-updated-design.md
```

#### Identity Service

```
Load the prd-questions skill. Load superpowers:brainstorming skill. Read docs/NAVIGATOR.md & docs/superpowers/specs/2026-03-25-identity-service-design.md . Check which common packages can be used for the Identity Service
```

```
Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-identity-service-design.md .
Refer to essential packages implementation docs/arch/adr-logger.md 
```

```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-25-identity-service-design.md
- clarifying questions and answers @tasks/prd-questions-identity-service.md
- Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest, BullMQ latest
Update component architecture design @docs/superpowers/specs/2026-03-25-identity-service-design.md with clarifications you got from @tasks/prd-questions-identity-service.md
Store updated component arch design at file @docs/superpowers/specs/2026-04-02-identity-service-updated-design.md
```

V1
```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-04-02-identity-service-updated-design.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest, BullMQ latest.
Write implementation plan, store to prd.json 
```

```
Load codereview skill. Please do review of implementation of apps/platform/integration-hub against spec in @docs/superpowers/specs/2026-04-02-identity-service-updated-design.md
```



**packages/@ortho/auth-middleware**

Code review:
```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- @docs/superpowers/specs/2026-04-02-identity-service-updated-design.md

Do code-review of the package "auth-middleware" ( packages/@ortho/auth-middleware ) either it completely satisfies requirements of the Identity Service.
```

Docs:
```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- @docs/superpowers/specs/2026-04-02-identity-service-updated-design.md

Scan packages implementation in:
- packages/@ortho/auth-middleware

Write package API description so that other consumers of these packages know how to use it. Provide several examples. Format should be similar to ADR.
Store document in
- docs/arch/adr-auth-middleware.md

Update docs NAVIGATOR
```



#### Media / File Service

```
Load the prd-questions skill. Load superpowers:brainstorming skill. Read docs/NAVIGATOR.md & docs/superpowers/specs/2026-03-25-media-service-design.md . Check which common packages can be used for the Media / File Service
```

```
Load the prd-questions skill and generate questions for spec provided in @docs/superpowers/specs/2026-03-25-media-service-design.md .
Refer to essential packages implementation:
- docs/arch/adr-logger.md 
- docs/arch/adr-event-bus.md
- docs/arch/adr-interpolator.md
- docs/arch/adr-filter-engine.md
```

```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-03-25-media-service-design.md
- clarifying questions and answers @tasks/prd-questions-media-service.md
- Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest, BullMQ latest
Update component architecture design @docs/superpowers/specs/2026-03-25-media-service-design.md with clarifications you got from @tasks/prd-questions-media-service.md
Store updated component arch design at file @docs/superpowers/specs/2026-04-03-media-service-updated-design.md
```

V1
```
Load the ralph skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- component architecture design @docs/superpowers/specs/2026-04-03-media-service-updated-design.md
Tech Stack: Node.js 24, TypeScript 5 (ESM), Fastify 5, Knex 3 + pg, @sinclair/typebox 3, Vitest latest, BullMQ latest.
Write implementation plan, store to prd.json 
```




```
Load codereview skill. Please do review of implementation of apps/platform/media-service against spec in @docs/superpowers/specs/2026-04-03-media-service-updated-design.md
```

#### Docker Compose

```
Load superpowers:brainstorming skill.
Read docs:
- overall platform & product architecture at @docs/01-platform-arch-design.md
- @docs/NAVIGATOR.md
We need implement docker-compose setup for development purposes. Read all specs if you need, read all the code, understand what assumptions have been made which services have to be run in local dev env.
```
