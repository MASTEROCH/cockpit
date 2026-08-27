// ============================================================================
// WANDO · Гость-в-задачу: ссылка на ОДНУ задачу для человека вне команды.
//   POST {"op":"create","project":"…","task":"…"}   (JWT участника команды)
//        → { token } — ссылка вида https://cock-pit.com/?guest=<token>
//   GET  ?t=<token>                                 (без авторизации)
//        → снимок задачи: название, статус, описание, чеклист, комменты
//   POST {"op":"comment","t":"<token>","name":"…","text":"…"} (без авторизации)
//        → коммент от гостя падает в задачу (автор помечен «гость»)
// Гость видит ровно одну задачу — ни проекта, ни команды. «Verify JWT» — ВЫКЛ.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "content-type": "application/json" } });
const ST: Record<string, string> = { backlog: "Бэклог", todo: "К работе", progress: "В работе", review: "Проверка", done: "Готово" };

function emailFromJwt(auth: string | null): string | null {
  try {
    const b = (auth ?? "").replace(/^Bearer\s+/i, "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return (JSON.parse(decodeURIComponent(escape(atob(b)))).email || "").toLowerCase();
  } catch { return null; }
}

async function shareRow(token: string) {
  const { data: sh } = await sb.from("task_shares").select("*").eq("token", token).eq("revoked", false).maybeSingle();
  if (!sh) return null;
  const { data: p } = await sb.from("projects").select("id,data").eq("id", sh.project_id).maybeSingle();
  const t = (p?.data?.tasks ?? []).find((x: Record<string, any>) => x.id === sh.task_id);
  return t ? { sh, p: p!, t } : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  if (req.method === "GET") {
    const token = new URL(req.url).searchParams.get("t") ?? "";
    const hit = await shareRow(token);
    if (!hit) return json({ error: "ссылка не действует" }, 404);
    const { p, t } = hit;
    const members = (p.data?.members ?? []) as Record<string, any>[];
    return json({ task: {
      title: t.title, status: t.status, statusName: ST[t.status] ?? t.status,
      description: t.description ?? "", end: t.end ?? null,
      project: p.data?.projectName ?? "", emoji: p.data?.emoji ?? "📄",
      assignee: members.find((m) => m.id === t.assigneeId)?.name ?? null,
      subtasks: (t.subtasks ?? []).map((s: Record<string, any>) => ({ text: s.text, done: !!s.done })),
      comments: (t.comments ?? []).slice(-20).map((c: Record<string, any>) => ({ ts: c.ts, author: c.author, text: c.text })),
    } });
  }

  if (req.method === "POST") {
    let b: Record<string, any>;
    try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

    if (b.op === "create") {
      const email = emailFromJwt(req.headers.get("authorization"));
      if (!email) return json({ error: "нужна авторизация" }, 401);
      const { data: member } = await sb.from("team").select("email").ilike("email", email).maybeSingle();
      if (!member) return json({ error: "только для команды" }, 403);
      const { data: p } = await sb.from("projects").select("id,data").eq("id", b.project).maybeSingle();
      if (!p || !(p.data?.tasks ?? []).some((x: Record<string, any>) => x.id === b.task)) return json({ error: "задача не найдена" }, 404);
      // одна живая ссылка на задачу: повторный запрос возвращает её же
      const { data: old } = await sb.from("task_shares").select("token").eq("task_id", b.task).eq("revoked", false).maybeSingle();
      if (old) return json({ token: old.token });
      const token = crypto.randomUUID().replace(/-/g, "");
      await sb.from("task_shares").insert({ token, project_id: b.project, task_id: b.task, created_by: email });
      return json({ token }, 201);
    }

    if (b.op === "comment") {
      const hit = await shareRow(String(b.t ?? ""));
      if (!hit) return json({ error: "ссылка не действует" }, 404);
      const text = String(b.text ?? "").trim().slice(0, 1000);
      if (!text) return json({ error: "пустой текст" }, 400);
      const name = String(b.name ?? "").trim().slice(0, 40) || "Гость";
      const { p, t } = hit;
      t.comments = t.comments ?? [];
      t.comments.push({ ts: Date.now(), author: name + " · гость", text });
      p.data.activity = p.data.activity ?? [];
      p.data.activity.unshift({ ts: Date.now(), who: name + " · гость", icon: "🌐", text: `коммент в «${t.title}»` });
      if (p.data.activity.length > 150) p.data.activity.length = 150;
      p.data.updatedAt = Date.now();
      await sb.from("projects").update({ data: p.data, updated_at: new Date().toISOString(), updated_by: null }).eq("id", p.id);
      return json({ ok: true }, 201);
    }
    return json({ error: "unknown op" }, 400);
  }
  return json({ error: "method" }, 405);
});
