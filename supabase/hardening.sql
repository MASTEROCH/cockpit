-- ============================================================================
-- WANDO · Готовность к работе команды (ROCH #1423) — поверх access.sql и project_roles.sql
--  1. projects.rev — номер версии, растёт на каждом обновлении (любой писатель: приложение, бот, функции).
--     Клиент пишет «если версия не изменилась» и при конфликте сливает — больше нет «кто последний, тот и прав».
--  2. Таблицы без RLS (configs, sessions, signals, users — пустые, от другого проекта) — закрыты от anon/authenticated.
--  3. cockpit_status / cockpit_projects (MCP-ключ) — только своё пространство и только видимые проекты.
--     cockpit_intake — заявка ложится в пространство автора ключа, а не в 'main'.
--  4. Охрана ролей: неадмин не меняет чужую почту в карточке участника (кроме «занять пустую карточку своей»),
--     не удаляет других участников, не плодит дубли id.
--  5. project_access (гости) — пишут только админ проекта и владелец/админ пространства.
--  6. team.role — только owner/admin/full/member, в нижнем регистре.
--  7. tg_chats — менять/отключать чат может админ или тот, кто его подключил; добавляет только сервер.
--  8. Служебные функции доступа — без execute у anon.
--  9. tg_updates — защита бота от повторной доставки одного обновления.
-- 10. Бакет avatars — фото файлом, а не data:URL в каждом проекте.
-- Безопасно к повторному запуску. Секретов не содержит.
-- ============================================================================

-- 1) версия проекта ------------------------------------------------------------
alter table public.projects add column if not exists rev bigint not null default 0;
create or replace function public.projects_bump_rev() returns trigger
language plpgsql as $$
begin
  new.rev := coalesce(old.rev, 0) + 1;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists projects_bump_rev on public.projects;
create trigger projects_bump_rev before update on public.projects
  for each row execute function public.projects_bump_rev();

-- 2) чужие таблицы без RLS -------------------------------------------------------
do $t$ declare t text; begin
  foreach t in array array['configs','sessions','signals','users'] loop
    if to_regclass('public.'||t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $t$;

-- 3) MCP-ключ видит только своё --------------------------------------------------
-- видит ли email проект: своё пространство (+ открыт / участник / владелец-админ) или гостевой доступ
create or replace function public.can_see_project(p_email text, p_project text)
returns boolean language sql stable security definer set search_path = public as
$$ select coalesce(p_email,'') <> '' and (
     exists (select 1 from projects p where p.id = p_project and public.is_member(p_email, p.workspace_id) and (
                public.team_sees_all(p_email) or public.project_is_open(p.id) or public.in_project_members(p_email, p.id)))
     or public.guest_role(p_email, p_project) is not null) $$;

create or replace function public.cockpit_status(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text; v_email text;
  v_today text := to_char((now() at time zone 'Asia/Tbilisi')::date,'YYYY-MM-DD');
  v_projects jsonb;
begin
  v_hash := encode(digest(p_token,'sha256'),'hex');
  select email into v_email from public.intake_tokens
    where token_hash = v_hash and coalesce(revoked,false) = false limit 1;
  if v_email is null then
    return jsonb_build_object('error','invalid or revoked token'); end if;
  update public.intake_tokens set last_used_at = now() where token_hash = v_hash;

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
      and public.can_see_project(v_email, pr.id)
  ) s;

  return jsonb_build_object('today',v_today,'projects',v_projects);
end $$;
revoke all on function public.cockpit_status(text) from public;
grant execute on function public.cockpit_status(text) to anon, authenticated;

create or replace function public.cockpit_projects(p_token text)
returns table(id text, name text, emoji text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_email text;
begin
  v_hash := encode(digest(p_token,'sha256'),'hex');
  select email into v_email from public.intake_tokens
    where token_hash = v_hash and not coalesce(revoked,false) limit 1;
  if v_email is null then return; end if;
  return query select p.id::text, p.name::text, coalesce(p.emoji,'📄')::text
    from public.projects p
    where coalesce((p.data->>'archived')::bool,false) = false and public.can_see_project(v_email, p.id);
end $$;
revoke all on function public.cockpit_projects(text) from public;
grant execute on function public.cockpit_projects(text) to anon, authenticated;

create or replace function public.cockpit_intake(p_token text, p_text text, p_project text default null,
  p_note text default null, p_source text default 'claude', p_by_name text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_tok public.intake_tokens%rowtype; v_id uuid; v_ws text;
begin
  if p_token is null or left(p_token,4) <> 'cpk_' then
    return jsonb_build_object('error','Неверный формат ключа'); end if;
  v_hash := encode(digest(p_token,'sha256'),'hex');
  select * into v_tok from public.intake_tokens where token_hash = v_hash;
  if v_tok.id is null or coalesce(v_tok.revoked,false) then
    return jsonb_build_object('error','Неверный или отозванный ключ WANDO'); end if;
  if p_text is null or length(btrim(p_text)) = 0 then
    return jsonb_build_object('error','Пустой текст задачи'); end if;
  -- пространство автора ключа; гость — пространство его проекта; иначе ключ ни к чему не привязан
  v_ws := coalesce(public.my_ws(v_tok.email),
    (select public.ws_of_project(pa.project_id) from public.project_access pa where lower(pa.email) = lower(v_tok.email) limit 1));
  if v_ws is null then
    return jsonb_build_object('error','Ключ не привязан к команде — попроси приглашение'); end if;
  insert into public.intake(by_email,by_name,source,workspace,workspace_id,target_project,text,note,status)
  values (v_tok.email,
          coalesce(nullif(btrim(coalesce(p_by_name,'')),''), v_tok.label, split_part(v_tok.email,'@',1)),
          left(coalesce(p_source,'claude'),40), v_tok.workspace, v_ws,
          nullif(left(coalesce(p_project,''),120),''), left(p_text,2000),
          nullif(left(coalesce(p_note,''),1000),''), 'pending')
  returning id into v_id;
  update public.intake_tokens set last_used_at = now() where id = v_tok.id;
  return jsonb_build_object('ok',true,'id',v_id,'message','Заявка ушла в очередь «На приёмке» WANDO.');
end $$;
revoke all on function public.cockpit_intake(text,text,text,text,text,text) from public;
grant execute on function public.cockpit_intake(text,text,text,text,text,text) to anon, authenticated;

-- 4) охрана ролей: + почта, удаление, дубли -------------------------------------------
create or replace function public.projects_guard_roles() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  em text := lower(coalesce(auth.jwt() ->> 'email',''));
  n jsonb; o jsonb;
  oe text; ne text;
begin
  if coalesce(auth.role(),'') = 'service_role' or em = '' then return new; end if;   -- сервер — свои проверки
  if public.team_sees_all(em) then return new; end if;                              -- владелец / админ пространства
  if exists (select 1 from jsonb_array_elements(coalesce(old.data->'members','[]'::jsonb)) m
              where lower(coalesce(m->>'email','')) = em and m->>'access' = 'admin') then return new; end if; -- админ проекта
  if (select count(*) from jsonb_array_elements(coalesce(new.data->'members','[]'::jsonb)))
     <> (select count(distinct m->>'id') from jsonb_array_elements(coalesce(new.data->'members','[]'::jsonb)) m) then
    raise exception 'Два участника с одним id — обнови страницу';
  end if;
  for n in select * from jsonb_array_elements(coalesce(new.data->'members','[]'::jsonb)) loop
    o := null;
    select m into o from jsonb_array_elements(coalesce(old.data->'members','[]'::jsonb)) m where m->>'id' = n->>'id' limit 1;
    if o is null then
      if coalesce(nullif(n->>'access',''),'edit') = 'admin' then raise exception 'Назначать админа проекта может только админ'; end if;
    else
      if coalesce(nullif(o->>'access',''),'edit') <> coalesce(nullif(n->>'access',''),'edit') then
        raise exception 'Менять роли в проекте может только его админ';
      end if;
      oe := lower(coalesce(o->>'email','')); ne := lower(coalesce(n->>'email',''));
      -- занять пустую карточку можно только своей почтой; чужую почту не трогаем
      if oe <> ne and not (oe = '' and ne = em) then
        raise exception 'Менять почту участника может только админ проекта';
      end if;
    end if;
  end loop;
  -- удалить можно только себя (выйти из проекта)
  for o in select * from jsonb_array_elements(coalesce(old.data->'members','[]'::jsonb)) loop
    if not exists (select 1 from jsonb_array_elements(coalesce(new.data->'members','[]'::jsonb)) m where m->>'id' = o->>'id')
       and lower(coalesce(o->>'email','')) <> em then
      raise exception 'Убирать участников из проекта может только его админ';
    end if;
  end loop;
  return new;
end $$;

-- 5) гости проекта — только админ проекта / владелец / админ пространства ------------------
drop policy if exists pa_admin_all on public.project_access;
create policy pa_admin_all on public.project_access for all to authenticated
  using (
    public.is_member(auth.jwt() ->> 'email', public.ws_of_project(project_access.project_id)) and (
         public.team_sees_all(auth.jwt() ->> 'email')
      or public.project_access_of(auth.jwt() ->> 'email', project_access.project_id) = 'admin'))
  with check (
    public.is_member(auth.jwt() ->> 'email', public.ws_of_project(project_access.project_id)) and (
         public.team_sees_all(auth.jwt() ->> 'email')
      or public.project_access_of(auth.jwt() ->> 'email', project_access.project_id) = 'admin'));

-- 6) роли пространства — фиксированный словарь ------------------------------------------
update public.team set role = lower(btrim(role)) where role is distinct from lower(btrim(role));
update public.team set role = 'member' where coalesce(role,'') not in ('owner','admin','full','member');
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'team_role_chk') then
    alter table public.team add constraint team_role_chk check (role in ('owner','admin','full','member'));
  end if;
end $c$;

-- 7) рабочие чаты ---------------------------------------------------------------------
drop policy if exists tg_chats_team on public.tg_chats;
drop policy if exists tg_chats_select on public.tg_chats;
drop policy if exists tg_chats_update on public.tg_chats;
drop policy if exists tg_chats_delete on public.tg_chats;
create policy tg_chats_select on public.tg_chats for select to authenticated
  using (public.is_member(auth.jwt() ->> 'email', tg_chats.workspace_id));
create policy tg_chats_update on public.tg_chats for update to authenticated
  using (public.is_member(auth.jwt() ->> 'email', tg_chats.workspace_id) and (
         public.team_sees_all(auth.jwt() ->> 'email') or lower(coalesce(tg_chats.added_by,'')) = lower(auth.jwt() ->> 'email')))
  with check (public.is_member(auth.jwt() ->> 'email', tg_chats.workspace_id) and (
         public.team_sees_all(auth.jwt() ->> 'email') or lower(coalesce(tg_chats.added_by,'')) = lower(auth.jwt() ->> 'email')));
create policy tg_chats_delete on public.tg_chats for delete to authenticated
  using (public.is_member(auth.jwt() ->> 'email', tg_chats.workspace_id) and (
         public.team_sees_all(auth.jwt() ->> 'email') or lower(coalesce(tg_chats.added_by,'')) = lower(auth.jwt() ->> 'email')));

-- 9) бот: одно обновление Telegram — одно исполнение (повторная доставка не дублирует действия) -------
create table if not exists public.tg_updates (update_id bigint primary key, ts timestamptz not null default now());
create index if not exists tg_updates_ts on public.tg_updates (ts);
alter table public.tg_updates enable row level security; -- политик нет: только service role (функция tg-bot)

-- 10) фото людей и клиентов — файлом в хранилище, в данных проекта короткая ссылка ----------------------
--     (раньше data:URL ~15 КБ копировался в каждый проект и упирался в 5 МБ памяти устройства). Чтение — по ссылке
--     (имя файла случайное), списка нет; загрузка — только в папку своего пространства; перезаписи и удаления нет.
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true) on conflict (id) do nothing;
drop policy if exists av_ins on storage.objects;
create policy av_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = public.my_ws(auth.jwt() ->> 'email'));

-- 8) служебные функции — не для anon -------------------------------------------------------
do $f$ declare f text; begin
  foreach f in array array['is_member(text,text)','my_ws(text)','role_rank(text)','rank_of(text)','is_team(text)',
    'guest_role(text,text)','team_sees_all(text)','in_project_members(text,text)','project_access_of(text,text)',
    'project_is_open(text)','ws_of_project(text)','can_money(text,text)','can_see_project(text,text)'] loop
    if to_regprocedure('public.'||f) is not null then
      execute format('revoke execute on function public.%s from public, anon', f);
      execute format('grant execute on function public.%s to authenticated, service_role', f);
    end if;
  end loop;
end $f$;

-- Проверка:
--   select column_name from information_schema.columns where table_name='projects' and column_name='rev';
--   select tgname from pg_trigger where tgrelid='public.projects'::regclass and not tgisinternal;
--   select relname, relrowsecurity from pg_class where relname in ('configs','sessions','signals','users');
--   select policyname, cmd from pg_policies where tablename in ('project_access','tg_chats');
