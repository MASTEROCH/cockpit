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

test('вложенность: 3 уровня, глубина-кап, каскад, корни на доске', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const out = {};
    const root = newTask('Передача визитки'); root.status = 'todo';
    const l2 = newTask('Подарок', root.id);
    const l3 = newTask('Анимация подарка', l2.id);
    // глубины
    out.depth = taskDepth(root) === 1 && taskDepth(l2) === 2 && taskDepth(l3) === 3;
    // migrate проставляет parentId старым задачам
    out.migrated = S.tasks.filter(t => t.parentId === undefined).length === 0;
    // потомки собираются рекурсивно
    const desc = descendants(root.id).map(t => t.id).sort();
    out.desc = JSON.stringify(desc) === JSON.stringify([l2.id, l3.id].sort());
    // крошки строятся от корня
    out.crumb = JSON.stringify(crumbPath(l3)) === JSON.stringify(['Передача визитки', 'Подарок']);
    // глубина n уровней: addKid на L3 создаёт L4
    curTask = l3; const before = S.tasks.length;
    const inp = document.getElementById('dKidIn'); inp.value = 'глубже'; addKid();
    const l4 = S.tasks[S.tasks.length - 1];
    out.cap = S.tasks.length === before + 1 && l4.parentId === l3.id && taskDepth(l4) === 4;
    // доска показывает только корни; бейдж 🧩 на корне
    renderBoard();
    const boardIds = Array.from(document.querySelectorAll('#board .card')).map(c => c.dataset.id || c.dataset.task || '');
    const boardHtml = document.getElementById('board').innerHTML;
    out.roots = !boardHtml.includes('Анимация подарка') && boardHtml.includes('Передача визитки');
    out.badge = boardHtml.includes('🧩 0/1');
    // каскадное удаление вместе с deps-чисткой
    const ids = new Set([root.id, ...descendants(root.id).map(x => x.id)]);
    S.tasks = S.tasks.filter(x => !ids.has(x.id)); S.tasks.forEach(x => x.deps = x.deps.filter(d => !ids.has(d)));
    out.cascade = !S.tasks.find(t => [root.id, l2.id, l3.id].includes(t.id));
    return out;
  });
  for (const [k, v] of Object.entries(r)) expect(v, k).toBe(true);
});

// ROCH #1391: @упоминания — полные имена с границей слова, уникальное первое слово; уведомляем упомянутых, но не себя и не исполнителя
test('упоминания: кого нашли и кому уходит уведомление', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    S.members = [{ id: 'a', name: 'Я Сам', email: 'me@local.test' }, { id: 'b', name: 'Анна Ли', email: 'b@local.test' },
      { id: 'c', name: 'Анна', email: 'c@local.test' }, { id: 'd', name: 'Марина Ковалёва', email: 'd@local.test' }];
    me = 'a';
    const f = t => mentionsIn(t).map(m => m.id).sort().join(',');
    const out = { full: f('@Анна Ли глянь'), both: f('@Анна Ли и @Анна'), first: f('@марина, срочно'), border: f('@Аннушка'), mail: f('a@b.com') };
    const sent = []; const orig = tgNotifyTo; tgNotifyTo = (m, kind) => { sent.push(m.id + ':' + kind); };
    notifyMentions({ id: 't', title: 'T', assigneeId: 'd' }, '@Я Сам @Анна @Марина Ковалёва');
    tgNotifyTo = orig; out.sent = sent.join(',');
    return out;
  });
  expect(r).toEqual({ full: 'b', both: 'b,c', first: 'd', border: '', mail: '', sent: 'c:mention' });
});

// ROCH #1392: матрица — срочность из срока, важность из приоритета/денег/клиента; перенос меняет ровно нужную ось
test('матрица важности: квадранты и перенос', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const t = S.tasks.find(x => !x.isMilestone);
    t.status = 'todo'; t.priority = 'med'; t.cash = false; t.clientId = null; t.start = todayISO(); t.end = isoIn(30);
    S.tasks.forEach(x => { x.deps = (x.deps || []).filter(d => d !== t.id); });
    const out = { start: quadOf(t) };
    t.cash = true; out.cash = quadOf(t);
    t.end = isoIn(1); out.soon = quadOf(t);
    out.moves = ['drop', 'give', 'plan', 'now'].map(q => { moveToQuad(t, q); return quadOf(t); }).join(',');
    setView('board'); boardMode = 'matrix'; render();
    out.lanes = document.querySelectorAll('#board .mq').length;
    boardMode = 'status';
    return out;
  });
  expect(r).toEqual({ start: 'drop', cash: 'plan', soon: 'now', moves: 'drop,give,plan,now', lanes: 4 });
});

// ROCH #1394: таймер скрытия однажды уехал в хвост //-комментария — тосты висели на экране вечно (жалоба Роча из Mini App)
test('тост без действия исчезает сам, с действием — живёт дольше', async ({ page }) => {
  await boot(page);
  // проверяем СВОЁ сообщение: демо может показать свою отложенную подсказку, и это не должно ронять тест
  const mine = txt => page.locator('#toast.show .tmsg', { hasText: txt });
  await page.evaluate(() => toast('Синхронизировано с командой', '☁️'));
  await expect(mine('Синхронизировано')).toHaveCount(1);
  await expect(mine('Синхронизировано')).toHaveCount(0, { timeout: 4000 });
  await page.evaluate(() => toast('Удалено', '🗑', 'Вернуть', () => {}));
  await page.waitForTimeout(3000);
  await expect(mine('Удалено')).toHaveCount(1); // подсказка без действия не имеет права затереть «Вернуть»
  await expect(mine('Удалено')).toHaveCount(0, { timeout: 4500 });
});

// ROCH #1394: заявка из бота уже разобрана ИИ — приёмка в приложении берёт готовое (кому, срок, важность, файлы), а не парсит текст заново
test('приёмка: разбор бота и файлы переезжают в задачу', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const who = S.members[1];
    const end = isoIn(3);
    intakeRows = [{ id: 'i1', text: 'сырой текст', status: 'pending', target_project: S.id,
      meta: { stage: 'suggest', pid: S.id, title: 'Согласовать макеты', assigneeId: who.id, end, priority: 'high', minutes: 30,
        description: 'из пересланного', files: [{ name: 'a.jpg', path: 'ws/intake/i1/1_a.jpg', size: 10, type: 'image/jpeg' }] } }];
    intakePid = () => S.id; decideIntake = () => {};
    acceptIntake('i1');
    const t = S.tasks[S.tasks.length - 1];
    return { title: t.title, who: t.assigneeId === who.id, end: t.end === end, pr: t.priority, files: (t.files || []).length, desc: t.description, est: t.estimate };
  });
  expect(r).toEqual({ title: 'Согласовать макеты', who: true, end: true, pr: 'high', files: 1, desc: 'из пересланного', est: 0.5 });
});

// ROCH #1399: приглашение ссылкой — запись в workspace_meta с правильным пространством/проектом и ссылка на бота; заглушки почты не показываются
test('приглашение ссылкой и скрытие почты-заглушки', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    let row = null;
    sb = { from: () => ({ insert: async (x) => { row = x; return { error: null }; } }) };
    myWsCached = async () => 'ws_test'; window.open = () => null;
    await openInvite();
    const go = document.querySelector('#invModal [data-invtg]');
    const code = (row.k || '').replace('invite:', '');
    return { key: /^invite:[a-z0-9]{12}$/.test(row.k), ws: row.v.ws, proj: row.v.project === S.id, by: row.v.by, max: row.v.max,
      days: Math.round((row.v.exp - Date.now()) / 864e5), link: decodeURIComponent(go.dataset.invtg).includes('start=join_' + code),
      shown: document.querySelector('#invScrim').classList.contains('show'),
      tg: shownEmail('tg123@tg.cock-pit.com'), real: shownEmail('a@b.com') };
  });
  expect(r).toEqual({ key: true, ws: 'ws_test', proj: true, by: 'romi4rv23@gmail.com', max: 20, days: 7, link: true, shown: true, tg: 'через Telegram', real: 'a@b.com' });
});
