-- ============================================================
-- WANDO · Атомарный счётчик вызовов ИИ (Ф5, добор)
--
-- Зачем: ai-review читал ai_usage.calls и писал calls+1 двумя запросами.
-- При параллельных вызовах инкременты теряются — дневной лимит протекает,
-- и чем активнее человек, тем сильнее. Read-modify-write нельзя чинить
-- ретраями: его чинят одним запросом.
--
-- Ключ (email, day) уже PRIMARY KEY — ON CONFLICT попадает точно в строку.
-- Применено: 2026-09-08 (supabase db query --linked), проект tonmsmxzmycimybzywqp.
-- ============================================================

create or replace function public.ai_usage_bump(p_email text, p_day date)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare v_calls integer;
begin
  insert into public.ai_usage (email, day, calls)
  values (lower(p_email), p_day, 1)
  on conflict (email, day) do update set calls = ai_usage.calls + 1
  returning calls into v_calls;
  return v_calls;
end;
$fn$;

-- Считает лимиты только сервер. Дать право обычному пользователю — значит
-- позволить накручивать чужой счётчик и запирать чужой доступ к ИИ.
revoke all on function public.ai_usage_bump(text, date) from public;
revoke all on function public.ai_usage_bump(text, date) from anon;
revoke all on function public.ai_usage_bump(text, date) from authenticated;
grant execute on function public.ai_usage_bump(text, date) to service_role;
