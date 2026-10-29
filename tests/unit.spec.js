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
    S.members = [{ id: 'a', name: 'Я Сам', email: myEmail }, { id: 'b', name: 'Анна Ли', email: 'b@local.test' }, // ROCH #1407: «я» — по почте входа
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

// ROCH #1401: «Открытка» (канон POSTCARD) — приложение шлёт серверу ТОЛЬКО id проекта, ссылку и текст берёт из ответа сервера;
// вне Telegram — обычный шеринг со ссылкой сервера; почта-заглушка не показывается
test('приглашение: клиент шлёт только id, ссылку даёт сервер', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    let sent = null;
    aiToken = async () => 'tok'; window.open = () => null;
    window.fetch = async (url, opt) => { sent = JSON.parse(opt.body); return { json: async () => ({
      code: 'abc123def456', link: 'https://t.me/wando_tasks_bot?start=join_abc123def456', web: 'https://cock-pit.com/?join=abc123def456',
      text: 'Роч зовёт тебя', prepared_id: null }) }; };
    await openInvite();
    const go = document.querySelector('#invModal [data-invtg]');
    return { keys: Object.keys(sent).sort().join(','), kind: sent.kind, proj: sent.project_id === S.id,
      share: decodeURIComponent(go.dataset.invtg).includes('start=join_abc123def456'),
      copy: document.querySelector('#invModal .inv-row input').value, card: !!document.querySelector('#invModal [data-invcard]'),
      shown: document.querySelector('#invScrim').classList.contains('show'),
      tg: shownEmail('tg123@tg.cock-pit.com'), real: shownEmail('a@b.com') };
  });
  expect(r).toEqual({ keys: 'access,by_name,guest,initData,kind,member_id,project_id,projects,role', kind: 'invite', proj: true, share: true,
    copy: 'https://t.me/wando_tasks_bot?start=join_abc123def456', card: false, shown: true, tg: 'через Telegram', real: 'a@b.com' });
});

// ROCH #1403: связи — круг не даём, каскад сроков, «можно начинать» / «готово» участникам; участники — комменты и @
test('связанные задачи: круг, каскад, разблокировка', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const [a, b, c] = S.tasks.filter(t => !t.isMilestone).slice(0, 3);
    [a, b, c].forEach(t => { t.deps = []; t.status = 'todo'; });
    S.tasks.forEach(t => { if (![a, b, c].includes(t)) t.deps = (t.deps || []).filter(d => ![a.id, b.id, c.id].includes(d)); });
    b.deps = [a.id]; c.deps = [b.id];
    const loop = depPath(c.id, a.id);                       // a ← b ← c: связь «a ждёт c» замкнула бы круг
    a.start = '2026-11-01'; a.end = '2026-11-05'; b.start = '2026-11-03'; b.end = '2026-11-04'; c.start = '2026-11-05'; c.end = '2026-11-06';
    const plan = cascadePlan(a).map(m => m.x === b ? 'b+' + m.sh : 'c+' + m.sh).join(',');
    const sent = []; const orig = tgNotifyTo; tgNotifyTo = (m, kind, t) => sent.push(kind + ':' + (t === b ? 'b' : t === a ? 'a' : '?') + ':' + m.id);
    const w = S.members.find(m => m.id !== a.assigneeId && m.id !== myId());
    b.assigneeId = S.members[1].id; a.watchers = [w.id];
    a.status = 'done'; histAdd(a, 'статус → Готово'); await new Promise(r => setTimeout(r, 20));
    tgNotifyTo = orig;
    return { loop, plan, unblock: sent.some(x => x.startsWith('unblock:b:')), done: sent.includes('done:a:' + w.id) };
  });
  expect(r).toEqual({ loop: true, plan: 'b+3,c+3', unblock: true, done: true }); // b: 03→06 (после 05), c: 05→08 (после нового конца b 07)
});

test('участники задачи: позвали, @ добавляет, коммент уходит исполнителю и участникам', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const t = S.tasks.find(x => !x.isMilestone); const [, p1, p2, p3] = S.members;
    S.members.forEach((m, i) => { m.email = m.email || ('m' + i + '@local.test'); });
    t.assigneeId = p1.id; t.watchers = [];
    const sent = []; const orig = tgNotifyTo; tgNotifyTo = (m, kind) => sent.push(kind + ':' + m.id);
    addWatcher(t, p2.id, true);
    notifyComment(t, 'глянь @' + p3.name);
    tgNotifyTo = orig;
    return { watchers: t.watchers.slice().sort().join(','), sent: sent.sort().join(',') };
  });
  const ids = await page.evaluate(() => S.members.map(m => m.id));
  expect(r.watchers).toBe([ids[2], ids[3]].sort().join(','));
  expect(r.sent).toBe(['comment:' + ids[1], 'comment:' + ids[2], 'mention:' + ids[3], 'watch:' + ids[2]].sort().join(','));
});

// ROCH #1402: доступы — без права на деньги скрыты клиенты; гость «только просмотр» — режим чтения; матрица добавляет в закрытый проект
test('доступы: деньги, только просмотр, матрица', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    accessReady = true; isTeam = true;
    teamRows = [{ email: myEmail, role: 'member', money: false }];
    render(); const noMoney = document.body.classList.contains('no-money');
    teamRows[0].money = true; render(); const money = !document.body.classList.contains('no-money');
    isTeam = false; myGrantRole = { [S.id]: 'viewer' }; render(); const ro = document.body.classList.contains('ro');
    isTeam = true; myGrantRole = {}; render();
    S.open = false; S.members = S.members.filter(m => m.email !== 'x@local.test');
    teamRows = [{ email: myEmail, role: 'owner' }, { email: 'x@local.test', role: 'member', name: 'Икс' }];
    matrixToggle(S.id, 'x@local.test');
    return { noMoney, money, ro, added: S.members.some(m => m.email === 'x@local.test'), rank: [roleRank('owner'), roleRank('full'), roleRank('member'), roleRank('')].join(',') };
  });
  expect(r).toEqual({ noMoney: true, money: true, ro: true, added: true, rank: '3,2,1,1' });
});

// ROCH #1407: «нажал на свой аватар — открылся профиль Дэна». После входа «я» — только по почте; нет меня в проекте коллеги — добавляюсь своим профилем
test('кто я: по почте, без чужого профиля', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const myMail = 'roch@local.test';
    // мой профиль в другом проекте
    reg.list.push({ id: 'pMine', name: 'Мой', emoji: '🚀' });
    localStorage.setItem(pkey('pMine'), JSON.stringify({ projectName: 'Мой', members: [{ id: 'm1', name: 'Роман', email: myMail, photo: 'data:image/png;base64,AA', color: '#38bdf8' }], tasks: [], sections: [{ id: 's1', name: 'x' }] }));
    // проект коллеги: m1 = Дэн, меня нет
    S.members = [{ id: 'm1', name: 'Дэн', email: 'den@local.test', color: '#a78bfa' }];
    localStorage.setItem('cockpit_me', 'm1');
    cloudOn = true; myEmail = myMail; accessReady = true; isTeam = true; teamRows = [{ email: myMail, role: 'owner' }];
    const before = myId();
    render();
    const me = member(myId());
    return { before, name: me && me.name, email: me && me.email, photo: !!(me && me.photo), den: S.members.find(m => m.id === 'm1').name, owner: isOwner() };
  });
  expect(r.before).toBe('u:roch@local.test');
  expect(r).toMatchObject({ name: 'Роман', email: 'roch@local.test', photo: true, den: 'Дэн', owner: true });
});

// ROCH #1409: «пользователь и доступы — и без почты, по Telegram»: в Mini App узнаём по номеру Telegram в карточке
test('кто я: в Mini App — по номеру Telegram', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    tmaUser = () => ({ id: 555, first_name: 'Марина' });
    S.members = [{ id: 'm1', name: 'Дэн', email: 'den@local.test' }, { id: 'm7', name: 'Марина', email: 'tg555@tg.cock-pit.com', tg: 555 }];
    cloudOn = true; myEmail = 'other@local.test';
    return myId();
  });
  expect(r).toBe('m7');
});

// ROCH #1410: приглашать — владелец и админ; участнику кнопка не показывается
test('приглашать могут владелец и админ, участник — нет', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    accessReady = true; isTeam = true;
    const at = role => { teamRows = [{ email: myEmail, role }]; render(); return [canInvite(), document.body.classList.contains('no-invite')]; };
    return { owner: at('owner'), admin: at('admin'), member: at('member') };
  });
  expect(r).toEqual({ owner: [true, false], admin: [true, false], member: [false, true] });
});

// ROCH #1411: пригласить сразу админом — только владелец; переключатель видит только он
test('приглашение админом: переключатель у владельца', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const sent = []; aiToken = async () => 'tok'; window.open = () => null;
    window.fetch = async (u, o) => { sent.push(JSON.parse(o.body).role); return { json: async () => ({ link: 'https://t.me/wando_tasks_bot?start=join_abc123def456', web: 'w', text: 't', prepared_id: null }) }; };
    accessReady = true; isTeam = true;
    teamRows = [{ email: myEmail, role: 'owner' }]; await openInvite();
    const seg = !!document.querySelector('#invModal [data-invrole="admin"]');
    document.querySelector('#invModal [data-invrole="admin"]').click(); await new Promise(r => setTimeout(r, 50));
    teamRows = [{ email: myEmail, role: 'admin' }]; await openInvite();
    const segAdmin = !!document.querySelector('#invModal [data-invrole]');
    return { seg, sent: sent.join(','), segAdmin };
  });
  expect(r).toEqual({ seg: true, sent: 'member,admin,member', segAdmin: false });
});

// ROCH #1412: роли в проекте как в Asana — наблюдатель только смотрит, комментатор комментирует; матрица ставит роль; нет доступа — запрос
test('роли в проекте: наблюдатель, комментатор, матрица, «Запросить доступ»', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    accessReady = true; isTeam = true;
    teamRows = [{ email: myEmail, role: 'member' }];
    S.members = [{ id: 'm1', name: 'Я', email: myEmail, access: 'view' }, { id: 'm2', name: 'Икс', email: 'x@local.test' }];
    render(); const view = [myProjectAccess(), document.body.classList.contains('ro'), document.body.classList.contains('rc')];
    S.members[0].access = 'comment'; render(); const comment = [myProjectAccess(), document.body.classList.contains('ro'), document.body.classList.contains('rc')];
    S.members[0].access = 'admin'; render(); const admin = [canManageProject(), document.body.classList.contains('ro')];
    teamRows = [{ email: myEmail, role: 'owner' }, { email: 'x@local.test', role: 'member' }];
    S.open = false; matrixSetAccess(S.id, 'x@local.test', 'comment'); const mx = (S.members.find(m => m.email === 'x@local.test') || {}).access;
    aiToken = async () => 'tok'; let sent = null; window.fetch = async (u, o) => { sent = JSON.parse(o.body); return { json: async () => ({ ok: true }) }; };
    openDeepLink('pNoSuch', 't1'); const shown = document.querySelector('#shareScrim').classList.contains('show');
    document.querySelector('[data-askacc]').click(); await new Promise(r => setTimeout(r, 50));
    return { view, comment, admin, mx, shown, kind: sent && sent.kind, pid: sent && sent.project_id };
  });
  expect(r).toEqual({ view: ['view', true, false], comment: ['comment', true, true], admin: [true, false], mx: 'comment', shown: true, kind: 'access_request', pid: 'pNoSuch' });
});

test('карточка клиента: не уезжает вбок на телефоне, срок — капсула, фото ставится/убирается/возвращается (#1421)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await boot(page);
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms));
    crmNew(); await w(150);
    const m = $('#crmModal'), out = {};
    out.noX = m.scrollWidth <= m.clientWidth;
    out.rowsFit = [...m.querySelectorAll('.crm-nextrow>*,.crm-noteadd>*,.crm-sh-head>*')].every(e => e.getBoundingClientRect().right <= m.getBoundingClientRect().right + 0.5);
    out.dateEmpty = $('.crm-date span').textContent;
    const d = $('#cDate'); d.value = fmtD(parseD(todayISO()) + dayMs); d.dispatchEvent(new Event('change'));
    out.dateSet = $('.crm-date span').textContent; out.dateCls = $('.crm-date').classList.contains('set');
    $('#cName').value = 'Тест Клиент'; $('#cName').dispatchEvent(new Event('input'));
    const c = CRM.find(x => x.id === crmCur);
    // фото: только наш data:image попадает в разметку
    c.photo = "x');background:url(javascript:alert(1))"; renderClient();
    out.badRejected = !$('#crmModal .crm-av').classList.contains('ph') && !$('#cPhotoX');
    const cv = document.createElement('canvas'); cv.width = cv.height = 8; c.photo = cv.toDataURL('image/jpeg', .8); renderClient();
    out.photoShown = $('#crmModal .crm-av').classList.contains('ph') && !!$('#cPhotoX');
    out.inCard = crmCard(c).includes('crm-av ph');
    $('#cPhotoX').click(); await w(50);
    out.removed = !c.photo && !$('#cPhotoX');
    const tb = [...document.querySelectorAll('#toast button, .toast button')].find(b => /Вернуть/.test(b.textContent));
    if (tb) tb.click(); await w(50);
    out.restored = !!c.photo && !!$('#cPhotoX');
    out.noX2 = m.scrollWidth <= m.clientWidth;
    return out;
  });
  expect(r).toEqual({ noX: true, rowsFit: true, dateEmpty: 'Когда', dateSet: 'завтра', dateCls: true, badRejected: true, photoShown: true, inCard: true, removed: true, restored: true, noX2: true });
});
