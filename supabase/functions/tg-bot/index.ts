// ============================================================================
// WANDO · Telegram-бот (webhook, Supabase Edge Function)
// Задачи из Telegram → Приёмка WANDO. «Статус» → сводка проектов.
// Ничего не создаёт напрямую — только очередь «На приёмке» (человек решает).
//
// Секреты (Dashboard → Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN — токен от @BotFather
//   TG_WEBHOOK_SECRET  — своя случайная строка (та же, что в setWebhook)
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY доступны автоматически.
// ВАЖНО: при деплое выключи «Verify JWT» — Telegram не шлёт Authorization.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SECRET = Deno.env.get("TG_WEBHOOK_SECRET") ?? "";
const sb = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const TG = (method: string, body: unknown) =>
  fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function say(chatId: number, html: string) {
  await TG("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const HELP = `<b>WANDO-бот — что делать</b>

Пиши задачу обычным языком — она улетит в <b>Приёмку</b> на cock-pit.com, где её подтвердят:
• <i>созвон с Димой завтра 2ч срочно</i>
• <i>вёрстка лендинга с 22 по 28 июля 12ч @дима</i>
• <i>проект AppHub: настроить аналитику важно</i>

Понимаю: @имя · сегодня/завтра/послезавтра · «с 22 по 28 июля» · «на 3 дня» · 2ч/12ч · !срочно/важно

<b>Команды</b>
/status — что по проектам (готово/просрочено/ближайшее)
/key cpk_… — привязать твой ключ WANDO (один раз)
/help — эта справка

Ключ берётся на cock-pit.com → меню ⋯ → «Подключить Claude» → «Сгенерировать ключ».`;

type Link = { chat_id: number; email: string; name: string | null; token_hash: string; workspace: string; revoked: boolean };

async function getLink(chatId: number): Promise<Link | null> {
  const { data } = await sb.from("tg_links").select("*").eq("chat_id", chatId).maybeSingle();
  if (!data || data.revoked) return null;
  return data as Link;
}

async function bindKey(chatId: number, name: string, raw: string): Promise<string> {
  if (!/^cpk_[A-Za-z0-9_-]{10,}$/.test(raw)) return "⚠ Не похоже на ключ. Формат: <code>/key cpk_…</code>";
  const hash = await sha256hex(raw);
  const { data: tok } = await sb.from("intake_tokens").select("email,workspace,revoked").eq("token_hash", hash).maybeSingle();
  if (!tok || tok.revoked) return "⚠ Ключ не найден или отозван. Сгенерируй новый на cock-pit.com → «Подключить Claude».";
  await sb.from("tg_links").upsert({ chat_id: chatId, email: tok.email, name, token_hash: hash, workspace: tok.workspace, revoked: false });
  return `✅ Привязано: <b>${esc(tok.email)}</b>\nТеперь просто пиши задачи — они полетят в Приёмку. /status — сводка.`;
}

async function statusSummary(link: Link): Promise<string> {
  const { data: team } = await sb.from("team").select("email").ilike("email", link.email).maybeSingle();
  let q = sb.from("projects").select("id,name,emoji,data");
  if (!team) {
    const { data: acc } = await sb.from("project_access").select("project_id").ilike("email", link.email);
    const ids = (acc ?? []).map((a) => a.project_id);
    if (!ids.length) return "У тебя пока нет доступных проектов.";
    q = q.in("id", ids);
  }
  const { data: rows } = await q;
  const today = new Date().toISOString().slice(0, 10);
  const out: string[] = [];
  for (const p of rows ?? []) {
    const d = p.data ?? {};
    if (d.demo === true || d.archived === true) continue;
    const tasks = (d.tasks ?? []).filter((t: Record<string, unknown>) => !t.isMilestone);
    const total = tasks.length;
    const done = tasks.filter((t: Record<string, unknown>) => t.status === "done").length;
    const open = tasks.filter((t: Record<string, unknown>) => t.status !== "done");
    const over = open.filter((t: Record<string, string>) => (t.end ?? "9999") < today);
    open.sort((a: Record<string, string>, b: Record<string, string>) => ((a.end ?? "9999") < (b.end ?? "9999") ? -1 : 1));
    let line = `${p.emoji ?? "📄"} <b>${esc(p.name ?? "Проект")}</b>: ${done}/${total} готово` + (over.length ? `, ⚠ ${over.length} просрочено` : "");
    if (over.length) line += `\n   ⏰ ${esc(over.slice(0, 4).map((t: Record<string, string>) => t.title).join("; "))}`;
    const next = open.filter((t: Record<string, string>) => (t.end ?? "9999") >= today).slice(0, 3);
    if (next.length) line += `\n   → ${esc(next.map((t: Record<string, string>) => t.title).join("; "))}`;
    out.push(line);
  }
  return out.length ? `<b>Статус WANDO · ${today}</b>\n\n${out.join("\n\n")}` : "Активных проектов нет.";
}

async function proposeTask(link: Link, text: string): Promise<string> {
  const { error } = await sb.from("intake").insert({
    by_email: link.email,
    by_name: link.name ?? link.email.split("@")[0],
    source: "telegram",
    workspace: link.workspace,
    text: text.slice(0, 2000),
    status: "pending",
  });
  if (error) return "⚠ Не получилось отправить: " + esc(error.message);
  return "📥 Улетело в Приёмку WANDO — подтвердят на cock-pit.com";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  let update: Record<string, any>;
  try { update = await req.json(); } catch { return new Response("ok"); }

  const msg = update.message ?? update.edited_message;
  const chatId: number | undefined = msg?.chat?.id;
  const text: string = (msg?.text ?? "").trim();
  if (!chatId || !text) return new Response("ok");
  const name: string = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "без имени";

  try {
    if (/^\/start/.test(text)) {
      const link = await getLink(chatId);
      await say(chatId, link
        ? `С возвращением, <b>${esc(link.name ?? link.email)}</b>! Пиши задачу — улетит в Приёмку. /status — сводка.`
        : `Привет! Я — вход в <b>WANDO</b> (что делать).\n\n1️⃣ Возьми ключ: cock-pit.com → меню ⋯ → «Подключить Claude» → «Сгенерировать ключ»\n2️⃣ Пришли мне: <code>/key cpk_…</code>\n3️⃣ Пиши задачи обычным языком\n\n/help — подробнее`);
    } else if (/^\/help/.test(text)) {
      await say(chatId, HELP);
    } else if (/^\/key\b/.test(text)) {
      const raw = text.replace(/^\/key\s*/, "").trim();
      const reply = await bindKey(chatId, name, raw);
      // подчистить сообщение с ключом из истории чата
      if (msg.message_id) await TG("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      await say(chatId, reply);
    } else {
      const link = await getLink(chatId);
      if (!link) {
        await say(chatId, "Сначала привяжи ключ: <code>/key cpk_…</code>\nКлюч: cock-pit.com → ⋯ → «Подключить Claude». /help — подробнее");
      } else if (/^\/status\b|^стат|что горит|^статус/i.test(text)) {
        await say(chatId, await statusSummary(link));
      } else if (/^\//.test(text)) {
        await say(chatId, "Не знаю такую команду. /help");
      } else {
        await say(chatId, await proposeTask(link, text));
      }
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    try { await say(chatId, "⚠ Что-то пошло не так: " + esc(m)); } catch { /* ignore */ }
  }
  return new Response("ok");
});
