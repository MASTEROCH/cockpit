-- ============================================================================
-- Cockpit · Intake layer (Claude → приёмник → подтверждение на сайте)
-- Один файл — вся серверная часть. Никаких Edge Functions: приём идёт через
-- защищённую SQL-функцию (RPC). Запусти ОДИН раз в Supabase → SQL Editor.
-- Безопасно к повторному запуску.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1) Персональные ключи подключения Claude (как GitHub PAT).
--    В базе — ТОЛЬКО sha-256-хэш ключа. Сырой ключ показывается один раз на сайте.
-- ----------------------------------------------------------------------------
create table if not exists public.intake_tokens (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  label        text,
  token_hash   text not null unique,
  workspace    text not null default 'default',   -- задел под мультитенантность
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked      boolean not null default false
);
alter table public.intake_tokens enable row level security;
drop policy if exists intake_tokens_own on public.intake_tokens;
create policy intake_tokens_own on public.intake_tokens
  for all
  using (lower(email) = lower((auth.jwt() ->> 'email')))
  with check (lower(email) = lower((auth.jwt() ->> 'email')));

-- ----------------------------------------------------------------------------
-- 2) Очередь заявок «На приёмке». Пишет ТОЛЬКО функция cockpit_intake (ниже).
--    Клиент сайта читает/решает в рамках своего workspace.
-- ----------------------------------------------------------------------------
create table if not exists public.intake (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  by_email       text not null,
  by_name        text,
  source         text,
  workspace      text not null default 'default',
  target_project text,
  text           text not null,
  note           text,
  status         text not null default 'pending',   -- pending | accepted | backlog | rejected
  decided_at     timestamptz,
  decided_by     text,
  result_task_id text
);
create index if not exists intake_ws_status_idx on public.intake (workspace, status, created_at desc);
alter table public.intake enable row level security;

-- читать/решать заявки можно только в тех workspace, где у тебя есть активный ключ
drop policy if exists intake_select on public.intake;
create policy intake_select on public.intake for select
  using (workspace in (select workspace from public.intake_tokens
    where lower(email) = lower((auth.jwt() ->> 'email')) and not revoked));
drop policy if exists intake_update on public.intake;
create policy intake_update on public.intake for update
  using (workspace in (select workspace from public.intake_tokens
    where lower(email) = lower((auth.jwt() ->> 'email')) and not revoked));
drop policy if exists intake_delete on public.intake;
create policy intake_delete on public.intake for delete
  using (workspace in (select workspace from public.intake_tokens
    where lower(email) = lower((auth.jwt() ->> 'email')) and not revoked));
-- insert через клиента запрещён (нет policy) — заявки создаёт только cockpit_intake()

-- ----------------------------------------------------------------------------
-- 3) Приём заявки от Claude. SECURITY DEFINER: проверяет ключ сам, поэтому
--    вызывается с публичным anon-ключом + персональным cpk_-токеном в параметре.
-- ----------------------------------------------------------------------------
create or replace function public.cockpit_intake(
  p_token text,
  p_text  text,
  p_project text default null,
  p_note  text default null,
  p_source text default 'claude',
  p_by_name text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_tok public.intake_tokens%rowtype; v_id uuid;
begin
  if p_token is null or left(p_token,4) <> 'cpk_' then
    return jsonb_build_object('error','Неверный формат ключа'); end if;
  v_hash := encode(digest(p_token,'sha256'),'hex');
  select * into v_tok from public.intake_tokens where token_hash = v_hash;
  if v_tok.id is null or v_tok.revoked then
    return jsonb_build_object('error','Неверный или отозванный ключ Cockpit'); end if;
  if p_text is null or length(btrim(p_text)) = 0 then
    return jsonb_build_object('error','Пустой текст задачи'); end if;

  insert into public.intake(by_email,by_name,source,workspace,target_project,text,note,status)
  values (
    v_tok.email,
    coalesce(nullif(btrim(coalesce(p_by_name,'')),''), v_tok.label, split_part(v_tok.email,'@',1)),
    left(coalesce(p_source,'claude'),40),
    v_tok.workspace,
    nullif(left(coalesce(p_project,''),120),''),
    left(p_text,2000),
    nullif(left(coalesce(p_note,''),1000),''),
    'pending'
  ) returning id into v_id;

  update public.intake_tokens set last_used_at = now() where id = v_tok.id;
  return jsonb_build_object('ok',true,'id',v_id,'message','Заявка ушла в очередь «На приёмке» Cockpit.');
end $$;

revoke all on function public.cockpit_intake(text,text,text,text,text,text) from public;
grant execute on function public.cockpit_intake(text,text,text,text,text,text) to anon, authenticated;

-- помощник Claude: список проектов (чтобы выбрать project)
create or replace function public.cockpit_projects(p_token text)
returns table(id text, name text, emoji text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_ok boolean;
begin
  v_hash := encode(digest(p_token,'sha256'),'hex');
  select true into v_ok from public.intake_tokens where token_hash = v_hash and not revoked limit 1;
  if not coalesce(v_ok,false) then return; end if;
  return query select p.id::text, p.name::text, coalesce(p.emoji,'📄')::text from public.projects p;
end $$;
revoke all on function public.cockpit_projects(text) from public;
grant execute on function public.cockpit_projects(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4) Realtime — заявки появляются на сайте мгновенно.
-- ----------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.intake;
exception when duplicate_object then null; end $$;

-- Готово. Никаких функций деплоить не нужно — дальше подключаешь Claude через сайт.
