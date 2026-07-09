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
//   ELEVENLABS_API_KEY    — для распознавания голосовых (иначе голос вежливо откажет)
// ВАЖНО: «Verify JWT» у функции — ВЫКЛ.
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SECRET = Deno.env.get("TG_WEBHOOK_SECRET") ?? "";
const INTERNAL = Deno.env.get("WANDO_INTERNAL_SECRET") ?? "";
const ELEVEN = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
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
    [{ text: "🔥 Что горит" }, { text: "📊 Статус" }],
    [{ text: "📥 Приёмка" }, { text: "❓ Помощь" }],
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

// ---------- проекты / сводки ----------
async function myProjects(email: string) {
  const team = await isTeam(email);
  let q = sb.from("projects").select("id,name,emoji,data,updated_at").order("updated_at", { ascending: false });
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
async function createIntake(link: Link, text: string, source: string): Promise<{ id: string | null; err?: string }> {
  const { data, error } = await sb.from("intake").insert({
    by_email: link.email, by_name: link.name ?? link.email.split("@")[0],
    source, workspace: link.workspace, text: text.slice(0, 2000), status: "pending",
    target_project: parseTask(text).project,
  }).select("id").single();
  if (error) return { id: null, err: error.message };
  return { id: data.id };
}

async function pickProject(target: string | null) {
  const { data } = await sb.from("projects").select("id,name,emoji,data,updated_at").order("updated_at", { ascending: false });
  const rows = (data ?? []).filter((p: Record<string, any>) => !(p.data?.demo === true) && !(p.data?.archived === true));
  if (!rows.length) return null;
  if (target) {
    const t = target.toLowerCase();
    const hit = rows.find((p) => p.id === target) || rows.find((p) => (p.name ?? "").toLowerCase() === t) || rows.find((p) => (p.name ?? "").toLowerCase().includes(t));
    if (hit) return hit;
  }
  return rows[0];
}

async function acceptIntake(intakeId: string, by: Link): Promise<string> {
  const { data: row } = await sb.from("intake").select("*").eq("id", intakeId).maybeSingle();
  if (!row) return "⚠ Заявка не найдена";
  if (row.status !== "pending") return "Уже решено (" + row.status + ")";
  const p = parseTask(row.text); if (!p.title) p.title = row.text.slice(0, 140);
  const proj = await pickProject(row.target_project || p.project);
  if (!proj) return "⚠ Нет активных проектов — создай на сайте";
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
  return `✅ Добавлено в ${proj.emoji ?? "📄"} <b>${esc(proj.name)}</b>: «${esc(task.title)}»${chips(p)}`;
}

async function rejectIntake(intakeId: string, by: Link, own: boolean): Promise<string> {
  const { data: row } = await sb.from("intake").select("id,status,text").eq("id", intakeId).maybeSingle();
  if (!row) return "⚠ Заявка не найдена";
  if (row.status !== "pending") return "Уже решено (" + row.status + ")";
  await sb.from("intake").update({ status: "rejected", decided_by: by.email, decided_at: new Date().toISOString() }).eq("id", intakeId);
  return own ? "🗑 Отозвано: «" + esc(String(row.text).slice(0, 80)) + "»" : "✕ Отклонено: «" + esc(String(row.text).slice(0, 80)) + "»";
}

async function listIntake(chatId: number, link: Link) {
  if (!(await isTeam(link.email))) { await say(chatId, "Приёмку решает команда. Твои заявки появятся у них с кнопками ✓/✕."); return; }
  const { data } = await sb.from("intake").select("*").eq("status", "pending").order("created_at", { ascending: false }).limit(6);
  if (!data?.length) { await say(chatId, "📭 Приёмка пуста — всё разобрано."); return; }
  await say(chatId, `📥 <b>На приёмке · ${data.length}</b>`);
  for (const r of data) {
    const p = parseTask(r.text);
    await sayInline(chatId, `<b>${esc(r.by_name ?? r.by_email)}</b>${r.source ? " · " + esc(r.source) : ""}\n«${esc(p.title || r.text)}»${chips(p)}`,
      [[{ text: "✓ Добавить", callback_data: "acc:" + r.id }, { text: "✕ Отклонить", callback_data: "rej:" + r.id }]]);
  }
}

// ---------- уведомления (вызываются триггерами БД через notify.sql) ----------
async function teamLinks(exceptEmail?: string): Promise<Link[]> {
  const { data: team } = await sb.from("team").select("email");
  const emails = (team ?? []).map((t: Record<string, string>) => t.email.toLowerCase()).filter((e) => e !== (exceptEmail ?? "").toLowerCase());
  if (!emails.length) return [];
  const { data: links } = await sb.from("tg_links").select("*").eq("revoked", false);
  return ((links ?? []) as Link[]).filter((l) => emails.includes(l.email.toLowerCase()));
}
async function notifyNewIntake(rec: Record<string, any>) {
  const p = parseTask(rec.text ?? "");
  for (const l of await teamLinks(rec.by_email)) {
    await sayInline(l.chat_id, `📥 <b>Новая заявка</b> от <b>${esc(rec.by_name ?? rec.by_email)}</b>${rec.source ? " · " + esc(rec.source) : ""}\n«${esc(p.title || rec.text)}»${chips(p)}`,
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
    try { await say(l.chat_id, await briefFor(l)); } catch { /* один упал — остальные получат */ }
  }
}

// ---------- голос → текст (ElevenLabs Scribe) ----------
async function transcribe(fileId: string): Promise<{ text?: string; err?: string }> {
  if (!ELEVEN) return { err: "Распознавание не настроено: добавь ELEVENLABS_API_KEY в Secrets функции." };
  const fi = await TG("getFile", { file_id: fileId });
  const path = fi?.result?.file_path;
  if (!path) return { err: "Не смог скачать голосовое из Telegram." };
  const audio = await fetch(`https://api.telegram.org/file/bot${BOT}/${path}`).then((r) => r.arrayBuffer());
  const fd = new FormData();
  fd.append("file", new Blob([audio], { type: "audio/ogg" }), "voice.ogg");
  fd.append("model_id", "scribe_v1");
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": ELEVEN }, body: fd });
  if (!r.ok) return { err: "Распознавание не удалось (" + r.status + ")." };
  const j = await r.json().catch(() => null);
  const text = (j?.text ?? "").trim();
  return text ? { text } : { err: "Пустая расшифровка — попробуй ещё раз, чуть чётче." };
}

// ---------- справка ----------
const HELP = `<b>WANDO-бот — пульт в кармане</b>

🎙 <b>Голос или текст</b> — задача улетает в Приёмку:
• <i>созвон с Димой завтра 2ч срочно</i>
• <i>проект AppHub: настроить аналитику важно</i>
Понимаю: @имя · сегодня/завтра/послезавтра · «с 22 по 28 июля» · «до 15 июля» · «на 3 дня» · 2ч · !срочно/важно · «проект Х: …»

<b>Кнопки снизу</b>
🔥 Что горит — просрочки и срочное
📊 Статус — сводка всех проектов
📥 Приёмка — заявки с кнопками ✓/✕ (команда)
❓ Помощь — это сообщение

<b>Автомагия</b>
• Новая заявка → команде пуш с кнопками ✓/✕
• Решение по твоей заявке → тебе пуш
• ☀️ 9:00 — утренний бриф: твой день + пульс проектов

/key cpk_… — привязка (ключ: ${SITE} → ⋯ → «Подключить Claude»)`;

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
    } catch { /* не роняем */ }
    return new Response("ok");
  }

  if (SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  let update: Record<string, any>;
  try { update = await req.json(); } catch { return new Response("ok"); }

  // --- кнопки ✓/✕/отозвать ---
  const cb = update.callback_query;
  if (cb?.data && cb.message?.chat?.id) {
    const chatId = cb.message.chat.id as number;
    const [act, id] = String(cb.data).split(":");
    const link = await getLink(chatId);
    let result = "⚠ Сначала привяжи ключ: /key cpk_…";
    if (link) {
      if (act === "acc" || act === "rej") {
        result = (await isTeam(link.email))
          ? (act === "acc" ? await acceptIntake(id, link) : await rejectIntake(id, link, false))
          : "Решает команда 🙂";
      } else if (act === "undo") {
        result = await rejectIntake(id, link, true);
      }
    }
    await TG("answerCallbackQuery", { callback_query_id: cb.id, text: result.replace(/<[^>]+>/g, "").slice(0, 190) });
    await TG("editMessageText", { chat_id: chatId, message_id: cb.message.message_id, text: result, parse_mode: "HTML" });
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
      const p = parseTask(tr.text);
      await sayInline(chatId, `🎙 Распознал: «${esc(p.title || tr.text)}»${chips(p)}\n📥 Улетело в Приёмку`,
        [[{ text: "✕ Отозвать", callback_data: "undo:" + res.id }]]);
      return new Response("ok");
    }

    const text: string = (msg.text ?? "").trim();
    if (!text) return new Response("ok");

    if (/^\/start/.test(text)) {
      const link = await getLink(chatId);
      await say(chatId, link
        ? `С возвращением, <b>${esc(link.name ?? link.email)}</b>! Пиши задачу — текстом или голосом 🎙`
        : `Привет! Я — вход в <b>WANDO</b> (что делать).\n\n1️⃣ Ключ: ${SITE} → ⋯ → «Подключить Claude» → «Сгенерировать ключ»\n2️⃣ Пришли мне: <code>/key cpk_…</code>\n3️⃣ Пиши задачи — текстом или голосом 🎙\n\n/help — подробнее`);
    } else if (/^\/help|^❓/.test(text)) {
      await say(chatId, HELP);
    } else if (/^\/key\b/.test(text)) {
      const raw = text.replace(/^\/key\s*/, "").trim();
      const reply = await bindKey(chatId, name, raw);
      if (msg.message_id) await TG("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
      await say(chatId, reply);
    } else {
      const link = await getLink(chatId);
      if (!link) { await say(chatId, "Сначала привяжи ключ: <code>/key cpk_…</code>\nКлюч: " + SITE + " → ⋯ → «Подключить Claude». /help — подробнее"); return new Response("ok"); }
      if (/^\/brief|^☀️/.test(text)) { await say(chatId, await briefFor(link)); }
      else if (/^🔥|^\/fire|что горит|^аврал/i.test(text)) { await say(chatId, await statusSummary(link.email, true)); }
      else if (/^📊|^\/status|^стат/i.test(text)) { await say(chatId, await statusSummary(link.email, false)); }
      else if (/^📥|^\/intake|^приёмка|^приемка/i.test(text)) { await listIntake(chatId, link); }
      else if (/^\//.test(text)) { await say(chatId, "Не знаю такую команду. /help"); }
      else {
        const res = await createIntake(link, text, "telegram");
        if (!res.id) { await say(chatId, "⚠ " + esc(res.err ?? "не отправилось")); }
        else {
          const p = parseTask(text);
          await sayInline(chatId, `📥 В Приёмке: «${esc(p.title || text)}»${chips(p)}`,
            [[{ text: "✕ Отозвать", callback_data: "undo:" + res.id }]]);
        }
      }
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    try { await say(chatId, "⚠ Что-то пошло не так: " + esc(m)); } catch { /* ignore */ }
  }
  return new Response("ok");
});
