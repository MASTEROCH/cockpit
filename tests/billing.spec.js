// Тариф: цена по местам. Те же числа считает бот (supabase/functions/tg-bot, const PRICE) —
// расхождение цены между приложением и счётом ломает доверие быстрее любого бага.
const { test, expect } = require('@playwright/test');
const path = require('path');

const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const BOOT = `localStorage.clear();S=migrate(seed());S.demo=false;
  reg.list=[{id:S.id,name:S.projectName,emoji:'🚀'}];reg.active=S.id;saveReg();
  localStorage.setItem(pkey(S.id),JSON.stringify(S));
  me=(S.members[0]||{}).id;localStorage.setItem('cockpit_me',me);cloudOn=false;
  hideGate();showGate=function(){};render();`;

const boot = async (page, extra = '') => {
  await page.goto(FILE);
  await page.evaluate(c => { (0, eval)(c); }, BOOT + extra);
};

test('цена: пять мест включены, шестое и дальше — по $9.99', async ({ page }) => {
  await boot(page);
  const p = await page.evaluate(() => [1, 5, 6, 8].map(n => +teamUsd(n).toFixed(2)));
  expect(p).toEqual([49.99, 49.99, 59.98, 79.96]);
  // курс Stars привязан к Founder (1900⭐ ≈ $19), иначе счёт в боте разъедется с экраном
  expect(await page.evaluate(() => toStars(49.99))).toBe(4999);
});

test('один человек — Founder, двое и больше — Team по местам', async ({ page }) => {
  await boot(page, `S.members=[{id:'m1',name:'A'}];openBilling();`);
  await expect(page.locator('#billModal')).toContainText('Founder');
  await page.evaluate(() => { S.members = [{ id: 'm1', name: 'A' }, { id: 'm2', name: 'B' }]; renderBilling(); });
  await expect(page.locator('#billModal')).toContainText('$49.99');
  await expect(page.locator('#billModal')).toContainText('За 30 дней');
});

test('шестое место названо и посчитано, а не спрятано в итог', async ({ page }) => {
  await boot(page, `S.members=[1,2,3,4,5,6,7].map(i=>({id:'m'+i,name:'N'+i}));openBilling();`);
  const txt = await page.locator('#billModal').textContent();
  expect(txt).toContain('$9.99');
  expect(txt).toContain('$69.97');   // 49.99 + 2 × 9.99
});

test('оплата уводит прямо в экран тарифа бота, а не «куда-нибудь в бота»', async ({ page }) => {
  await boot(page, `S.members=[{id:'m1',name:'A'},{id:'m2',name:'B'}];openBilling();`);
  expect(await page.locator('#blPay').getAttribute('href')).toBe('https://t.me/wando_tasks_bot?start=plan');
});

test('отказ по тарифу — не тупик: из него есть шаг в оплату', async ({ page }) => {
  await boot(page);
  const flags = await page.evaluate(() => [
    isPaywall('Вандо-ИИ доступен в тарифе Founder ⭐ — открой /plan у @wando_tasks_bot'),
    isPaywall('ANTHROPIC_API_KEY не задан в секретах функции')]);
  expect(flags).toEqual([true, false]);
  await page.evaluate(() => { $('#aiScrim').classList.add('show'); renderAIError('Вандо-ИИ доступен в тарифе Founder ⭐'); });
  await page.click('#aiPlanOpen');
  await expect(page.locator('#billScrim')).toHaveClass(/show/);
});
