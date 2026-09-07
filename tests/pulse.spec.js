// Пульс компании: диагноз проекта считается из данных, худший — сверху.
const { test, expect } = require('@playwright/test');
const path = require('path');

const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');
// два проекта: один здоровый, один умирающий
const BOOT = `localStorage.clear();
  S=migrate(seed());S.demo=false;S.projectName='Живой';
  const now=Date.now();
  S.activity=[{ts:now-3600000,who:'Roch',icon:'✅',text:'свежая запись'}];
  S.tasks.forEach(t=>{if(!t.isMilestone){t.status='done';t.doneTs=now-864e5;}});
  S.tasks[0].status='todo';S.tasks[0].end=fmtD(parseD(todayISO())+10*864e5);
  reg.list=[{id:S.id,name:S.projectName,emoji:'🟢'}];reg.active=S.id;saveReg();
  localStorage.setItem(pkey(S.id),JSON.stringify(S));
  const dead=migrate(seed());dead.id='pdead';dead.projectName='Умирающий';dead.demo=false;
  dead.activity=[{ts:now-40*864e5,who:'Roch',icon:'✏️',text:'давняя запись'}];
  dead.tasks.forEach(t=>{if(!t.isMilestone){t.status='todo';t.end=fmtD(parseD(todayISO())-9*864e5);t.doneTs=0;t.statusTs=0;}});
  reg.list.push({id:'pdead',name:'Умирающий',emoji:'🔴'});saveReg();
  localStorage.setItem(pkey('pdead'),JSON.stringify(dead));
  me=(S.members[0]||{}).id;localStorage.setItem('cockpit_me',me);cloudOn=false;
  hideGate();showGate=function(){};setView('all');render();`;

test('умирающий проект поднимается наверх и объясняет себя', async ({ page }) => {
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(FILE);
  await page.evaluate(c => { (0, eval)(c); }, BOOT);
  await expect(page.locator('#portfolio .puhead')).toContainText('Умирающий');
  const rows = await page.locator('#portfolio .purow .pun').allTextContents();
  expect(rows[0]).toBe('Умирающий');           // худший первым
  const scores = await page.evaluate(() => reg.list.map(m => {
    const d = loadProj(m.id); return { n: m.name, p: projectPulse(m, d) };
  }));
  const dead = scores.find(x => x.n === 'Умирающий');
  const live = scores.find(x => x.n === 'Живой');
  expect(dead.p.band).toBe('dying');
  expect(dead.p.score).toBeLessThan(live.p.score);
  expect(dead.p.sig.map(s => s.k)).toEqual(expect.arrayContaining(['over', 'quiet', 'nomove']));
  expect(errs).toEqual([]);
});

test('проект без активных задач не считается умирающим', async ({ page }) => {
  await page.goto(FILE);
  await page.evaluate(c => { (0, eval)(c); }, BOOT);
  const p = await page.evaluate(() => {
    const d = loadProj('pdead');
    d.tasks.forEach(t => { t.status = 'done'; });
    return projectPulse({ id: 'pdead', name: 'Умирающий' }, d);
  });
  expect(p.band).toBe('ok');
  expect(p.idle).toBe(true);
});

test('ручная метка «горим» опускает счёт, «по плану» — поднимает', async ({ page }) => {
  await page.goto(FILE);
  await page.evaluate(c => { (0, eval)(c); }, BOOT);
  const [base, red, green] = await page.evaluate(() => {
    const d = loadProj('pdead');
    const b = projectPulse({ id: 'pdead' }, d).score;
    d.health = { c: 'r' }; const r = projectPulse({ id: 'pdead' }, d).score;
    d.health = { c: 'g' }; const g = projectPulse({ id: 'pdead' }, d).score;
    return [b, r, g];
  });
  expect(red).toBeLessThan(base);
  expect(green).toBeGreaterThan(base);
});
