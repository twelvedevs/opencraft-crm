- [x] implement `@ortho/interpolator` , used by Automation Engine and Nurturing Engine
- [x] implement `@platform/sequence-ui` as part of Nurturing Engine
- [ ] The Automation Engine's `unenroll_sequence` action is a new action type that requires amending the Automation Engine spec and implementation
    - this raised by prd-questions skill while working on Nurturing Engine
    - prd-questions-nurturing-engine.md
    - C. Partially — add the action type definition/interface only, defer the full worker implementation
- [x] Build `@platform/filter-engine` as part of Audience Engine, but migrate the Automation Engine in a follow-up
- [ ] verify `@platform/filter-engine` — a shared pure-function filter evaluator used by both the Audience Engine and the Automation Engine
- [x] ### `@platform/audience-ui` React Component
- [ ] update event-bus docs, find what other services require updates
- [x] Implement `@platform/integration-hub-ui`
- [ ] надо отдельно провалидировать все ивенты и все типы и пейлоуды на целостность всей конструкции
- [ ] build map of inter-service communications, who talks to whom, data streams
- [x] implement Swagger for each service
- [ ] build `@platform/automation-ui` , part of Automation Engine
- [ ] Dashboard UI — owned by the Reporting Service
- [ ] build `@platform/template-ui` React component — Unlayer email editor, SMS text editor, template library browser, part of Template Engine
- [ ] `@platform/notification-ui` - part of Notifications Engine
- [ ] RBAC:
    Known implementation gaps revealed by this suite (tests will FAIL until fixed):
      - marketing_staff can PATCH leads (service has no global role restriction)
      - marketing_staff can access conversation inbox (empty locations = all-access)
      - marketing_staff can trigger campaign send-now (campaign service has no RBAC)
      - call_center_agent can POST /sequences (nurturing service has no role check on create)
    
    NOTE: Nurturing sequence RBAC tested only for activate/disable (role-restricted
    endpoints). The POST /sequences endpoint currently requires only authentication.


- [x] 1)  Implement test scenarios for "RBAC & Access Control"      , ~20  cases (Фундамент безопасности)
- [x] 2)  Implement test scenarios for "Создание лидов & атрибуция" , ~19  cases (Корневая сущность)
- [x] 3)  Implement test scenarios for "New Patient Pipeline"       , ~25  cases (Core demo path)
- [ ] 4)  Implement test scenarios for "Ortho2 CSV Import"          , ~18  cases (Единственный EHR-мост)
- [ ] 5)  Implement test scenarios for "Nurture Sequences"          , ~16  cases (Главная автоматизация)
- [ ] 6)  Implement test scenarios for "Shared Inbox"               , ~14  cases (Ежедневная операция)
- [ ] 7)  Implement test scenarios for "Внешние интеграции (сбои")  , ~18  cases (Resilience)
- [ ] 8)  Implement test scenarios for "Analytics & Attribution"    , ~14  cases (Primary KPI)
- [ ] 9)  Implement test scenarios for "Дедупликация & Merge"       , ~10  cases (Data quality)
- [ ] 10) Implement test scenarios for "In Treatment Pipeline"      , ~6   cases (Happy path cont)
- [ ] 11) Implement test scenarios for "Аудит & Конкурентность"     , ~9   cases (Data integrity)
- [ ] 12) Implement test scenarios for "In Retention Pipeline"      , ~8   cases (Full flow)
- [ ] 13) Implement test scenarios for "AI Communications"          , ~14  cases (Graceful degradation)
- [ ] 14) Implement test scenarios for "Email Campaigns"            , ~16  cases (CAN-SPAM compliance)
- [ ] 15) Implement test scenarios for "Referral Tracking"          , ~12  cases (Extended feature)
- [ ] 16) Implement test scenarios for "Многолокационные сценарии"  , ~5   cases (RBAC overlap)


