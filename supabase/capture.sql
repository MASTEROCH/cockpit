-- ============================================================================
-- WANDO · Бот = один блокнот (ROCH #1394)
--  · tg_capture_buf — личные сообщения боту живут здесь 2,5 с, чтобы склеить пачку:
--                     альбом фото, «переслать с комментарием», контент + голосовая следом.
--                     Обрабатывает последнее сообщение пачки; повтор вебхука Telegram гасит первичный ключ.
--                     Клиенту недоступна — читает и чистит только функция tg-bot (service role).
--  · intake.meta    — разбор ИИ (кому, проект, срок, важность), загруженные файлы, id созданной задачи —
--                     нужен для «Отменить», «Другому…» и для приёмки с готовым разбором в приложении.
-- Безопасно к повторному запуску. Секретов не содержит.
-- ============================================================================

create table if not exists public.tg_capture_buf (
  chat_id    bigint not null,
  msg_id     bigint not null,
  payload    jsonb  not null,                -- { own: [текст автора], fwd: [пересланное], files: [{file_id,name,mime,size}] }
  ts         timestamptz not null default now(),
  claimed_at timestamptz,                    -- забрано в пачку
  primary key (chat_id, msg_id)
);
create index if not exists tg_capture_buf_open on public.tg_capture_buf (chat_id, claimed_at, ts);
alter table public.tg_capture_buf enable row level security;
-- политик нет намеренно: только service role функции

alter table public.intake add column if not exists meta jsonb;

-- Проверка: select count(*) from tg_capture_buf;  select column_name from information_schema.columns where table_name='intake' and column_name='meta';
