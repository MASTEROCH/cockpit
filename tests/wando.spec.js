// WANDO E2E: пользовательские пути из walkthrough (персоны A/B/C)
// Локальный файл, облако зашимлено — тестируем UI/flow, не Supabase.
const { test, expect } = require('@playwright/test');
const path = require('path');

const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');

// буткит: залогиненный пользователь с боевым seed-проектом
const BOOT = `localStorage.clear();S=migrate(seed());S.demo=false;
  reg.list=[{id:S.id,name:S.projectName,emoji:'🚀'}];reg.active=S.id;saveReg();
  localStorage.setItem(pkey(S.id),JSON.stringify(S));
  me=(S.members[0]||{}).id;localStorage.setItem('cockpit_me',me);myEmail='romi4rv23@gmail.com';cloudOn=true;isTeam=true;
  hideGate();showGate=function(){};render();`;

async function boot(page, extra = '') {
  await page.goto(FILE);
  await page.evaluate(c => { (0, eval)(c); }, BOOT + extra);
}

test.describe('Персона A · новичок', () => {
  test('пустой проект зовёт наставника, а не пугает пустотой', async ({ page }) => {
    await boot(page, `S.tasks=[];setView('now');`);
    await expect(page.locator('#npPlan')).toBeVisible();
    await page.click('#npPlan');
    await expect(page.locator('#planScrim')).toHaveClass(/show/);
    await expect(page.locator('#planDl .chip')).toHaveCount(3); // чипы срока
  });

  test('первая задача строкой → доска → Готово → Отменить', async ({ page }) => {
    await boot(page, `S.tasks=[];runCmd('позвонить дизайнеру завтра 1ч');setView('board');`);
    await expect(page.locator('#board .card', { hasText: 'позвонить дизайнеру' })).toBeVisible();
    await page.evaluate(() => { const t = S.tasks[0]; const un = markDone(S.id, t.id); render(); toast('Готово', '✅', 'Отменить', un); });
    await expect(page.locator('#toast .tact')).toBeVisible();
    await page.click('#toast .tact');
    const status = await page.evaluate(() => S.tasks[0].status);
    expect(status).not.toBe('done');
  });

  test('quick-done пишет в историю (велосити не слепнет)', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { S.tasks[0].status = 'todo'; markDone(S.id, S.tasks[0].id); });
    const act = await page.evaluate(() => S.activity[0]);
    expect(act.icon).toBe('✅');
  });

  test('все задачи закрыты → «красавчик», без повторного наставника', async ({ page }) => {
    await boot(page, `S.tasks.forEach(t=>{t.status='done'});setView('now');`);
    await expect(page.locator('.now-hero .nh-title')).toContainText('красавчик');
    await expect(page.locator('#npPlan')).toHaveCount(0);
  });
});

test.describe('Персона B · день PM', () => {
  test('отчёт империи открывается и закрывается по Esc', async ({ page }) => {
    await boot(page, `setView('all');openEmpireRep();`);
    await expect(page.locator('#repModal')).toContainText('Отчёт недели');
    await page.keyboard.press('Escape');
    await expect(page.locator('#repScrim')).not.toHaveClass(/show/);
  });

  test('команда «отчёт» в строке открывает империю', async ({ page }) => {
    await boot(page, `runCmd('отчёт');`);
    await expect(page.locator('#repScrim')).toHaveClass(/show/);
  });

  test('фокус-таймер показывает накопленный итог на кнопке', async ({ page }) => {
    await boot(page, `S.tasks.forEach(t=>{t.status='todo';t.assigneeId=me;t.end=todayISO();t.estimate=1;t.priority='med';});
      setView('now');const hero=document.querySelector('[data-done]');task(hero.dataset.done).spent=2.3;render();`);
    await expect(page.locator('#focusStart')).toContainText('уже 2.3ч');
  });
});

test.describe('Персона C · империя', () => {
  test('герой берётся из чужого проекта с меткой «вся империя»', async ({ page }) => {
    await boot(page, `
      localStorage.setItem(pkey('p2'),JSON.stringify({id:'p2',projectName:'ROCH Audit',emoji:'🎯',
        tasks:[{id:'t1',title:'Горящий оффер',sectionId:'s1',assigneeId:'m1',start:todayISO(),end:fmtD(parseD(todayISO())-3*dayMs),status:'todo',estimate:2,spent:0,priority:'urgent',cash:true,comments:[],deps:[],isMilestone:false}],
        members:[{id:'m1',name:'Roch',email:'romi4rv23@gmail.com'}],sections:[{id:'s1',name:'x'}],ideas:[]}));
      reg.list.push({id:'p2',name:'ROCH Audit',emoji:'🎯'});
      S.tasks.forEach(t=>{t.assigneeId=null;});setView('now');`);
    await expect(page.locator('.now-hero .nh-label')).toContainText('все проекты');
    await expect(page.locator('.now-hero .nh-title')).toContainText('Горящий оффер');
  });

  test('⌘K находит задачу по слову из коммента', async ({ page }) => {
    await boot(page, `S.tasks[0].comments=[{text:'обсудили брендбук',author:'Дима',ts:1}];`);
    const found = await page.evaluate(() =>
      buildPaletteIndex().some(x => x.type === 'Задача' && x.kw.includes('брендбук')));
    expect(found).toBe(true);
  });
});

test.describe('Мобайл', () => {
  test.skip(({ viewport }) => viewport.width > 500, 'только мобильный проект');

  test('нижний нав и сегмент «‹ Проекты» на месте', async ({ page }) => {
    await boot(page, `setView('board');`);
    await expect(page.locator('.mnav')).toBeVisible();
    await expect(page.locator('#mseg button', { hasText: '‹ Проекты' })).toBeVisible();
  });

  test('long-press на задаче открывает лист действий', async ({ page }) => {
    await boot(page, `S.tasks.forEach(t=>{t.status='todo';t.assigneeId=me;t.end=todayISO();});setView('now');`);
    const row = page.locator('#now .mrow').first();
    const box = await row.boundingBox();
    await page.touchscreen.tap(box.x + 10, box.y + 10).catch(() => {});
    await page.evaluate(() => { // тап-эмуляция long-press: touchstart без движения 500мс
      const el = document.querySelector('#now .mrow');
      const ev = new Event('touchstart'); ev.touches = [{ clientX: 100, clientY: 100 }];
      el.dispatchEvent(ev);
    });
    await page.waitForTimeout(600);
    await expect(page.locator('#lpScrim')).toHaveClass(/show/);
    await expect(page.locator('#lpModal [data-lp="done"]')).toBeVisible();
  });
});
