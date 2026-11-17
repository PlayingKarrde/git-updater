'use strict';

// Choosing a release asset by hand: the pattern remembered from a pick, the chooser's
// classification of a release, and the "choose one" signal a failed pick carries.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../src/core');
const github = require('../src/github');
const detect = require('../src/detect');
const runner = require('../src/runner');

const A = (names) => names.map((name) => ({ name, size: 1000 }));

// --- assetPatternFor --------------------------------------------------------

test('pattern: the version becomes *, so the next release matches the same file', () => {
  const p = core.assetPatternFor('OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb', '32.2.2');
  assert.equal(p, 'OBS-Studio-*-Ubuntu-24.04-x86_64.deb');
  const next = A(['OBS-Studio-32.3.0-Ubuntu-24.04-x86_64.deb', 'OBS-Studio-32.3.0-Ubuntu-26.04-x86_64.deb']);
  assert.equal(core.matchAsset(next, p).name, 'OBS-Studio-32.3.0-Ubuntu-24.04-x86_64.deb');
});

test('pattern: a "v" in both tag and name is replaced with the version', () => {
  assert.equal(core.assetPatternFor('tool-v1.2.3-linux.tar.gz', 'v1.2.3'), 'tool-*-linux.tar.gz');
  // Tag without the v: the v in the file name stays literal.
  assert.equal(core.assetPatternFor('Godot_v4.5-stable_linux.x86_64.zip', '4.5-stable'), 'Godot_v*_linux.x86_64.zip');
});

test('pattern: a name without the version is kept exactly', () => {
  assert.equal(core.assetPatternFor('app-linux-x64.tar.gz', 'v1.0.0'), 'app-linux-x64.tar.gz');
});

test('pattern: a too-short version is not wildcarded', () => {
  assert.equal(core.assetPatternFor('app1-x64-1.tar.gz', '1'), 'app1-x64-1.tar.gz');
});

test('pattern: falls back to the exact name when * would also match a sibling', () => {
  const names = ['app-1.0-x64.tar.gz', 'app-1.0-x64.tar.gz.part2', 'app-1.0.1-x64.tar.gz'];
  // "app-*-x64.tar.gz" would hit 1.0 and 1.0.1 both.
  assert.equal(core.assetPatternFor('app-1.0-x64.tar.gz', '1.0', names), 'app-1.0-x64.tar.gz');
});

test('pattern: a name that reads as a glob is pinned with an escaped regex', () => {
  const p = core.assetPatternFor('weird*name.zip', 'v1.0.0');
  assert.match(p, /^\/.*\/$/);
  assert.equal(core.matchAsset(A(['weird*name.zip', 'weirdXname.zip']), p).name, 'weird*name.zip');
});

// --- assetChoices -----------------------------------------------------------

const OBS = A([
  'OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb',
  'OBS-Studio-32.2.2-Ubuntu-26.04-x86_64.deb',
  'OBS-Studio-32.2.2-Sources.tar.gz',
  'OBS-Studio-32.2.2-Windows.zip',
  'SHA256SUMS',
  'OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb.sha256',
]);

test('choices: metadata is hidden, builds are classified, auto pick is marked', () => {
  const r = core.assetChoices(OBS, 'installer', 'x64', null, 'linux', { id: 'ubuntu', versionId: '26.04' });
  const by = Object.fromEntries(r.choices.map((c) => [c.name, c]));
  assert.ok(!by.SHA256SUMS && !by['OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb.sha256']);
  assert.equal(r.auto, 'OBS-Studio-32.2.2-Ubuntu-26.04-x86_64.deb');
  assert.equal(by[r.auto].auto, true);
  assert.equal(by['OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb'].status, 'ok');
  assert.equal(by['OBS-Studio-32.2.2-Sources.tar.gz'].status, 'rejected');
  assert.equal(by['OBS-Studio-32.2.2-Windows.zip'].status, 'rejected');
  assert.equal(r.choices[0].name, r.auto, 'best match is listed first');
});

test('choices: a build of the other type is marked, not offered as ok', () => {
  const r = core.assetChoices(OBS, 'portable', 'x64', null, 'linux', null);
  const deb = r.choices.find((c) => c.name.endsWith('24.04-x86_64.deb'));
  assert.equal(deb.status, 'other-type');
  assert.equal(r.auto, null);
});

test('choices: a file with no platform marker is unknown, still listed', () => {
  const r = core.assetChoices(A(['thing.bin']), 'portable', 'x64', null, 'linux', null);
  assert.equal(r.choices[0].status, 'unknown');
});

test('choices: close is set when two ok builds score within a point', () => {
  const twin = A(['app-1.0-linux-x86_64.tar.gz', 'app-1.0-linux-x86_64.tar.xz']);
  assert.equal(core.assetChoices(twin, 'portable', 'x64', null, 'linux', null).close, true);
  const clear = A(['app-1.0-linux-x86_64.tar.gz', 'app-1.0-linux-arm64.tar.gz']);
  assert.equal(core.assetChoices(clear, 'portable', 'x64', null, 'linux', null).close, false);
});

// --- resolveAsset -----------------------------------------------------------

test('resolve: a saved pattern wins over auto-pick', () => {
  const repo = { type: 'installer', asset: 'OBS-Studio-*-Ubuntu-24.04-x86_64.deb' };
  assert.equal(core.resolveAsset(repo, OBS, null, 'linux', { id: 'ubuntu', versionId: '26.04' }).name, 'OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb');
});

test('resolve: a pattern that stopped matching asks for a choice', () => {
  const repo = { type: 'installer', asset: 'obs-*-noble.deb' };
  assert.throws(() => core.resolveAsset(repo, OBS, null, 'linux', null), (e) => e.chooseAsset === true);
});

test('resolve: nothing usable for this platform asks for a choice', () => {
  const repo = { type: 'portable' };
  assert.throws(() => core.resolveAsset(repo, A(['thing.bin']), null, 'linux', null), (e) => e.chooseAsset === true);
});

test('resolve: "ships the other type" keeps its own fix, not the chooser', () => {
  const repo = { type: 'portable' };
  assert.throws(
    () => core.resolveAsset(repo, A(['app_1.0_amd64.deb']), null, 'linux', null),
    (e) => /change its type to Installer/.test(e.message) && !e.chooseAsset
  );
});

test('validateConfig: rejects an invalid asset pattern', () => {
  assert.throws(
    () => core.validateConfig({ repos: [{ owner: 'o', repo: 'r', type: 'installer', asset: '/(/' }] }),
    /"asset" is not a valid pattern/
  );
});

// --- runner: a check reports it before the user hits Update ----------------

test('check: an update with no usable download comes back flagged chooseAsset', async () => {
  const real = {
    getLatestRelease: github.getLatestRelease,
    installedVersion: detect.installedVersion,
    installedFlavor: detect.installedFlavor,
    clearCache: detect.clearCache,
    osRelease: detect.osRelease,
  };
  github.getLatestRelease = async () => ({ tag_name: 'v2.0.0', assets: A(['thing.bin']) });
  detect.installedVersion = async () => null;
  detect.installedFlavor = async () => null;
  detect.clearCache = () => {};
  detect.osRelease = () => null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-assetchoice-'));
  try {
    const cfg = { repos: [{ owner: 'o', repo: 'r', type: 'installer' }] };
    const { results } = await runner.run(cfg, { mode: 'check', statePath: path.join(dir, 'state.json') });
    assert.equal(results[0].status, 'failed');
    assert.equal(results[0].chooseAsset, true);
    assert.equal(results[0].to, '2.0.0');
  } finally {
    Object.assign(github, { getLatestRelease: real.getLatestRelease });
    Object.assign(detect, {
      installedVersion: real.installedVersion,
      installedFlavor: real.installedFlavor,
      clearCache: real.clearCache,
      osRelease: real.osRelease,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
