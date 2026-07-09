-- ============================================================================
-- WANDO · Team & Roles + Telegram-привязка
-- Заменяет захардкоженный список email в RLS на таблицу team + добавляет
-- гостевой доступ по проектам (project_access) и привязку Telegram (tg_links).
-- Запускать ОДИН раз в Supabase → SQL Editor. Безопасно к повторному запуску.
-- Новых людей (Денис и др.) добавляет команда прямо на сайте: Команда → «Доступ».
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Команда (полный доступ ко ВСЕМ проектам, включая личные друг друга)
-- ----------------------------------------------------------------------------
create table if not exists public.team (
  email      text primary key,
  name       text,
  role       text not null default 'full',      -- 'full' (пока единственная)
  created_at timestamptz not null default now()
);
alter table public.team enable row level security;
-- команду видят только члены команды; менять состав — тоже они
drop policy if exists team_rw on public.team;
create policy team_rw on public.team
  for all
  using (exists (select 1 from public.team t where lower(t.email) = lower((auth.jwt() ->> 'email'))))
  with check (exists (select 1 from public.team t where lower(t.email) = lower((auth.jwt() ->> 'email'))));

insert into public.team(email, name) values
  ('romi4rv23@gmail.com',      'Роман'),
  ('dmitry.nevmer@gmail.com',  'Дмитрий')
on conflict (email) do nothing;
-- Денис и следующие: добавляются на сайте (Команда → «Доступ и роли»)
-- или вручную: insert into public.team(email,name) values ('email','Имя');

-- ----------------------------------------------------------------------------
-- 2) Гостевой доступ по проектам (уровень «Саша»: видит/ведёт только выданное)
--    role: 'member' — видит проект и может вести задачи;
--          'viewer' — только смотрит.
-- ----------------------------------------------------------------------------
create table if not exists public.project_access (
  project_id text not null,
  email      text not null,
  role       text not null default 'member',    -- 'member' | 'viewer'
  granted_by text,
  created_at timestamptz not null default now(),
  primary key (project_id, email)
);
alter table public.project_access enable row level security;
-- выдавать/забирать доступ может только команда; гость видит свои выдачи
drop policy if exists pa_team_all on public.project_access;
create policy pa_team_all on public.project_access
  for all
  using (exists (select 1 from public.team t where lower(t.email) = lower((auth.jwt() ->> 'email'))))
  with check (exists (select 1 from public.team t where lower(t.email) = lower((auth.jwt() ->> 'email'))));
drop policy if exists pa_guest_see_own on public.project_access;
create policy pa_guest_see_own on public.project_access
  for select
  using (lower(email) = lower((auth.jwt() ->> 'email')));

-- ----------------------------------------------------------------------------
-- 3) RLS на projects: команда — всё; гость — только выданные проекты
--    (сносим ВСЕ старые политики, включая захардкоженные email)
-- ----------------------------------------------------------------------------
do $$ declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname='public' and tablename='projects' loop
    execute format('drop policy %I on public.projects', pol.policyname);
  end loop;
end $$;

create policy projects_team_all on public.projects
  for all
  using (exists (select 1 from public.team t where lower(t.email) = lower((auth.jwt() ->> 'email'))))
  with check (exists (select 1 from public.team t where lower(t.email) = lower((auth.jwt() ->> 'email'))));

create policy projects_guest_select on public.projects
  for select
  using (exists (select 1 from public.project_access pa
    where pa.project_id = projects.id
      and lower(pa.email) = lower((auth.jwt() ->> 'email'))));

create policy projects_guest_update on public.projects
  for update
  using (exists (select 1 from public.project_access pa
    where pa.project_id = projects.id
      and lower(pa.email) = lower((auth.jwt() ->> 'email'))
      and pa.role = 'member'))
  with check (exists (select 1 from public.project_access pa
    where pa.project_id = projects.id
      and lower(pa.email) = lower((auth.jwt() ->> 'email'))
      and pa.role = 'member'));
-- (insert/delete проектов гостям намеренно не даём)

-- ----------------------------------------------------------------------------
-- 4) Приёмка видна и решается ТОЛЬКО командой (гости лишь отправляют через бот/Claude)
-- ----------------------------------------------------------------------------
drop policy if exists intake_select on public.intake;
create policy intake_select on public.intake for select
  using (exists (select 1 from public.team t where lower(t.email) = lower((auth.jwt() ->> 'email'))));
drop policy if exists intake_update on public.intake;
create policy intake_update on public.intake for update
  using (exists (select 1 from public.team t where lower(t.email) = lower((auth.jwt() ->> 'email'))));
drop policy if exists intake_delete on public.intake;
create policy intake_delete on public.intake for delete
  using (exists (select 1 from public.team t where lower(t.email) = lower((auth.jwt() ->> 'email'))));

-- ----------------------------------------------------------------------------
-- 5) Привязка Telegram-аккаунтов (пишет только edge-функция сервис-ключом)
-- ----------------------------------------------------------------------------
create table if not exists public.tg_links (
  chat_id    bigint primary key,
  email      text not null,
  name       text,
  token_hash text not null,
  workspace  text not null default 'default',
  created_at timestamptz not null default now(),
  revoked    boolean not null default false
);
alter table public.tg_links enable row level security;
-- политик нет намеренно: клиентам таблица недоступна, только service role

-- ----------------------------------------------------------------------------
-- 6) cockpit_status / cockpit_projects теперь уважают доступ:
--    команда видит всё, гость — только выданные проекты
-- ----------------------------------------------------------------------------
create or replace function public.cockpit_status(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text; v_email text;
  v_is_team boolean;
  v_today text := to_char((now() at time zone 'UTC')::date,'YYYY-MM-DD');
  v_projects jsonb;
begin
  v_hash := encode(digest(p_token,'sha256'),'hex');
  select email into v_email from public.intake_tokens
    where token_hash = v_hash and coalesce(revoked,false) = false limit 1;
  if v_email is null then
    return jsonb_build_object('error','invalid or revoked token'); end if;
  update public.intake_tokens set last_used_at = now() where token_hash = v_hash;
  select exists(select 1 from public.team t where lower(t.email)=lower(v_email)) into v_is_team;

  select coalesce(jsonb_agg(row_to_json(s)::jsonb order by (s.overdue) desc,(s.total) desc),'[]'::jsonb)
    into v_projects
  from (
    select pr.name as project, pr.emoji as emoji,
      (select count(*) from jsonb_array_elements(coalesce(pr.data->'tasks','[]'::jsonb)) t
        where coalesce((t->>'isMilestone')::bool,false)=false) as total,
      (select count(*) from jsonb_array_elements(coalesce(pr.data->'tasks','[]'::jsonb)) t
        where coalesce((t->>'isMilestone')::bool,false)=false and (t->>'status')='done') as done,
      (select count(*) from jsonb_array_elements(coalesce(pr.data->'tasks','[]'::jsonb)) t
        where coalesce((t->>'isMilestone')::bool,false)=false and (t->>'status')<>'done'
          and coalesce(t->>'end','9999-12-31') < v_today) as overdue,
      (select coalesce(jsonb_agg(x.title order by x.endd asc),'[]'::jsonb) from (
        select (t->>'title') as title, coalesce(t->>'end','9999-12-31') as endd
        from jsonb_array_elements(coalesce(pr.data->'tasks','[]'::jsonb)) t
        where coalesce((t->>'isMilestone')::bool,false)=false and (t->>'status')<>'done'
        order by coalesce(t->>'end','9999-12-31') asc limit 6) x) as next_up,
      (select coalesce(jsonb_agg(x.title order by x.endd asc),'[]'::jsonb) from (
        select (t->>'title') as title, coalesce(t->>'end','9999-12-31') as endd
        from jsonb_array_elements(coalesce(pr.data->'tasks','[]'::jsonb)) t
        where coalesce((t->>'isMilestone')::bool,false)=false and (t->>'status')<>'done'
          and coalesce(t->>'end','9999-12-31') < v_today
        order by coalesce(t->>'end','9999-12-31') asc limit 8) x) as overdue_titles
    from public.projects pr
    where coalesce(pr.data->>'demo','false') <> 'true'
      and coalesce((pr.data->>'archived')::bool,false) = false
      and (v_is_team or exists (select 1 from public.project_access pa
            where pa.project_id = pr.id and lower(pa.email)=lower(v_email)))
  ) s;

  return jsonb_build_object('today',v_today,'projects',v_projects);
end $$;
grant execute on function public.cockpit_status(text) to anon;

create or replace function public.cockpit_projects(p_token text)
returns table(id text, name text, emoji text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_email text; v_is_team boolean;
begin
  v_hash := encode(digest(p_token,'sha256'),'hex');
  select email into v_email from public.intake_tokens
    where token_hash = v_hash and not revoked limit 1;
  if v_email is null then return; end if;
  select exists(select 1 from public.team t where lower(t.email)=lower(v_email)) into v_is_team;
  return query select p.id::text, p.name::text, coalesce(p.emoji,'📄')::text
    from public.projects p
    where v_is_team or exists (select 1 from public.project_access pa
      where pa.project_id = p.id and lower(pa.email)=lower(v_email));
end $$;
revoke all on function public.cockpit_projects(text) from public;
grant execute on function public.cockpit_projects(text) to anon, authenticated;

-- Готово: team = полный доступ; project_access = гостевой уровень «Саша»;
-- tg_links = привязки Telegram для бота (edge-функция tg-bot).
