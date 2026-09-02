// WANDO — «Завести компанию»: создать изолированный воркспейс + его владельца.
// Только СУПЕР-владелец HQ (воркспейс 'main', role owner) может это сделать.
// Пишет service-role ключом (клиент под RLS воркспейсы/чужую команду не создаёт — и верно).
// verify_jwt=true по умолчанию (не в config.toml) → гейтвей требует валидный JWT.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPER = "romi4rv23@gmail.com"; // хардкод-фолбэк супер-владельца
const sbs = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });

// Проверяем ПОДПИСЬ токена через Auth (а не читаем payload) — иначе подделка email.
async function emailFromJwt(auth: string | null): Promise<string | null> {
  try {
    const tok = (auth || "").replace(/^Bearer\s+/i, "");
    if (!tok || tok.split(".").length !== 3) return null;
    const { data, error } = await sbs.auth.getUser(tok);
    if (error || !data?.user?.email) return null;
    return data.user.email.toLowerCase();
  } catch { return null; }
}

// Заводить компании может супер-владелец: жёсткий SUPER или owner воркспейса 'main'.
async function isSuper(email: string): Promise<boolean> {
  if (email === SUPER) return true;
  try {
    const { data } = await sbs.from("team").select("role,workspace_id").ilike("email", email).maybeSingle();
    return !!data && data.workspace_id === "main" && data.role === "owner";
  } catch { return false; }
}

function slugId(name: string): string {
  const base = (name || "ws").toLowerCase().normalize("NFKD")
    .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 24) || "ws";
  const rnd = Math.random().toString(36).slice(2, 7);
  return `${base}-${rnd}`;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const email = await emailFromJwt(req.headers.get("authorization"));
  if (!email) return json({ error: "нужен вход" }, 401);
  if (!(await isSuper(email))) return json({ error: "только владелец HQ может заводить компании" }, 403);

  let body: Record<string, string> = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }); }
  const name = (body?.name || "").trim();
  const ownerEmail = (body?.ownerEmail || "").trim().toLowerCase();
  const ownerName = (body?.ownerName || "").trim();
  const plan = (body?.plan || "founder").trim(); // solo | founder | team

  if (!name) return json({ ok: false, error: "нужно название компании" });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) return json({ ok: false, error: "email владельца некорректен" });

  // email глобально уникален в team → один email = одна компания
  const { data: taken } = await sbs.from("team").select("email,workspace_id").ilike("email", ownerEmail).maybeSingle();
  if (taken) return json({ ok: false, error: `${ownerEmail} уже привязан к воркспейсу «${taken.workspace_id}». Один email = одна компания.` });

  const id = slugId(name);
  const { error: e1 } = await sbs.from("workspaces").insert({ id, name, plan, created_by: email });
  if (e1) return json({ ok: false, error: "воркспейс не создан: " + e1.message }, 500);

  const { error: e2 } = await sbs.from("team")
    .insert({ email: ownerEmail, name: ownerName || ownerEmail.split("@")[0], role: "owner", workspace_id: id });
  if (e2) {
    await sbs.from("workspaces").delete().eq("id", id); // откат — не оставляем сироту
    return json({ ok: false, error: "владелец не добавлен: " + e2.message }, 500);
  }

  return json({ ok: true, workspaceId: id, ownerEmail, name });
});
