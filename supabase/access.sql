-- ============================================================================
-- WANDO · Закрыть дыры доступа (ROCH #1402) — поверх tenant_isolation.sql
--  1. workspace_meta: служебные ключи входа и приглашений — только сервер (service role).
--     Раньше любой участник мог переписать `weblogin:<код>` (state=yes + чужой email → чужая сессия),
--     завести `invite:` от имени владельца, прочитать `selfserve:`.
--  2. Клиенты и деньги (`crm:*`) — владелец/админ + те, кому поставили «Клиенты и деньги» (team.money).
--     Всем нынешним участникам галочка ставится здесь же — ни у кого ничего не пропадает.
--  3. `profile:<email>` пишет только сам владелец профиля.
--  4. Удалить проект — только владелец/админ (было: любой участник, политика for all включала DELETE).
-- Безопасно к повторному запуску. Секретов не содержит.
-- ============================================================================

alter table public.team add column if not exists money boolean not null default false;
-- нынешние участники видели клиентов — сохраняем, снять можно в «Команде» (один раз: только у тех, кто был до колонки)
do $m$ begin
  if not exists (select 1 from public.workspace_meta where k = 'migr:access_money_seeded') then
    update public.team set money = true;
    insert into public.workspace_meta (k, workspace_id, v) values ('migr:access_money_seeded', 'main', jsonb_build_object('ts', now()));
  end if;
end $m$;

-- право на клиентов и деньги в этом пространстве
create or replace function public.can_money(p_email text, p_ws text)
returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from team t where lower(t.email) = lower(coalesce(p_email,'')) and t.workspace_id = p_ws
     and (t.role in ('owner','admin','full') or t.money)) $$; -- пустая роль = обычный участник, как в role_rank
grant execute on function public.can_money(text, text) to authenticated;

-- служебные ключи — не для клиента
create or replace function public.meta_private(p_k text)
returns boolean language sql immutable as
$$ select p_k like 'invite:%' or p_k like 'weblogin:%' or p_k like 'selfserve:%' or p_k like 'migr:%' $$;

-- ============================ WORKSPACE_META ===============================
do $wm$ begin
  if to_regclass('public.workspace_meta') is not null then
    execute 'drop policy if exists wm_team_all on public.workspace_meta';
    execute 'drop policy if exists wm_select on public.workspace_meta';
    execute 'drop policy if exists wm_insert on public.workspace_meta';
    execute 'drop policy if exists wm_update on public.workspace_meta';
    execute 'drop policy if exists wm_delete on public.workspace_meta';
    execute $p$create policy wm_select on public.workspace_meta for select to authenticated using (
      public.is_member(auth.jwt() ->> 'email', workspace_meta.workspace_id)
      and not public.meta_private(workspace_meta.k)
      and (workspace_meta.k not like 'crm:%' or public.can_money(auth.jwt() ->> 'email', workspace_meta.workspace_id)))$p$;
    execute $p$create policy wm_insert on public.workspace_meta for insert to authenticated with check (
      public.is_member(auth.jwt() ->> 'email', workspace_meta.workspace_id)
      and not public.meta_private(workspace_meta.k)
      and (workspace_meta.k not like 'crm:%' or public.can_money(auth.jwt() ->> 'email', workspace_meta.workspace_id))
      and (workspace_meta.k not like 'profile:%' or lower(workspace_meta.k) = 'profile:' || lower(auth.jwt() ->> 'email')))$p$;
    execute $p$create policy wm_update on public.workspace_meta for update to authenticated using (
      public.is_member(auth.jwt() ->> 'email', workspace_meta.workspace_id)
      and not public.meta_private(workspace_meta.k)
      and (workspace_meta.k not like 'crm:%' or public.can_money(auth.jwt() ->> 'email', workspace_meta.workspace_id))
      and (workspace_meta.k not like 'profile:%' or lower(workspace_meta.k) = 'profile:' || lower(auth.jwt() ->> 'email')))
      with check (
      public.is_member(auth.jwt() ->> 'email', workspace_meta.workspace_id)
      and not public.meta_private(workspace_meta.k)
      and (workspace_meta.k not like 'crm:%' or public.can_money(auth.jwt() ->> 'email', workspace_meta.workspace_id))
      and (workspace_meta.k not like 'profile:%' or lower(workspace_meta.k) = 'profile:' || lower(auth.jwt() ->> 'email')))$p$;
    execute $p$create policy wm_delete on public.workspace_meta for delete to authenticated using (
      public.is_member(auth.jwt() ->> 'email', workspace_meta.workspace_id)
      and not public.meta_private(workspace_meta.k)
      and (workspace_meta.k not like 'crm:%' or public.can_money(auth.jwt() ->> 'email', workspace_meta.workspace_id))
      and (workspace_meta.k not like 'profile:%' or lower(workspace_meta.k) = 'profile:' || lower(auth.jwt() ->> 'email')))$p$;
  end if;
end $wm$;

-- ============================ PROJECTS: DELETE =============================
-- одна политика for all → раздельно: видеть/создавать/менять — как было; удалять — только владелец/админ
drop policy if exists projects_team_visible on public.projects;
drop policy if exists projects_team_select on public.projects;
drop policy if exists projects_team_insert on public.projects;
drop policy if exists projects_team_update on public.projects;
drop policy if exists projects_team_delete on public.projects;

create policy projects_team_select on public.projects for select to authenticated using (
  public.is_member(auth.jwt() ->> 'email', projects.workspace_id) and (
       public.team_sees_all(auth.jwt() ->> 'email')
    or public.project_is_open(projects.id)
    or public.guest_role(auth.jwt() ->> 'email', projects.id) is not null
    or public.in_project_members(auth.jwt() ->> 'email', projects.id)));
create policy projects_team_insert on public.projects for insert to authenticated with check (
  public.is_member(auth.jwt() ->> 'email', projects.workspace_id) and (
       public.team_sees_all(auth.jwt() ->> 'email')
    or public.project_is_open(projects.id)
    or public.guest_role(auth.jwt() ->> 'email', projects.id) = 'member'
    or public.in_project_members(auth.jwt() ->> 'email', projects.id)));
create policy projects_team_update on public.projects for update to authenticated
  using (
    public.is_member(auth.jwt() ->> 'email', projects.workspace_id) and (
         public.team_sees_all(auth.jwt() ->> 'email')
      or public.project_is_open(projects.id)
      or public.guest_role(auth.jwt() ->> 'email', projects.id) = 'member'
      or public.in_project_members(auth.jwt() ->> 'email', projects.id)))
  with check (
    public.is_member(auth.jwt() ->> 'email', projects.workspace_id) and (
         public.team_sees_all(auth.jwt() ->> 'email')
      or public.project_is_open(projects.id)
      or public.guest_role(auth.jwt() ->> 'email', projects.id) = 'member'
      or public.in_project_members(auth.jwt() ->> 'email', projects.id)));
create policy projects_team_delete on public.projects for delete to authenticated using (
  public.is_member(auth.jwt() ->> 'email', projects.workspace_id) and public.team_sees_all(auth.jwt() ->> 'email'));

-- Проверка:
--   select policyname, cmd from pg_policies where tablename in ('projects','workspace_meta') order by 1;
--   select email, role, money from team;
