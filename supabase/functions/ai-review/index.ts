// WANDO — ИИ-слой (Supabase Edge Function, Deno): разбор доски, план, ЧАТ с Вандо
// Ключ Anthropic хранится как секрет: ANTHROPIC_API_KEY (никогда в коде/репо).
// Доступ только для команды: таблица team (фолбэк — старый список).
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOW = ["romi4rv23@gmail.com", "dmitry.nevmer@gmail.com"];
const sbs = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
async function allowed(email: string): Promise<boolean> {
  try {
    const { data, error } = await sbs.from("team").select("email").ilike("email", email).maybeSingle();
    if (error) throw error;
    return !!data;
  } catch { return ALLOW.includes(email); }
}
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
Используй ТОЧНЫЕ названия задач и имена участников из данных. Максимум 6 самых важных suggestions. Если всё в порядке — "suggestions": [].
ВАЖНО: верни ТОЛЬКО сам JSON-объект, без markdown, без \`\`\` и без любого текста до или после.`;

const SYSTEM_PLAN = `Ты — опытный продакт-лид. По цели проекта составь рабочий план из 6–12 атомарных задач.
Учитывай команду (распределяй нагрузку), сегодняшнюю дату (ставь реалистичные сроки и последовательность с учётом зависимостей), и не дублируй уже существующие задачи.
Названия — с глаголом («Сверстать…», «Настроить…»). Одну ключевую задачу назови с «релиз» или «запуск».
Отвечай ТОЛЬКО валидным JSON на русском по схеме:
{"tasks":[
  {"title":"<название>","estimate":<часы:number>,"priority":"low|med|high|urgent","assignee":"<имя из команды или null>","start":"YYYY-MM-DD","end":"YYYY-MM-DD","note":"<зачем задача, 1 фраза>"}
]}
Даты — относительно сегодня, рабочая последовательность (зависимые позже). assignee — точное имя из команды или null.
ВАЖНО: верни ТОЛЬКО JSON-объект, без markdown и без текста до/после.`;

const SYSTEM_CHAT = `Ты — Вандо, живой ум WANDO («что делать») и супер-проджект-менеджер команды фаундеров. Характер: умный друг-операционщик уровня лучшего chief of staff — прямой, тёплый, без воды и корпоративщины. На «ты».
Тебе дают: состояние проектов (задачи, сроки, люди, загрузка), статистику использования функций WANDO и вопрос человека.
Что ты умеешь:
• отвечать на любые вопросы по проектам: что горит, кто перегружен, что делать дальше и ПОЧЕМУ — всегда опирайся на данные, называй точные задачи и имена;
• помогать думать: разложить хаос, приоритизировать, предложить план, сформулировать задачу;
• улучшать сам инструмент: по статистике использования замечай, чем пользуются, а чем нет, и предлагай что упростить/убрать/добавить;
• поддерживать здоровую культуру: замечать перекосы («всё на одном человеке»), предлагать разгрузку, хвалить за реальные результаты.
Формат: коротко и по делу, обычно 2-6 предложений или компактный список. Без markdown-заголовков. Эмодзи умеренно. Если данных не хватает — скажи, чего не хватает, не выдумывай.`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const email = emailFromJwt(req.headers.get("authorization"));
    if (!email || !(await allowed(email))) return json({ error: "Доступ только для команды" }, 403);

    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "ANTHROPIC_API_KEY не задан в секретах функции" }, 500);

    const body = await req.json();
    const { project, mode, goal, messages, context } = body;

    // ----- режим ЧАТА с Вандо (маскот на сайте) -----
    if (mode === "chat") {
      const hist = (Array.isArray(messages) ? messages : []).slice(-14)
        .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
      if (!hist.length || hist[hist.length - 1].role !== "user") return json({ error: "Нет вопроса" }, 400);
      hist[0] = { role: "user", content: `КОНТЕКСТ (не показывай его сырым, используй для ответов):\n${JSON.stringify(context ?? {}).slice(0, 60000)}\n\n---\n${hist[0].content}` };
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1200, system: SYSTEM_CHAT, messages: hist }),
      });
      const data = await r.json();
      if (!r.ok) return json({ error: data?.error?.message || "Ошибка Anthropic API" }, 502);
      return json({ text: String(data?.content?.[0]?.text ?? "").trim() });
    }

    if (!project) return json({ error: "Нет данных проекта" }, 400);

    // ----- режим генерации ПЛАНА: цель → список задач -----
    if (mode === "plan") {
      const team = (project.members || []).map((m: any) => m.name).join(", ") || "—";
      const existing = (project.tasks || []).map((t: any) => t.title).slice(0, 40).join("; ") || "пока нет";
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 2200, system: SYSTEM_PLAN,
          messages: [{ role: "user", content:
            `Сегодня: ${project.today}\nПроект: ${project.project}\nКоманда: ${team}\nУже есть задачи (НЕ дублируй): ${existing}\n\nЦель:\n${goal || ""}` }],
        }),
      });
      const data = await r.json();
      if (!r.ok) return json({ error: data?.error?.message || "Ошибка Anthropic API" }, 502);
      const text: string = (data?.content?.[0]?.text || "").replace(/```json|```/g, "").trim();
      const m = text.match(/\{[\s\S]*\}/);
      let parsed: any = { tasks: [] };
      try { parsed = m ? JSON.parse(m[0]) : { tasks: [] }; } catch { parsed = { tasks: [] }; }
      if (!Array.isArray(parsed.tasks)) parsed.tasks = [];
      return json({ tasks: parsed.tasks });
    }

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

    const text: string = (data?.content?.[0]?.text || "").replace(/```json|```/g, "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    let parsed: any;
    try { parsed = m ? JSON.parse(m[0]) : { summary: text, risks: [], suggestions: [] }; }
    catch { parsed = { summary: "", risks: [], suggestions: [] }; }
    if (!Array.isArray(parsed.suggestions)) parsed.suggestions = [];
    if (!Array.isArray(parsed.risks)) parsed.risks = [];
    return json(parsed);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
