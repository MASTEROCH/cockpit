// Язык. Словарь ключуется русской строкой: нет перевода — экран остаётся русским
// и ничего не ломается. Проверяем именно это свойство, а не наличие переводов.
const { test, expect } = require('@playwright/test');
const path = require('path'), fs = require('fs'), http = require('http');

const ROOT = path.resolve(__dirname, '..');
let server, BASE;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;
});
test.afterAll(() => server && server.close());

const boot = async (page, lang) => {
  await page.route('**/*', r => r.request().url().startsWith(BASE)
    ? r.continue() : r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.addInitScript(l => { try { localStorage.setItem('cockpit_lang', l); } catch (e) {} }, lang);
  await page.goto(BASE + '/index.html');
  await page.waitForFunction(() => typeof t === 'function');
  await page.evaluate(async l => { await loadLang(l); LANG = l; }, lang);
};

test('словарь грузится и переводит цельные фразы с подстановкой', async ({ page }) => {
  await boot(page, 'en');
  const r = await page.evaluate(() => ({
    simple: t('Войти'),
    vars: t('На <b>{email}</b>. Введи <b>6 цифр</b> из письма — или открой ссылку из него на этом устройстве. Загляни в «Спам», если письма нет.', { email: 'a@b.c' }),
    size: Object.keys(DICT).length,
  }));
  expect(r.simple).toBe('Sign in');
  expect(r.vars).toContain('a@b.c');
  expect(r.vars).toContain('6 digits');
  expect(r.size).toBeGreaterThan(20);
});

test('нет перевода — возвращается русский, экран не ломается', async ({ page }) => {
  await boot(page, 'en');
  const miss = await page.evaluate(() => {
    const s = 'Строка, которой заведомо нет в словаре';
    return { back: t(s), counted: langCoverage().missing > 0 };
  });
  expect(miss.back).toBe('Строка, которой заведомо нет в словаре');
  expect(miss.counted).toBe(true);   // непереведённое копится для отчёта, а не теряется
});

test('числительные — грамматика, а не словарь: две формы вместо трёх', async ({ page }) => {
  await boot(page, 'en');
  const en = await page.evaluate(() => [1, 2, 5, 21].map(n => n + ' ' + plural(n, 'день', 'дня', 'дней')));
  expect(en).toEqual(['1 day', '2 days', '5 days', '21 days']);
  const ru = await page.evaluate(() => { DICT = null; return [1, 2, 5, 21].map(n => n + ' ' + plural(n, 'день', 'дня', 'дней')); });
  expect(ru).toEqual(['1 день', '2 дня', '5 дней', '21 день']);
});

test('экран входа переводится целиком, без русских хвостов', async ({ page }) => {
  await boot(page, 'en');
  await page.evaluate(() => { sb = { auth: { signInWithOtp: async () => ({}), verifyOtp: async () => ({}) } }; renderGate('sent', 'roch@gmail.com'); });
  const card = await page.locator('.gatecard').textContent();
  expect(card).toContain('Check your email');
  expect(card).toContain('Open Gmail');
  expect(card).not.toMatch(/[А-Яа-яЁё]/);   // ни одной кириллической буквы на экране
});

test('переключатель языка спрятан, пока перевод неполный', async ({ page }) => {
  await boot(page, 'ru');
  expect(await page.evaluate(() => langBeta())).toBe(false);
  await page.evaluate(() => { localStorage.setItem('cockpit_lang_beta', '1'); });
  expect(await page.evaluate(() => langBeta())).toBe(true);
});
