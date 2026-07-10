// WANDO · ICS-фид календаря: подписка Google/Apple Calendar на твои задачи.
// GET /functions/v1/ics?k=cpk_…  → text/calendar (мои открытые задачи с дедлайнами + вехи).
// Авторизация: существующие ключи intake_tokens (sha256-хэш). Verify JWT: ВЫКЛ.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const escIcs = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const dt = (iso: string) => (iso || "").replace(/-/g, "");

Deno.serve(async (req) => {
  if (req.method !== "GET") return new Response("GET only", { status: 405 });
  const key = new URL(req.url).searchParams.get("k") ?? "";
  if (!/^cpk_[A-Za-z0-9_-]{10,}$/.test(key)) return new Response("bad key", { status: 403 });
  const hash = await sha256hex(key);
  const { data: tok } = await sb.from("intake_tokens").select("email,revoked").eq("token_hash", hash).maybeSingle();
  if (!tok || tok.revoked) return new Response("key not found", { status: 403 });
  const email = String(tok.email).toLowerCase();

  const { data: t } = await sb.from("team").select("workspace_id").ilike("email", email).maybeSingle();
  const ws = t?.workspace_id ?? "main";
  const { data: projs } = await sb.from("projects").select("id,name,emoji,data").eq("workspace_id", ws);

  const lines: string[] = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//WANDO//RU", "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:WANDO — что делать", "X-WR-TIMEZONE:Asia/Tbilisi",
  ];
  for (const p of projs ?? []) {
    const d = p.data ?? {};
    if (d.demo === true || d.archived === true) continue;
    const me = (d.members ?? []).find((m: Record<string, any>) => (m.email ?? "").toLowerCase() === email);
    for (const task of (d.tasks ?? []) as Record<string, any>[]) {
      if (task.status === "done" || !task.end) continue;
      const mine = me && task.assigneeId === me.id;
      if (!task.isMilestone && !mine) continue;              // вехи проекта + мои задачи
      const emoji = task.isMilestone ? "🚩" : (task.cash ? "💰" : "");
      const endNext = dt(task.end);                          // all-day: DTEND эксклюзивный, но 1-дневное ок с DTSTART only
      lines.push(
        "BEGIN:VEVENT",
        `UID:${task.id}@wando.${p.id}`,
        `DTSTART;VALUE=DATE:${dt(task.start || task.end)}`,
        `DTEND;VALUE=DATE:${endNext}`,
        `SUMMARY:${escIcs((emoji ? emoji + " " : "") + task.title + " · " + (p.emoji ?? "") + " " + p.name)}`,
        `DESCRIPTION:${escIcs("WANDO · https://cock-pit.com/?t=" + p.id + ":" + task.id)}`,
        "END:VEVENT",
      );
    }
  }
  lines.push("END:VCALENDAR");
  await sb.from("intake_tokens").update({ last_used_at: new Date().toISOString() }).eq("token_hash", hash);
  return new Response(lines.join("\r\n"), {
    headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "max-age=600" },
  });
});
