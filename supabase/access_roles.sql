-- ============================================================================
-- WANDO · Роли и видимость ВНУТРИ команды (Этап 1b — серверный enforcement)
-- ----------------------------------------------------------------------------
-- ЧТО ДЕЛАЕТ: переносит модель доступа из клиента (index.html, Stage 1a) в RLS,
-- чтобы её нельзя было обойти прямыми запросами к PostgREST.
--
--   • Владелец (owner) и Админ (admin, а также легаси 'full') — видят ВСЕ проекты.
--   • Участник (member) — видит только ОТКРЫТЫЕ проекты + те, куда добавлен
--     (в data.members по email, либо выдан project_access).
--   • Гость (не в team) — только свой выданный проект (project_access) — как было.
--   • Управлять составом команды и ролями может только тот, кто ВЫШЕ:
--     ранг owner(3) > admin(2) > member(1). Действие строго ниже себя;
--     равный равного и вышестоящего — нельзя (анти-эскалация: участник НЕ может
--     повысить себе роль). Это и есть иерархия удаления, которую задал Роч.
--   • Гостевые доступы к проекту может выдавать/забирать тот, кто сам в этом
--     проекте (админ/владелец — везде; участник/гость-member — в рамках своего).
--
-- БЕЗОПАСНОСТЬ ПРИМЕНЕНИЯ:
--   — Вся миграция обёрнута в BEGIN/COMMIT: применяется АТОМАРНО. Любая ошибка
--     откатит всё целиком — не бывает «половины» и залипшего локаута.
--   — Все проверки идут через SECURITY DEFINER функции (обходят RLS) — нет
--     рекурсии политик (42P17), как и предупреждает team.sql.
--   — Идемпотентно: drop policy if exists / create or replace — безопасно к повтору.
--
-- ТРЕБУЕТ: применённый team.sql (таблицы team, project_access; функции is_team,
--   guest_role). Не зависит от workspace-изоляции (Ф1/Ф2) — её можно катить отдельно.
--
-- Запускать: Supabase → SQL Editor → вставить целиком → Run.
-- ============================================================================

begin;

-- ---- 0) Владелец: Роч выше всех. Легаси-роль 'full' остаётся «видит всё». ----
update public.team set role = 'owner' where lower(email) = 'romi4rv23@gmail.com';

-- ---- 1) helper: ранг роли (owner 3 > admin 2 > member 1; чужой/нет — 0) ----
create or replace function public.role_rank(p_email text)
returns int language sql stable security definer set search_path = public as
$$ select case coalesce(nullif((select role from public.team
        where lower(email) = lower(coalesce(p_email,'')) limit 1), ''), '')
     when 'owner' then 3 when 'full' then 3 when 'admin' then 2 when 'member' then 1
     else 0 end $$;
grant execute on function public.role_rank(text) to anon, authenticated;

-- ранг для ПРОИЗВОЛЬНОГО значения роли (для проверки НОВОЙ роли в with check) --
create or replace function public.rank_of(p_role text)
returns int language sql immutable as
$$ select case coalesce(nullif(p_role,''),'member')
     when 'owner' then 3 when 'full' then 3 when 'admin' then 2 when 'member' then 1
     else 1 end $$;
grant execute on function public.rank_of(text) to anon, authenticated;

-- ---- 2) helper: видит ли этот email все проекты (owner/admin/full) ----
create or replace function public.team_sees_all(p_email text)
returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from public.team
     where lower(email) = lower(coalesce(p_email,''))
       and coalesce(nullif(role,''),'full') in ('owner','admin','full')) $$;
grant execute on function public.team_sees_all(text) to anon, authenticated;

-- ---- 3) helper: открыт ли проект всей команде (флаг отсутствует = открыт) ----
create or replace function public.project_is_open(p_project text)
returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((data->>'open')::boolean, true)
     from public.projects where id = p_project $$;
grant execute on function public.project_is_open(text) to anon, authenticated;

-- ---- 4) helper: числится ли email в data.members проекта (добавлен явно) ----
create or replace function public.in_project_members(p_email text, p_project text)
returns boolean language sql stable security definer set search_path = public as
$$ select coalesce(p_email,'') <> '' and exists(
     select 1 from public.projects p,
       jsonb_array_elements(coalesce(p.data->'members','[]'::jsonb)) m
     where p.id = p_project
       and lower(coalesce(m->>'email','')) = lower(p_email)) $$;
grant execute on function public.in_project_members(text,text) to anon, authenticated;

-- ============================================================================
-- 5) PROJECTS — снести все прежние политики и собрать одну модель видимости
-- ============================================================================
do $$ declare pol record;
begin
  for pol in select policyname from pg_policies
      where schemaname='public' and tablename='projects' loop
    execute format('drop policy %I on public.projects', pol.policyname);
  end loop;
end $$;

-- члены команды: элевейтед видят всё; участник — открытые + свои
create policy projects_team_visible on public.projects
  for all to authenticated
  using (
    public.is_team(auth.jwt() ->> 'email') and (
         public.team_sees_all(auth.jwt() ->> 'email')
      or public.project_is_open(projects.id)
      or public.guest_role(auth.jwt() ->> 'email', projects.id) is not null
      or public.in_project_members(auth.jwt() ->> 'email', projects.id)
    )
  )
  with check (
    public.is_team(auth.jwt() ->> 'email') and (
         public.team_sees_all(auth.jwt() ->> 'email')
      or public.project_is_open(projects.id)
      or public.guest_role(auth.jwt() ->> 'email', projects.id) = 'member'
      or public.in_project_members(auth.jwt() ->> 'email', projects.id)
    )
  );

-- чистые гости (не в team): только выданные проекты (как в team.sql)
create policy projects_guest_select on public.projects
  for select to authenticated
  using (public.guest_role(auth.jwt() ->> 'email', projects.id) is not null);

create policy projects_guest_update on public.projects
  for update to authenticated
  using (public.guest_role(auth.jwt() ->> 'email', projects.id) = 'member')
  with check (public.guest_role(auth.jwt() ->> 'email', projects.id) = 'member');

-- ============================================================================
-- 6) TEAM — читают все члены; менять состав/роли — только строго выше по рангу
--    (анти-эскалация: участник не повысит себя; равный равного не тронет)
-- ============================================================================
drop policy if exists team_rw     on public.team;
drop policy if exists team_select on public.team;
drop policy if exists team_insert on public.team;
drop policy if exists team_update on public.team;
drop policy if exists team_delete on public.team;

create policy team_select on public.team
  for select to authenticated
  using (public.is_team(auth.jwt() ->> 'email'));

-- добавить нового: я элевейтед и НОВАЯ роль строго ниже моего ранга
create policy team_insert on public.team
  for insert to authenticated
  with check (public.role_rank(auth.jwt() ->> 'email') > public.rank_of(role));

-- сменить роль: мой ранг > текущего ранга цели И > новой роли (не поднять до себя)
create policy team_update on public.team
  for update to authenticated
  using  (public.role_rank(auth.jwt() ->> 'email') > public.role_rank(team.email))
  with check (public.role_rank(auth.jwt() ->> 'email') > public.rank_of(role));

-- удалить: мой ранг строго выше ранга цели
create policy team_delete on public.team
  for delete to authenticated
  using (public.role_rank(auth.jwt() ->> 'email') > public.role_rank(team.email));

-- ============================================================================
-- 7) PROJECT_ACCESS — гостей проекта ведёт тот, кто сам в этом проекте
--    (владелец/админ — везде; участник или гость-member — в рамках своего)
-- ============================================================================
drop policy if exists pa_team_all      on public.project_access;
drop policy if exists pa_guest_see_own on public.project_access;
drop policy if exists pa_admin_all     on public.project_access;
drop policy if exists pa_see_own       on public.project_access;

create policy pa_admin_all on public.project_access
  for all to authenticated
  using (
         public.team_sees_all(auth.jwt() ->> 'email')
      or public.in_project_members(auth.jwt() ->> 'email', project_access.project_id)
      or public.guest_role(auth.jwt() ->> 'email', project_access.project_id) = 'member'
  )
  with check (
         public.team_sees_all(auth.jwt() ->> 'email')
      or public.in_project_members(auth.jwt() ->> 'email', project_access.project_id)
      or public.guest_role(auth.jwt() ->> 'email', project_access.project_id) = 'member'
  );

create policy pa_see_own on public.project_access
  for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email'));

commit;

-- ============================================================================
-- ПРОВЕРКИ ПОСЛЕ ПРИМЕНЕНИЯ (выполнить отдельно; всё безопасно, только чтение):
--
--   -- a) роли на месте, Роч — владелец:
--   select email, role from public.team order by public.role_rank(email) desc;
--
--   -- b) политики projects (ждём: projects_team_visible + 2 гостевые):
--   select policyname, cmd from pg_policies
--     where schemaname='public' and tablename='projects';
--
--   -- c) политики team (ждём: select/insert/update/delete по рангу):
--   select policyname, cmd from pg_policies
--     where schemaname='public' and tablename='team';
--
-- ПОВЕДЕНЧЕСКИ (в приложении, после Run):
--   1) вход Роча → все проекты видны, создаются/сохраняются.
--   2) создать закрытый проект, добавить участника (member) НЕ в него →
--      у него этот проект не появляется; открыть проект всем → появляется.
--   3) участник (member) не может через UI/запрос повысить себе роль (RLS режет).
--   4) бот «📊 Статус» отвечает (service-role обходит RLS — работает всегда).
--
-- ОТКАТ: заново прогнать team.sql (вернёт старые is_team-политики projects/team/
--   project_access — «команда видит всё»). Функции role_rank/team_sees_all и т.п.
--   останутся (безвредны, никем не используются после отката).
-- ============================================================================
