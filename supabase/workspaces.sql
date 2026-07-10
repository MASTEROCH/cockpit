-- ============================================================
-- WANDO · Multi-tenant Ф1: воркспейсы (ЧЕРНОВИК — НЕ ПРИМЕНЯТЬ
-- без явного подтверждения Роча; см. MULTITENANT_PLAN.md)
-- Обратная совместимость: default 'main' — сайт/бот работают как раньше.
-- ============================================================

create table if not exists public.workspaces (
  id text primary key,
  name text not null,
  plan text not null default 'solo',          -- solo | founder | team | founder_forever
  stars_until timestamptz,                    -- оплачено Stars до (null = бессрочно/бесплатно)
  created_by text,                            -- email создателя
  created_at timestamptz not null default now()
);

-- команда Роча: вне биллинга навсегда
insert into public.workspaces (id, name, plan, created_by)
values ('main', 'WANDO HQ', 'founder_forever', 'romi4rv23@gmail.com')
on conflict (id) do update set plan = 'founder_forever';

-- workspace_id везде, default 'main' = безопасный backfill одним махом
alter table public.projects       add column if not exists workspace_id text not null default 'main';
alter table public.intake         add column if not exists workspace_id text not null default 'main';
alter table public.team           add column if not exists workspace_id text not null default 'main';
alter table public.tg_links       add column if not exists workspace_id text not null default 'main';
alter table public.tg_bind_codes  add column if not exists workspace_id text not null default 'main';
alter table public.workspace_meta add column if not exists workspace_id text not null default 'main';

create index if not exists idx_projects_ws on public.projects (workspace_id);
create index if not exists idx_intake_ws   on public.intake (workspace_id);
create index if not exists idx_team_ws     on public.team (workspace_id);

-- ВНИМАНИЕ: RLS-политики НЕ трогаем в этой фазе — текущие is_team()/guest_role()
-- продолжают работать (все существующие строки = 'main'). Переход политик на
-- is_member(workspace_id) — отдельная Ф2 со своим подтверждением и curl-проверкой.
