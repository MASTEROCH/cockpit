// WANDO · TMA-вход: Telegram initData → Supabase-сессия (ноль действий юзера)
// Проверяем подпись initData ботом, находим юзера в tg_links → magiclink token.
// Секреты: TELEGRAM_BOT_TOKEN (общий с tg-bot). Verify JWT: ВЫКЛ.
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "content-type": "application/json" } });

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { initData } = await req.json();
    if (!initData || !BOT) return json({ error: "нет initData" }, 400);
    const p = new URLSearchParams(initData);
    const hash = p.get("hash") ?? ""; p.delete("hash");
    const dcs = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
    const secret = await hmac(new TextEncoder().encode("WebAppData"), BOT);
    const calc = hex(await hmac(secret, dcs));
    if (calc !== hash) return json({ error: "подпись не сошлась" }, 403);
    const authDate = +(p.get("auth_date") ?? 0);
    if (Date.now() / 1000 - authDate > 86400) return json({ error: "initData устарел" }, 403);
    const user = JSON.parse(p.get("user") ?? "{}");
    const { data: link } = await sb.from("tg_links").select("email,revoked").eq("chat_id", user.id).maybeSingle();
    if (!link || link.revoked) return json({ error: "not_linked" }, 404);
    const { data, error } = await sb.auth.admin.generateLink({ type: "magiclink", email: link.email });
    if (error) return json({ error: error.message }, 500);
    return json({ email: link.email, token_hash: data.properties?.hashed_token });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
