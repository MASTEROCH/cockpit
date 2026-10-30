// WANDO · запись проекта без потерь для серверных функций (ROCH #1423).
// Было: «прочитал data целиком → поменял → записал целиком» — правка, сделанная командой между чтением и записью, терялась.
// Стало: чтение через projSelect запоминает rev и копию data; saveProjectData пишет «если rev не изменился»,
// а при конфликте забирает свежую строку и сливает 3-way (та же логика, что mergeProj в приложении) и пишет снова.
// Строка, прочитанная мимо projSelect, пишется как раньше (без проверки) — поведение не хуже прежнего.
// Папка _shared не деплоится как функция — её импортируют tg-bot, tma-auth, api, task-share, gh-hook.
// deno-lint-ignore-file no-explicit-any

const orig = new WeakMap<object, { base: any; rev: number | null }>();
const clone = (x: any) => JSON.parse(JSON.stringify(x ?? null));

function track(row: any) {
  if (row && row.data && typeof row.data === "object") orig.set(row.data, { base: clone(row.data), rev: row.rev ?? null });
  return row;
}

/** sb.from("projects").select(cols) — то же самое, но строки запоминают rev и исходную data для безопасной записи */
export function projSelect(sb: any, cols: string): any {
  const c = cols === "*" || /(^|,)\s*rev\s*(,|$)/.test(cols) || !/(^|,)\s*data\s*(,|$)/.test(cols) ? cols : cols + ",rev";
  const wrap = (b: any): any => new Proxy(b, {
    get(t, k) {
      if (k === "then") {
        return (res: any, rej: any) => t.then((r: any) => {
          if (r?.data) (Array.isArray(r.data) ? r.data : [r.data]).forEach(track);
          return r;
        }).then(res, rej);
      }
      const v = t[k];
      if (typeof v !== "function") return v;
      return (...a: any[]) => { const out = v.apply(t, a); return out && typeof out.then === "function" ? wrap(out) : out; };
    },
  });
  return wrap(sb.from("projects").select(c));
}

const byId = (a: any[]) => { const m: Record<string, any> = {}; (a ?? []).forEach((x) => { if (x && x.id) m[x.id] = x; }); return m; };
function mergeList(bA: any[], lA: any[], cA: any[], lNewer: boolean) {
  const b = byId(bA), l = byId(lA), c = byId(cA), js = (x: any) => JSON.stringify(x);
  const out: any[] = [];
  for (const id of new Set([...Object.keys(l), ...Object.keys(c)])) {
    const bx = b[id], lx = l[id], cx = c[id];
    if (lx && cx) {
      if (js(lx) === js(cx)) { out.push(lx); continue; }
      if (bx && js(lx) === js(bx)) { out.push(cx); continue; }
      if (bx && js(cx) === js(bx)) { out.push(lx); continue; }
      const win = lNewer ? lx : cx;
      if (lx.comments || cx.comments) {
        const seen: Record<string, 1> = {}, cm: any[] = [];
        [...(lx.comments ?? []), ...(cx.comments ?? [])].forEach((x: any) => { const k = (x.ts ?? 0) + "|" + (x.author ?? "") + "|" + (x.text ?? ""); if (!seen[k]) { seen[k] = 1; cm.push(x); } });
        cm.sort((a, z) => (a.ts ?? 0) - (z.ts ?? 0)); win.comments = cm;
      }
      out.push(win); continue;
    }
    const x = lx || cx;
    if (!bx) { out.push(x); continue; }          // новое с одной стороны
    if (js(x) !== js(bx)) out.push(x);            // правка бьёт удаление
  }
  const order = ((lNewer ? lA : cA) ?? []).map((x: any) => x.id);
  out.sort((a, z) => { const ia = order.indexOf(a.id), iz = order.indexOf(z.id); return (ia < 0 ? 1e9 : ia) - (iz < 0 ? 1e9 : iz); });
  return out;
}
export function mergeProj(base: any, local: any, cloud: any) {
  base = base ?? {};
  const lNewer = (local.updatedAt ?? 0) >= (cloud.updatedAt ?? 0);
  const M = clone(lNewer ? local : cloud);
  for (const k of ["tasks", "sections", "members", "ideas"]) M[k] = mergeList(base[k], local[k], cloud[k], lNewer);
  const uni = (a: any[], b: any[], cap?: number) => {
    const seen: Record<string, 1> = {}, o: any[] = [];
    [...(a ?? []), ...(b ?? [])].forEach((x: any) => { const k = (x.ts ?? 0) + "|" + (x.text ?? ""); if (!seen[k]) { seen[k] = 1; o.push(x); } });
    o.sort((x, y) => (y.ts ?? 0) - (x.ts ?? 0)); return cap ? o.slice(0, cap) : o;
  };
  M.activity = uni(local.activity, cloud.activity, 150);
  M.notes = uni(local.notes, cloud.notes);
  M.updatedAt = Math.max(local.updatedAt ?? 0, cloud.updatedAt ?? 0);
  return M;
}

/** записать data проекта: с проверкой rev и слиянием при конфликте, если строку читали через projSelect */
export async function saveProjectData(sb: any, id: string, data: any): Promise<{ error?: any }> {
  const o = orig.get(data);
  const now = () => new Date().toISOString();
  if (!o || o.rev == null) {
    const { error } = await sb.from("projects").update({ data, updated_at: now(), updated_by: null }).eq("id", id);
    return { error };
  }
  let base = o.base, mine = data, rev = o.rev;
  for (let i = 0; i < 4; i++) {
    const { data: up, error } = await sb.from("projects").update({ data: mine, updated_at: now(), updated_by: null }).eq("id", id).eq("rev", rev).select("rev");
    if (error) return { error };
    if (up?.length) { orig.set(mine, { base: clone(mine), rev: up[0].rev }); return {}; }
    const { data: cur } = await sb.from("projects").select("data,rev").eq("id", id).maybeSingle();
    if (!cur) return { error: { message: "Проект не найден" } };
    mine = mergeProj(base, mine, cur.data); base = cur.data; rev = cur.rev;
  }
  return { error: { message: "Не удалось слить правки — попробуй ещё раз" } };
}
