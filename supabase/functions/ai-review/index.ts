// Cockpit — AI-разбор доски (Supabase Edge Function, Deno)
// Ключ Anthropic хранится как секрет: ANTHROPIC_API_KEY (никогда в коде/репо).
// Доступ только для команды (проверка email из JWT).
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const ALLOW = ["romi4rv23@gmail.com", "dmitry.nevmer@gmail.com"];
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });

function emailFromJwt(auth: string | null): string | null {
  try {
    const tok = (auth || "").replace(/^Bearer\s+/i, "");
    const b = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(decodeURIComponent(escape(atob(b))));
    return (p.email || "").toLowerCase();
  } catch { return null; }
}

const SYSTEM = `Ты — планировщик-копилот для двух фаундеров стартапа (студия, много проектов).
Проанализируй проект и дай КОНКРЕТНЫЕ, обоснованные данными предложения по эстимации, приоритетам, срокам и распределению нагрузки. Без воды, без общих фраз.
Учитывай: перегруз участников (load против capacity), заниженные/завышенные эстимейты (spent против estimate), просроченные задачи, нарушенный порядок зависимостей, задачи без сроков.
Отвечай ТОЛЬКО валидным JSON на русском по схеме:
{
 "summary": "1-2 предложения про общее состояние",
 "risks": ["конкретный риск", "..."],
 "suggestions": [
   {"type":"reestimate","taskTitle":"<точное название>","estimate":16,"reason":"почему"},
   {"type":"reprioritize","taskTitle":"<точное название>","priority":"низкий|средний|высокий|срочно","reason":"почему"},
   {"type":"reschedule","taskTitle":"<точное название>","start":"YYYY-MM-DD","end":"YYYY-MM-DD","reason":"почему"},
   {"type":"reassign","taskTitle":"<точное название>","assignee":"<имя участника>","reason":"почему"}
 ]
}
Используй ТОЧНЫЕ названия задач и имена участников из данных. Максимум 6 самых важных suggestions. Если всё в порядке — "suggestions": [].`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const email = emailFromJwt(req.headers.get("authorization"));
    if (!email || !ALLOW.includes(email)) return json({ error: "Доступ только для команды" }, 403);

    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "ANTHROPIC_API_KEY не задан в секретах функции" }, 500);

    const { project } = await req.json();
    if (!project) return json({ error: "Нет данных проекта" }, 400);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1800,
        system: SYSTEM,
        messages: [{ role: "user", content: `Сегодня: ${project.today}\n\nДанные проекта:\n${JSON.stringify(project)}` }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return json({ error: data?.error?.message || "Ошибка Anthropic API" }, 502);

    const text: string = data?.content?.[0]?.text || "";
    const m = text.match(/\{[\s\S]*\}/);
    let parsed: any;
    try { parsed = m ? JSON.parse(m[0]) : { summary: text, risks: [], suggestions: [] }; }
    catch { parsed = { summary: text, risks: [], suggestions: [] }; }
    if (!Array.isArray(parsed.suggestions)) parsed.suggestions = [];
    if (!Array.isArray(parsed.risks)) parsed.risks = [];
    return json(parsed);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
