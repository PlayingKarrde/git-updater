'use strict';

// Self-update when running FROM an AppImage: the image file is replaced, not a sibling
// app-<version>/ folder written next to the read-only /tmp/.mount_* the process runs from.

const path = require('path');
const os = require('os');
const fs = require('fs');

// selfupdate.js fixes its storage root at require-time — isolate it first.
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-selfupdate-appimage-'));
process.env.GITUPDATER_DATA_DIR = path.join(FAKE, 'data');

const { test } = require('node:test');
const assert = require('node:assert');
const github = require('../src/github');
const selfupdate = require('../src/selfupdate');

const imageAt = (dir, name = 'git-updater.AppImage', body = 'old') => {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};

test('appImageFile: only on Linux, only an existing absolute file', () => {
  const img = imageAt(path.join(FAKE, 'a'));
  assert.equal(selfupdate.appImageFile({ APPIMAGE: img }, 'linux'), img);
  assert.equal(selfupdate.appImageFile({ APPIMAGE: img }, 'win32'), null);
  assert.equal(selfupdate.appImageFile({}, 'linux'), null);
  assert.equal(selfupdate.appImageFile({ APPIMAGE: 'rel/path.AppImage' }, 'linux'), null);
  assert.equal(selfupdate.appImageFile({ APPIMAGE: path.join(FAKE, 'missing.AppImage') }, 'linux'), null);
});

test('canApply: an AppImage in a writable folder can update; macOS never; no AppImage as before', () => {
  const img = imageAt(path.join(FAKE, 'b'));
  assert.equal(selfupdate.canApply({ APPIMAGE: img }, 'linux'), true);
  assert.equal(selfupdate.canApply({}, 'linux'), true);
  assert.equal(selfupdate.canApply({}, 'darwin'), false);
});

test('appImageAsset: picks the AppImage, never the tarball', () => {
  const a = selfupdate.appImageAsset([
    { name: 'git-updater-0.3.1-linux-x64.tar.gz' },
    { name: 'git-updater-0.3.1-linux-x86_64.AppImage' },
  ]);
  assert.equal(a.name, 'git-updater-0.3.1-linux-x86_64.AppImage');
  assert.throws(() => selfupdate.appImageAsset([{ name: 'x.tar.gz' }]), /no AppImage/);
});

test('replaceFile: swaps the content at the same path, executable, no temp left behind', () => {
  const dir = path.join(FAKE, 'c');
  const img = imageAt(dir);
  const src = path.join(FAKE, 'new.AppImage');
  fs.writeFileSync(src, 'new');
  selfupdate.replaceFile(src, img);
  assert.equal(fs.readFileSync(img, 'utf8'), 'new');
  if (process.platform !== 'win32') assert.equal(fs.statSync(img).mode & 0o111, 0o111);
  assert.deepEqual(fs.readdirSync(dir), ['git-updater.AppImage']);
});

test('relaunchEnv: drops the AppImage runtime vars and paths into the old mount', () => {
  const env = selfupdate.relaunchEnv({
    APPDIR: '/tmp/.mount_abc',
    APPIMAGE: '/home/u/git-updater.AppImage',
    ARGV0: 'git-updater',
    OWD: '/home/u',
    LD_LIBRARY_PATH: '/tmp/.mount_abc/usr/lib:/opt/lib',
    XDG_DATA_DIRS: '/tmp/.mount_abc/usr/share',
    PATH: '/tmp/.mount_abc:/usr/bin',
    HOME: '/home/u',
  });
  assert.deepEqual(env, { LD_LIBRARY_PATH: '/opt/lib', PATH: '/usr/bin', HOME: '/home/u' });
});

test('prepareUpdate: from an AppImage, replaces the image file and never writes beside the mount', async () => {
  const dir = path.join(FAKE, 'd');
  const img = imageAt(dir);
  // The "root" of a run from an AppImage is the mount; make it read-only to prove it is not touched.
  const mount = path.join(FAKE, 'mount');
  fs.mkdirSync(mount);
  const real = { ...github };
  github.getLatestRelease = async () => ({
    tag_name: 'v9.9.9',
    assets: [
      { name: 'git-updater-9.9.9-linux-x64.tar.gz', browser_download_url: 'https://example.invalid/t' },
      { name: 'git-updater-9.9.9-linux-x86_64.AppImage', browser_download_url: 'https://example.invalid/a' },
    ],
  });
  let fetched = null;
  github.downloadAsset = async (url, file) => {
    fetched = url;
    fs.writeFileSync(file, 'v9.9.9 image');
  };
  github.fetchChecksumFromRelease = async () => null;
  github.verifyDigest = () => ({ skipped: true, note: 'test' });
  try {
    const r = await selfupdate.prepareUpdate(mount, '0.3.0', () => {}, { env: { APPIMAGE: img }, platform: 'linux' });
    assert.equal(fetched, 'https://example.invalid/a');
    assert.equal(r.appImage, img);
    assert.equal(r.tag, '9.9.9');
    assert.equal(fs.readFileSync(img, 'utf8'), 'v9.9.9 image');
    assert.deepEqual(fs.readdirSync(mount), [], 'nothing staged in the mount');
  } finally {
    Object.assign(github, real);
  }
});
