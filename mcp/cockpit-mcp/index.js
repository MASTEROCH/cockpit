#!/usr/bin/env node
/**
 * Cockpit MCP server
 * Даёт любому Claude (Claude Code в VS Code, Claude Desktop, и т.д.) инструменты,
 * чтобы кидать задачи в очередь «На приёмке» Cockpit. На сайте человек подтверждает.
 *
 * Конфиг через переменные окружения:
 *   COCKPIT_TOKEN  (обязателен) — персональный ключ cpk_… (генерируется на cock-pit.com → Подключить Claude)
 *   COCKPIT_URL    (необязателен) — URL проекта Supabase. По умолчанию общий проект Cockpit.
 *   COCKPIT_ANON   (необязателен) — публичный anon-ключ Supabase (безопасно встраивать).
 *   COCKPIT_SOURCE (необязателен) — метка устройства, например "claude-desktop-dima".
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOKEN = process.env.COCKPIT_TOKEN || "";
const SUPA_URL = (process.env.COCKPIT_URL || "https://tonmsmxzmycimybzywqp.supabase.co").replace(/\/+$/, "");
// anon-ключ публичный (он же в самом сайте) — безопасно встраивать как дефолт
const ANON = process.env.COCKPIT_ANON || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbm1zbXh6bXljaW15Ynp5d3FwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NTE5NDksImV4cCI6MjA5NzQyNzk0OX0.c9ER6paD6GzUS_z40b2nv3d5jwEiREy9xXASAprrldM";
const SOURCE = process.env.COCKPIT_SOURCE || "claude";

async function rpc(fn, params) {
  const res = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON, authorization: "Bearer " + ANON },
    body: JSON.stringify(params),
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
  if (data && data.error) throw new Error(data.error);
  return data;
}

const TOOLS = [
  {
    name: "cockpit_propose_task",
    description:
      "Отправить задачу в Cockpit (cock-pit.com). Задача попадает в очередь «На приёмке», " +
      "где человек её подтверждает, правит, отправляет в бэклог или отклоняет — НЕ создаётся напрямую. " +
      "Пиши задачу естественным текстом; Cockpit сам распознает исполнителя (@имя), сроки (завтра, с 22 по 28 июня), " +
      "оценку (2ч, 12ч) и приоритет (!срочно, важно). Используй, когда пользователь просит поставить/добавить задачу, " +
      "напоминание или пункт работы себе или партнёру.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Текст задачи, напр. «Лендинг @дима с 22 по 28 июня 12ч !срочно»" },
        project: { type: "string", description: "Необязательно: имя или id проекта-получателя" },
        note: { type: "string", description: "Необязательно: контекст/детали для человека при подтверждении" },
      },
      required: ["text"],
    },
  },
  {
    name: "cockpit_list_projects",
    description: "Показать проекты Cockpit (id, имя, эмодзи), чтобы выбрать project для cockpit_propose_task.",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server({ name: "cockpit", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (!TOKEN) throw new Error("Не задан COCKPIT_TOKEN. Сгенерируй ключ на cock-pit.com → «Подключить Claude».");

    if (name === "cockpit_propose_task") {
      const text = (args.text || "").trim();
      if (!text) throw new Error("Пустой текст задачи");
      const r = await rpc("cockpit_intake", {
        p_token: TOKEN, p_text: text,
        p_project: args.project || null, p_note: args.note || null, p_source: SOURCE,
      });
      return { content: [{ type: "text", text: `✅ ${r.message || "Заявка отправлена в Cockpit."} (id ${r.id})` }] };
    }

    if (name === "cockpit_list_projects") {
      const rows = await rpc("cockpit_projects", { p_token: TOKEN });
      const list = (rows || []).map((p) => `${p.emoji || "📄"} ${p.name} — ${p.id}`).join("\n") || "проектов пока нет";
      return { content: [{ type: "text", text: list }] };
    }

    throw new Error("Неизвестный инструмент: " + name);
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: "⚠ " + (e.message || String(e)) }] };
  }
});

await server.connect(new StdioServerTransport());
console.error("cockpit-mcp готов · " + SUPA_URL + "/rest/v1/rpc" + (TOKEN ? "" : " · ⚠ нет COCKPIT_TOKEN"));
