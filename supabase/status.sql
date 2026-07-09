-- ============================================================
--  WANDO · двусторонний Claude: чтение статуса проекта из чата
--  Добавляет RPC cockpit_status(p_token) — Claude спрашивает
--  «что по проекту / что горит», WANDO отдаёт компактную сводку.
--  Только ЧТЕНИЕ. Ничего не меняет. Проверяет cpk_-токен сам,
--  поэтому вызывается публичным anon-ключом (секреты не нужны).
--
--  Применить один раз: Supabase → SQL Editor → выполнить весь файл.
--  Требует уже применённого supabase/intake.sql (таблица intake_tokens).
-- ============================================================

create or replace function cockpit_status(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_email text;
  v_today text := to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD');
  v_projects jsonb;
begin
  v_hash := encode(digest(p_token, 'sha256'), 'hex');
  select email into v_email
    from intake_tokens
    where token_hash = v_hash and coalesce(revoked, false) = false
    limit 1;
  if v_email is null then
    return jsonb_build_object('error', 'invalid or revoked token');
  end if;
  update intake_tokens set last_used_at = now() where token_hash = v_hash;

  -- сводка по каждому неархивному не-демо проекту команды
  select coalesce(jsonb_agg(row_to_json(s)::jsonb order by (s.overdue) desc, (s.total) desc), '[]'::jsonb)
    into v_projects
  from (
    select
      pr.name as project,
      pr.emoji as emoji,
      (select count(*) from jsonb_array_elements(coalesce(pr.data->'tasks','[]'::jsonb)) t
        where coalesce((t->>'isMilestone')::bool, false) = false) as total,
      (select count(*) from jsonb_array_elements(coalesce(pr.data->'tasks','[]'::jsonb)) t
        where coalesce((t->>'isMilestone')::bool, false) = false and (t->>'status') = 'done') as done,
      (select count(*) from jsonb_array_elements(coalesce(pr.data->'tasks','[]'::jsonb)) t
        where coalesce((t->>'isMilestone')::bool, false) = false
          and (t->>'status') <> 'done'
          and coalesce(t->>'end','9999-12-31') < v_today) as overdue,
      (select coalesce(jsonb_agg(x.title order by x.endd asc), '[]'::jsonb)
         from (
           select (t->>'title') as title, coalesce(t->>'end','9999-12-31') as endd
           from jsonb_array_elements(coalesce(pr.data->'tasks','[]'::jsonb)) t
           where coalesce((t->>'isMilestone')::bool, false) = false
             and (t->>'status') <> 'done'
           order by coalesce(t->>'end','9999-12-31') asc
           limit 6
         ) x) as next_up,
      (select coalesce(jsonb_agg(x.title order by x.endd asc), '[]'::jsonb)
         from (
           select (t->>'title') as title, coalesce(t->>'end','9999-12-31') as endd
           from jsonb_array_elements(coalesce(pr.data->'tasks','[]'::jsonb)) t
           where coalesce((t->>'isMilestone')::bool, false) = false
             and (t->>'status') <> 'done'
             and coalesce(t->>'end','9999-12-31') < v_today
           order by coalesce(t->>'end','9999-12-31') asc
           limit 8
         ) x) as overdue_titles
    from projects pr
    where coalesce(pr.data->>'demo','false') <> 'true'
      and coalesce((pr.data->>'archived')::bool, false) = false
  ) s;

  return jsonb_build_object('today', v_today, 'projects', v_projects);
end
$$;

grant execute on function cockpit_status(text) to anon;

-- Примечание по мультитенантности: сейчас функция возвращает проекты всей
-- команды (у проектов нет колонки workspace — доступ и так ограничен allowlist).
-- Для продажи другим фаундерам добавь projects.workspace и фильтр
-- `and pr.workspace = (select workspace from intake_tokens where token_hash = v_hash)`.
