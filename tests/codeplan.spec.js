const { test, expect } = require('@playwright/test');
const path = require('path');
const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const BOOT = `localStorage.clear();S=migrate(seed());S.demo=false;
  reg.list=[{id:S.id,name:S.projectName,emoji:'🚀'}];reg.active=S.id;saveReg();
  localStorage.setItem(pkey(S.id),JSON.stringify(S));
  me=(S.members[0]||{}).id;localStorage.setItem('cockpit_me',me);cloudOn=false;
  hideGate();showGate=function(){};render();`;

test('пустое состояние без репозитория + нормализация ссылки', async ({ page }) => {
  const errs=[];page.on('pageerror',e=>errs.push(String(e)));
  await page.goto(FILE);
  await page.evaluate(c=>{(0,eval)(c);}, BOOT);
  await page.evaluate(()=>openDrift());
  await expect(page.locator('#driftScrim')).toHaveClass(/show/);
  await expect(page.locator('.dfhook')).toContainText('/functions/v1/gh-hook');
  const norm = await page.evaluate(()=>[
    repoNorm('https://github.com/MASTEROCH/cockpit'),
    repoNorm('https://github.com/MASTEROCH/cockpit.git'),
    repoNorm(' MASTEROCH/cockpit '),
    repoNorm('MASTEROCH/cockpit/tree/main'),
    repoNorm('мусор')]);
  expect(norm).toEqual(['MASTEROCH/cockpit','MASTEROCH/cockpit','MASTEROCH/cockpit','MASTEROCH/cockpit','']);
  expect(errs).toEqual([]);
});

test('расхождение считается в обе стороны, коммит заводится задачей и откатывается', async ({ page }) => {
  const errs=[];page.on('pageerror',e=>errs.push(String(e)));
  await page.goto(FILE);
  await page.evaluate(c=>{(0,eval)(c);}, BOOT + `
    S.repo='MASTEROCH/cockpit';
    S.tasks.forEach(x=>{if(x.status==='progress')x.status='todo';});
    const t=S.tasks.find(x=>!x.isMilestone);t.status='progress';
    const t2=S.tasks.filter(x=>!x.isMilestone)[1];t2.status='progress';
    const now=Date.now();
    S.codelog=[
      {ts:now-864e5,sha:'aaa1111',msg:'рефакторинг сборки',who:'roch',url:'',tids:[]},
      {ts:now-2*864e5,sha:'bbb2222',msg:'правка стилей шапки',who:'roch',url:'',tids:[]},
      {ts:now-3*864e5,sha:'ccc3333',msg:'работа по задаче',who:'roch',url:'',tids:[t2.id]},
      {ts:now-40*864e5,sha:'old0000',msg:'древний коммит',who:'roch',url:'',tids:[]}];
    save();openDrift();`);
  const kpi = await page.evaluate(()=>{const d=driftData();
    return {log:d.log.length,linked:d.linked,loose:d.loose.length,stale:d.stale.length};});
  expect(kpi.log).toBe(3);          // 40-дневный коммит за окном
  expect(kpi.linked).toBe(1);
  expect(kpi.loose).toBe(2);
  expect(kpi.stale).toBe(1);        // вторая «в работе» тронута коммитом
  const before = await page.evaluate(()=>S.tasks.length);
  await page.locator('#driftModal .dfadd').first().click();
  const after = await page.evaluate(()=>({n:S.tasks.length,
    last:S.tasks[S.tasks.length-1].status,loose:driftData().loose.length}));
  expect(after.n).toBe(before+1);
  expect(after.last).toBe('done');
  expect(after.loose).toBe(1);
  await page.click('#toast .tact');
  const back = await page.evaluate(()=>({n:S.tasks.length,loose:driftData().loose.length}));
  expect(back.n).toBe(before);
  expect(back.loose).toBe(2);
  expect(errs).toEqual([]);
});
