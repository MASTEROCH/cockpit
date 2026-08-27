-- ============================================================================
-- WANDO · Пятничный итог недели: статус-митинг, сжатый до одного сообщения
--  · пятница 18:30 Батуми (14:30 UTC) — каждому: сколько закрыто за 7 дней,
--    разрез по проектам и топ недели. Молчит, если закрыто 0.
--
-- ⚠️ ПЕРЕД ЗАПУСКОМ: замени INTERNAL_SECRET_HERE (1 вхождение) на значение
--    секрета WANDO_INTERNAL_SECRET (тот же, что в Secrets функции tg-bot).
-- Запускать в Supabase → SQL Editor. Безопасно к повторному запуску.
-- ============================================================================

select cron.schedule(
  'wando-friday-digest',
  '30 14 * * 5',
  $$
  select net.http_post(
    url     := 'https://tonmsmxzmycimybzywqp.supabase.co/functions/v1/tg-bot',
    headers := jsonb_build_object('content-type','application/json',
                                  'x-wando-internal','INTERNAL_SECRET_HERE'),
    body    := jsonb_build_object('kind','friday_digest')
  );
  $$
);

-- Проверка: select jobname, schedule from cron.job where jobname like 'wando-%';
-- Ожидаю строку wando-friday-digest (30 14 * * 5) среди прочих.
