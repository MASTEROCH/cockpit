-- ============================================================================
-- WANDO · Роли в проекте «как в Asana» (ROCH #1412) — поверх access.sql
--  Уровни участника проекта: data.members[].access = admin | edit | comment | view (нет поля = edit).
--  1. Наблюдатель (view) ничего не пишет в проект — UPDATE только admin/edit/comment
--     (комментатору нужна запись комментария; правку задач ему запрещает интерфейс).
--  2. Роли меняют только админ проекта и владелец/админ пространства — триггер сравнивает
--     data.members до/после: остальные могут добавить себя (не админом) и править свои поля, но не чужие роли.
--  3. Запросы доступа `accessreq:*` — служебные, только сервер.
-- Безопасно к повторному запуску. Секретов не содержит.
-- ============================================================================

-- роль человека в проекте (по почте), null — не участник
create or replace function public.project_access_of(p_email text, p_project text)
returns text language sql stable security definer set search_path = public as
$$ select coalesce(nullif(m->>'access',''),'edit')
     from projects p, jsonb_array_elements(coalesce(p.data->'members','[]'::jsonb)) m
    where p.id = p_project and coalesce(p_email,'') <> '' and lower(coalesce(m->>'email','')) = lower(p_email)
    limit 1 $$;
grant execute on function public.project_access_of(text,text) to authenticated;

-- служебные ключи workspace_meta: + запросы доступа
create or replace function public.meta_private(p_k text)
returns boolean language sql immutable as
$$ select p_k like 'invite:%' or p_k like 'weblogin:%' or p_k like 'selfserve:%' or p_k like 'migr:%' or p_k like 'accessreq:%' $$;

-- UPDATE проекта: участник-наблюдатель больше не пишет
drop policy if exists projects_team_update on public.projects;
create policy projects_team_update on public.projects for update to authenticated
  using (
    public.is_member(auth.jwt() ->> 'email', projects.workspace_id) and (
         public.team_sees_all(auth.jwt() ->> 'email')
      or (public.project_is_open(projects.id) and coalesce(public.project_access_of(auth.jwt() ->> 'email', projects.id),'edit') <> 'view')
      or public.guest_role(auth.jwt() ->> 'email', projects.id) = 'member'
      or public.project_access_of(auth.jwt() ->> 'email', projects.id) in ('admin','edit','comment')))
  with check (
    public.is_member(auth.jwt() ->> 'email', projects.workspace_id) and (
         public.team_sees_all(auth.jwt() ->> 'email')
      or (public.project_is_open(projects.id) and coalesce(public.project_access_of(auth.jwt() ->> 'email', projects.id),'edit') <> 'view')
      or public.guest_role(auth.jwt() ->> 'email', projects.id) = 'member'
      or public.project_access_of(auth.jwt() ->> 'email', projects.id) in ('admin','edit','comment')));

-- роли меняет только админ проекта / владелец / админ пространства
create or replace function public.projects_guard_roles() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  em text := lower(coalesce(auth.jwt() ->> 'email',''));
  n jsonb; o jsonb;
begin
  if coalesce(auth.role(),'') = 'service_role' or em = '' then return new; end if;   -- сервер (бот, функции) — свои проверки
  if public.team_sees_all(em) then return new; end if;                              -- владелец / админ пространства
  if exists (select 1 from jsonb_array_elements(coalesce(old.data->'members','[]'::jsonb)) m
              where lower(coalesce(m->>'email','')) = em and m->>'access' = 'admin') then return new; end if; -- админ проекта
  for n in select * from jsonb_array_elements(coalesce(new.data->'members','[]'::jsonb)) loop
    select m into o from jsonb_array_elements(coalesce(old.data->'members','[]'::jsonb)) m where m->>'id' = n->>'id' limit 1;
    if o is null then
      if coalesce(nullif(n->>'access',''),'edit') = 'admin' then raise exception 'Назначать админа проекта может только админ'; end if;
    elsif coalesce(nullif(o->>'access',''),'edit') <> coalesce(nullif(n->>'access',''),'edit') then
      raise exception 'Менять роли в проекте может только его админ';
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists projects_guard_roles on public.projects;
create trigger projects_guard_roles before update on public.projects
  for each row when (old.data->'members' is distinct from new.data->'members')
  execute function public.projects_guard_roles();

-- Проверка:
--   select policyname, cmd from pg_policies where tablename='projects';
--   select tgname from pg_trigger where tgrelid='public.projects'::regclass and not tgisinternal;
