// WANDO · приглашение в команду ссылкой (ROCH #1399).
// Одна логика погашения для бота (t.me/…?start=join_<код>) и сайта (cock-pit.com/?join=<код>) — правила в одном месте.
// Приглашение — строка workspace_meta `invite:<код>` = { ws, project, by, byName, role, exp, max, uses }; создаёт его приложение.
// Папка _shared не деплоится как функция — её импортируют tg-bot и tma-auth.
// deno-lint-ignore-file no-explicit-any

export const TG_EMAIL_DOMAIN = "tg.cock-pit.com";
// учётка по Telegram без почты (Роч, 29.10: «приглашённому email не нужен»): личность подтверждает сам Telegram,
// домен наш и писем туда не бывает. В интерфейсе такая почта не показывается.
export const tgEmail = (chatId: number | string) => `tg${chatId}@${TG_EMAIL_DOMAIN}`;
export const isTgEmail = (e: string) => String(e ?? "").toLowerCase().endsWith("@" + TG_EMAIL_DOMAIN);

const PALETTE = ["#a78bfa", "#f472b6", "#38bdf8", "#34d399", "#fbbf24", "#fb923c"];

export async function readInvite(sb: any, code: string): Promise<{ inv?: Record<string, any>; err?: string }> {
  if (!/^[A-Za-z0-9]{8,32}$/.test(code)) return { err: "Ссылка-приглашение повреждена — попроси новую" };
  const { data } = await sb.from("workspace_meta").select("v").eq("k", "invite:" + code).maybeSingle();
  const inv = data?.v as Record<string, any> | undefined;
  if (!inv?.ws || !inv?.by) return { err: "Приглашение не найдено — попроси новую ссылку" };
  if (Date.now() > Number(inv.exp ?? 0)) return { err: "Срок приглашения истёк — попроси новую ссылку" };
  if (Number(inv.uses ?? 0) >= Number(inv.max ?? 20)) return { err: "По этой ссылке уже вошли все — попроси новую" };
  // приглашать могут только Владелец / Админ этого пространства — проверка на сервере, кнопка в интерфейсе не в счёт
  const { data: by } = await sb.from("team").select("role").ilike("email", inv.by).eq("workspace_id", inv.ws).limit(1);
  const role = String(by?.[0]?.role || "full").toLowerCase();
  if (!by?.length || !["owner", "full", "admin"].includes(role)) return { err: "Это приглашение больше не действует" };
  return { inv };
}

export async function redeemInvite(sb: any, code: string, who: { email: string; name: string; tg?: number | string }) {
  const { inv, err } = await readInvite(sb, code);
  if (!inv) return { ok: false as const, err };
  const em = who.email.toLowerCase();
  const name = (who.name || em.split("@")[0]).slice(0, 60);
  const { data: have } = await sb.from("team").select("email").ilike("email", em).eq("workspace_id", inv.ws).limit(1);
  const already = !!have?.length;
  if (!already) {
    const { error } = await sb.from("team").insert({ email: em, name, workspace_id: inv.ws, role: "member" });
    if (error) return { ok: false as const, err: "Не получилось добавить в команду: " + error.message };
  }
  // участник проекта — чтобы на него сразу можно было ставить задачи. ROCH #1404: проектов может быть несколько
  // (профиль заполнили за него и отметили проекты); карточка-заготовка (inv.member) в каждом проекте получает его вход
  const pids = [...new Set([inv.project, ...((inv.projects ?? []) as string[])].filter(Boolean))] as string[];
  let pid: string | null = null, projectName = "";
  for (const id of pids) {
    const { data: p } = await sb.from("projects").select("id,name,data,workspace_id").eq("id", id).maybeSingle();
    if (!p || p.workspace_id !== inv.ws) continue;
    const d = p.data ?? {}; d.members = d.members ?? [];
    const slot = inv.member ? d.members.find((m: any) => m?.id === inv.member && !m?.email) : null;
    let changed = false;
    // ROCH #1409: номер Telegram в карточке — второй ключ личности (узнаём и без почты)
    if (slot) { slot.email = em; if (who.tg) slot.tg = Number(who.tg); if (!slot.name || /^Новый участник/.test(slot.name)) slot.name = name; changed = true; }
    else if (!d.members.some((m: any) => String(m?.email ?? "").toLowerCase() === em)) {
      d.members.push({ id: inv.member || ("m" + Math.random().toString(36).slice(2, 8)), name, email: em, ...(who.tg ? { tg: Number(who.tg) } : {}), role: "", color: PALETTE[d.members.length % PALETTE.length], capacity: 30 });
      changed = true;
    }
    if (changed) {
      d.activity = d.activity ?? [];
      d.activity.unshift({ ts: Date.now(), who: name, icon: "👋", text: "вошёл(ла) в команду по приглашению" });
      d.updatedAt = Date.now();
      await sb.from("projects").update({ data: d, updated_at: new Date().toISOString(), updated_by: null }).eq("id", p.id);
    }
    if (!pid) { pid = p.id; projectName = p.name ?? ""; }
  }
  if (!already) await sb.from("workspace_meta").update({ v: { ...inv, uses: Number(inv.uses ?? 0) + 1 } }).eq("k", "invite:" + code);
  const { data: w } = await sb.from("workspaces").select("name").eq("id", inv.ws).maybeSingle();
  return { ok: true as const, ws: inv.ws as string, wsName: (w?.name ?? "") as string, pid, projectName, by: inv.by as string, byName: (inv.byName ?? inv.by) as string, already };
}
