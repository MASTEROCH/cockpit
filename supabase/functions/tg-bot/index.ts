// ============================================================================
// WANDO · Telegram-бот v2 — пульт в кармане
//  · текст И ГОЛОС (ElevenLabs Scribe) → Приёмка, с превью разбора и «Отозвать»
//  · постоянная клавиатура: 🔥 Что горит · 📊 Статус · 📥 Приёмка · ❓ Помощь
//  · Приёмка прямо в TG: пуш команде с кнопками ✓/✕ — задача создаётся из чата
//  · автору — пуш о решении; утренний бриф в 9:00 Батуми (pg_cron, notify.sql)
//
// Секреты (Dashboard → Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN    — токен @BotFather
//   TG_WEBHOOK_SECRET     — секрет вебхука Telegram (тот же, что в setWebhook)
//   WANDO_INTERNAL_SECRET — секрет внутренних событий БД→бот (тот же, что в notify.sql)
//   GROQ_API_KEY          — голосовые, БЕСПЛАТНО (console.groq.com, Whisper large-v3)
//   (альтернативы: OPENAI_API_KEY или ELEVENLABS_API_KEY — каскад сам выберет)
// ВАЖНО: «Verify JWT» у функции — ВЫКЛ.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SECRET = Deno.env.get("TG_WEBHOOK_SECRET") ?? "";
const INTERNAL = Deno.env.get("WANDO_INTERNAL_SECRET") ?? "";
// STT-провайдеры (каскад: какой ключ задан — тот и работает)
const GROQ = Deno.env.get("GROQ_API_KEY") ?? "";        // БЕСПЛАТНО: console.groq.com (Whisper large-v3)
const OPENAI = Deno.env.get("OPENAI_API_KEY") ?? "";    // платный Whisper, если есть
const ELEVEN = Deno.env.get("ELEVENLABS_API_KEY") ?? ""; // Scribe, если есть
const SITE = "cock-pit.com";
const TZ = 4; // Батуми UTC+4 — «сегодня/завтра» считаем по местному

const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

// ---------- Telegram helpers ----------
const TG = (method: string, body: unknown) =>
  fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => null);

const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const KEYBOARD = {
  keyboard: [
    [{ text: "🔥 Что горит" }, { text: "📊 Статус" }, { text: "🧭 Мои задачи" }],
    [{ text: "📥 Приёмка" }, { text: "💡 Идея" }, { text: "❓ Помощь" }],
  ],
  resize_keyboard: true, is_persistent: true,
};

async function say(chatId: number, html: string, extra: Record<string, unknown> = {}) {
  await TG("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: KEYBOARD, ...extra });
}
async function sayInline(chatId: number, html: string, buttons: unknown[][]) {
  await TG("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: buttons } });
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- время (локальное, Батуми) ----------
function todayISO(plusDays = 0): string {
  const d = new Date(Date.now() + TZ * 3600_000 + plusDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

// ---------- мини-парсер задачи (порт parseQuick; кириллица — без \b!) ----------
const MONTHS = ["янв", "фев", "мар", "апр", "ма", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
function monIdx(w: string): number { const l = w.toLowerCase(); return MONTHS.findIndex((m) => l.startsWith(m)); }
type Parsed = { title: string; est: number; prio: string | null; start: string | null; end: string | null; assignee: string | null; project: string | null };
function parseTask(raw: string): Parsed {
  let body = (raw || "").trim();
  let est = 0, prio: string | null = null, start: string | null = null, end: string | null = null, assignee: string | null = null, project: string | null = null;
  const pm = body.match(/^(?:в\s+)?проект[еа]?\s+(.+?)\s*[:—-]\s*/i);
  if (pm) { project = pm[1].trim(); body = body.slice(pm[0].length).trim(); }
  const em = body.match(/(\d+(?:[.,]\d+)?)\s*(?:часов|часа|час|ч|h)(?![а-яёa-z\d])/i);
  if (em) { est = parseFloat(em[1].replace(",", ".")); body = body.replace(em[0], " "); }
  const RX_URG = /(?:^|[\s!])(срочно|urgent|критич[а-яё]*)(?=\s|$|[!.,])/i;
  const RX_HI = /(?:^|[\s!])(важно|высокий приоритет|high)(?=\s|$|[!.,])/i;
  if (RX_URG.test(body)) { prio = "urgent"; body = body.replace(RX_URG, " "); }
  else if (RX_HI.test(body)) { prio = "high"; body = body.replace(RX_HI, " "); }
  let am = body.match(/@\s*([A-Za-zА-Яа-яЁё]+)/);
  if (am) { assignee = am[1]; body = body.replace(am[0], " "); }
  else { am = body.match(/\s(?:для|на)\s+([А-Яа-яЁёA-Za-z]+)(?=\s|$)/i); if (am && monIdx(am[1]) < 0 && !/^\d/.test(am[1])) { assignee = am[1]; body = body.replace(am[0], " "); } }
  if (/послезавтра/i.test(body)) { start = todayISO(2); body = body.replace(/послезавтра/i, " "); }
  else if (/завтра/i.test(body)) { start = todayISO(1); body = body.replace(/завтра/i, " "); }
  else if (/сегодня/i.test(body)) { start = todayISO(0); body = body.replace(/сегодня/i, " "); }
  const y = new Date().getUTCFullYear();
  const dd = (n: number) => String(n).padStart(2, "0");
  let dm = body.match(/с\s+(\d{1,2})\s*(?:по|до|[-–])\s*(\d{1,2})\s+([А-Яа-яёЁ]+)/i) || body.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([А-Яа-яёЁ]+)/i);
  if (dm) { const mi = monIdx(dm[3]); if (mi >= 0) { start = `${y}-${dd(mi + 1)}-${dd(+dm[1])}`; end = `${y}-${dd(mi + 1)}-${dd(+dm[2])}`; body = body.replace(dm[0], " "); } }
  else { const sm = body.match(/(?:до|к)\s+(\d{1,2})\s+([А-Яа-яёЁ]+)/i); if (sm) { const mi = monIdx(sm[2]); if (mi >= 0) { end = `${y}-${dd(mi + 1)}-${dd(+sm[1])}`; if (!start) start = todayISO(0); body = body.replace(sm[0], " "); } } }
  const nd = body.match(/на\s+(\d{1,2})\s*(дн[а-яё]*|день|недел[а-яё]*)/i);
  if (nd) { const n = +nd[1] * (/недел/i.test(nd[2]) ? 7 : 1); if (!start) start = todayISO(0); const s = new Date(start + "T00:00:00Z"); end = new Date(s.getTime() + (n - 1) * 86400_000).toISOString().slice(0, 10); body = body.replace(nd[0], " "); }
  const title = body.replace(/\s{2,}/g, " ").replace(/^[,;.\-—\s]+|[,;.\-—\s]+$/g, "").trim();
  return { title, est, prio, start, end, assignee, project };
}
function chips(p: Parsed): string {
  const out: string[] = [];
  if (p.assignee) out.push("👤 " + esc(p.assignee));
  if (p.start) out.push("📅 " + p.start.slice(8) + "." + p.start.slice(5, 7) + (p.end && p.end !== p.start ? "–" + p.end.slice(8) + "." + p.end.slice(5, 7) : ""));
  if (p.est) out.push("⏱ " + p.est + "ч");
  if (p.prio) out.push(p.prio === "urgent" ? "⚑ срочно" : "⚑ важно");
  if (p.project) out.push("📁 " + esc(p.project));
  return out.length ? "\n" + out.join(" · ") : "";
}

// ---------- доступ ----------
type Link = { chat_id: number; email: string; name: string | null; token_hash: string; workspace: string; revoked: boolean };
async function getLink(chatId: number): Promise<Link | null> {
  const { data } = await sb.from("tg_links").select("*").eq("chat_id", chatId).maybeSingle();
  return data && !data.revoked ? data as Link : null;
}
async function isTeam(email: string): Promise<boolean> {
  const { data } = await sb.from("team").select("email").ilike("email", email).maybeSingle();
  return !!data;
}
async function bindKey(chatId: number, name: string, raw: string): Promise<string> {
  if (!/^cpk_[A-Za-z0-9_-]{10,}$/.test(raw)) return "⚠ Не похоже на ключ. Формат: <code>/key cpk_…</code>";
  const hash = await sha256hex(raw);
  const { data: tok } = await sb.from("intake_tokens").select("email,workspace,revoked").eq("token_hash", hash).maybeSingle();
  if (!tok || tok.revoked) return `⚠ Ключ не найден или отозван. Сгенерируй новый: ${SITE} → ⋯ → «Подключить Claude».`;
  await sb.from("tg_links").upsert({ chat_id: chatId, email: tok.email, name, token_hash: hash, workspace: tok.workspace, revoked: false });
  return `✅ Привязано: <b>${esc(tok.email)}</b>\nПиши задачи текстом или голосом 🎙 — всё улетит в Приёмку.`;
}
// привязка в один тап: сайт открыл t.me/бот?start=bind_<код> → мы по коду знаем, кто это
async function bindByCode(chatId: number, name: string, code: string): Promise<string> {
  const { data: bc } = await sb.from("tg_bind_codes").select("*").eq("code", code).maybeSingle();
  if (!bc || bc.used) return `⚠ Код не найден или уже использован. Открой ${SITE} и нажми «Подключить Telegram» ещё раз.`;
  if (Date.now() - new Date(bc.created_at).getTime() > 15 * 60_000) {
    return `⚠ Код истёк (живёт 15 минут). Открой ${SITE} и нажми «Подключить Telegram» ещё раз.`;
  }
  await sb.from("tg_links").upsert({ chat_id: chatId, email: bc.email, name, token_hash: bc.token_hash, workspace: bc.workspace, revoked: false });
  await sb.from("tg_bind_codes").update({ used: true }).eq("code", code);
  return `✅ <b>Telegram подключён: ${esc(bc.email)}</b>\n\nТеперь просто пиши задачи — текстом или голосом 🎙\nКнопки снизу: 🔥 Что горит · 📊 Статус · 📥 Приёмка\n\nВернись на сайт — он уже увидел привязку ✨`;
}

// ---------- Ф3: self-serve — новое пространство по email ----------
async function selfServe(chatId: number, name: string, email: string): Promise<string> {
  const em = email.toLowerCase();
  const { data: existing } = await sb.from("team").select("email,workspace_id").ilike("email", em).maybeSingle();
  if (existing) return `Этот email уже в пространстве WANDO. Если это ты — привяжись с сайта ${SITE} («Подключить Telegram») или ключом <code>/key cpk_…</code> 🔐`;
  try { await sb.auth.admin.createUser({ email: em, email_confirm: true }); } catch { /* уже существует — ок */ }
  const ws = "ws_" + Math.random().toString(36).slice(2, 10);
  const { error: e1 } = await sb.from("workspaces").insert({ id: ws, name: (name || "Founder") + " HQ", plan: "solo", created_by: em });
  if (e1) return "⚠ Не получилось создать пространство: " + esc(e1.message);
  await sb.from("team").insert({ email: em, name: name || "Founder", workspace_id: ws });
  await sb.from("tg_links").upsert({ chat_id: chatId, email: em, name, token_hash: "selfserve", revoked: false, workspace_id: ws });
  const today = todayISO(0);
  const proj = { id: "p" + Math.random().toString(36).slice(2, 9), projectName: "Мой первый проект", emoji: "🚀", demo: false, parentId: null, updatedAt: Date.now(),
    members: [{ id: "m1", name: name || "Founder", email: em, role: "Founder", color: "#a78bfa", capacity: 30 }],
    sections: [{ id: "s1", name: "Задачи" }], ideas: [], activity: [],
    tasks: [
      { id: "t1", title: "Написать сюда первую задачу — текстом или голосом 🎙", sectionId: "s1", assigneeId: "m1", start: today, end: today, status: "todo", estimate: 1, spent: 0, priority: "med", description: "", comments: [], isMilestone: false, deps: [] },
      { id: "t2", title: "Открыть WANDO кнопкой меню и осмотреться", sectionId: "s1", assigneeId: "m1", start: today, end: todayISO(1), status: "todo", estimate: 1, spent: 0, priority: "med", description: "", comments: [], isMilestone: false, deps: [] },
    ] };
  await sb.from("projects").insert({ id: proj.id, name: proj.projectName, emoji: proj.emoji, data: proj, workspace_id: ws, updated_at: new Date().toISOString() });
  _wsCache[em] = ws;
  return `🚀 <b>Твоё пространство создано!</b>\n\nЖми кнопку <b>WANDO</b> в меню бота — ты уже залогинен (вход по этому Telegram).\nПиши задачи прямо сюда — текстом или голосом 🎙\n\nПлан: <b>Solo</b> (бесплатно). /plan — что даёт Founder ⭐`;
}

// ---------- воркспейсы (multi-tenant Ф3) ----------
const _wsCache: Record<string, string> = {};
async function wsByEmail(email: string): Promise<string> {
  const k = (email || "").toLowerCase();
  if (_wsCache[k]) return _wsCache[k];
  const { data } = await sb.from("team").select("workspace_id").ilike("email", email).maybeSingle();
  return _wsCache[k] = (data?.workspace_id) ?? "main";
}

// ---------- проекты / сводки ----------
async function myProjects(email: string) {
  const team = await isTeam(email);
  const ws = await wsByEmail(email);
  let q = sb.from("projects").select("id,name,emoji,data,updated_at").eq("workspace_id", ws).order("updated_at", { ascending: false });
  if (!team) {
    const { data: acc } = await sb.from("project_access").select("project_id").ilike("email", email);
    const ids = (acc ?? []).map((a: Record<string, string>) => a.project_id);
    if (!ids.length) return { team, rows: [] as Record<string, any>[] };
    q = q.in("id", ids);
  }
  const { data } = await q;
  const rows = (data ?? []).filter((p: Record<string, any>) => !(p.data?.demo === true) && !(p.data?.archived === true));
  return { team, rows };
}
function taskList(p: Record<string, any>) { return ((p.data?.tasks ?? []) as Record<string, any>[]).filter((t) => !t.isMilestone); }

async function statusSummary(email: string, fireOnly: boolean): Promise<string> {
  const { rows } = await myProjects(email);
  if (!rows.length) return "Пока нет доступных проектов.";
  const today = todayISO(0);
  const out: string[] = [];
  for (const p of rows) {
    const tasks = taskList(p);
    const open = tasks.filter((t) => t.status !== "done");
    const over = open.filter((t) => (t.end ?? "9999") < today);
    const burning = open.filter((t) => (t.end ?? "9999") <= today || t.priority === "urgent");
    if (fireOnly && !burning.length) continue;
    const done = tasks.length - open.length;
    let line = `${p.emoji ?? "📄"} <b>${esc(p.name ?? "Проект")}</b>: ${done}/${tasks.length} готово` + (over.length ? `, ⚠ ${over.length} просрочено` : "");
    if (fireOnly) { line += `\n   🔥 ${esc(burning.slice(0, 4).map((t) => t.title).join("; "))}`; }
    else {
      if (over.length) line += `\n   ⏰ ${esc(over.slice(0, 3).map((t) => t.title).join("; "))}`;
      const next = open.filter((t) => (t.end ?? "9999") >= today).sort((a, b) => ((a.end ?? "9999") < (b.end ?? "9999") ? -1 : 1)).slice(0, 3);
      if (next.length) line += `\n   → ${esc(next.map((t) => t.title).join("; "))}`;
    }
    out.push(line);
  }
  if (!out.length) return fireOnly ? "🔥 Ничего не горит — можно строить ✨" : "Активных проектов нет.";
  return `<b>${fireOnly ? "🔥 Что горит" : "📊 Статус WANDO"} · ${today}</b>\n\n${out.join("\n\n")}`;
}

async function briefFor(link: Link): Promise<string> {
  const { rows } = await myProjects(link.email);
  const today = todayISO(0);
  const mineToday: string[] = []; const mineOver: string[] = [];
  for (const p of rows) {
    const me = ((p.data?.members ?? []) as Record<string, any>[]).find((m) => (m.email ?? "").toLowerCase() === link.email.toLowerCase());
    if (!me) continue;
    for (const t of taskList(p)) {
      if (t.status === "done" || t.assigneeId !== me.id) continue;
      const tag = `${t.title} <i>(${p.emoji ?? "📄"} ${esc(p.name)})</i>`;
      if ((t.end ?? "9999") < today) mineOver.push(tag);
      else if (t.end === today) mineToday.push(tag);
    }
  }
  let out = `☀️ <b>Доброе утро${link.name ? ", " + esc(link.name.split(" ")[0]) : ""}!</b>\n`;
  if (mineOver.length) out += `\n⏰ <b>Просрочено у тебя · ${mineOver.length}</b>\n${mineOver.slice(0, 5).map((t) => "• " + t).join("\n")}\n`;
  if (mineToday.length) out += `\n🎯 <b>На сегодня · ${mineToday.length}</b>\n${mineToday.slice(0, 5).map((t) => "• " + t).join("\n")}\n`;
  if (!mineOver.length && !mineToday.length) out += "\n🎯 На тебе сегодня дедлайнов нет — можно строить.\n";
  out += "\n" + await statusSummary(link.email, false);
  return out;
}

// ---------- Приёмка из Telegram ----------
// ответ после захвата: мгновенно в Приёмке + один необязательный тап «Куда?»
async function captureReply(chatId: number, link: Link, intakeId: string, text: string, prefix: string) {
  const p = parseTask(text);
  // если проект назван голосом/текстом («проект X: …») — вопросов нет
  if (p.project) {
    const proj = await pickProjectStrict(p.project, await wsByEmail(link.email));
    if (proj) {
      await sb.from("intake").update({ target_project: proj.id }).eq("id", intakeId);
      await rememberChoice(chatId, proj.id);
      await sayInline(chatId, `${prefix} → ${proj.emoji ?? "📄"} <b>${esc(proj.name)}</b>: «${esc(p.title || text)}»${chips(p)}`,
        [[{ text: "✕ Отозвать", callback_data: "undo:" + intakeId }]]);
      return;
    }
  }
  const kb = await projectButtons(link.email, intakeId, "route", (link as Record<string, any>).last_project);
  kb.push([{ text: "🤷 решу позже", callback_data: "route:" + intakeId + ":none" }, { text: "✕ Отозвать", callback_data: "undo:" + intakeId }]);
  await sayInline(chatId, `${prefix}: «${esc(p.title || text)}»${chips(p)}\n\n📁 <b>Куда?</b> <i>(один тап — и я запомню)</i>`, kb);
}
async function createIntake(link: Link, text: string, source: string): Promise<{ id: string | null; err?: string }> {
  const _ws = await wsByEmail(link.email);
  const { data, error } = await sb.from("intake").insert({ workspace_id: _ws,
    by_email: link.email, by_name: link.name ?? link.email.split("@")[0],
    source, workspace: link.workspace, text: text.slice(0, 2000), status: "pending",
    target_project: parseTask(text).project,
  }).select("id").single();
  if (error) return { id: null, err: error.message };
  return { id: data.id };
}

// СТРОГИЙ выбор проекта: никакого «возьмём последний» — либо нашли, либо null.
// Тихие догадки = каша; система знает или спрашивает.
async function pickProjectStrict(target: string | null, ws?: string) {
  if (!target) return null;
  const { data } = await sb.from("projects").select("id,name,emoji,data,workspace_id").order("updated_at", { ascending: false });
  const rows = (data ?? []).filter((p: Record<string, any>) => !(p.data?.demo === true) && !(p.data?.archived === true) && (!ws || p.workspace_id === ws));
  const t = target.toLowerCase();
  return rows.find((p) => p.id === target) || rows.find((p) => (p.name ?? "").toLowerCase() === t) || rows.find((p) => (p.name ?? "").toLowerCase().includes(t)) || null;
}
// кнопки «Куда?» — проекты пользователя, его последний выбор первым (бот учится)
async function projectButtons(email: string, intakeId: string, prefix: string, lastProject?: string | null) {
  const { rows } = await myProjects(email);
  const ordered = [...rows];
  if (lastProject) { const i = ordered.findIndex((p) => p.id === lastProject); if (i > 0) { const [x] = ordered.splice(i, 1); ordered.unshift(x); } }
  const btns = ordered.slice(0, 8).map((p) => ({ text: `${p.emoji ?? "📄"} ${String(p.name ?? "").slice(0, 22)}`, callback_data: `${prefix}:${intakeId}:${p.id}` }));
  const kb: Array<Array<Record<string, string>>> = [];
  for (let i = 0; i < btns.length; i += 2) kb.push(btns.slice(i, i + 2));
  return kb;
}
async function rememberChoice(chatId: number, projectId: string) {
  try { await sb.from("tg_links").update({ last_project: projectId }).eq("chat_id", chatId); } catch { /* колонки может не быть до followup.sql */ }
}

// принять заявку; projectId обязателен (из target или из явного выбора кнопкой).
// Возвращает "" если проект не определён — вызывающий покажет кнопки выбора.
async function acceptIntake(intakeId: string, by: Link, projectId?: string): Promise<string> {
  const { data: row } = await sb.from("intake").select("*").eq("id", intakeId).maybeSingle();
  if (!row) return "⚠ Заявка не найдена";
  if (row.status !== "pending") return "Уже решено (" + row.status + ")";
  const p = parseTask(row.text); if (!p.title) p.title = row.text.slice(0, 140);
  const proj = await pickProjectStrict(projectId || row.target_project || p.project, await wsByEmail(by.email));
  if (!proj) return ""; // не угадываем — спросим кнопками
  const d = proj.data ?? {};
  d.tasks = d.tasks ?? []; d.sections = d.sections?.length ? d.sections : [{ id: "s1", name: "Задачи" }]; d.members = d.members ?? [];
  let assigneeId: string | null = null;
  if (p.assignee) {
    const an = p.assignee.toLowerCase();
    const m = d.members.find((m: Record<string, any>) => (m.name ?? "").toLowerCase().startsWith(an)) || d.members.find((m: Record<string, any>) => (m.email ?? "").toLowerCase().startsWith(an));
    if (m) assigneeId = m.id;
  }
  const start = p.start ?? todayISO(0);
  const task = {
    id: "t" + Math.random().toString(36).slice(2, 9), title: p.title.slice(0, 140),
    sectionId: d.sections[0].id, assigneeId, start, end: p.end ?? start,
    status: "todo", estimate: p.est || 0, spent: 0, priority: p.prio ?? "med",
    description: row.note ?? "", comments: [], isMilestone: false, deps: [], createdTs: Date.now(),
  };
  d.tasks.push(task);
  d.activity = d.activity ?? [];
  d.activity.unshift({ ts: Date.now(), who: (by.name ?? by.email) + " · TG", icon: "📥", text: "из приёмки: «" + task.title + "»" });
  d.updatedAt = Date.now();
  const { error } = await sb.from("projects").update({ data: d, updated_at: new Date().toISOString(), updated_by: null }).eq("id", proj.id);
  if (error) return "⚠ Не удалось создать задачу: " + esc(error.message);
  await sb.from("intake").update({ status: "accepted", decided_by: by.email, decided_at: new Date().toISOString(), target_project: proj.id, result_task_id: task.id }).eq("id", intakeId);
  return `✅ Добавлено в ${proj.emoji ?? "📄"} <b>${esc(proj.name)}</b>: «<a href="https://${SITE}/?t=${proj.id}:${task.id}">${esc(task.title)}</a>»${chips(p)}\n<i>↩︎ ответь на это сообщение — текст станет комментом к задаче</i>`;
}

async function rejectIntake(intakeId: string, by: Link, own: boolean): Promise<string> {
  const { data: row } = await sb.from("intake").select("id,status,text").eq("id", intakeId).maybeSingle();
  if (!row) return "⚠ Заявка не найдена";
  if (row.status !== "pending") return "Уже решено (" + row.status + ")";
  await sb.from("intake").update({ status: "rejected", decided_by: by.email, decided_at: new Date().toISOString() }).eq("id", intakeId);
  return own ? "🗑 Отозвано: «" + esc(String(row.text).slice(0, 80)) + "»" : "✕ Отклонено: «" + esc(String(row.text).slice(0, 80)) + "»";
}

async function targetLabel(target: string | null): Promise<string> {
  if (!target) return "\n📁 <i>без проекта — выберем при добавлении</i>";
  const proj = await pickProjectStrict(target);
  return proj ? `\n📁 ${proj.emoji ?? "📄"} ${esc(proj.name)}` : "\n📁 <i>без проекта</i>";
}
async function listIntake(chatId: number, link: Link) {
  if (!(await isTeam(link.email))) { await say(chatId, "Приёмку решает команда. Твои заявки появятся у них с кнопками ✓/✕."); return; }
  const { data } = await sb.from("intake").select("*").eq("status", "pending").eq("workspace_id", await wsByEmail(link.email)).order("created_at", { ascending: false }).limit(6);
  if (!data?.length) { await say(chatId, "📭 Приёмка пуста — всё разобрано."); return; }
  await say(chatId, `📥 <b>На приёмке · ${data.length}</b>`);
  for (const r of data) {
    const p = parseTask(r.text);
    await sayInline(chatId, `<b>${esc(r.by_name ?? r.by_email)}</b>${r.source ? " · " + esc(r.source) : ""}\n«${esc(p.title || r.text)}»${chips(p)}${await targetLabel(r.target_project)}`,
      [[{ text: "✓ Добавить", callback_data: "acc:" + r.id }, { text: "✕ Отклонить", callback_data: "rej:" + r.id }]]);
  }
}
// ---------- карманные выжимки: мои / человека / проекта ----------
async function myTasksList(link: Link): Promise<string> {
  const { rows } = await myProjects(link.email);
  const today = todayISO(0);
  const items: Array<{ s: string; end: string }> = [];
  for (const p of rows) {
    const me = ((p.data?.members ?? []) as Record<string, any>[]).find((m) => (m.email ?? "").toLowerCase() === link.email.toLowerCase());
    if (!me) continue;
    for (const t of taskList(p)) {
      if (t.status === "done" || t.assigneeId !== me.id) continue;
      const over = (t.end ?? "9999") < today;
      items.push({ end: t.end ?? "9999", s: `${over ? "🔴" : t.end === today ? "🟡" : "•"} ${esc(t.title)} <i>(${p.emoji ?? "📄"} ${esc(p.name)}${t.end ? " · до " + t.end.slice(8) + "." + t.end.slice(5, 7) : ""})</i>` });
    }
  }
  if (!items.length) return "🧘 На тебе нет открытых задач.";
  items.sort((a, b) => (a.end < b.end ? -1 : 1));
  return `🧭 <b>Твои задачи · ${items.length}</b>\n${items.slice(0, 12).map((x) => x.s).join("\n")}${items.length > 12 ? "\n…и ещё " + (items.length - 12) : ""}`;
}
async function memberTasksList(link: Link, whoName: string): Promise<string> {
  const { rows } = await myProjects(link.email);
  const today = todayISO(0); const wn = whoName.toLowerCase();
  const items: Array<{ s: string; end: string }> = []; let realName = whoName;
  for (const p of rows) {
    const m = ((p.data?.members ?? []) as Record<string, any>[]).find((m) => (m.name ?? "").toLowerCase().startsWith(wn));
    if (!m) continue; realName = m.name;
    for (const t of taskList(p)) {
      if (t.status === "done" || t.assigneeId !== m.id) continue;
      const over = (t.end ?? "9999") < today;
      items.push({ end: t.end ?? "9999", s: `${over ? "🔴" : t.end === today ? "🟡" : "•"} ${esc(t.title)} <i>(${p.emoji ?? "📄"} ${esc(p.name)})</i>` });
    }
  }
  if (!items.length) return `У <b>${esc(realName)}</b> нет открытых задач (или не нашёл такого).`;
  items.sort((a, b) => (a.end < b.end ? -1 : 1));
  return `👤 <b>${esc(realName)} · ${items.length} в работе</b>\n${items.slice(0, 12).map((x) => x.s).join("\n")}`;
}
async function projectDigest(link: Link, name: string): Promise<string> {
  const { rows } = await myProjects(link.email);
  const t = name.toLowerCase();
  const p = rows.find((x) => (x.name ?? "").toLowerCase() === t) || rows.find((x) => (x.name ?? "").toLowerCase().includes(t));
  if (!p) return `Проект «${esc(name)}» не нашёл. Мои проекты: ${rows.map((x) => esc(x.name)).join(", ")}`;
  const today = todayISO(0);
  const tasks = taskList(p); const open = tasks.filter((x) => x.status !== "done");
  const over = open.filter((x) => (x.end ?? "9999") < today);
  const members = (p.data?.members ?? []) as Record<string, any>[];
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? "—";
  const next = open.sort((a, b) => ((a.end ?? "9999") < (b.end ?? "9999") ? -1 : 1)).slice(0, 6);
  return `${p.emoji ?? "📄"} <b>${esc(p.name)}</b> · ${tasks.length - open.length}/${tasks.length} готово${over.length ? ` · ⚠ ${over.length} просрочено` : ""}\n\n${next.map((x) => `${(x.end ?? "9999") < today ? "🔴" : "•"} ${esc(x.title)} <i>(${esc(nameOf(x.assigneeId))}${x.end ? " · " + x.end.slice(8) + "." + x.end.slice(5, 7) : ""})</i>`).join("\n") || "Открытых задач нет ✨"}`;
}

// ---------- уведомления (вызываются триггерами БД через notify.sql) ----------
async function teamLinks(exceptEmail?: string, ws?: string): Promise<Link[]> {
  let tq = sb.from("team").select("email,workspace_id");
  if (ws) tq = tq.eq("workspace_id", ws);
  const { data: team } = await tq;
  const emails = (team ?? []).map((t: Record<string, string>) => t.email.toLowerCase()).filter((e) => e !== (exceptEmail ?? "").toLowerCase());
  if (!emails.length) return [];
  const { data: links } = await sb.from("tg_links").select("*").eq("revoked", false);
  return ((links ?? []) as Link[]).filter((l) => emails.includes(l.email.toLowerCase()));
}
async function notifyNewIntake(rec: Record<string, any>) {
  if (rec.source === "telegram-idea") return; // идеи маршрутизирует сам автор — не шумим
  const p = parseTask(rec.text ?? "");
  const tl = await targetLabel(rec.target_project);
  for (const l of await teamLinks(rec.by_email, rec.workspace_id ?? "main")) {
    await sayInline(l.chat_id, `📥 <b>Новая заявка</b> от <b>${esc(rec.by_name ?? rec.by_email)}</b>${rec.source ? " · " + esc(rec.source) : ""}\n«${esc(p.title || rec.text)}»${chips(p)}${tl}`,
      [[{ text: "✓ Добавить", callback_data: "acc:" + rec.id }, { text: "✕ Отклонить", callback_data: "rej:" + rec.id }]]);
  }
}
async function notifyDecision(rec: Record<string, any>) {
  if ((rec.decided_by ?? "").toLowerCase() === (rec.by_email ?? "").toLowerCase()) return; // сам себе не шлём
  const { data: link } = await sb.from("tg_links").select("*").ilike("email", rec.by_email).eq("revoked", false).maybeSingle();
  if (!link) return;
  const t = parseTask(rec.text ?? "").title || rec.text;
  const map: Record<string, string> = { accepted: "✅ Твоя задача принята", backlog: "📥 Твоя задача ушла в бэклог", rejected: "✕ Твоя задача отклонена" };
  await say(link.chat_id, `${map[rec.status] ?? "Решение: " + rec.status}: «${esc(t)}»\n<i>решил: ${esc(rec.decided_by ?? "")}</i>`);
}
async function morningBrief() {
  const { data: links } = await sb.from("tg_links").select("*").eq("revoked", false);
  for (const l of (links ?? []) as Link[]) {
    try { await sendBrief(l); } catch { /* один упал — остальные получат */ }
  }
}
// бриф + отдельные «ждёшь от X» с кнопкой пинга (бот — плохой полицейский, не ты)
async function sendBrief(link: Link) {
  await say(link.chat_id, await briefFor(link));
  const waits = await myWaits(link.email);
  for (const w of waits.slice(0, 3)) {
    await sayInline(link.chat_id, `🤝 Ждёшь от <b>${esc(w.whoName)}</b>: «${esc(w.title)}» <i>(${w.pemoji} ${esc(w.pname)})</i>`,
      [[{ text: "🔔 Пингануть " + w.whoName.split(" ")[0], callback_data: `ping:${w.pid}:${w.tid}` }]]);
  }
}
// задачи, где я исполнитель, но жду шага от другого (waitingOn)
async function myWaits(email: string) {
  const { rows } = await myProjects(email);
  const out: Array<{ pid: string; pname: string; pemoji: string; tid: string; title: string; whoId: string; whoName: string }> = [];
  for (const p of rows) {
    const members = (p.data?.members ?? []) as Record<string, any>[];
    const me = members.find((m) => (m.email ?? "").toLowerCase() === email.toLowerCase());
    if (!me) continue;
    for (const t of taskList(p)) {
      if (t.status === "done" || t.assigneeId !== me.id || !t.waitingOn || t.waitingOn === me.id) continue;
      const who = members.find((m) => m.id === t.waitingOn);
      out.push({ pid: p.id, pname: p.name, pemoji: p.emoji ?? "📄", tid: t.id, title: t.title, whoId: t.waitingOn, whoName: who?.name ?? "партнёра" });
    }
  }
  return out;
}
async function pingWaiting(asker: Link, projectId: string, taskId: string): Promise<string> {
  const { data: p } = await sb.from("projects").select("id,name,emoji,data").eq("id", projectId).maybeSingle();
  if (!p) return "⚠ Проект не найден";
  const t = ((p.data?.tasks ?? []) as Record<string, any>[]).find((x) => x.id === taskId);
  if (!t || t.status === "done") return "Задача уже закрыта ✨";
  const who = ((p.data?.members ?? []) as Record<string, any>[]).find((m) => m.id === t.waitingOn);
  if (!who?.email) return "⚠ У того, кого ждём, не указан email";
  const { data: wl } = await sb.from("tg_links").select("chat_id").ilike("email", who.email).eq("revoked", false).maybeSingle();
  if (!wl) return `⚠ ${esc(who.name ?? "Он")} ещё не подключил Telegram — пингани лично`;
  await say(wl.chat_id, `🔔 <b>${esc(asker.name ?? asker.email)}</b> ждёт от тебя шага:\n«<a href="https://${SITE}/?t=${p.id}:${t.id}">${esc(t.title)}</a>» <i>(${p.emoji ?? "📄"} ${esc(p.name)})</i>\n\nСделай ход — или просто ответь на это сообщение, текст станет комментом 🙌`);
  return `🔔 Пингнул ${esc(who.name ?? "")} — теперь мяч на его стороне ✅`;
}
// 🧍 стендап по требованию: вопрос команде, ответы reply'ем летят инициатору.
// Хранилища нет — маркер su=<chatId инициатора> зашит в text_link якорь вопроса.
async function askStandup(init: Link, initChat: number): Promise<string> {
  const ws = await wsByEmail(init.email);
  const links = (await teamLinks(init.email, ws)).filter((l) => l.chat_id !== initChat);
  if (!links.length) return "🧍 Пока некому: никто из команды не привязал Telegram.";
  const q = `🧍 <b>${esc(init.name ?? init.email)}</b> собирает <a href="https://${SITE}/?su=${initChat}">стендап</a>:\n\n1️⃣ что сделал вчера\n2️⃣ что делаешь сегодня\n3️⃣ что мешает\n\n<i>↩︎ ответь на ЭТО сообщение одним сообщением — я перешлю</i>`;
  let n = 0;
  for (const l of links) { await TG("sendMessage", { chat_id: l.chat_id, text: q, parse_mode: "HTML", disable_web_page_preview: true }); n++; }
  return `🧍 Спросил ${n} ${n === 1 ? "человека" : "человек"} — ответы прилетят сюда по мере готовности.`;
}

// вечерний разбор: закрыто сегодня + незакрытое с переносом одним тапом
function nextMondayISO(): string {
  const now = new Date(Date.now() + TZ * 3600_000);
  const dow = (now.getUTCDay() + 6) % 7; // пн=0
  return todayISO(7 - dow);
}
async function shiftMyTasks(email: string, targetISO: string): Promise<number> {
  const { rows } = await myProjects(email);
  const today = todayISO(0);
  let n = 0;
  for (const p of rows) {
    const members = (p.data?.members ?? []) as Record<string, any>[];
    const me = members.find((m) => (m.email ?? "").toLowerCase() === email.toLowerCase());
    if (!me) continue;
    let touched = false;
    for (const t of taskList(p)) {
      if (t.status === "done" || t.assigneeId !== me.id) continue;
      if ((t.end ?? "9999") > today) continue; // переносим только сегодняшнее/просроченное
      t.end = targetISO;
      if ((t.start ?? targetISO) > targetISO) t.start = targetISO;
      touched = true; n++;
    }
    if (touched) {
      p.data.updatedAt = Date.now();
      p.data.activity = p.data.activity ?? [];
      p.data.activity.unshift({ ts: Date.now(), who: email.split("@")[0] + " · TG", icon: "🌙", text: "вечерний разбор: перенос незакрытого" });
      await sb.from("projects").update({ data: p.data, updated_at: new Date().toISOString(), updated_by: null }).eq("id", p.id);
    }
  }
  return n;
}
async function eveningReview() {
  const { data: links } = await sb.from("tg_links").select("*").eq("revoked", false);
  const today = todayISO(0);
  for (const l of (links ?? []) as Link[]) {
    try {
      const { rows } = await myProjects(l.email);
      let doneToday = 0; const open: string[] = [];
      const dayStart = new Date(today + "T00:00:00Z").getTime() - TZ * 3600_000;
      for (const p of rows) {
        const members = (p.data?.members ?? []) as Record<string, any>[];
        const me = members.find((m) => (m.email ?? "").toLowerCase() === l.email.toLowerCase());
        if (!me) continue;
        for (const t of taskList(p)) {
          if (t.assigneeId !== me.id) continue;
          if (t.status === "done" && t.doneTs && t.doneTs >= dayStart) doneToday++;
          if (t.status !== "done" && (t.end ?? "9999") <= today) open.push(`${t.title} <i>(${p.emoji ?? "📄"} ${esc(p.name)})</i>`);
        }
      }
      if (!doneToday && !open.length) continue; // тишина лучше пустого отчёта
      let text = `🌇 <b>Вечерний разбор</b>\n`;
      text += doneToday ? `\n✅ Закрыто сегодня: <b>${doneToday}</b> — красавчик!\n` : "";
      if (open.length) text += `\n🌙 Не закрылось · ${open.length}:\n${open.slice(0, 6).map((t) => "• " + t).join("\n")}\n\nПеренести одним тапом — и план снова честный:`;
      if (open.length) {
        await sayInline(l.chat_id, text, [[{ text: "🌙 На завтра", callback_data: "shiftall:tomorrow:x" }, { text: "📆 На понедельник", callback_data: "shiftall:monday:x" }]]);
      } else {
        await say(l.chat_id, text + "\n🏁 Все дедлайны дня закрыты. Чистый вечер!");
      }
    } catch { /* следующий */ }
  }
}

// ---------- Вандо-пульс: ИИ сам выходит на связь, но НИКОГДА не спамит ----------
// Тройной антиспам: cron 3р/нед + пауза ≥48ч на человека + право ответить SKIP.
const ANTHROPIC = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const PULSE_SYSTEM = `Ты — Вандо, живой ум таск-трекера WANDO и супер-проджект команды фаундеров. Тебе дают состояние проектов человека.
Твоя задача — решить: есть ли ОДНА вещь, ради которой стоит написать ему сегодня. Это может быть:
• назревающая проблема (перекос нагрузки, тихо гниющая задача, риск по срокам) — скажи прямо и предложи конкретный ход;
• реальный повод похвалить (серия закрытий, чистый день) — коротко и искренне, без сиропа;
• процесс/культура (например, всё висит на одном человеке — предложи делегировать).
ЖЕЛЕЗНЫЕ ПРАВИЛА: максимум 3 коротких предложения. Никаких общих фраз («не забывай отдыхать»), никакой воды, ничего, что видно и так. Не повторяй то, что говорил в прошлый раз (тебе покажут). Если сегодня НЕТ ничего по-настоящему стоящего — ответь ровно одним словом: SKIP. Пиши по-русски, на «ты», тепло и по делу. Начни с подходящего эмодзи.`;
async function askClaude(system: string, user: string, maxTokens = 400): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "anthropic " + r.status);
  return String(data?.content?.[0]?.text ?? "").trim();
}
async function aiPulse() {
  if (!ANTHROPIC) return;
  const { data: links } = await sb.from("tg_links").select("*").eq("revoked", false);
  for (const l of (links ?? []) as Array<Link & { last_ai_ping?: string; last_ai_text?: string }>) {
    try {
      if (!(await isTeam(l.email))) continue; // пульс — для фаундеров
      if (l.last_ai_ping && Date.now() - new Date(l.last_ai_ping).getTime() < 48 * 3600_000) continue;
      const status = (await statusSummary(l.email, false)).replace(/<[^>]+>/g, "");
      const waits = await myWaits(l.email);
      const ctx = `Человек: ${l.name ?? l.email}\nСегодня: ${todayISO(0)}\n\nСостояние проектов:\n${status}\n\nОн ждёт шагов от других: ${waits.map((w) => `«${w.title}» от ${w.whoName}`).join("; ") || "нет"}\n\nЧто ты говорил ему в прошлый раз (НЕ повторяйся): ${l.last_ai_text ?? "ничего"}`;
      const out = await askClaude(PULSE_SYSTEM, ctx);
      if (!out || /^skip\b/i.test(out)) continue;
      await say(l.chat_id, `<b>Вандо на связи</b> 🤝\n\n${esc(out)}`);
      await sb.from("tg_links").update({ last_ai_ping: new Date().toISOString(), last_ai_text: out.slice(0, 500) }).eq("chat_id", l.chat_id);
    } catch { /* следующий */ }
  }
}

// ---------- голос → текст (каскад: Groq → OpenAI → ElevenLabs) ----------
async function sttWhisper(base: string, key: string, model: string, audio: ArrayBuffer): Promise<string> {
  const fd = new FormData();
  fd.append("file", new Blob([audio], { type: "audio/ogg" }), "voice.ogg");
  fd.append("model", model);
  const r = await fetch(base + "/audio/transcriptions", { method: "POST", headers: { authorization: "Bearer " + key }, body: fd });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return String(j.text ?? "").trim();
}
async function sttEleven(audio: ArrayBuffer): Promise<string> {
  const fd = new FormData();
  fd.append("file", new Blob([audio], { type: "audio/ogg" }), "voice.ogg");
  fd.append("model_id", "scribe_v1");
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": ELEVEN }, body: fd });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return String(j.text ?? "").trim();
}
async function transcribe(fileId: string): Promise<{ text?: string; err?: string }> {
  if (!GROQ && !OPENAI && !ELEVEN) {
    return { err: "Распознавание не настроено. Бесплатно: ключ на console.groq.com → в Secrets функции как GROQ_API_KEY." };
  }
  const fi = await TG("getFile", { file_id: fileId });
  const path = fi?.result?.file_path;
  if (!path) return { err: "Не смог скачать голосовое из Telegram." };
  const audio = await fetch(`https://api.telegram.org/file/bot${BOT}/${path}`).then((r) => r.arrayBuffer());
  const tries: Array<() => Promise<string>> = [];
  if (GROQ) tries.push(() => sttWhisper("https://api.groq.com/openai/v1", GROQ, "whisper-large-v3-turbo", audio));
  if (OPENAI) tries.push(() => sttWhisper("https://api.openai.com/v1", OPENAI, "whisper-1", audio));
  if (ELEVEN) tries.push(() => sttEleven(audio));
  let lastErr = "";
  for (const t of tries) {
    try { const text = await t(); if (text) return { text }; lastErr = "пустая расшифровка"; }
    catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
  }
  return { err: "Распознавание не удалось (" + lastErr + ") — попробуй ещё раз, чуть чётче." };
}

// ---------- справка ----------
const HELP = `<b>WANDO-бот — пульт в кармане</b>

🎙 <b>Голос или текст</b> — задача мгновенно в Приёмке, а куда именно — один тап по кнопке (я запоминаю твой выбор):
• <i>созвон с Димой завтра 2ч срочно</i>
• <i>проект AppHub: настроить аналитику важно</i> — с названием проекта вопросов не будет
💡 <i>идея реферальная программа</i> — в бэклог идей проекта

<b>Быстрые выжимки</b>
🧭 Мои задачи · <i>задачи Димы</i> · <i>проект Датум</i> — состояние в один взгляд
🔥 Что горит · 📊 Статус · 📥 Приёмка (✓/✕ прямо здесь)

<b>Автомагия</b>
• ☀️ 9:00 — утренний бриф: твой день + «ждёшь от…» с кнопкой 🔔 Пингануть
• 🌇 18:00 — вечерний разбор: что закрыто, незакрытое — на завтра одним тапом
• Новая заявка → команде пуш с ✓/✕; решение → автору пуш
• 💬 Ответь (reply) на сообщение бота о задаче — текст станет комментом в её карточке
• ⭐ /plan — тариф Founder (оплата Stars прямо здесь)\n• 🧍 «стендап» — соберу у команды «вчера/сегодня/мешает», ответы пришлю тебе

Понимаю: @имя · сегодня/завтра/послезавтра · «с 22 по 28 июля» · «до 15 июля» · «на 3 дня» · 2ч · !срочно/важно`;

// ---------- main ----------
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  // внутренние события от БД (триггеры notify.sql) и pg_cron
  if (INTERNAL && req.headers.get("x-wando-internal") === INTERNAL) {
    try {
      const ev = await req.json();
      if (ev.kind === "intake_insert") await notifyNewIntake(ev.record ?? {});
      else if (ev.kind === "intake_decided") await notifyDecision(ev.record ?? {});
      else if (ev.kind === "morning_brief") await morningBrief();
      else if (ev.kind === "evening_review") await eveningReview();
      else if (ev.kind === "ai_pulse") await aiPulse();
    } catch { /* не роняем */ }
    return new Response("ok");
  }

  if (SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  let update: Record<string, any>;
  try { update = await req.json(); } catch { return new Response("ok"); }

  // --- Stars: подтверждение и зачисление оплаты (Ф4) ---
  if (update.pre_checkout_query) {
    await TG("answerPreCheckoutQuery", { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
    return new Response("ok");
  }
  {
    const sp = update.message?.successful_payment;
    if (sp?.invoice_payload?.startsWith?.("founder:")) {
      const ws = sp.invoice_payload.slice(8);
      const { data: w } = await sb.from("workspaces").select("stars_until").eq("id", ws).maybeSingle();
      const base = Math.max(Date.now(), w?.stars_until ? new Date(w.stars_until).getTime() : 0);
      const until = new Date(base + 31 * 86400_000).toISOString();
      await sb.from("workspaces").update({ plan: "founder", stars_until: until }).eq("id", ws);
      await say(update.message.chat.id, `⭐ <b>Founder активен!</b> До ${until.slice(0, 10)}.\nВандо-ИИ, наставник и отчёты — открыты. Погнали 🚀`);
      return new Response("ok");
    }
  }

  // --- кнопки: ✓/✕, «Куда?», отозвать, перенос, пинг ---
  const cb = update.callback_query;
  if (cb?.data && cb.message?.chat?.id) {
    const chatId = cb.message.chat.id as number;
    const parts = String(cb.data).split(":");
    const act = parts[0], id = parts[1], arg = parts[2];
    const link = await getLink(chatId);
    let result = "⚠ Сначала привяжи Telegram на " + SITE;
    let handled = false;
    if (link) {
      if (act === "acc" || act === "accto") {
        if (!(await isTeam(link.email))) result = "Решает команда 🙂";
        else {
          result = await acceptIntake(id, link, act === "accto" ? arg : undefined);
          if (result === "") { // проект не определён — спрашиваем, не угадываем
            const kb = await projectButtons(link.email, id, "accto", (link as Record<string, any>).last_project);
            kb.push([{ text: "✕ Отклонить", callback_data: "rej:" + id }]);
            await TG("answerCallbackQuery", { callback_query_id: cb.id, text: "Выбери проект 📁" });
            await TG("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: cb.message.text + "\n\n📁 <b>Куда добавить?</b>", parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
            handled = true;
          } else if (act === "accto") { await rememberChoice(chatId, arg); }
        }
      } else if (act === "rej") {
        result = (await isTeam(link.email)) ? await rejectIntake(id, link, false) : "Решает команда 🙂";
      } else if (act === "undo") {
        result = await rejectIntake(id, link, true);
      } else if (act === "route") { // маршрутизация своей заявки: intakeId + projectId|none
        const { data: row } = await sb.from("intake").select("id,status,text").eq("id", id).maybeSingle();
        if (!row || row.status !== "pending") result = "Уже решено";
        else if (arg === "none") {
          result = `📥 В Приёмке <i>(проект решат при разборе)</i>: «${esc(parseTask(row.text).title || row.text)}»`;
          await TG("answerCallbackQuery", { callback_query_id: cb.id, text: "Ок, решат в Приёмке" });
          await TG("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: result, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✕ Отозвать", callback_data: "undo:" + id }]] } });
          handled = true;
        } else {
          const proj = await pickProjectStrict(arg, await wsByEmail(link.email));
          if (!proj) result = "⚠ Проект не найден";
          else {
            await sb.from("intake").update({ target_project: proj.id }).eq("id", id);
            await rememberChoice(chatId, proj.id);
            result = `📥 В Приёмке → ${proj.emoji ?? "📄"} <b>${esc(proj.name)}</b>: «${esc(parseTask(row.text).title || row.text)}»`;
            await TG("answerCallbackQuery", { callback_query_id: cb.id, text: "→ " + proj.name });
            await TG("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: result, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✕ Отозвать", callback_data: "undo:" + id }]] } });
            handled = true;
          }
        }
      } else if (act === "ideato") { // идея → в бэклог идей выбранного проекта
        const { data: row } = await sb.from("intake").select("*").eq("id", id).maybeSingle();
        if (!row || row.status !== "pending") result = "Уже решено";
        else {
          const proj = await pickProjectStrict(arg, await wsByEmail(link.email));
          if (!proj) result = "⚠ Проект не найден";
          else {
            const d = proj.data ?? {}; d.ideas = d.ideas ?? [];
            d.ideas.push({ id: "i" + Math.random().toString(36).slice(2, 9), title: String(row.text).slice(0, 200), note: "", votes: 1, createdTs: Date.now() });
            d.updatedAt = Date.now();
            d.activity = d.activity ?? [];
            d.activity.unshift({ ts: Date.now(), who: (link.name ?? link.email) + " · TG", icon: "💡", text: "идея: «" + String(row.text).slice(0, 80) + "»" });
            await sb.from("projects").update({ data: d, updated_at: new Date().toISOString(), updated_by: null }).eq("id", proj.id);
            await sb.from("intake").update({ status: "backlog", decided_by: link.email, decided_at: new Date().toISOString(), target_project: proj.id }).eq("id", id);
            await rememberChoice(chatId, proj.id);
            result = `💡 В бэклоге идей ${proj.emoji ?? "📄"} <b>${esc(proj.name)}</b>: «${esc(String(row.text).slice(0, 100))}»`;
          }
        }
      } else if (act === "shiftall") { // вечерний разбор: перенос незакрытого
        const target = id === "monday" ? nextMondayISO() : todayISO(1);
        const n = await shiftMyTasks(link.email, target);
        result = n ? `🌙 Перенёс ${n} задач(и) на ${target.slice(8)}.${target.slice(5, 7)} — план снова честный ✅` : "Нечего переносить — всё чисто ✨";
      } else if (act === "ping") { // вежливый пинг того, от кого ждёшь
        result = await pingWaiting(link, id, arg);
      }
    }
    if (!handled) {
      await TG("answerCallbackQuery", { callback_query_id: cb.id, text: result.replace(/<[^>]+>/g, "").slice(0, 190) });
      await TG("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: result, parse_mode: "HTML" });
    }
    return new Response("ok");
  }

  const msg = update.message ?? update.edited_message;
  const chatId: number | undefined = msg?.chat?.id;
  if (!chatId) return new Response("ok");
  const name: string = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "без имени";

  try {
    // --- голосовые (voice / audio / video_note) ---
    const voice = msg.voice ?? msg.audio ?? msg.video_note;
    if (voice?.file_id) {
      const link = await getLink(chatId);
      if (!link) { await say(chatId, "Сначала привяжи ключ: <code>/key cpk_…</code> (см. /help)"); return new Response("ok"); }
      await TG("sendChatAction", { chat_id: chatId, action: "typing" });
      const tr = await transcribe(voice.file_id);
      if (!tr.text) { await say(chatId, "⚠ " + esc(tr.err ?? "не распознал")); return new Response("ok"); }
      const res = await createIntake(link, tr.text, "telegram-voice");
      if (!res.id) { await say(chatId, "⚠ " + esc(res.err ?? "не отправилось")); return new Response("ok"); }
      await captureReply(chatId, link, res.id, tr.text, "🎙 Распознал");
      return new Response("ok");
    }

    const text: string = (msg.text ?? "").trim();
    if (!text) return new Response("ok");

    // --- ответ на сообщение бота о задаче → комментарий в задачу ---
    const rp = msg.reply_to_message;
    if (rp && !text.startsWith("/")) {
      const ents = [...(rp.entities ?? []), ...(rp.caption_entities ?? [])] as Record<string, any>[];
      let ref: { pid: string; tid: string } | null = null;
      for (const e of ents) {
        if (e.type === "text_link" && e.url) {
          const m = String(e.url).match(/[?#]t=([\w-]+):([\w-]+)/);
          if (m) { ref = { pid: m[1], tid: m[2] }; break; }
        }
      }
      // стендап-ответ: маркер su=<chatId инициатора> в якоре вопроса
      for (const e of ents) {
        if (e.type === "text_link" && e.url) {
          const ms = String(e.url).match(/[?&]su=(\d+)/);
          if (ms) {
            const link = await getLink(chatId);
            const who = link ? (link.name ?? link.email) : name;
            await TG("sendMessage", { chat_id: +ms[1], parse_mode: "HTML", disable_web_page_preview: true,
              text: `🧍 <b>${esc(who)}</b>:\n${esc(text.slice(0, 1500))}` });
            await say(chatId, "🧍 Передал ✓");
            return new Response("ok");
          }
        }
      }
      if (ref) {
        const link = await getLink(chatId);
        if (!link) { await say(chatId, "Сначала привяжи ключ: <code>/key cpk_…</code> (см. /help)"); return new Response("ok"); }
        const { data: p } = await sb.from("projects").select("id,name,emoji,data").eq("id", ref.pid).maybeSingle();
        const t = p && ((p.data?.tasks ?? []) as Record<string, any>[]).find((x) => x.id === ref.tid);
        if (!t) { await say(chatId, "⚠ Задача не нашлась — возможно, удалена"); return new Response("ok"); }
        t.comments = t.comments ?? [];
        t.comments.push({ text: text.slice(0, 1000), author: (link.name ?? link.email) + " · TG", authorId: null, when: "сейчас", ts: Date.now() });
        p.data.activity = p.data.activity ?? [];
        p.data.activity.unshift({ ts: Date.now(), who: (link.name ?? link.email) + " · TG", icon: "💬", text: "коммент к «" + t.title + "»" });
        p.data.updatedAt = Date.now();
        const { error } = await sb.from("projects").update({ data: p.data, updated_at: new Date().toISOString(), updated_by: null }).eq("id", p.id);
        await say(chatId, error ? "⚠ Не сохранилось: " + esc(error.message) : `💬 Коммент к «${esc(t.title)}» сохранён — команда увидит его в карточке задачи`);
        return new Response("ok");
      }
    }

    if (/^\/start/.test(text)) {
      const payload = text.replace(/^\/start\s*/, "").trim();
      if (/^bind_[A-Za-z0-9_-]{10,}$/.test(payload)) {
        await say(chatId, await bindByCode(chatId, name, payload.slice(5)));
        return new Response("ok");
      }
      const link = await getLink(chatId);
      await say(chatId, link
        ? `С возвращением, <b>${esc(link.name ?? link.email)}</b>! Пиши задачу — текстом или голосом 🎙`
        : `Привет! Я — вход в <b>WANDO</b> (что делать).\n\n<b>Новый здесь?</b> Просто пришли свой email — создам тебе личное пространство за 5 секунд 🚀\n\nУже в команде? Открой <b>${SITE}</b> → «Подключить Telegram» (1 тап), либо ключом: <code>/key cpk_…</code>\n\n/help — подробнее`);
    } else if (/^\/help|^❓/.test(text)) {
      await say(chatId, HELP);
    } else if (/^\/plan|^⭐/.test(text)) {
      const link = await getLink(chatId);
      if (!link) { await say(chatId, "Сначала создай пространство: пришли свой email 🚀"); return new Response("ok"); }
      const ws = await wsByEmail(link.email);
      const { data: w } = await sb.from("workspaces").select("plan,stars_until").eq("id", ws).maybeSingle();
      const plan = w?.plan ?? "solo";
      if (plan === "founder_forever") { await say(chatId, "💜 У тебя вечный <b>Founder</b> — всё включено, навсегда."); return new Response("ok"); }
      const until = w?.stars_until ? new Date(w.stars_until) : null;
      const active = until && until.getTime() > Date.now();
      const head = active
        ? `⭐ <b>Founder активен</b> до ${until!.toISOString().slice(0, 10)}.\nПродлить ещё на 30 дней:`
        : `План: <b>${plan === "solo" ? "Solo (бесплатно)" : plan}</b>.\n\n<b>Founder ⭐</b> — Вандо-ИИ и пульс, наставник-планирование, 📊 отчёты империи, проекты без лимита.`;
      await say(chatId, head);
      await TG("sendInvoice", { chat_id: chatId, title: "WANDO Founder · 30 дней",
        description: "Вандо-ИИ, наставник, отчёты, безлимит проектов",
        payload: "founder:" + ws, currency: "XTR", prices: [{ label: "Founder / 30 дней", amount: 1900 }] });
      return new Response("ok");
    } else if (/^\/key\b/.test(text)) {
      const raw = text.replace(/^\/key\s*/, "").trim();
      const reply = await bindKey(chatId, name, raw);
      if (msg.message_id) await TG("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
      await say(chatId, reply);
    } else {
      const link = await getLink(chatId);
      if (!link) {
        const em = text.match(/^[\w.+-]+@[\w-]+\.[\w.]{2,}$/);
        if (em) { await say(chatId, await selfServe(chatId, name, em[0])); return new Response("ok"); }
        await say(chatId, "Пришли свой <b>email</b> — создам тебе личное пространство 🚀\nИли привяжись к команде: " + SITE + " → «Подключить Telegram», либо <code>/key cpk_…</code>");
        return new Response("ok");
      }
      if (/^\/standup|^стендап|^🧍/i.test(text)) { await say(chatId, await askStandup(link, chatId)); }
      else if (/^\/brief|^☀️/.test(text)) { await sendBrief(link); }
      else if (/^🔥|^\/fire|что горит|^аврал/i.test(text)) { await say(chatId, await statusSummary(link.email, true)); }
      else if (/^📊|^\/status|^стат/i.test(text)) { await say(chatId, await statusSummary(link.email, false)); }
      else if (/^📥|^\/intake|^приёмка|^приемка/i.test(text)) { await listIntake(chatId, link); }
      else if (/^💡( Идея)?$/i.test(text)) { await say(chatId, "💡 Пиши: <code>идея твоя мысль…</code> — закину в бэклог идей нужного проекта (спрошу куда одним тапом)."); }
      else if (/^(💡\s*)?идея[:\s]/i.test(text)) {
        const ideaText = text.replace(/^(💡\s*)?идея[:\s]+/i, "").trim();
        if (!ideaText) { await say(chatId, "Пустая идея 🙂 Пиши: <code>идея …</code>"); }
        else {
          const res = await createIntake(link, ideaText, "telegram-idea");
          if (!res.id) await say(chatId, "⚠ " + esc(res.err ?? "не отправилось"));
          else {
            const kb = await projectButtons(link.email, res.id, "ideato", (link as Record<string, any>).last_project);
            kb.push([{ text: "✕ Отозвать", callback_data: "undo:" + res.id }]);
            await sayInline(chatId, `💡 Идея: «${esc(ideaText)}»\n\n📁 <b>В бэклог какого проекта?</b>`, kb);
          }
        }
      }
      else if (/^\/my|^🧭|^мои задачи|^мои дела|^что у меня/i.test(text)) { await say(chatId, await myTasksList(link)); }
      else if (/^задачи\s+[А-Яа-яЁёA-Za-z]/i.test(text)) { await say(chatId, await memberTasksList(link, text.replace(/^задачи\s+/i, "").trim())); }
      else if (/^проект\s+[^:]+$/i.test(text)) { await say(chatId, await projectDigest(link, text.replace(/^проект\s+/i, "").trim())); }
      else if (/^\//.test(text)) { await say(chatId, "Не знаю такую команду. /help"); }
      else {
        const res = await createIntake(link, text, "telegram");
        if (!res.id) { await say(chatId, "⚠ " + esc(res.err ?? "не отправилось")); }
        else await captureReply(chatId, link, res.id, text, "📥 В Приёмке");
      }
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    try { await say(chatId, "⚠ Что-то пошло не так: " + esc(m)); } catch { /* ignore */ }
  }
  return new Response("ok");
});
