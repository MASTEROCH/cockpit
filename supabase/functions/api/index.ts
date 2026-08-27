// ============================================================================
// WANDO · Публичное API v1 — ключ уровня воркспейса (выдаёт бот: «api ключ»).
//   Авторизация:  Authorization: Bearer wk_…
//   GET  ?op=projects                     → список проектов со счётчиками
//   GET  ?op=tasks&project=<id>[&status=] → задачи проекта (короткие #ID)
//   POST {"op":"create","project":"<id>","title":"…"[,"description","end","priority","assignee"]}
//   POST {"op":"status","task":"<#ID или id>","status":"backlog|todo|progress|review|done"}
// Ключ хранится только хешем (sha256) в api_keys. «Verify JWT» — ВЫКЛ.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "content-type": "application/json" } });
const STATUSES = ["backlog", "todo", "progress", "review", "done"];

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function wsByKey(auth: string | null): Promise<string | null> {
  const key = (auth ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!key.startsWith("wk_")) return null;
  const { data } = await sb.from("api_keys").select("workspace_id").eq("key_hash", await sha256(key)).maybeSingle();
  return data?.workspace_id ?? null;
}
const shortId = (id: string) => String(id).slice(1, 6).toUpperCase();
const uid = (p: string) => p + Math.random().toString(36).slice(2, 8);
const today = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10); // Батуми

function taskOut(t: Record<string, any>, members: Record<string, any>[]) {
  return { id: shortId(t.id), title: t.title, status: t.status, priority: t.priority ?? "med",
    assignee: members.find((m) => m.id === t.assigneeId)?.name ?? null,
    start: t.start ?? null, end: t.end ?? null, estimate: t.estimate ?? 0, done: t.status === "done" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ws = await wsByKey(req.headers.get("authorization"));
  if (!ws) return json({ error: "invalid or missing api key" }, 401);
  const rowsQ = () => sb.from("projects").select("id,data").eq("workspace_id", ws);

  if (req.method === "GET") {
    const u = new URL(req.url);
    const op = u.searchParams.get("op") ?? "projects";
    const { data: rows } = await rowsQ();
    if (op === "projects") {
      return json({ projects: (rows ?? []).map((r) => ({ id: r.id, name: r.data?.projectName ?? "", emoji: r.data?.emoji ?? "📄",
        tasks: (r.data?.tasks ?? []).filter((t: Record<string, any>) => !t.isMilestone).length,
        done: (r.data?.tasks ?? []).filter((t: Record<string, any>) => !t.isMilestone && t.status === "done").length })) });
    }
    if (op === "tasks") {
      const row = (rows ?? []).find((r) => r.id === u.searchParams.get("project"));
      if (!row) return json({ error: "project not found" }, 404);
      const st = u.searchParams.get("status");
      let ts = (row.data?.tasks ?? []).filter((t: Record<string, any>) => !t.isMilestone);
      if (st) ts = ts.filter((t: Record<string, any>) => t.status === st);
      return json({ tasks: ts.map((t: Record<string, any>) => taskOut(t, row.data?.members ?? [])) });
    }
    return json({ error: "unknown op" }, 400);
  }

  if (req.method === "POST") {
    let b: Record<string, any>;
    try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const { data: rows } = await rowsQ();

    if (b.op === "create") {
      const row = (rows ?? []).find((r) => r.id === b.project);
      if (!row) return json({ error: "project not found" }, 404);
      if (!b.title) return json({ error: "title required" }, 400);
      const d = row.data; const members = (d.members ?? []) as Record<string, any>[];
      const t: Record<string, any> = { id: uid("t"), title: String(b.title).slice(0, 140),
        sectionId: d.sections?.[0]?.id ?? null, assigneeId: null, start: today(), end: today(),
        status: "todo", estimate: +b.estimate || 0, spent: 0,
        priority: ["low", "med", "high", "urgent"].includes(b.priority) ? b.priority : "med",
        description: String(b.description ?? "").slice(0, 2000), comments: [], isMilestone: false, deps: [], parentId: null, createdTs: Date.now() };
      if (b.end && /^\d{4}-\d\d-\d\d$/.test(b.end)) t.end = b.end;
      if (b.assignee) { const m = members.find((x) => String(x.name).toLowerCase() === String(b.assignee).toLowerCase()); if (m) t.assigneeId = m.id; }
      d.tasks = d.tasks ?? []; d.tasks.push(t);
      d.activity = d.activity ?? []; d.activity.unshift({ ts: Date.now(), who: "API", icon: "🔌", text: `новая задача «${t.title}»` });
      if (d.activity.length > 150) d.activity.length = 150;
      d.updatedAt = Date.now();
      await sb.from("projects").update({ data: d, updated_at: new Date().toISOString(), updated_by: null }).eq("id", row.id);
      return json({ ok: true, id: shortId(t.id), project: row.id }, 201);
    }

    if (b.op === "status") {
      if (!STATUSES.includes(b.status)) return json({ error: "status must be one of " + STATUSES.join("|") }, 400);
      const want = String(b.task ?? "").replace(/^#/, "").toUpperCase();
      for (const row of rows ?? []) {
        const t = (row.data?.tasks ?? []).find((x: Record<string, any>) => shortId(x.id) === want || x.id === b.task);
        if (!t) continue;
        t.status = b.status; t.statusTs = Date.now();
        if (b.status === "done") { t.doneTs = Date.now(); if (t.estimate && !t.spent) t.spent = t.estimate; }
        t.hist = t.hist ?? []; t.hist.push({ ts: Date.now(), who: "API", text: "статус → " + b.status });
        if (t.hist.length > 30) t.hist = t.hist.slice(-30);
        row.data.activity = row.data.activity ?? [];
        row.data.activity.unshift({ ts: Date.now(), who: "API", icon: "🔌", text: `«${t.title}» → ${b.status}` });
        if (row.data.activity.length > 150) row.data.activity.length = 150;
        row.data.updatedAt = Date.now();
        await sb.from("projects").update({ data: row.data, updated_at: new Date().toISOString(), updated_by: null }).eq("id", row.id);
        return json({ ok: true, id: want, status: b.status });
      }
      return json({ error: "task not found" }, 404);
    }
    return json({ error: "unknown op" }, 400);
  }
  return json({ error: "method" }, 405);
});
