// WANDO · TMA-вход: Telegram initData → Supabase-сессия (ноль действий юзера)
// Проверяем подпись initData ботом, находим юзера в tg_links → magiclink token.
// Секреты: TELEGRAM_BOT_TOKEN (общий с tg-bot). Verify JWT: ВЫКЛ.
import { createClient } from "npm:@supabase/supabase-js@2";
import { redeemInvite } from "../_shared/invite.ts";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...cors, "content-type": "application/json" } });

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
async function sessionFor(email: string): Promise<string | undefined> {
  const { data, error } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  return data.properties?.hashed_token;
}

// Подпись initData Telegram → пользователь Telegram или null (тот же расчёт, что при входе в Mini App)
async function verifyInitData(initData: string): Promise<Record<string, any> | null> {
  if (!initData || !BOT) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash") ?? ""; p.delete("hash");
  const dcs = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), BOT);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  if (Date.now() / 1000 - +(p.get("auth_date") ?? 0) > 86400) return null;
  try { return JSON.parse(p.get("user") ?? "{}"); } catch { return null; }
}

// ROCH #1401: «Открытка» приглашения (канон POSTCARD). Клиент шлёт ТОЛЬКО project_id: право приглашать, код, ссылки
// и карточку (обложка-JPEG + подпись + кнопка «Войти в команду») строит сервер. В Mini App карточка сохраняется
// в Telegram (savePreparedInlineMessage) и уходит родным окном «Отправить» (shareMessage). Ссылка — с непрозрачным кодом, не telegram_id.
const SITE_URL = "https://cock-pit.com";
const BOT_USER = "wando_tasks_bot";
const escH = (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function rnd(n: number) { const a = "abcdefghijkmnpqrstuvwxyz23456789"; return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => a[b % 32]).join(""); }
async function makeInvite(req: Request, body: Record<string, any>) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await sb.auth.getUser(jwt);
  const email = u?.user?.email?.toLowerCase();
  if (!email) return json({ error: "нужен вход" }, 401);
  const { data: p } = await sb.from("projects").select("id,name,workspace_id").eq("id", String(body.project_id ?? "")).maybeSingle();
  if (!p) return json({ error: "проект не найден" }, 404);
  const { data: me } = await sb.from("team").select("name,role").ilike("email", email).eq("workspace_id", p.workspace_id).limit(1);
  const role = String(me?.[0]?.role || "full").toLowerCase();
  if (!me?.length || !["owner", "full", "admin"].includes(role)) return json({ error: "Приглашать может владелец или админ пространства" }, 403);
  const code = rnd(12), exp = Date.now() + 7 * 864e5;
  // ROCH #1411: пригласить сразу админом может только владелец (админов назначает он один)
  const invRole = body.role === "admin" && role === "owner" ? "admin" : "member";
  // ROCH #1404: профиль заполнили за него и отметили проекты — берём только проекты того же пространства
  let projects: string[] = [];
  if (Array.isArray(body.projects) && body.projects.length) {
    const { data: ps } = await sb.from("projects").select("id").eq("workspace_id", p.workspace_id).in("id", body.projects.map(String).slice(0, 30));
    projects = (ps ?? []).map((x: Record<string, any>) => x.id);
  }
  const byName = String(body.by_name || me[0].name || email.split("@")[0]).slice(0, 60);
  const { error } = await sb.from("workspace_meta").insert({ k: "invite:" + code, workspace_id: p.workspace_id,
    v: { ws: p.workspace_id, project: p.id, by: email, byName, role: invRole, exp, max: body.member_id ? 1 : 20, uses: 0,
      ...(body.member_id ? { member: String(body.member_id).slice(0, 40) } : {}), ...(projects.length ? { projects } : {}) } }); // ROCH #1404: приглашение для карточки-заготовки — одноразовое
  if (error) return json({ error: error.message }, 500);
  const link = `https://t.me/${BOT_USER}?start=join_${code}`, web = `${SITE_URL}/?join=${code}`;
  const text = `${byName} зовёт тебя ${invRole === "admin" ? "админом " : ""}в «${p.name}» в WANDO — нажми, и ты в команде`;
  let prepared_id: string | null = null;
  const tg = body.initData ? await verifyInitData(String(body.initData)) : null;
  if (tg?.id) {
    const caption = `<b>${escH(byName)} зовёт тебя в «${escH(p.name)}»</b>\nWANDO — штаб команды: задачи, сроки и клиенты в одном месте. Нажми — и ты внутри, без паролей.`;
    const r = await fetch(`https://api.telegram.org/bot${BOT}/savePreparedInlineMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: tg.id, allow_user_chats: true, allow_group_chats: true, allow_bot_chats: false, allow_channel_chats: false,
        result: { type: "photo", id: code, photo_url: `${SITE_URL}/wando-invite.jpg`, thumbnail_url: `${SITE_URL}/wando-invite-thumb.jpg`,
          photo_width: 1200, photo_height: 630, title: `Приглашение в «${p.name}»`, caption, parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "Войти в команду", url: link }]] } } }) }).then((x) => x.json()).catch((e) => ({ ok: false, description: String(e) }));
    if (r?.ok) prepared_id = r.result?.id ?? null;
    else console.error("postcard: savePreparedInlineMessage failed", r?.description); // fail-loud: клиент покажет обычную ссылку
  }
  return json({ code, link, web, text, exp, prepared_id, role: invRole });
}

// ROCH #1399: вход на САЙТ через Telegram. Браузер заводит код + секрет (секрет живёт только в браузере, у нас — его хеш),
// открывает t.me/бот?start=login_<код>; бот спрашивает «Войти в браузере? Да/Нет» и пишет state. Сессию отдаём один раз —
// только тому, кто знает секрет; запись удаляется. Подтверждение в боте обязательно: без него ссылку login_ подсунули бы жертве.
async function loginPoll(code: string, secret: string, ua: string) {
  if (!/^[A-Za-z0-9]{16,40}$/.test(code) || secret.length < 16) return json({ error: "bad" }, 400);
  const key = "weblogin:" + code;
  const sh = await sha(secret);
  const { data: row } = await sb.from("workspace_meta").select("v").eq("k", key).maybeSingle();
  if (!row) {
    await sb.from("workspace_meta").insert({ k: key, workspace_id: "main", v: { sh, ts: Date.now(), ua: ua.slice(0, 160), state: "wait" } });
    return json({ state: "wait" });
  }
  const v = (row.v ?? {}) as Record<string, any>;
  if (v.sh !== sh) return json({ error: "чужой код" }, 403);
  if (Date.now() - Number(v.ts ?? 0) > 5 * 60000) { await sb.from("workspace_meta").delete().eq("k", key); return json({ state: "expired" }); }
  if (v.state === "no") { await sb.from("workspace_meta").delete().eq("k", key); return json({ state: "denied" }); }
  if (v.state !== "yes" || !v.email) return json({ state: "wait" });
  await sb.from("workspace_meta").delete().eq("k", key);
  return json({ state: "ok", email: v.email, token_hash: await sessionFor(v.email) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json();
    if (body.kind === "invite") return await makeInvite(req, body);
    if (body.kind === "login_poll") return await loginPoll(String(body.code ?? ""), String(body.secret ?? ""), req.headers.get("user-agent") ?? "");
    if (body.kind === "join_web") { // ?join=<код> на сайте: вошёл по почте → гасим приглашение по его JWT
      const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: u } = await sb.auth.getUser(jwt);
      const email = u?.user?.email?.toLowerCase();
      if (!email) return json({ error: "нужен вход" }, 401);
      const r = await redeemInvite(sb, String(body.code ?? ""), { email, name: String(body.name ?? "") });
      return json(r, r.ok ? 200 : 400);
    }
    const { initData } = body;
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
    return json({ email: link.email, token_hash: await sessionFor(link.email) });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
