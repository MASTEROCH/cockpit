-- ============================================================================
-- WANDO · Рабочие чаты → Приёмка
--  · tg_chats      — какой Telegram-чат к какому проекту привязан и как часто слать выжимку
--  · tg_chat_msgs  — буфер сообщений после сита (без стикеров, «ок», ботов); живёт ≤ 3 суток,
--                    клиенту недоступен — читает и чистит только функция tg-bot (service role)
--  · pg_cron каждые 30 мин → событие chat_digest; кому пора — решает функция по cadence
--
-- ⚠️ ПЕРЕД ЗАПУСКОМ: замени INTERNAL_SECRET_HERE (1 вхождение) на значение секрета
--    WANDO_INTERNAL_SECRET (тот же, что в Secrets функции tg-bot).
-- Запускать в Supabase → SQL Editor. Безопасно к повторному запуску.
-- ============================================================================

create table if not exists public.tg_chats (
  chat_id        bigint primary key,
  workspace_id   text not null default 'main',
  project_id     text,
  title          text,
  added_by       text not null,                       -- email того, кто подключил
  enabled        boolean not null default true,
  cadence        text not null default 'twice',       -- now | twice | evening
  last_digest_at timestamptz,
  created_at     timestamptz not null default now()
);
alter table public.tg_chats enable row level security;
drop policy if exists tg_chats_team on public.tg_chats;
create policy tg_chats_team on public.tg_chats for all to authenticated
  using (public.is_member(auth.jwt() ->> 'email', tg_chats.workspace_id))
  with check (public.is_member(auth.jwt() ->> 'email', tg_chats.workspace_id));

create table if not exists public.tg_chat_msgs (
  chat_id    bigint not null references public.tg_chats(chat_id) on delete cascade,
  msg_id     bigint not null,
  from_id    bigint,
  from_name  text,
  text       text not null,
  ts         timestamptz not null default now(),
  processed  boolean not null default false,
  primary key (chat_id, msg_id)
);
create index if not exists tg_chat_msgs_pending on public.tg_chat_msgs (chat_id, processed, ts);
alter table public.tg_chat_msgs enable row level security;
-- политик нет намеренно: клиенту переписку не отдаём, только service role функции

select cron.schedule(
  'wando-chat-digest',
  '*/30 * * * *',
  $$
  select net.http_post(
    url     := 'https://tonmsmxzmycimybzywqp.supabase.co/functions/v1/tg-bot',
    headers := jsonb_build_object('content-type','application/json',
                                  'x-wando-internal','INTERNAL_SECRET_HERE'),
    body    := jsonb_build_object('kind','chat_digest')
  );
  $$
);

-- Проверка: select jobname, schedule from cron.job where jobname like 'wando-%';
--           select chat_id, title, project_id, cadence, enabled from tg_chats;
