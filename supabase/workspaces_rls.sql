-- ============================================================
-- WANDO · Multi-tenant Ф2: RLS-изоляция воркспейсов
-- ЧЕРНОВИК — НЕ ПРИМЕНЯТЬ без явного «да» Роча. Требует applied Ф1.
-- Паттерн: SECURITY DEFINER (анти-42P17, как в team.sql).
-- Катить в нерабочее время команды; после — curl-проверки внизу.
-- ============================================================

-- членство: email состоит в team ЭТОГО воркспейса
create or replace function public.is_member(p_email text, p_ws text)
returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from team where lower(email)=lower(p_email) and workspace_id=p_ws) $$;
grant execute on function public.is_member(text, text) to anon, authenticated;

-- мой воркспейс по email (для self-serve: 1 email = 1 воркспейс в v1)
create or replace function public.my_ws(p_email text)
returns text language sql stable security definer set search_path = public as
$$ select workspace_id from team where lower(email)=lower(p_email) limit 1 $$;
grant execute on function public.my_ws(text) to anon, authenticated;

-- ---- projects: политики team → member(workspace) ----
drop policy if exists projects_team_all on public.projects;
create policy projects_team_all on public.projects
  for all to authenticated
  using (public.is_member(auth.jwt() ->> 'email', projects.workspace_id))
  with check (public.is_member(auth.jwt() ->> 'email', projects.workspace_id));
-- гостевые политики (guest_role) остаются как есть — project_access уже точечный

-- ---- intake (реальные политики: intake_select/update/delete; insert идёт
--      через intake_tokens-путь и service-role — его не трогаем) ----
drop policy if exists intake_select on public.intake;
create policy intake_select on public.intake for select to authenticated
  using (public.is_member(auth.jwt() ->> 'email', intake.workspace_id));
drop policy if exists intake_update on public.intake;
create policy intake_update on public.intake for update to authenticated
  using (public.is_member(auth.jwt() ->> 'email', intake.workspace_id))
  with check (public.is_member(auth.jwt() ->> 'email', intake.workspace_id));
drop policy if exists intake_delete on public.intake;
create policy intake_delete on public.intake for delete to authenticated
  using (public.is_member(auth.jwt() ->> 'email', intake.workspace_id));

-- ---- team: вижу/правлю только команду своего воркспейса ----
drop policy if exists team_rw on public.team;
create policy team_rw on public.team
  for all to authenticated
  using (public.is_member(auth.jwt() ->> 'email', team.workspace_id))
  with check (public.is_member(auth.jwt() ->> 'email', team.workspace_id));

-- ---- workspace_meta ----
drop policy if exists wm_team_all on public.workspace_meta;
create policy wm_team_all on public.workspace_meta
  for all to authenticated
  using (public.is_member(auth.jwt() ->> 'email', workspace_meta.workspace_id))
  with check (public.is_member(auth.jwt() ->> 'email', workspace_meta.workspace_id));

-- ============================================================
-- ПРОВЕРКИ ПОСЛЕ ПРИМЕНЕНИЯ (curl, PostgREST):
-- 1) с валидным JWT члена main: GET /rest/v1/projects → строки приходят
-- 2) с anon-ключом без JWT: GET /rest/v1/projects → []
-- 3) сайт: вход Роча → проекты видны, задача создаётся/редактируется
-- 4) бот: «📊 Статус» отвечает (service-role обходит RLS — должен работать всегда)
-- ОТКАТ: заново прогнать блок политик из team.sql (старые is_team-версии).
-- ============================================================
