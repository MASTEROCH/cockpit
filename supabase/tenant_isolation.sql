-- ============================================================================
-- WANDO · Изоляция воркспейсов + роли (Ф1+Ф2 сведённые) — ЕДИНАЯ миграция
-- ----------------------------------------------------------------------------
-- ЗАЧЕМ: продажа другим компаниям = каждая компания (workspace) видит ТОЛЬКО
-- своё. Сводит в один согласованный проход: workspace_id-изоляцию И ролевую
-- модель внутри команды (owner/admin/member + иерархия). Без этого сведения
-- глобальный is_team() дал бы межкомпанийную утечку (owner компании B увидел
-- бы проекты компании A) — поэтому все политики projects/team/project_access
-- проверяют И воркспейс, И роль.
--
-- ЭТА МИГРАЦИЯ ЗАМЕНЯЕТ (supersedes) access_roles.sql — гонять нужно ЕЁ одну.
--
-- БЕЗОПАСНОСТЬ:
--   • Всё в BEGIN/COMMIT — атомарно. Ошибка на любом шаге → полный откат,
--     половины/локаута не бывает.
--   • Идемпотентно: to_regclass-гарды на ALTER, drop-all-policy циклы,
--     create or replace. Безопасно к повтору.
--   • Проверки через SECURITY DEFINER функции — нет рекурсии политик (42P17).
--   • backfill workspace_id default 'main' → все текущие данные = воркспейс
--     'main' (команда Роча), ничего не пропадает и не блокируется.
--
-- Запускать: Supabase → SQL Editor → вставить целиком → Run. Проверки — внизу.
-- ============================================================================

begin;

-- ============================ Ф1: воркспейсы ================================
create table if not exists public.workspaces (
  id text primary key,
  name text not null,
  plan text not null default 'solo',       -- solo | founder | team | founder_forever
  stars_until timestamptz,
  created_by text,
  created_at timestamptz not null default now()
);
insert into public.workspaces (id, name, plan, created_by)
  values ('main', 'WANDO HQ', 'founder_forever', 'romi4rv23@gmail.com')
  on conflict (id) do update set plan = 'founder_forever';

-- workspace_id на всех мультитенантных таблицах (только если таблица существует)
do $$ begin
  if to_regclass('public.projects')      is not null then alter table public.projects      add column if not exists workspace_id text not null default 'main'; end if;
  if to_regclass('public.intake')        is not null then alter table public.intake        add column if not exists workspace_id text not null default 'main'; end if;
  if to_regclass('public.team')          is not null then alter table public.team          add column if not exists workspace_id text not null default 'main'; end if;
  if to_regclass('public.tg_links')      is not null then alter table public.tg_links      add column if not exists workspace_id text not null default 'main'; end if;
  if to_regclass('public.tg_bind_codes') is not null then alter table public.tg_bind_codes add column if not exists workspace_id text not null default 'main'; end if;
  if to_regclass('public.workspace_meta')is not null then alter table public.workspace_meta add column if not exists workspace_id text not null default 'main'; end if;
end $$;
create index if not exists idx_projects_ws on public.projects (workspace_id);
create index if not exists idx_team_ws     on public.team (workspace_id);

-- Роч — владелец своего воркспейса (выше всех)
update public.team set role = 'owner' where lower(email) = 'romi4rv23@gmail.com';

-- ============================ helpers ======================================
-- членство в воркспейсе (email уникален глобально: 1 email = 1 воркспейс)
create or replace function public.is_member(p_email text, p_ws text)
returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from team where lower(email)=lower(coalesce(p_email,'')) and workspace_id=p_ws) $$;
grant execute on function public.is_member(text, text) to anon, authenticated;

create or replace function public.my_ws(p_email text)
returns text language sql stable security definer set search_path = public as
$$ select workspace_id from team where lower(email)=lower(coalesce(p_email,'')) limit 1 $$;
grant execute on function public.my_ws(text) to anon, authenticated;

create or replace function public.ws_of_project(p_project text)
returns text language sql stable security definer set search_path = public as
$$ select workspace_id from projects where id = p_project $$;
grant execute on function public.ws_of_project(text) to anon, authenticated;

-- ранг роли: owner 3 > admin/full 2 > member 1 > чужой 0
-- (легаси 'full' = 2, как админ: видит всё, но владелец им управляет)
create or replace function public.role_rank(p_email text)
returns int language sql stable security definer set search_path = public as
$$ select case coalesce(nullif((select role from team where lower(email)=lower(coalesce(p_email,'')) limit 1),''),'')
     when 'owner' then 3 when 'full' then 2 when 'admin' then 2 when 'member' then 1 else 0 end $$;
grant execute on function public.role_rank(text) to anon, authenticated;

create or replace function public.rank_of(p_role text)
returns int language sql immutable as
$$ select case coalesce(nullif(p_role,''),'member')
     when 'owner' then 3 when 'full' then 2 when 'admin' then 2 when 'member' then 1 else 1 end $$;
grant execute on function public.rank_of(text) to anon, authenticated;

-- видит ли email все проекты своего воркспейса (owner/admin/full)
create or replace function public.team_sees_all(p_email text)
returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from team where lower(email)=lower(coalesce(p_email,''))
     and coalesce(nullif(role,''),'full') in ('owner','admin','full')) $$;
grant execute on function public.team_sees_all(text) to anon, authenticated;

-- открыт ли проект всей команде (флаг отсутствует = открыт)
create or replace function public.project_is_open(p_project text)
returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((data->>'open')::boolean, true) from projects where id = p_project $$;
grant execute on function public.project_is_open(text) to anon, authenticated;

-- числится ли email в data.members проекта (добавлен явно)
create or replace function public.in_project_members(p_email text, p_project text)
returns boolean language sql stable security definer set search_path = public as
$$ select coalesce(p_email,'') <> '' and exists(
     select 1 from projects p, jsonb_array_elements(coalesce(p.data->'members','[]'::jsonb)) m
     where p.id = p_project and lower(coalesce(m->>'email','')) = lower(p_email)) $$;
grant execute on function public.in_project_members(text,text) to anon, authenticated;

-- is_team / guest_role (как в team.sql — на случай отката/переустановки)
create or replace function public.is_team(p_email text)
returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from team where lower(email)=lower(coalesce(p_email,''))) $$;
grant execute on function public.is_team(text) to anon, authenticated;

create or replace function public.guest_role(p_email text, p_project text)
returns text language sql stable security definer set search_path = public as
$$ select role from project_access where lower(email)=lower(coalesce(p_email,'')) and project_id=p_project limit 1 $$;
grant execute on function public.guest_role(text,text) to anon, authenticated;

-- ============================ PROJECTS =====================================
-- снести ВСЕ политики и собрать: воркспейс + роль в одной модели
do $$ declare pol record; begin
  for pol in select policyname from pg_policies where schemaname='public' and tablename='projects' loop
    execute format('drop policy %I on public.projects', pol.policyname); end loop; end $$;

create policy projects_team_visible on public.projects
  for all to authenticated
  using (
    public.is_member(auth.jwt() ->> 'email', projects.workspace_id) and (
         public.team_sees_all(auth.jwt() ->> 'email')
      or public.project_is_open(projects.id)
      or public.guest_role(auth.jwt() ->> 'email', projects.id) is not null
      or public.in_project_members(auth.jwt() ->> 'email', projects.id)))
  with check (
    public.is_member(auth.jwt() ->> 'email', projects.workspace_id) and (
         public.team_sees_all(auth.jwt() ->> 'email')
      or public.project_is_open(projects.id)
      or public.guest_role(auth.jwt() ->> 'email', projects.id) = 'member'
      or public.in_project_members(auth.jwt() ->> 'email', projects.id)));

-- чистые гости (не в team) — только выданный проект
create policy projects_guest_select on public.projects
  for select to authenticated
  using (public.guest_role(auth.jwt() ->> 'email', projects.id) is not null);
create policy projects_guest_update on public.projects
  for update to authenticated
  using (public.guest_role(auth.jwt() ->> 'email', projects.id) = 'member')
  with check (public.guest_role(auth.jwt() ->> 'email', projects.id) = 'member');

-- ============================ TEAM =========================================
-- воркспейс-скоуп + иерархия рангов (строго ниже себя; анти-эскалация)
do $$ declare pol record; begin
  for pol in select policyname from pg_policies where schemaname='public' and tablename='team' loop
    execute format('drop policy %I on public.team', pol.policyname); end loop; end $$;

create policy team_select on public.team
  for select to authenticated
  using (public.is_member(auth.jwt() ->> 'email', team.workspace_id));

create policy team_insert on public.team
  for insert to authenticated
  with check (public.is_member(auth.jwt() ->> 'email', workspace_id)
    and public.role_rank(auth.jwt() ->> 'email') > public.rank_of(role));

create policy team_update on public.team
  for update to authenticated
  using (public.is_member(auth.jwt() ->> 'email', team.workspace_id)
    and public.role_rank(auth.jwt() ->> 'email') > public.role_rank(team.email))
  with check (public.is_member(auth.jwt() ->> 'email', workspace_id)
    and public.role_rank(auth.jwt() ->> 'email') > public.rank_of(role));

create policy team_delete on public.team
  for delete to authenticated
  using (public.is_member(auth.jwt() ->> 'email', team.workspace_id)
    and public.role_rank(auth.jwt() ->> 'email') > public.role_rank(team.email));

-- ============================ PROJECT_ACCESS ===============================
-- гостей проекта ведёт член ЭТОГО воркспейса, который сам в проекте (или админ)
do $$ declare pol record; begin
  for pol in select policyname from pg_policies where schemaname='public' and tablename='project_access' loop
    execute format('drop policy %I on public.project_access', pol.policyname); end loop; end $$;

create policy pa_admin_all on public.project_access
  for all to authenticated
  using (
    public.is_member(auth.jwt() ->> 'email', public.ws_of_project(project_access.project_id)) and (
         public.team_sees_all(auth.jwt() ->> 'email')
      or public.in_project_members(auth.jwt() ->> 'email', project_access.project_id)))
  with check (
    public.is_member(auth.jwt() ->> 'email', public.ws_of_project(project_access.project_id)) and (
         public.team_sees_all(auth.jwt() ->> 'email')
      or public.in_project_members(auth.jwt() ->> 'email', project_access.project_id)));

create policy pa_see_own on public.project_access
  for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email'));

-- ============================ INTAKE (приёмка) =============================
-- видит/решает только команда ЭТОГО воркспейса (insert идёт service-role — не трогаем)
do $intake$ begin
  if to_regclass('public.intake') is not null then
    execute 'drop policy if exists intake_select on public.intake';
    execute 'drop policy if exists intake_update on public.intake';
    execute 'drop policy if exists intake_delete on public.intake';
    execute 'create policy intake_select on public.intake for select to authenticated using (public.is_member(auth.jwt() ->> ''email'', intake.workspace_id))';
    execute 'create policy intake_update on public.intake for update to authenticated using (public.is_member(auth.jwt() ->> ''email'', intake.workspace_id)) with check (public.is_member(auth.jwt() ->> ''email'', intake.workspace_id))';
    execute 'create policy intake_delete on public.intake for delete to authenticated using (public.is_member(auth.jwt() ->> ''email'', intake.workspace_id))';
  end if;
end $intake$;

-- ============================ WORKSPACE_META ===============================
do $wm$ begin
  if to_regclass('public.workspace_meta') is not null then
    execute 'drop policy if exists wm_team_all on public.workspace_meta';
    execute 'create policy wm_team_all on public.workspace_meta for all to authenticated using (public.is_member(auth.jwt() ->> ''email'', workspace_meta.workspace_id)) with check (public.is_member(auth.jwt() ->> ''email'', workspace_meta.workspace_id))';
  end if;
end $wm$;

-- ============================ WORKSPACES ===================================
alter table public.workspaces enable row level security;
drop policy if exists ws_member_select on public.workspaces;
create policy ws_member_select on public.workspaces
  for select to authenticated
  using (public.is_member(auth.jwt() ->> 'email', id));
-- insert/update воркспейсов — только service role (self-serve/бот)

-- ============================ мёртвые таблицы SignalOS =====================
-- публично читались (вкл. хэши паролей) — WANDO их не использует (решение Роча 25.08)
drop table if exists public.users, public.configs, public.sessions, public.signals;

-- ============================ триггер воркспейса проекта ===================
-- INSERT: проект получает воркспейс создателя; UPDATE: workspace_id неизменяем
create or replace function public.set_project_ws()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    if (auth.jwt() ->> 'email') is not null then
      new.workspace_id := coalesce(public.my_ws(auth.jwt() ->> 'email'), new.workspace_id, 'main');
    end if;
  elsif TG_OP = 'UPDATE' then
    new.workspace_id := old.workspace_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_projects_ws_ins on public.projects;
create trigger trg_projects_ws_ins before insert on public.projects
  for each row execute function public.set_project_ws();
drop trigger if exists trg_projects_ws_upd on public.projects;
create trigger trg_projects_ws_upd before update on public.projects
  for each row execute function public.set_project_ws();

commit;

-- ============================================================================
-- ПРОВЕРКИ ПОСЛЕ ПРИМЕНЕНИЯ (только чтение, безопасно):
--   -- воркспейсы и роли:
--   select id, name, plan from public.workspaces;
--   select email, workspace_id, role, public.role_rank(email) r from public.team order by r desc;
--   -- политики на месте (projects: 3; team: 4; project_access: 2):
--   select tablename, count(*) from pg_policies where schemaname='public'
--     and tablename in ('projects','team','project_access','intake','workspace_meta','workspaces')
--     group by tablename order by tablename;
--   -- мёртвые таблицы снесены (ждём ошибку «relation does not exist» = хорошо):
--   -- select * from public.users limit 1;
--
-- ПОВЕДЕНЧЕСКИ:
--   1) вход Роча → проекты видны, создаются/сохраняются; бот «📊 Статус» отвечает.
--   2) новый воркспейс (2-я компания): insert into workspaces + team(email,workspace_id='<ws>')
--      → их проекты уходят в '<ws>' (триггер) и не видны команде 'main', и наоборот.
--   3) участник (member) не повышает себе роль; закрытый проект не видит.
--
-- ОТКАТ: re-run team.sql (вернёт глобальные is_team-политики «команда видит всё»,
--   БЕЗ воркспейс-изоляции). Функции/колонки workspace_id останутся (безвредны).
-- ============================================================================
