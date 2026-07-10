# WANDO Multi-tenant + Stars — план (НЕ ПРИМЕНЯТЬ без явного «да» Роча)

Цель: внешние фаундеры получают изолированные воркспейсы и платят Telegram Stars;
команда Роча живёт как воркспейс `main` с планом `founder_forever` — вне биллинга навсегда.

## Фазы (каждая — отдельный заход плагина + явное подтверждение Роча)

**Ф1. Схема.** `workspaces.sql`: таблица workspaces (id, name, plan, stars_until, created_by)
+ колонка `workspace_id` (default 'main') в projects / intake / team / tg_links / tg_bind_codes / workspace_meta
+ backfill 'main' + запись workspaces('main', plan='founder_forever').
Обратная совместимость: сайт и бот работают без изменений (default закрывает всё).

**Ф2. RLS.** Переписать политики: `is_team()` → `is_member(workspace_id)` (SECURITY DEFINER,
паттерн отработан в team.sql после грабли 42P17). Гости project_access — внутри воркспейса.

**Ф3. Self-serve в боте.** `/start` без привязки → кнопка «🚀 Создать своё пространство»:
бот создаёт workspace + team-запись + welcome-проект, шлёт magic-link (tma-auth уже умеет).
Лимиты Solo: 1 компания, 3 проекта — проверка в боте и на сайте (const PLAN_LIMITS).

**Ф4. Stars.** В боте: `/plan` → sendInvoice(currency:"XTR", Founder 1900⭐/мес ≈ $19)
→ pre_checkout_query → successful_payment → workspaces.stars_until = now()+31д.
Фича-гейт: Вандо-ИИ/пульс/отчёты/наставник — только plan!='solo' или stars_until>now().
`plan='founder_forever'` обходит все проверки.

**Ф5. Изоляция ИИ-костов.** ai-review: rate-limit по workspace_id (таблица ai_usage,
дневной кап для платных, ноль для solo).

## Правила
- Каждый SQL — через дашборд/плагин, ПОСЛЕ явного «да» Роча (CLAUDE.md).
- Ничего не переименовывать (cockpit_* канон).
- Воркспейс main никогда не должен попасть под лимиты/биллинг — тест на это обязателен.
- Откат Ф1: колонки default'ами безопасны; политики Ф2 — единственная точка риска,
  катить в нерабочее время команды, проверять curl'ом как в d5bbfe3.
