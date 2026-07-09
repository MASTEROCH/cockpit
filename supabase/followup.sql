-- ============================================================================
-- WANDO · Автодожим: вечерний разбор + память маршрутизации бота
--  · 18:00 Батуми (14:00 UTC) — вечерний разбор каждому: что закрыто,
--    незакрытое переносится одним тапом («план снова честный»)
--  · tg_links.last_project — бот запоминает твой последний выбор проекта
--
-- ⚠️ ПЕРЕД ЗАПУСКОМ: замени INTERNAL_SECRET_HERE (1 вхождение) на значение
--    секрета WANDO_INTERNAL_SECRET (тот же, что в Secrets функции tg-bot).
-- Запускать в Supabase → SQL Editor. Безопасно к повторному запуску.
-- ============================================================================

alter table public.tg_links add column if not exists last_project text;

select cron.schedule(
  'wando-evening-review',
  '0 14 * * *',
  $$
  select net.http_post(
    url     := 'https://tonmsmxzmycimybzywqp.supabase.co/functions/v1/tg-bot',
    headers := jsonb_build_object('content-type','application/json',
                                  'x-wando-internal','INTERNAL_SECRET_HERE'),
    body    := jsonb_build_object('kind','evening_review')
  );
  $$
);

-- Проверка: select jobname, schedule from cron.job where jobname like 'wando-%';
-- Ожидаю две строки: wando-morning-brief (0 5 * * *) и wando-evening-review (0 14 * * *).
