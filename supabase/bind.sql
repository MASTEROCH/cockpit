-- ============================================================================
-- WANDO · Привязка Telegram в ОДИН ТАП (deep-link, без копирования ключей)
-- Сайт после логина сам создаёт ключ + одноразовый код и открывает
-- t.me/wando_tasks_bot?start=bind_<код>. Бот по коду привязывает чат.
-- Запускать в Supabase → SQL Editor. Безопасно к повторному запуску.
-- ============================================================================

-- одноразовые коды привязки (живут 15 минут, сгорают после использования)
create table if not exists public.tg_bind_codes (
  code       text primary key,
  email      text not null,
  token_hash text not null,
  workspace  text not null default 'default',
  created_at timestamptz not null default now(),
  used       boolean not null default false
);
alter table public.tg_bind_codes enable row level security;

-- залогиненный пользователь создаёт коды только на свой email; читать не нужно
drop policy if exists bind_insert_own on public.tg_bind_codes;
create policy bind_insert_own on public.tg_bind_codes
  for insert to authenticated
  with check (lower(email) = lower((auth.jwt() ->> 'email')));
-- (select/update — только service role из бота)

-- сайт должен видеть СВОЮ привязку (для «✅ Telegram подключён» после Start)
drop policy if exists tg_links_see_own on public.tg_links;
create policy tg_links_see_own on public.tg_links
  for select
  using (lower(email) = lower((auth.jwt() ->> 'email')));

-- Готово. Дальше: бот обрабатывает /start bind_<код> (tg-bot v2.1).
