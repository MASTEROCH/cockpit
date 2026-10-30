// WANDO · синхронизация без потерь и права в точке сохранения (ROCH #1423).
// Макет Supabase ведёт projects.rev так же, как триггер projects_bump_rev: +1 на каждое обновление.
const { test, expect } = require('@playwright/test');
const path = require('path');

const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const BOOT = `localStorage.clear();S=migrate(seed());S.demo=false;
  reg.list=[{id:S.id,name:S.projectName,emoji:'🚀'}];reg.active=S.id;saveReg();
  localStorage.setItem(pkey(S.id),JSON.stringify(S));
  me='u-me';myEmail='romi4rv23@gmail.com';cloudOn=true;isTeam=true;accessLegacy=true;
  hideGate();showGate=function(){};render();
  window.mockSb=function(db){
    const rows=db.rows;
    const run=st=>{
      const match=r=>st.f.every(([k,v,op])=>op==='in'?v.includes(r[k]):String(r[k])===String(v));
      if(st.op==='insert'){const p=st.p;if(rows[p.id])return {data:null,error:{message:'duplicate key value',code:'23505'}};
        rows[p.id]=Object.assign({},JSON.parse(JSON.stringify(p)),{rev:1});db.writes.push(['insert',p.id]);
        const o={rev:1};return {data:st.single?o:[o],error:null};}
      if(st.op==='update'){if(db.deny)return {data:[],error:null};
        const hit=Object.values(rows).filter(match);hit.forEach(r=>{Object.assign(r,JSON.parse(JSON.stringify(st.p)));r.rev=(r.rev||0)+1;db.writes.push(['update',r.id,r.rev]);});
        const o=hit.map(r=>({rev:r.rev}));return {data:st.single?(o[0]||null):o,error:null};}
      if(st.op==='upsert'){rows[st.p.id]=Object.assign(rows[st.p.id]||{rev:0},JSON.parse(JSON.stringify(st.p)));return {data:null,error:null};}
      const hit=Object.values(rows).filter(match).map(r=>JSON.parse(JSON.stringify(r)));
      return {data:st.single?(hit[0]||null):hit,error:null};};
    return {from:()=>{const st={op:'select',f:[],single:false};const api={
      select(){return api;},insert(p){st.op='insert';st.p=p;return api;},update(p){st.op='update';st.p=p;return api;},
      upsert(p){st.op='upsert';st.p=p;return api;},delete(){st.op='delete';return api;},
      eq(k,v){st.f.push([k,v]);return api;},in(k,v){st.f.push([k,v,'in']);return api;},ilike(k,v){st.f.push([k,v]);return api;},
      order(){return api;},like(){return api;},maybeSingle(){st.single=true;return api;},
      then(res,rej){return Promise.resolve(run(st)).then(res,rej);}};return api;},
      channel:()=>({on(){return this;},subscribe(){return this;}}),auth:{getSession:async()=>({data:{}})}};
  };`;

test.use({ viewport: { width: 1280, height: 840 } });
async function boot(page) { await page.goto(FILE); await page.evaluate(c => { (0, eval)(c); }, BOOT); }
const wait = ms => new Promise(r => setTimeout(r, ms));

test('конфликт двух устройств: правки обеих сторон сливаются, ничего не теряется', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms));
    const base = JSON.parse(JSON.stringify(S));
    const db = { rows: {}, writes: [] };
    db.rows[S.id] = { id: S.id, name: S.projectName, emoji: '🚀', data: JSON.parse(JSON.stringify(base)), rev: 1 };
    sb = mockSb(db); revOk = true; saveBase(S.id, JSON.stringify(base)); setRev(S.id, 1);
    // партнёр (другое устройство) добавил задачу — в облаке rev 2, а этот телефон «проспал»
    const partner = JSON.parse(JSON.stringify(base)); const extra = Object.assign({}, partner.tasks[0], { id: 'tPartner', title: 'Задача партнёра' });
    partner.tasks.push(extra); db.rows[S.id].data = partner; db.rows[S.id].rev = 2;
    // а здесь меняем название первой задачи и сохраняем
    const t0 = S.tasks[0].id; S.tasks[0].title = 'Моё новое название'; save(); flushPushes();
    await w(120); await (_pq[S.id] || Promise.resolve()); await w(60);
    const cloud = db.rows[S.id];
    return { rev: cloud.rev, mine: cloud.data.tasks.find(t => t.id === t0).title, partner: !!cloud.data.tasks.find(t => t.id === 'tPartner'),
      localHasPartner: !!S.tasks.find(t => t.id === 'tPartner'), known: getRev(S.id), sv: !!cloud.data._sv && _svSent.has(cloud.data._sv) };
  });
  expect(r).toEqual({ rev: 3, mine: 'Моё новое название', partner: true, localHasPartner: true, known: 3, sv: true });
});

test('открытая карточка: обновление команды сливается сразу, карточка смотрит в новый S, Undo не трогает чужое', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const db = { rows: {}, writes: [] }; sb = mockSb(db); revOk = true;
    saveBase(S.id, JSON.stringify(S)); setRev(S.id, 5);
    const tid = S.tasks.find(t => t.status !== 'done').id; openTask(tid);
    const remote = JSON.parse(JSON.stringify(S)); remote.tasks.push(Object.assign({}, remote.tasks[0], { id: 'tNew', title: 'Пришло от команды' }));
    applyRemote({ id: S.id, name: S.projectName, emoji: '🚀', data: remote, rev: 6 });
    const open = document.querySelector('#drawer').classList.contains('show');
    return { open, same: curTask === S.tasks.find(t => t.id === tid), got: !!S.tasks.find(t => t.id === 'tNew'), rev: getRev(S.id), undo: undoStack.length };
  });
  expect(r).toEqual({ open: true, same: true, got: true, rev: 6, undo: 0 });
});

test('наблюдатель: правка откатывается и не уходит в облако; комментатор — только комменты', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms));
    const db = { rows: {}, writes: [] }; sb = mockSb(db); revOk = true;
    accessLegacy = false; accessReady = true; isTeam = true; teamRows = [{ email: myEmail, role: 'member' }];
    S.members.push({ id: 'mMe', name: 'Я', email: myEmail, access: 'view' }); localStorage.setItem(pkey(S.id), JSON.stringify(S)); saveBase(S.id, JSON.stringify(S));
    const t = S.tasks[0], was = t.title; t.title = 'Взлом'; save(); await w(30);
    const viewReverted = S.tasks[0].title === was;
    S.members.find(m => m.id === 'mMe').access = 'comment'; localStorage.setItem(pkey(S.id), JSON.stringify(S)); saveBase(S.id, JSON.stringify(S));
    S.tasks[0].comments.push({ ts: Date.now(), author: 'Я', text: 'Коммент' }); save();
    const commentKept = (loadProj(S.id).tasks[0].comments || []).some(c => c.text === 'Коммент');
    S.tasks[0].title = 'Опять'; save();
    const titleReverted = S.tasks[0].title === was;
    await w(800); flushPushes(); await w(50);
    return { viewReverted, commentKept, titleReverted, noViewWrite: !db.writes.some(x => x[0] === 'update' && (db.rows[x[1]] || {}).data && db.rows[x[1]].data.tasks[0].title === 'Взлом') };
  });
  expect(r).toEqual({ viewReverted: true, commentKept: true, titleReverted: true, noViewWrite: true });
});

test('данные из облака: фото/эмодзи/цвет/id не выходят из атрибута', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const p = cleanProj({ emoji: '"><img src=x onerror=alert(1)>', members: [{ id: 'm1"x', name: '<b>Х</b>', color: 'red;background:url(javascript:1)', photo: "x');background:url(javascript:alert(1))" }],
      tasks: [{ id: 't1" onmouseover="1', assigneeId: 'm1"x', deps: ['a"b'] }] });
    const av = avatarOf(p.members[0], 30);
    return { emoji: /[<>"]/.test(p.emoji), id: p.members[0].id, tid: p.tasks[0].id, color: p.members[0].color === COLORS[0], photo: p.members[0].photo === undefined,
      av: /javascript|onerror|<b>/.test(av), esc: esc("a'b\"c") };
  });
  expect(r).toEqual({ emoji: false, id: 'm1x', tid: 't1onmouseover1', color: true, photo: true, av: false, esc: 'a&#39;b&quot;c' });
});

test('профиль один на человека: имя меняется во всех проектах, где ты участник', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    S.members.push({ id: 'mMe', name: 'Старое имя', email: myEmail }); save();
    const other = migrate(seed()); other.id = 'pOther'; other.projectName = 'Второй'; other.members.push({ id: 'mx', name: 'Старое имя', email: myEmail });
    localStorage.setItem(pkey('pOther'), JSON.stringify(other)); reg.list.push({ id: 'pOther', name: 'Второй', emoji: '📄' }); saveReg();
    saveMyProfile({ name: 'Роч Новый' });
    openSettings();
    return { here: member('mMe').name, there: loadProj('pOther').members.find(m => m.id === 'mx').name,
      settings: document.querySelector('#setScrim').classList.contains('show') && !!document.querySelector('#setName') };
  });
  expect(r).toEqual({ here: 'Роч Новый', there: 'Роч Новый', settings: true });
});

test('другой аккаунт на том же устройстве — чистый лист; переполнение памяти не обрывает отправку', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms));
    localStorage.setItem('cockpit_crm', '[{"id":"c1","name":"Чужой клиент"}]');
    const oldId = S.id; wipeLocalData();
    const wiped = !localStorage.getItem(pkey(oldId)) && !localStorage.getItem('cockpit_crm') && reg.list.length === 1 && S.id !== oldId && CRM.length === 0;
    // квота: настоящая ошибка хранилища → плашка, а save() доходит до облака
    const db = { rows: {}, writes: [] }; sb = mockSb(db); revOk = true;
    S.projectName = 'Проект после квоты'; S.tasks = migrate(seed()).tasks;
    const big = 'x'.repeat(1024 * 1024); try { for (let i = 0; i < 12; i++) localStorage.setItem('fill' + i, big); } catch (e) {}
    save(); flushPushes(); await w(80); await (_pq[S.id] || Promise.resolve());
    const banner = !!document.getElementById('storeFull');
    for (let i = 0; i < 12; i++) localStorage.removeItem('fill' + i);
    return { wiped, banner, pushed: !!db.rows[S.id] };
  });
  expect(r).toEqual({ wiped: true, banner: true, pushed: true });
});
