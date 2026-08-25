-- ============================================================
-- WANDO · Изоляция воркспейсов — добивка Ф2 (2026-08-25)
-- Закрывает найденные на ревизии дыры. Идемпотентно, безопасно к повтору.
-- Применять в Supabase → SQL Editor после явного «да» Роча.
-- ============================================================

-- 0) базовые функции Ф2 (create or replace — на случай если что-то не доехало)
create or replace function public.is_member(p_email text, p_ws text)
returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from team where lower(email)=lower(coalesce(p_email,'')) and workspace_id=p_ws) $$;
grant execute on function public.is_member(text, text) to anon, authenticated;

create or replace function public.my_ws(p_email text)
returns text language sql stable security definer set search_path = public as
$$ select workspace_id from team where lower(email)=lower(coalesce(p_email,'')) limit 1 $$;
grant execute on function public.my_ws(text) to anon, authenticated;

-- 1) воркспейс проекта (для политик project_access)
create or replace function public.ws_of_project(p_project text)
returns text language sql stable security definer set search_path = public as
$$ select workspace_id from projects where id = p_project $$;
grant execute on function public.ws_of_project(text) to anon, authenticated;

-- 2) ДЫРА: pa_team_all была на глобальном is_team() — команда любого
--    воркспейса могла управлять гостевыми доступами чужих проектов.
drop policy if exists pa_team_all on public.project_access;
create policy pa_team_all on public.project_access
  for all to authenticated
  using (public.is_member(auth.jwt() ->> 'email', public.ws_of_project(project_id)))
  with check (public.is_member(auth.jwt() ->> 'email', public.ws_of_project(project_id)));

-- 3) ДЫРА: workspaces читалась анонимно (RLS был выключен).
alter table public.workspaces enable row level security;
drop policy if exists ws_member_select on public.workspaces;
create policy ws_member_select on public.workspaces
  for select to authenticated
  using (public.is_member(auth.jwt() ->> 'email', id));
-- insert/update — только service role (бот, self-serve)

-- 4) ДЫРА: чужие таблицы старого эксперимента SignalOS (users, configs,
--    sessions, signals) были публично читаемы, включая хэши паролей.
--    WANDO их не использует — по решению Роча (2026-08-25) сносим совсем.
drop table if exists public.users, public.configs, public.sessions, public.signals;

-- 5) БАГ: сайт не подставляет workspace_id при создании проекта (default 'main').
--    Триггер: при INSERT от залогиненного юзера проект получает ЕГО воркспейс;
--    при UPDATE workspace_id неизменяем (анти-угон проекта между воркспейсами).
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

-- ============================================================
-- ПРОВЕРКИ ПОСЛЕ ПРИМЕНЕНИЯ (curl с anon-ключом, БЕЗ JWT):
--   GET /rest/v1/users?select=*     → []
--   GET /rest/v1/configs?select=*   → []
--   GET /rest/v1/workspaces?select=* → []
--   GET /rest/v1/projects?select=*  → []
-- Сайт: вход Роча → проекты создаются/сохраняются, бот отвечает /status.
-- ОТКАТ п.2: прогнать блок pa_team_all из team.sql (is_team-версия).
-- ОТКАТ п.4: таблицы удалены безвозвратно (данные SignalOS были тестовым мусором).
-- ============================================================
