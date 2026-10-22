'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../src/core');

const base = () => ({
  portableRoot: 'C:/Apps',
  categories: [{ name: 'Games', dir: 'C:/Games' }],
  repos: [],
});
const app = (extra) => ({ owner: 'TeeJS', repo: 'open-quake', type: 'portable', ...extra });

test('a portable app in a category installs under that category folder', () => {
  const cfg = { ...base(), repos: [app({ category: 'Games' }), { owner: 'ShareX', repo: 'ShareX', type: 'portable' }] };
  core.validateConfig(cfg);
  assert.strictEqual(cfg.repos[0].install.dir, 'C:/Games/open-quake');
  assert.strictEqual(cfg.repos[1].install.dir, 'C:/Apps/ShareX');
});

test('category names match case-insensitively', () => {
  const cfg = { ...base(), repos: [app({ category: 'games' })] };
  core.validateConfig(cfg);
  assert.strictEqual(cfg.repos[0].install.dir, 'C:/Games/open-quake');
});

test('a category folder works without a portableRoot', () => {
  const cfg = { categories: [{ name: 'Games', dir: 'D:/Games/' }], repos: [app({ category: 'Games' })] };
  core.validateConfig(cfg);
  assert.strictEqual(cfg.repos[0].install.dir, 'D:/Games/open-quake');
});

test('explicit install.dir still wins over a category', () => {
  const cfg = { ...base(), repos: [app({ category: 'Games', install: { dir: 'E:/Quake' } })] };
  core.validateConfig(cfg);
  assert.strictEqual(cfg.repos[0].install.dir, 'E:/Quake');
});

test('an undefined category is rejected', () => {
  const cfg = { ...base(), repos: [app({ category: 'Tools' })] };
  assert.throws(() => core.validateConfig(cfg), /category "Tools" is not defined/);
});

test('categories need a name, a folder, and unique names', () => {
  assert.throws(() => core.validateCategories({ categories: [{ name: 'Games' }], repos: [] }), /needs a folder/);
  assert.throws(() => core.validateCategories({ categories: [{ dir: 'C:/x' }], repos: [] }), /"name" is required/);
  assert.throws(
    () => core.validateCategories({ categories: [{ name: 'Games', dir: 'C:/a' }, { name: 'GAMES', dir: 'C:/b' }], repos: [] }),
    /defined twice/
  );
});

test('moving an app into a category plans a folder move', () => {
  const before = { ...base(), repos: [app()] };
  const after = { ...base(), repos: [app({ category: 'Games' })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), [
    { key: 'TeeJS/open-quake#portable', from: 'C:/Apps/open-quake', to: 'C:/Games/open-quake' },
  ]);
});

test('taking an app out of a category moves it back to portableRoot', () => {
  const before = { ...base(), repos: [app({ category: 'Games' })] };
  const after = { ...base(), repos: [app()] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32').map((m) => m.to), ['C:/Apps/open-quake']);
});

test("changing a category's folder moves its apps", () => {
  const before = { ...base(), repos: [app({ category: 'Games' })] };
  const after = { ...base(), categories: [{ name: 'Games', dir: 'D:/Games' }], repos: [app({ category: 'Games' })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32').map((m) => m.to), ['D:/Games/open-quake']);
});

test('a plain portableRoot change moves nothing', () => {
  const before = { ...base(), repos: [app()] };
  const after = { ...base(), portableRoot: 'D:/Apps', repos: [app()] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), []);
});

test('the same folder spelled differently on Windows is not a move', () => {
  const before = { ...base(), repos: [app({ category: 'Games' })] };
  const after = { ...base(), categories: [{ name: 'Games', dir: 'c:\\games\\' }], repos: [app({ category: 'Games' })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), []);
});

test('installer apps and new apps never move', () => {
  const inst = { owner: 'o', repo: 'r', type: 'installer' };
  const before = { ...base(), repos: [inst] };
  const after = { ...base(), repos: [{ ...inst, category: 'Games' }, app({ category: 'Games' })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), []);
});

test('a hand-set install.dir is left alone', () => {
  const before = { ...base(), repos: [app({ install: { dir: 'E:/Quake' } })] };
  const after = { ...base(), repos: [app({ category: 'Games', install: { dir: 'E:/Quake' } })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), []);
  assert.strictEqual(after.repos[0].install.dir, 'E:/Quake');
});

test('an install.dir that only repeats the old default is dropped and the app follows its category', () => {
  const before = { ...base(), repos: [app({ install: { dir: 'C:/Apps/open-quake' } })] };
  const after = { ...base(), repos: [app({ category: 'Games', install: { dir: 'C:/Apps/open-quake' } })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32').map((m) => m.to), ['C:/Games/open-quake']);
  assert.strictEqual(after.repos[0].install, undefined);
});

test('setting an app its own folder moves it there', () => {
  const before = { ...base(), repos: [app()] };
  const after = { ...base(), repos: [app({ install: { dir: 'E:/Quake' } })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), [
    { key: 'TeeJS/open-quake#portable', from: 'C:/Apps/open-quake', to: 'E:/Quake' },
  ]);
});

test("changing an app's own folder moves it from the old one", () => {
  const before = { ...base(), repos: [app({ install: { dir: 'E:/Quake' } })] };
  const after = { ...base(), repos: [app({ install: { dir: 'F:/Quake' } })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32').map((m) => [m.from, m.to]), [['E:/Quake', 'F:/Quake']]);
});

test("clearing an app's own folder moves it back to the default", () => {
  const before = { ...base(), repos: [app({ category: 'Games', install: { dir: 'E:/Quake' } })] };
  const after = { ...base(), repos: [app({ category: 'Games' })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32').map((m) => m.to), ['C:/Games/open-quake']);
});
