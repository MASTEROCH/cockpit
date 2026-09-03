// WANDO · Отзыв доступа + уведомление (владелец/админ управляет ДОСТУПОМ, не паролями).
// Убирает человека из команды строго НИЖЕ себя по рангу, отзывает Telegram-связку и
// гостевые доступы, и шлёт ему пуш «доступ обновлён владельцем». verify_jwt=true (дефолт).
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const sbs = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "content-type": "application/json" } });

async function emailFromJwt(auth: string | null): Promise<string | null> {
  try {
    const tok = (auth || "").replace(/^Bearer\s+/i, "");
    if (!tok || tok.split(".").length !== 3) return null;
    const { data, error } = await sbs.auth.getUser(tok);
    if (error || !data?.user?.email) return null;
    return data.user.email.toLowerCase();
  } catch { return null; }
}
const RANK: Record<string, number> = { owner: 3, full: 2, admin: 2, member: 1 };
async function rankOf(email: string): Promise<{ rank: number; ws: string | null; name: string | null }> {
  const { data } = await sbs.from("team").select("role,workspace_id,name").ilike("email", email).maybeSingle();
  if (!data) return { rank: 0, ws: null, name: null };
  return { rank: RANK[String(data.role || "full")] ?? 0, ws: data.workspace_id ?? "main", name: data.name ?? null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const caller = await emailFromJwt(req.headers.get("authorization"));
    if (!caller) return json({ error: "нужен вход" }, 401);
    const { email } = await req.json();
    const target = String(email || "").trim().toLowerCase();
    if (!target) return json({ ok: false, error: "нет email" });
    if (target === caller) return json({ ok: false, error: "себя убрать нельзя" });

    const me = await rankOf(caller);
    const them = await rankOf(target);
    if (them.rank === 0) return json({ ok: false, error: "такого нет в команде" });
    // Строго ниже себя: равного/вышестоящего убрать нельзя (иерархия Роча).
    if (me.rank <= them.rank) return json({ error: "убрать можно только строго ниже себя по доступу" }, 403);
    // В рамках своего воркспейса (нельзя трогать чужую компанию).
    if (me.ws && them.ws && me.ws !== them.ws) return json({ error: "чужой воркспейс" }, 403);

    // Взять связку ДО удаления — чтобы отправить уведомление.
    const { data: link } = await sbs.from("tg_links").select("chat_id").ilike("email", target).eq("revoked", false).maybeSingle();

    await sbs.from("team").delete().ilike("email", target);
    await sbs.from("tg_links").update({ revoked: true }).ilike("email", target);
    await sbs.from("project_access").delete().ilike("email", target);

    let notified = false;
    if (link?.chat_id && BOT) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: link.chat_id, parse_mode: "HTML",
            text: `🔒 Твой доступ к <b>WANDO</b> обновлён владельцем${me.name ? " (" + me.name + ")" : ""}.\nЧтобы узнать детали — напиши ему напрямую.` }),
        });
        notified = r.ok;
      } catch { /* уведомление не критично */ }
    }
    return json({ ok: true, notified });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
