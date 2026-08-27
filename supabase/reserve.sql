-- ============================================================================
-- WANDO · «Запас»: API-ключи, гостевые ссылки на задачу, крон кладбища амбиций
--  · api_keys    — ключ публичного API (только sha256-хеш; выдаёт бот: «api ключ»)
--  · task_shares — гостевые ссылки на одну задачу (?guest=<token>)
--  · крон «кладбище амбиций» — 1-е число месяца, 11:00 Батуми (07:00 UTC)
-- Секрет подставлять не нужно: команда копируется из существующего джоба.
-- Запускать в Supabase → SQL Editor. Безопасно к повторному запуску.
-- ============================================================================

create table if not exists public.api_keys (
  workspace_id text primary key,
  key_hash     text not null,
  label        text not null default 'default',
  created_at   timestamptz not null default now()
);
alter table public.api_keys enable row level security; -- политик нет: только service role

create table if not exists public.task_shares (
  token      text primary key,
  project_id text not null,
  task_id    text not null,
  created_by text not null,
  revoked    boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists task_shares_task on public.task_shares (task_id);
alter table public.task_shares enable row level security; -- политик нет: только service role

do $do$
declare cmd text;
begin
  select command into cmd from cron.job where jobname = 'wando-evening-review';
  if cmd is null then raise exception 'wando-evening-review not found'; end if;
  perform cron.schedule('wando-graveyard', '0 7 1 * *', replace(cmd, 'evening_review', 'graveyard'));
end $do$;

select jobname, schedule from cron.job where jobname like 'wando-%' order by jobname;
-- Ожидаю 5 строк, среди них wando-graveyard (0 7 1 * *).
