# QA Scenarios — Ortho CRM

**Coverage:** Full spectrum — happy path, boundary/edge cases, permission violations, external integration failures.
**Scope:** REST API level (no UI). ~170+ scenarios across 16 functional categories.
**Generated:** 2026-04-23

---

## 1. Создание лидов и атрибуция

### Happy Path
- Лид из website-формы с полными UTM-параметрами → лид создан, все атрибуционные поля заполнены и заморожены
- Google Ads Lead Form webhook → лид создан с campaign/ad group/keyword/device
- Meta Lead Ad webhook → лид создан с campaign/ad set/ad ID, platform=facebook или instagram
- Входящий звонок на Twilio tracking number → лид создан автоматически, call duration и source number залогированы
- Клик по реферальной ссылке + форма → лид создан с referrer_id и referrer_type=patient
- Ручной ввод координатором walk-in → source=walk_in, location и staff_id зафиксированы
- CSV bulk import валидных строк → лиды созданы пачкой с import_batch_id

### Граничные случаи
- Форма без UTM → source=direct, все UTM-поля null, лид создан
- Реферальная ссылка кликнута, форма не заполнена → лид не создан (только клик-событие)
- Дубль по телефону при повторной отправке формы → флаг дубля, координатор видит prompt для merge
- Дубль по email при разных телефонах → флаг дубля
- Google Ads display-кампания (нет keyword) → keyword=null, остальные поля заполнены
- Входящий звонок с номера существующего лида → привязка к существующему лиду, не дубль
- CSV с отсутствующими обязательными полями (нет ни phone, ни email) → строка отклонена с указанием поля

### Сбои интеграций
- Google Ads webhook delivery fail → retry-механизм, лид не теряется, алерт
- Meta webhook с задержкой в несколько часов → лид создан, timestamp = время webhook'а
- Twilio incoming call webhook не принят → звонок прошёл, лид не создан, алерт команде
- CSV с битой структурой файла → validation error, ничего не зафиксировано
- Meta API: дублирующийся webhook (один лид дважды) → идемпотентность: один лид

---

## 2. Дедупликация и merge

### Happy Path
- Точное совпадение по телефону → дубль обнаружен, координатор мёрджит
- Точное совпадение по email → дубль обнаружен, координатор мёрджит
- После merge: first_touch из более раннего лида, last_touch из позднего, полный activity history обоих
- Координатор выбирает NOT merge → оба лида остаются активными независимо
- Координатор unmerg'ит ранее слитые записи → восстанавливаются оригинальные атрибуции обоих

### Граничные случаи
- Три записи с одинаковым телефоном → все три флагируются вместе
- Merge лидов из разных pipeline (один New Patient, другой уже In Treatment) → валидация: что происходит?
- Один Ortho2-record матчится на несколько CRM-лидов → координатор выбирает вручную

### Права доступа
- Call Center Agent пытается смотреть/мёрджить лидов чужой локации → заблокировано

---

## 3. New Patient Pipeline — переходы по стадиям

### Full Happy Path Journey
- New Lead → Contacted → Exam Scheduled → Exam Completed → Tx Presented → Contract Signed → конвертация в In Treatment
- Каждый переход запускает правильную автоматическую последовательность

### New Lead
- Лид создан → немедленный SMS отправлен (0 min delay), 2-hr follow-up запланирован
- Assign to location coordinator выполнен, follow-up task создан

### Contacted
- Координатор логирует первый контакт → стадия меняется на Contacted
- Если нет ответа 24 часа → auto SMS follow-up 1
- Если нет ответа 72 часа → auto SMS follow-up 2, email nurture запускается

### Exam Scheduled
- Координатор бронирует appointment → стадия Exam Scheduled, подтверждение SMS немедленно
- 48 часов до экзамена → reminder SMS
- 2 часа до экзамена → финальный reminder SMS
- 30 минут после запланированного времени без прихода → task для координатора (no-show alert)

### Exam Completed
- Координатор отмечает exam complete → стадия Exam Completed
- SMS с thank-you + ссылкой на treatment plan через 4 часа
- Email с financing info + CareCredit через 24 часа

### Tx Presented
- Координатор логирует treatment presentation → стадия Tx Presented
- Financing SMS (CareCredit link), 48hr check-in автоматически
- AI-assisted follow-up draft доступен координатору

### Contract Signed
- Координатор отмечает signed ИЛИ матч через Ortho2 CSV → стадия Contract Signed
- Welcome SMS + email отправлены
- Запись удалена из New Patient pipeline, создана в In Treatment
- Attribution locked, conversion event залогирован

### Lost
- Координатор отмечает Lost → все активные nurture sequences останавливаются немедленно
- 30-day re-engagement SMS отправлен автоматически
- Лид реактивируется → перемещается в Contacted, activity возобновляется
- Лид не реактивируется за 30 дней → архивируется
- Loss reason залогирован

### Граничные и граничные случаи
- Лид не контактирован за 2 часа SLA → алерт координатору
- Лид в Contacted 5 дней без booking → что происходит? auto-Lost или task?
- Appointment отменён → стадия откатывается в Contacted?
- Координатор вручную откатывает стадию назад (регрессия) → разрешено? залогировано в audit?
- Лид пропускает стадии: сразу Contract Signed минуя Exam Completed → валидация
- Два координатора редактируют один лид одновременно → conflict detection, последняя запись побеждает?
- Истечение 14-дневного лимита в Tx Presented → auto-Lost?

---

## 4. In Treatment Pipeline

### Happy Path
- Конвертация через Contract Signed → In Treatment запись создана автоматически
- Welcome sequence стартует (инструкции, контакты)
- Monthly check-in SMS по расписанию
- Review request через 3 месяца
- Ortho2 CSV: patient = Debanded/Completed → Treatment Complete, congratulations sequence, переход в In Retention

### Граничные случаи
- Ortho2 CSV помечает пациента как active, но он уже в In Treatment → идемпотентность, нет дубля
- Пациент в In Treatment подаёт новый лид как реферал → отдельный New Patient лид, не merge

---

## 5. In Retention Pipeline

### Happy Path
- Active Retention: инструкции по ретейнеру отправлены, 3-month check-in, referral link через 90 дней
- Recall Due: reminder sequence за 30/7/0 дней, booking link
- Appointment booked → стадия продвигается
- Long-term Follow: annual check-in, birthday message, referral campaign

### Граничные случаи
- Recall Due: 60 дней прошло без appointment → Long-term Follow или overdue?
- Пациент сделал opt-out из SMS → recall reminders только email? task координатору?
- Birthday message для пациента, рождённого 29 февраля → корректно в невисокосный год?
- Пациент в Retention подаёт новый лид на себя (хочет брекеты снова) → новый лид в New Patient, не merge

---

## 6. Nurture Automation & Sequences

### Happy Path
- Sequence A: шаги 1–5 доставлены в правильное время (0 min, 2 hrs, 24 hrs, 3 days, 5 days)
- Active hours: auto-SMS не отправляется до 8:00 и после 20:00 → перенос на 8:00
- A/B тест: 50% лидов получают вариант A, 50% — B, winner выбирается через 4 часа по open rate
- Лид отвечает STOP → немедленно удалён из всех sequences, дальнейших сообщений нет

### Граничные случаи
- Лид opt-out, затем opt-in снова → с какого шага возобновить? или заново?
- Шаг sequence запланирован на 02:00 → переносится на 08:00 следующего дня
- Стадия лида меняется пока sequence в процессе → старая sequence отменяется? новая стартует? обе идут?
- A/B тест с 1 лидом → 100% к одному варианту?
- Sequence step отключён во время активного прогона → пропуск или завершение?
- AI-assisted step: Claude API недоступен → fallback на шаблон? шаг пропущен? координатор уведомлён?
- Step с delay=0 вслед за step с delay=0 → оба срабатывают одновременно?
- Marketing Staff публикует sequence напрямую → заблокировано (только drafts)
- Manager публикует sequence → моментально применяется к лидам уже в этой стадии?

---

## 7. Shared Inbox & Two-Way Texting

### Happy Path
- Входящий SMS → виден всем координаторам локации в shared inbox
- Координатор claim conversation → другие видят "claimed"
- Координатор отвечает вручную → доставлен через Twilio, залогирован
- Внутренняя заметка → видна только staff, не отправлена лиду
- Координатор escalates → manager видит флаг
- Scheduled send: сообщение отправлено точно в назначенное время

### Граничные случаи
- Два координатора отвечают на одно сообщение одновременно → оба доставляются? или конфликт?
- Координатор вручную отправляет в thread, где включён AI Agent → AI Agent немедленно деактивируется для этого thread
- Лид шлёт несколько сообщений подряд быстро → все отображаются в правильном порядке
- Входящий SMS с неизвестного номера (нет лида) → создаётся новый лид? или появляется как unknown?
- Сообщение длиннее 160 символов → разбивается на части (SMS segments) или MMS?
- Ответ лида на auto-sequence message → появляется в inbox как inbound? да, должен

### Права доступа
- Call Center Agent пытается открыть inbox другой локации → заблокировано
- Marketing Staff пытается открыть любой inbox → заблокировано (нет разрешения)
- Marketing Manager открывает inbox всех локаций → работает

---

## 8. AI-Assisted Communications

### Happy Path
- Входящее сообщение → 2-3 smart reply draft'а сгенерированы
- Coordinator выбирает draft, редактирует, отправляет
- Objection flag → Claude предлагает стратегии по типу возражения
- Thread с 10+ сообщениями → 3-sentence summary показан при открытии
- Manager просматривает lead score → Claude объясняет почему high/low
- Sequence AI-step: персонализация с name, treatment interest, location, coordinator notes

### Граничные случаи
- Claude API rate limited → drafts недоступны, координатор пишет вручную, ошибка показана
- AI draft содержит некорректный контент → coordinator review и edit обязательны (не auto-send)
- Thread с 0 сообщениями → summary не генерируется, показывается "no history yet"
- Лид без поля treatment_interest → AI fallback на generic шаблон
- Objection флаг поставлен несколько раз в одном thread → дедупликация предложений

### AI Agent Mode
- Agent mode включён → первый response SMS без участия координатора
- 3 обмена пройдено → на 4-м автоматическая эскалация к координатору
- Пациент задаёт клинический вопрос → немедленная эскалация
- Пациент выражает дистресс → немедленная эскалация
- Confidence ниже threshold → эскалация
- Каждое agent-сообщение содержит disclosure текст с номером телефона и STOP инструкцией
- Координатор вручную отправляет в thread → agent mode деактивируется для этого thread
- Marketing Manager выключает agent mode mid-sequence → применяется к новым сообщениям, не к уже отправленным

### Права доступа на AI Agent Mode
- Marketing Manager включает → работает
- Call Center Manager пытается → заблокировано
- Marketing Staff пытается → заблокировано

---

## 9. Marketing Analytics & Attribution

### Happy Path
- Dashboard: количество лидов по каналам за выбранный период
- Cost per lead = ad spend ÷ leads generated, совпадает с ожидаемым
- Exam conversion rate = Leads → Exam Scheduled ÷ total leads
- Case conversion rate = Contract Signed ÷ Exam Completed
- ROAS = Revenue attributed ÷ ad spend
- Lead response time = среднее время от lead creation до first contact
- Фильтр по дате: last 7 days, last 30 days, custom range — все работают корректно
- Фильтр по локации: одна локация / несколько / все 34
- Ad spend refresh каждые 4 часа из Google/Meta APIs
- 24-месячный исторический lookback доступен

### Граничные случаи
- Локация без лидов в выбранном периоде → метрики = 0, нет деления на ноль
- Кампания генерирует лиды но без spend-данных → cost-метрики = N/A или $0
- Нормализация валюты: счёт в EUR → отображается в USD
- Coordinator с 0 лидами в отчёте → показывается как 0, не исключается
- Отчёт за 24 месяца → нет timeout, приемлемое время загрузки

### Права доступа
- Call Center Agent: видит только свою локацию в analytics
- Call Center Manager: видит только свои назначенные локации
- Marketing Staff: видит все локации, read-only
- Call Center Agent пытается запросить all-locations view → отфильтровано/заблокировано

### Exports & Reports
- Export в CSV: корректные данные и формат
- Export в PDF: корректное форматирование
- Scheduled weekly report: email marketing manager'у каждый понедельник
- Еженедельный отчёт покрывает пн–вс корректно (границы периода)

---

## 10. Referral Tracking

### Happy Path
- Post-treatment: уникальный referral URL генерируется на пациента
- Referral link автоматически включается в thank-you sequence (90 дней)
- Referred лид кликает + заполняет форму → лид создан с referrer_id, referrer_type=patient
- Referred лид конвертирует → referring patient получает кредит в системе
- Staff логирует выдачу reward → reward event залогирован (CRM не обрабатывает платёж)
- Referring patient получает SMS при booking exam его рефералом
- Referring patient получает SMS при Contract Signed его рефералом

### Doctor Referral
- Уникальная ссылка на doctor practice → лид создан с referrer_type=doctor
- Doctor referral portal: врач видит статус своих рефералов
- Auto thank-you отправлен врачу когда его реферал начинает лечение
- Referral volume report: рейтинг врачей по case starts

### Граничные случаи
- Referral link кликнут, форма не заполнена → клик отслежен, лид не создан
- Один лид реферирован несколькими источниками → first-touch wins, кто получает кредит?
- Referral link распространён публично → много кликов от незнакомых → корректная обработка
- Doctor portal с невалидным токеном → 403
- Reward залогирован для реферала, который ещё не конвертировал → validation error или allowed?

---

## 11. Email Campaigns

### Happy Path
- Marketing Staff создаёт draft → не отправляется без approve manager'а
- Marketing Manager публикует → отправляется аудитории
- Personalization tokens: `{{first_name}}`, `{{location_name}}`, `{{coordinator_name}}`, `{{referral_link}}` — все заменены корректно
- A/B subject line test: 50/50 split, winner выбирается через 4 часа по open rate
- Unsubscribe: лид кликает → удалён из всех будущих рассылок (CAN-SPAM)
- Plain text fallback автогенерируется
- Hard bounce → автоудалён из списка; soft bounce → retry

### Граничные случаи
- Campaign с 0 получателями → предупреждение до отправки
- Personalization token для пустого поля → fallback text или пустая строка?
- Лид в exclusion-сегменте И в основном → exclusion wins
- Лид в нескольких overlapping сегментах → получает письмо только 1 раз
- Campaign scheduled в будущем → не отправляется раньше времени
- Unsubscribed лид добавлен в новую кампанию → автоматически исключён
- Spam score check показывает высокий риск → нельзя отправить без override manager'а?

### Права доступа
- Call Center Agent/Manager пытается отправить кампанию → заблокировано
- Marketing Staff пытается publish/send → заблокировано (только draft + submit for approval)

### Инфраструктура
- SendGrid API 4xx → кампания failed, manager уведомлён, нет partial send
- SendGrid API 5xx → retry, persistent failure → campaign помечена failed
- Отправка 10 000+ получателей → очередь, нет timeout

---

## 12. Ortho2 CSV Import

### Happy Path
- Active patients CSV → матч на лидов, Contract Signed, In Treatment созданы, nurture sequences остановлены
- Completed patients CSV → перемещение в In Retention, retention sequence стартует
- Appointments CSV → matched leads → Exam Scheduled, appointment details залогированы
- No-shows CSV → matched leads → Contacted, no-show re-engagement sequence triggered
- Import log: пользователь, timestamp, filename, matched/unmatched/skipped counts
- Undo в течение 2 часов → все изменения import'а отменены

### Match Logic
- Exact mobile phone match → highest confidence, обновлено без флага
- Email match, нет phone → обновлено (с указанием типа матча)
- Имя + home phone → флаг для ручной проверки координатором
- Имя + дата рождения → флаг для ручной проверки
- Нет матча → флаг для ручного review, не авто-обновлено
- Несколько CRM-лидов матчатся на один Ortho2-record → координатор выбирает

### Validation
- CSV с неправильными колонками → validation error, ничего не импортировано
- CSV с частично валидными строками → валидные строки обработаны, невалидные перечислены
- Дублирующиеся строки в одном CSV → одна применена, другая пропущена
- Пустой CSV (только header) → "0 records to import"
- Очень большой CSV (10 000+ строк) → импорт в очереди, координатор уведомлён по завершении
- Undo после 2-часового окна → заблокировано с error message
- Preview mode показывает точно какие записи будут изменены, до confirm

### Права доступа
- Call Center Agent пытается импортировать → заблокировано
- Call Center Manager импортирует для своей локации → разрешено
- Call Center Manager пытается затронуть лидов другой локации через CSV → заблокировано
- Marketing Manager импортирует для всех локаций → разрешено

---

## 13. Roles & Access Control

### Call Center Agent — boundary tests
- Просматривает и редактирует лидов своей локации → разрешено
- Запрашивает лидов другой локации → 403/пустой результат
- Пытается отправить bulk SMS → заблокировано
- Пытается создать/редактировать nurture sequence → заблокировано
- Пытается запустить CSV import → заблокировано
- Запрашивает analytics другой локации → отфильтровано

### Call Center Manager — boundary tests
- Видит лидов всех своих назначенных локаций → корректно
- Назначен на несколько локаций → видит все из них
- Bulk SMS для своей локации → разрешено
- Bulk SMS для другой локации → заблокировано
- Пытается publish nurture sequence → заблокировано
- Пытается включить AI Agent mode → заблокировано

### Marketing Staff — boundary tests
- Просматривает лидов всех локаций (read-only) → разрешено
- Пытается редактировать лид → заблокировано
- Пытается изменить pipeline stage → заблокировано
- Пытается отправить SMS → заблокировано
- Создаёт campaign draft → разрешено, не опубликовано
- Пытается publish campaign напрямую → заблокировано
- Пытается открыть conversation inbox → заблокировано

### Marketing Manager — boundary tests
- Publish campaigns и sequences → разрешено
- Включает AI Agent mode → разрешено
- Создаёт/редактирует/деактивирует staff accounts → разрешено
- Просматривает system audit log → разрешено
- Генерирует API ключи → разрешено

### Cross-role boundary
- Просроченный JWT используется → 401
- Невалидная подпись JWT → 401
- Неаутентифицированный запрос к любому endpoint → 401
- Privilege escalation: agent пытается изменить свой role через API → заблокировано
- Токен одной роли используется для endpoint другой роли → 403

---

## 14. Многолокационные сценарии

### Happy Path
- Лид создан в Location A → виден координаторам A, не виден в Location B
- Marketing Manager перемещает лид из A в B → лид теперь в B
- Координатор B обрабатывает лид

### Граничные случаи
- Звонок на Twilio-номер Location A от пациента, физически находящегося в Location B → assigned to A (tracking number определяет локацию)
- Лид не появляется на экзамене в Location A, walk-in в Location B → два отдельных лида или merge?
- Coordinator Location A бронирует exam в Location B → может ли он назначить лид в B?

---

## 15. Сбои внешних интеграций

### Twilio
- Исходящий SMS fail → retry с exponential backoff, координатор уведомлён после N попыток
- Invalid phone number (Twilio возвращает ошибку) → лид помечен "invalid phone"
- Twilio number pool исчерпан → нельзя провижнить новые tracking числа, alert
- Входящий webhook не принят → входящее сообщение пропущено, нет data loss на стороне CRM

### SendGrid
- API 4xx → кампания failed, manager уведомлён, нет partial send
- API 5xx → retry, persistent failure → campaign marked failed
- Unsubscribe webhook от SendGrid не принят → лид получит следующую кампанию (edge case для reconciliation)

### Google Ads API
- Rate limit 429 → backoff, данные обновятся при следующей попытке
- OAuth token истёк → требуется re-auth, dashboard показывает "last updated: X ago"
- Google Ads account disconnected → attribution новых Google-лидов неполная, alert

### Meta Ads API
- Lead Ad webhook пришёл с задержкой → лид создан, timestamp = submission time из payload
- Дублирующийся webhook (один лид дважды) → идемпотентность: один лид

### Claude API
- API недоступен → AI features показывают "unavailable", ручной режим работает
- API response malformed JSON → graceful error, fallback на шаблон
- Timeout >10 сек → AI draft не показывается, координатор пишет вручную

---

## 16. Данные, конкурентность и аудит

### Immutability атрибуции
- Поля first_touch_* неизменны после создания лида — никакое действие пользователя не перезаписывает
- Attribution сохраняется через merge
- Attribution сохраняется через pipeline conversion
- После деактивации staff account его записи в audit log сохраняются с меткой "deactivated user"

### Audit Log
- Каждый stage change залогирован: user, timestamp, from_stage, to_stage, lead_id
- Каждый ручной SMS залогирован
- Каждый CSV import залогирован
- Каждое создание/деактивация staff account залогировано
- Каждый publish/unpublish sequence залогирован
- Call Center Agent не видит audit log → 403
- Marketing Manager видит и фильтрует audit log

### Конкурентные операции
- Два координатора одновременно переводят лид из New Lead → Contacted → один успешен, другой видит conflict error
- Два координатора одновременно отправляют сообщения в один thread → оба доставляются
- CSV import идёт пока координатор вручную редактирует matching лид → last-write-wins или lock?
