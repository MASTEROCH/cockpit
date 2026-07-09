-- ============================================================================
-- WANDO · Пуши и утренний бриф (БД → tg-bot)
--  · новая заявка в Приёмке  → команде в Telegram (с кнопками ✓/✕)
--  · решение по заявке       → автору в Telegram
--  · 9:00 Батуми (05:00 UTC) → утренний бриф каждому привязанному
--
-- ⚠️ ПЕРЕД ЗАПУСКОМ: замени ВСЕ ТРИ вхождения INTERNAL_SECRET_HERE на значение
--    секрета WANDO_INTERNAL_SECRET (тот же, что в Secrets edge-функции tg-bot).
-- Запускать в Supabase → SQL Editor. Безопасно к повторному запуску.
-- ============================================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---- новая заявка → пуш команде --------------------------------------------
create or replace function public.wando_notify_intake_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url     := 'https://tonmsmxzmycimybzywqp.supabase.co/functions/v1/tg-bot',
    headers := jsonb_build_object('content-type','application/json',
                                  'x-wando-internal','INTERNAL_SECRET_HERE'),
    body    := jsonb_build_object('kind','intake_insert','record',to_jsonb(new))
  );
  return new;
end $$;

drop trigger if exists trg_wando_intake_insert on public.intake;
create trigger trg_wando_intake_insert
  after insert on public.intake
  for each row when (new.status = 'pending')
  execute function public.wando_notify_intake_insert();

-- ---- решение по заявке → пуш автору ----------------------------------------
create or replace function public.wando_notify_intake_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url     := 'https://tonmsmxzmycimybzywqp.supabase.co/functions/v1/tg-bot',
    headers := jsonb_build_object('content-type','application/json',
                                  'x-wando-internal','INTERNAL_SECRET_HERE'),
    body    := jsonb_build_object('kind','intake_decided','record',to_jsonb(new))
  );
  return new;
end $$;

drop trigger if exists trg_wando_intake_update on public.intake;
create trigger trg_wando_intake_update
  after update on public.intake
  for each row when (old.status = 'pending' and new.status <> 'pending')
  execute function public.wando_notify_intake_update();

-- ---- утренний бриф: 05:00 UTC = 09:00 Батуми --------------------------------
-- cron.schedule с тем же именем перезаписывает расписание (идемпотентно)
select cron.schedule(
  'wando-morning-brief',
  '0 5 * * *',
  $$
  select net.http_post(
    url     := 'https://tonmsmxzmycimybzywqp.supabase.co/functions/v1/tg-bot',
    headers := jsonb_build_object('content-type','application/json',
                                  'x-wando-internal','INTERNAL_SECRET_HERE'),
    body    := jsonb_build_object('kind','morning_brief')
  );
  $$
);

-- Проверка: select jobname, schedule from cron.job where jobname='wando-morning-brief';
