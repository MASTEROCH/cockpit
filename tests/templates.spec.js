// Шаблоны-ДНК: у каждого шаблона связный порядок работ, а не плоский список.
const { test, expect } = require('@playwright/test');
const path = require('path');

const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');

test('каждый шаблон собирается: зависимости резолвятся, «зачем» есть у всех', async ({ page }) => {
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(FILE);
  const out = await page.evaluate(() => Object.keys(TPL_DNA).map(k => {
    const p = buildTemplate(k);
    const ids = new Set(p.tasks.map(t => t.id));
    return {
      k, tasks: p.tasks.length,
      deps: p.tasks.reduce((a, t) => a + t.deps.length, 0),
      badDeps: p.tasks.some(t => t.deps.some(d => !ids.has(d))),
      noWhy: p.tasks.filter(t => !t.description).length,
      badSec: p.tasks.some(t => !p.sections.find(s => s.id === t.sectionId)),
      badDate: p.tasks.some(t => !/^\d{4}-\d\d-\d\d$/.test(t.start) || t.end < t.start),
    };
  }));
  out.forEach(r => {
    expect(r.tasks, r.k).toBeGreaterThan(3);
    expect(r.deps, r.k).toBeGreaterThan(0);
    expect(r.badDeps, r.k).toBe(false);
    expect(r.noWhy, r.k).toBe(0);
    expect(r.badSec, r.k).toBe(false);
    expect(r.badDate, r.k).toBe(false);
  });
  expect(errs).toEqual([]);
});

test('сценарии фаундера из роадмапа на месте и заканчиваются вехой', async ({ page }) => {
  await page.goto(FILE);
  const keys = await page.evaluate(() => TEMPLATES.map(t => t.k));
  expect(keys).toEqual(expect.arrayContaining(['mvp', 'saas', 'site']));
  const miles = await page.evaluate(() => ['mvp', 'saas', 'site']
    .map(k => buildTemplate(k).tasks.filter(t => t.isMilestone).length));
  miles.forEach(n => expect(n).toBe(1));
  // название проекта подставляется из шаблона, а не «Новый проект»
  const names = await page.evaluate(() => ['saas', 'site'].map(k => TPL_NAME[k]));
  expect(names).toEqual(['Запуск SaaS', 'Клиентский сайт']);
});

test('зависимости идут вперёд по времени, а не назад', async ({ page }) => {
  await page.goto(FILE);
  const bad = await page.evaluate(() => {
    const out = [];
    Object.keys(TPL_DNA).forEach(k => {
      const p = buildTemplate(k);
      const by = {};
      p.tasks.forEach(t => { by[t.id] = t; });
      p.tasks.forEach(t => t.deps.forEach(d => {
        if (by[d] && by[d].start > t.start) out.push(k + ': ' + t.title + ' ← ' + by[d].title);
      }));
    });
    return out;
  });
  expect(bad).toEqual([]);
});
