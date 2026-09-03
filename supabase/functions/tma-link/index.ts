// WANDO · Авто-связка Telegram в Mini App (zero-friction дверь).
// Вошёл почтой ОДИН раз внутри Mini App → связка chat_id↔email создаётся сама.
// Дальше открытие ☰ WANDO = мгновенный вход (tma-auth по initData), без «Подключить Telegram».
// Проверяем И подпись initData (личность Telegram), И JWT вошедшего (его email). verify_jwt=true (дефолт).
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const sbs = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "content-type": "application/json" } });

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256hex(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}
async function emailFromJwt(auth: string | null): Promise<string | null> {
  try {
    const tok = (auth || "").replace(/^Bearer\s+/i, "");
    if (!tok || tok.split(".").length !== 3) return null;
    const { data, error } = await sbs.auth.getUser(tok);
    if (error || !data?.user?.email) return null;
    return data.user.email.toLowerCase();
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const email = await emailFromJwt(req.headers.get("authorization"));
    if (!email) return json({ error: "нужен вход" }, 401);
    const { initData } = await req.json();
    if (!initData || !BOT) return json({ error: "нет initData" }, 400);

    // Проверяем подпись initData ботом (личность Telegram подлинная)
    const p = new URLSearchParams(initData);
    const hash = p.get("hash") ?? ""; p.delete("hash");
    const dcs = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
    const secret = await hmac(new TextEncoder().encode("WebAppData"), BOT);
    if (hex(await hmac(secret, dcs)) !== hash) return json({ error: "подпись не сошлась" }, 403);
    if (Date.now() / 1000 - +(p.get("auth_date") ?? 0) > 86400) return json({ error: "initData устарел" }, 403);
    const user = JSON.parse(p.get("user") ?? "{}");
    if (!user.id) return json({ error: "нет user" }, 400);

    // Уже привязан? К этому email — ок; к другому — не перехватываем (анти-угон).
    const { data: ex } = await sbs.from("tg_links").select("email,revoked").eq("chat_id", user.id).maybeSingle();
    if (ex && !ex.revoked) {
      if (ex.email.toLowerCase() === email) return json({ ok: true, already: true });
      return json({ error: "этот Telegram уже привязан к другому аккаунту" }, 409);
    }

    // Токен для бот→приёмка (tg_links.token_hash NOT NULL): свой intake-токен на эту связку
    const raw = "cpk_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const token_hash = await sha256hex(raw);
    await sbs.from("intake_tokens").insert({ email, label: "Telegram (Mini App)", token_hash, workspace: "default" });

    const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || email.split("@")[0];
    const { error } = await sbs.from("tg_links").upsert({ chat_id: user.id, email, name, token_hash, workspace: "default", revoked: false });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
