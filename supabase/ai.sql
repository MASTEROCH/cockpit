-- ============================================================================
-- WANDO · Вандо-мозг: проактивный ИИ-пульс (пн/ср/пт, 12:30 Батуми)
-- ИИ сам выходит на связь ТОЛЬКО если есть что сказать по делу:
-- проблемное место, перекос, повод похвалить. Антиспам тройной:
-- расписание 3р/нед + пауза ≥48ч на человека + право ИИ ответить SKIP.
--
-- ⚠️ ПЕРЕД ЗАПУСКОМ: замени INTERNAL_SECRET_HERE (1 вхождение) на значение
--    секрета WANDO_INTERNAL_SECRET.
-- ============================================================================

alter table public.tg_links add column if not exists last_ai_ping timestamptz;
alter table public.tg_links add column if not exists last_ai_text text;

select cron.schedule(
  'wando-ai-pulse',
  '30 8 * * 1,3,5',
  $$
  select net.http_post(
    url     := 'https://tonmsmxzmycimybzywqp.supabase.co/functions/v1/tg-bot',
    headers := jsonb_build_object('content-type','application/json',
                                  'x-wando-internal','INTERNAL_SECRET_HERE'),
    body    := jsonb_build_object('kind','ai_pulse')
  );
  $$
);

-- ----------------------------------------------------------------------------
-- Эпоха сброса: 🧨 «Полный сброс» на одном устройстве должен вычищать
-- локальные копии и на устройствах партнёров (иначе легаси воскресает
-- при их следующем входе через cloudSync-push).
-- ----------------------------------------------------------------------------
create table if not exists public.workspace_meta (
  k          text primary key,
  v          jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.workspace_meta enable row level security;
drop policy if exists wm_team_all on public.workspace_meta;
create policy wm_team_all on public.workspace_meta
  for all
  using (public.is_team(auth.jwt() ->> 'email'))
  with check (public.is_team(auth.jwt() ->> 'email'));

-- Проверка: select jobname, schedule from cron.job where jobname like 'wando-%';
-- Ожидаю ТРИ строки: morning-brief (0 5 * * *), evening-review (0 14 * * *),
-- ai-pulse (30 8 * * 1,3,5).
