// WANDO unit-инварианты в реальном Chrome (наследник погибших smoke2-5 из /tmp).
// Урок #155: постоянные тесты живут ТОЛЬКО в репо.
const { test, expect } = require('@playwright/test');
const path = require('path');

const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const BOOT = `localStorage.clear();S=migrate(seed());S.demo=false;
  reg.list=[{id:S.id,name:S.projectName,emoji:'🚀'}];reg.active=S.id;saveReg();
  localStorage.setItem(pkey(S.id),JSON.stringify(S));
  me=(S.members[0]||{}).id;localStorage.setItem('cockpit_me',me);myEmail='romi4rv23@gmail.com';cloudOn=true;isTeam=true;
  hideGate();showGate=function(){};render();`;

test.use({ viewport: { width: 1280, height: 840 } });
async function boot(page, extra = '') {
  await page.goto(FILE);
  await page.evaluate(c => { (0, eval)(c); }, BOOT + extra);
}

test('merge-синк: 6 инвариантов слияния', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const mk = (id, title, st) => ({ id, title, sectionId: 's1', start: '2026-07-01', end: '2026-07-10', status: st || 'todo', estimate: 2, spent: 0, priority: 'med', comments: [], deps: [], isMilestone: false });
    const base = { projectName: 'P', emoji: '🚀', updatedAt: 100, tasks: [mk('t1', 'Альфа'), mk('t2', 'Бета'), mk('t3', 'Гамма')], sections: [{ id: 's1', name: 'X' }], members: [], ideas: [], activity: [{ ts: 1, who: 'a', icon: '·', text: 'старт' }], notes: [] };
    const cl = o => JSON.parse(JSON.stringify(o));
    const out = {};
    // 1: правки в разных задачах
    let L = cl(base); L.updatedAt = 200; L.tasks[0].title = 'Альфа v2';
    let C = cl(base); C.updatedAt = 300; C.tasks[1].status = 'done';
    let M = mergeProj(base, L, C);
    out.both = M.tasks[0].title === 'Альфа v2' && M.tasks[1].status === 'done';
    // 2: добавление + чужая правка
    L = cl(base); L.updatedAt = 200; L.tasks.push(mk('t9', 'Новая'));
    C = cl(base); C.updatedAt = 300; C.tasks[2].title = 'Гамма упд';
    M = mergeProj(base, L, C);
    out.add = M.tasks.length === 4 && !!M.tasks.find(t => t.id === 't9') && M.tasks.find(t => t.id === 't3').title === 'Гамма упд';
    // 3: конфликт одной задачи — новее побеждает, комменты объединяются
    L = cl(base); L.updatedAt = 400; L.tasks[0].title = 'от L'; L.tasks[0].comments = [{ ts: 10, author: 'A', text: 'x' }];
    C = cl(base); C.updatedAt = 300; C.tasks[0].title = 'от C'; C.tasks[0].comments = [{ ts: 20, author: 'B', text: 'y' }];
    M = mergeProj(base, L, C);
    out.conflict = M.tasks[0].title === 'от L' && M.tasks[0].comments.length === 2;
    // 4: правка бьёт удаление, чистое удаление проходит
    L = cl(base); L.updatedAt = 400; L.tasks = L.tasks.filter(t => t.id !== 't1' && t.id !== 't2');
    C = cl(base); C.updatedAt = 300; C.tasks[0].title = 'Альфа спасена';
    M = mergeProj(base, L, C);
    out.del = !!M.tasks.find(t => t.id === 't1' && t.title === 'Альфа спасена') && !M.tasks.find(t => t.id === 't2');
    // 5: activity union без дублей
    L = cl(base); L.updatedAt = 400; L.activity.unshift({ ts: 50, who: 'A', icon: '✅', text: 'x' });
    C = cl(base); C.updatedAt = 300; C.activity.unshift({ ts: 60, who: 'B', icon: '💬', text: 'y' });
    M = mergeProj(base, L, C);
    out.act = M.activity.length === 3 && M.activity[0].ts === 60;
    // 6: сходимость
    const M2 = mergeProj(base, C, L);
    out.conv = JSON.stringify(M.tasks.map(t => t.id).sort()) === JSON.stringify(M2.tasks.map(t => t.id).sort());
    return out;
  });
  for (const [k, v] of Object.entries(r)) expect(v, k).toBe(true);
});

test('наставник: приоритет правил и кулдауны', async ({ page }) => {
  await boot(page, `S.tasks.forEach(t=>{if(!t.isMilestone){t.status='todo';t.assigneeId=me;t.end=todayISO();t.estimate=3;t.priority='med';t.cash=false;}});setView('now');`);
  await expect(page.locator('.mentorcard [data-ma="overload"]')).toBeVisible(); // перегруз первым
  await page.click('.mentorcard [data-ma="overload"]');
  const sum = await page.evaluate(() => S.tasks.filter(x => !x.isMilestone && x.status !== 'done' && x.end <= todayISO()).reduce((s, x) => s + (+x.estimate || 0), 0));
  expect(sum).toBeLessThanOrEqual(8);
  // дневной лимит: вторая подсказка молчит
  await page.evaluate(() => { S.tasks.forEach(t => { if (!t.isMilestone) t.status = 'progress'; }); render(); });
  await expect(page.locator('.mentorcard')).toHaveCount(0);
  // сброс дня → WIP-фокус
  await page.evaluate(() => { localStorage.removeItem('cockpit_mentor_day'); render(); });
  await expect(page.locator('.mentorcard [data-ma="focus"]')).toBeVisible();
  await page.click('.mentorcard [data-ma="focus"]');
  expect(await page.evaluate(() => S.tasks.filter(x => !x.isMilestone && x.status === 'progress').length)).toBe(2);
});

test('приёмка: никаких тихих дефолтов + optgroup компаний', async ({ page }) => {
  await boot(page, `intakeReady=true;
    intakeRows=[{id:'q1',text:'задача без цели завтра 2ч',by_name:'QA',by_email:'q@q.q',source:'telegram',created_at:new Date().toISOString(),target_project:null}];
    setView('intake');`);
  expect(await page.evaluate(() => document.getElementById('iproj_q1').value)).toBe('');
  const before = await page.evaluate(() => S.tasks.length);
  await page.evaluate(() => acceptIntake('q1', false));
  expect(await page.evaluate(() => S.tasks.length)).toBe(before); // без проекта не создаёт
  await page.evaluate(() => { document.getElementById('iproj_q1').value = S.id; acceptIntake('q1', false); });
  expect(await page.evaluate(() => S.tasks.length)).toBe(before + 1);
  const sel = await page.evaluate(() => { reg.list.push({ id: 'pC', name: 'Корп', emoji: '🏢' }, { id: 'pK', name: 'Дочка', emoji: '📄', parentId: 'pC' }); return projectSelectHTML('x1', null); });
  expect(sel).toContain('<optgroup label="🏢 Корп">');
  expect(sel).toContain('value="" selected');
});

test('деньги: markDone→история→undo, исходы, пульс, отчёт', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const out = {};
    const t = S.tasks[0]; t.status = 'todo'; t.cash = true; t.amount = 1500;
    const un = markDone(S.id, t.id);
    out.act = S.activity[0].icon === '✅';
    un(); out.undo = t.status === 'todo';
    t.status = 'done'; t.cashOutcome = 'yes'; t.cashOutcomeTs = Date.now();
    S.tasks[1].cash = true; S.tasks[1].status = 'todo'; S.tasks[1].amount = 500;
    setView('now');
    const cp = (document.querySelector('.cashpulse') || {}).textContent || '';
    out.pulse = cp.includes('500') && cp.includes('1.5k');
    out.report = reportText(empireReport()).includes('всего ~$500');
    out.why = whyNext(S.tasks[1], '').join(' ').includes('~$500');
    return out;
  });
  for (const [k, v] of Object.entries(r)) expect(v, k).toBe(true);
});

test('утилиты: isGoalLike, shareCapture, personScores-склейка, экспорт', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const out = {};
    out.goal = isGoalLike('запустить лендинг с оплатой') === true && isGoalLike('позвонить дизайнеру завтра в 15:00') === false && isGoalLike('запустить сайт') === false;
    out.share = shareCapture('?title=%D0%A1%D1%82%D0%B0%D1%82%D1%8C%D1%8F&url=https%3A%2F%2Fx.com') === true && shareCapture('?x=1') === false;
    S.members[0].email = ''; S.members[0].points = 3;
    localStorage.setItem(pkey(S.id), JSON.stringify(S));
    localStorage.setItem(pkey('p2'), JSON.stringify({ id: 'p2', projectName: 'X', emoji: '🎯', tasks: [], sections: [{ id: 's1', name: 'x' }], ideas: [], members: [{ id: 'm1', name: S.members[0].name, email: 'romi4rv23@gmail.com', points: 5, color: '#888' }] }));
    reg.list.push({ id: 'p2', name: 'X', emoji: '🎯' });
    const ps = personScores().filter(x => x.name === S.members[0].name);
    out.dedupe = ps.length === 1 && ps[0].points === 8;
    let md = ''; const B = window.Blob; window.Blob = class { constructor(p) { md = p.join(''); } };
    HTMLAnchorElement.prototype.click = function () {};
    exportMd(); window.Blob = B;
    out.md = md.includes('## ') && /- \[[x ]\]/.test(md);
    try { tickKpis(); out.tick = true; } catch (e) { out.tick = false; }
    return out;
  });
  for (const [k, v] of Object.entries(r)) expect(v, k).toBe(true);
});
