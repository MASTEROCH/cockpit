// Вход по коду. Письмо несёт и цифры, и ссылку — экран не должен зависеть от того,
// какой путь у человека сработает, поэтому проверяем оба и защиту от выжигания лимита.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Гейт на file:// намеренно показывает заглушку «локальная копия — вход не работает»,
// поэтому вход проверяем по http, как у людей.
const ROOT = path.resolve(__dirname, '..');
let server, FILE;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  FILE = 'http://127.0.0.1:' + server.address().port + '/index.html';
});
test.afterAll(() => server && server.close());

// протокол file:// гейт подменяет заглушкой — поднимаем http и глушим сеть Supabase
async function openGate(page, { verify } = {}) {
  const calls = { sent: 0, verified: [] };
  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(FILE.replace('/index.html', ''))) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(FILE);
  await page.evaluate(([v]) => {
    localStorage.clear();
    S = migrate(seed()); S.demo = false;
    reg.list = [{ id: S.id, name: S.projectName, emoji: '🚀' }]; reg.active = S.id; saveReg();
    window.__calls = { sent: 0, verified: [] };
    sb = {
      auth: {
        signInWithOtp: async () => { window.__calls.sent++; return {}; },
        verifyOtp: async ({ token }) => { window.__calls.verified.push(token); return v ? {} : { error: { message: 'Token has expired or is invalid' } }; },
      },
    };
    renderGate('sent', 'roch@wando.test');
  }, [!!verify]);
  return calls;
}

test('шесть цифр отправляются сами, лишние символы не проходят', async ({ page }) => {
  await openGate(page, { verify: true });
  await expect(page.locator('#gateCode')).toBeVisible();
  await page.locator('#gateCode').pressSequentially('a1b2c3');  // буквы отсеиваются на лету
  expect(await page.inputValue('#gateCode')).toBe('123');
  expect(await page.evaluate(() => window.__calls.verified.length)).toBe(0);
  await page.fill('#gateCode', '');
  await page.fill('#gateCode', '123456');
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__calls.verified)).toEqual(['123456']);
});

test('неверный код объясняет себя и не съедает введённое', async ({ page }) => {
  await openGate(page, { verify: false });
  await page.fill('#gateCode', '111111');
  await expect(page.locator('#gateCodeErr')).toContainText('истёк');
  expect(await page.inputValue('#gateCode')).toBe('111111');
  await expect(page.locator('#gateGo')).toBeEnabled();
});

test('ссылка из письма остаётся равноправным путём', async ({ page }) => {
  await openGate(page, { verify: true });
  await expect(page.locator('.gatecard .gp')).toContainText('открой ссылку');
});

test('повтор письма на таймере — лимит писем не выжигается в ноль', async ({ page }) => {
  await openGate(page, { verify: true });
  await page.click('#gateResend');
  await expect(page.locator('#gateResend')).toBeDisabled();
  await expect(page.locator('#gateResend')).toContainText('(');
  expect(await page.evaluate(() => window.__calls.sent)).toBe(1);
});
