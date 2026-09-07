// Умная неделя: расклад задач всех проектов по дням. Облако выключено —
// проверяем локальный движок (он же фолбэк, когда Вандо недоступен).
const { test, expect } = require('@playwright/test');
const path = require('path');

const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const BOOT = `localStorage.clear();S=migrate(seed());S.demo=false;
  reg.list=[{id:S.id,name:S.projectName,emoji:'🚀'}];reg.active=S.id;saveReg();
  localStorage.setItem(pkey(S.id),JSON.stringify(S));
  me=(S.members[0]||{}).id;localStorage.setItem('cockpit_me',me);myEmail='romi4rv23@gmail.com';cloudOn=false;
  hideGate();showGate=function(){};render();`;

async function boot(page, extra = '') {
  await page.goto(FILE);
  await page.evaluate(c => { (0, eval)(c); }, BOOT + extra);
}

const MINE = `S.tasks.forEach(t=>{if(!t.isMilestone){t.assigneeId=me;t.status='todo';}});setView('week');`;

test('расклад открывается и не перегружает день сверх ёмкости', async ({ page }) => {
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await boot(page, MINE);
  await page.click('#wSmart');
  await expect(page.locator('#wplanScrim')).toHaveClass(/show/);
  expect(await page.locator('#wplanModal .wpday')).toHaveCount(7);
  expect(await page.locator('#wplanModal .wprow').count()).toBeGreaterThan(0);
  // ни один день не берёт больше дневной ёмкости — иначе план врёт
  const over = await page.evaluate(() =>
    wplan.days.filter(d => wpHours(d) > wplan.daily + 0.01));
  expect(over).toEqual([]);
  expect(errs).toEqual([]);
});

test('крупная задача занимает несколько дней, а не валится на дедлайн', async ({ page }) => {
  await boot(page, MINE);
  await page.click('#wSmart');
  const spans = await page.evaluate(() => wplan.plan
    .filter(x => (wplan.byId[x.id].t.estimate || 0) > wplan.daily)
    .map(x => Object.keys(x.load).length));
  spans.forEach(n => expect(n).toBeGreaterThan(1));
});

test('снятая галка освобождает ёмкость дня и не едет в задачи', async ({ page }) => {
  await boot(page, MINE);
  await page.click('#wSmart');
  const row = page.locator('#wplanModal .wprow').first();
  const id = await row.getAttribute('data-id');
  const before = await page.evaluate(() => wpHours(wplan.plan[0].day));
  await row.click();
  const after = await page.evaluate(() => wpHours(wplan.plan[0].day));
  expect(after).toBeLessThan(before);
  await page.click('#wpApply');
  const [pid, tid] = id.split('|');
  const day = await page.evaluate(([pid, tid]) => {
    const d = pid === S.id ? S : loadProj(pid);
    return (d.tasks.find(t => t.id === tid) || {}).end;
  }, [pid, tid]);
  const planned = await page.evaluate(i => (wplan.plan.find(x => x.id === i) || {}).day, id);
  expect(day).not.toBe(planned); // выключенную задачу не трогаем
});

test('применение переносит сроки и откатывается через «Отменить»', async ({ page }) => {
  await boot(page, MINE);
  const before = await page.evaluate(() => S.tasks.map(t => t.end));
  await page.click('#wSmart');
  await page.click('#wpApply');
  await expect(page.locator('#wplanScrim')).not.toHaveClass(/show/);
  const after = await page.evaluate(() => S.tasks.map(t => t.end));
  expect(after).not.toEqual(before);
  await page.click('#toast .tact');
  const back = await page.evaluate(() => S.tasks.map(t => t.end));
  expect(back).toEqual(before);
});
