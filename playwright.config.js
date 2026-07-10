// WANDO E2E — Playwright поверх системного Chrome (без скачивания браузеров)
// Запуск: npx playwright test        (или npm run test:e2e)
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 840 },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 840 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
});
