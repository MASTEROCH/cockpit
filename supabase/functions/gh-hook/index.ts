// ============================================================================
// WANDO · Смарт-коммиты: GitHub push-вебхук → задачи закрываются из коммитов.
//  · «closes #A1B2C» / «fix #A1B2C» / «закрыл #A1B2C» → задача Готово + коммент
//  · просто «#A1B2C» в сообщении → коммент «упомянута в коммите»
//  · #ID — короткий номер из карточки задачи (5 знаков, виден в шапке карточки)
//
// Подключение (один раз, на каждый нужный репозиторий):
//   GitHub → repo → Settings → Webhooks → Add webhook
//   Payload URL: https://tonmsmxzmycimybzywqp.supabase.co/functions/v1/gh-hook
//   Content type: application/json · Secret: значение GH_WEBHOOK_SECRET
//   Events: Just the push event
// Секреты функции: GH_WEBHOOK_SECRET (придумай длинную строку, та же в GitHub).
// ВАЖНО: «Verify JWT» — ВЫКЛ (подпись HMAC проверяем сами).
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const SECRET = Deno.env.get("GH_WEBHOOK_SECRET") ?? "";

async function validSig(body: string, header: string | null): Promise<boolean> {
  if (!SECRET || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const got = header.slice(7).toLowerCase();
  if (got.length !== hex.length) return false;
  let diff = 0; // сравнение без ранних выходов
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

const CLOSE_RE = /(?:clos\w*|fix\w*|resolv\w*|закр\w*|готов\w*|сдела\w*|done)[^\n#]{0,12}#([a-z0-9]{4,6})/gi;
const ANY_RE = /#([a-z0-9]{4,6})/gi;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const body = await req.text();
  if (!(await validSig(body, req.headers.get("x-hub-signature-256")))) {
    return new Response("bad signature", { status: 401 });
  }
  const event = req.headers.get("x-github-event") ?? "";
  if (event === "ping") return new Response(JSON.stringify({ ok: true, pong: true }), { headers: { "content-type": "application/json" } });
  if (event !== "push") return new Response("ok");

  let payload: Record<string, any>;
  try { payload = JSON.parse(body); } catch { return new Response("ok"); }
  const commits = (payload.commits ?? []) as Record<string, any>[];
  if (!commits.length) return new Response("ok");

  // короткий #ID из карточки → задача (по всем проектам; продукт одно-командный)
  const { data: rows } = await sb.from("projects").select("id,data");
  const map = new Map<string, { row: Record<string, any>; t: Record<string, any> }>();
  for (const row of rows ?? []) {
    for (const t of (row.data?.tasks ?? []) as Record<string, any>[]) {
      map.set(String(t.id).slice(1, 6).toUpperCase(), { row, t });
    }
  }

  const changed = new Set<Record<string, any>>();
  let closed = 0, mentioned = 0;
  for (const c of commits) {
    const msg = String(c.message ?? "");
    const first = msg.split("\n")[0].slice(0, 140);
    const sha7 = String(c.id ?? "").slice(0, 7);
    const author = String(c.author?.username ?? c.author?.name ?? "GitHub");
    const closeIds = new Set<string>(), allIds = new Set<string>();
    for (const m of msg.matchAll(CLOSE_RE)) closeIds.add(m[1].toUpperCase());
    for (const m of msg.matchAll(ANY_RE)) allIds.add(m[1].toUpperCase());
    for (const id of allIds) {
      const hit = map.get(id);
      if (!hit) continue;
      const { row, t } = hit;
      const doClose = closeIds.has(id) && t.status !== "done";
      t.comments = t.comments ?? [];
      t.comments.push({ ts: Date.now(), author: "GitHub", text: (doClose ? "✅ Закрыта коммитом " : "🔗 Упомянута в коммите ") + sha7 + " (" + author + "): " + first + (c.url ? "\n" + c.url : "") });
      if (doClose) {
        t.status = "done"; t.statusTs = Date.now(); t.doneTs = Date.now();
        if (t.estimate && !t.spent) t.spent = t.estimate;
        t.hist = t.hist ?? [];
        t.hist.push({ ts: Date.now(), who: author + " · GitHub", text: "статус → Готово (коммит " + sha7 + ")" });
        if (t.hist.length > 30) t.hist = t.hist.slice(-30);
        closed++;
      } else mentioned++;
      row.data.activity = row.data.activity ?? [];
      row.data.activity.unshift({ ts: Date.now(), who: author + " · GitHub", icon: doClose ? "✅" : "🔗", text: "«" + t.title + "» " + (doClose ? "закрыта коммитом " : "упомянута в коммите ") + sha7 });
      if (row.data.activity.length > 150) row.data.activity.length = 150;
      changed.add(row);
    }
  }
  for (const row of changed) {
    row.data.updatedAt = Date.now();
    await sb.from("projects").update({ data: row.data, updated_at: new Date().toISOString(), updated_by: null }).eq("id", row.id);
  }
  return new Response(JSON.stringify({ ok: true, closed, mentioned }), { headers: { "content-type": "application/json" } });
});
