'use strict';

// Self-update, Squirrel.Windows style: a new version is a brand-new sibling folder
// (<root>/app-<version>/), created by plain extraction — nothing a process is running from
// is ever renamed or deleted. The launcher at <root> hands off on start to the newest app-*
// folder that is newer than itself. Old app-* folders are removed on a later start, once
// nothing runs from them. The only binary ever executed is this same signed build (no
// helper, no shell, no script).
//
// Layout (the flat unzip-and-run install simply becomes the launcher on the first update):
//   <root>/git-updater[.exe]            launcher (the original flat install, never touched)
//   <root>/app-0.1.6/git-updater[.exe]  the version actually running
//
// Windows and Linux both work this way, and the reason it is safe is the INDIRECTION: the
// running process reads from app-x.y.z, and an update writes a NEW sibling directory and
// repoints the launcher. Nothing ever replaces the directory being read from.
//
// macOS has no equivalent, because the .app bundle IS the unit the system launches. There
// is nowhere to put a launcher that is not itself inside the thing being replaced. So
// canApply() is false there and the UI offers the release page instead.
//
// An earlier version of this comment said the swap breaks signature continuity. That was
// measured on hardware and is FALSE: a swapped-in bundle verifies as valid, the running
// process survives, and a relaunch picks up the new version correctly. A real signed
// Electron app also survived the swap outright — four processes, 30 seconds, old
// directory deleted underneath it, no crash.
//
// So the case against an in-place macOS self-update rests on the indirection argument
// above, which needs no hardware, and NOT on a crash nobody has observed. What is left is
// a version mismatch — the running process keeps executing code it loaded before the
// swap, while its own bundle path now serves different files — that we could not provoke
// a failure from. checkForUpdate() still reports new versions on every platform.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./core');
const github = require('./github');
const install = require('./install');
const state = require('./state');
const paths = require('./paths');
const { log } = require('./log');

// Overridable for testing against a repo other than the real one.
const REPO_OWNER = process.env.GITUPDATER_SELFUPDATE_OWNER || 'PlayingKarrde';
const REPO_NAME = process.env.GITUPDATER_SELFUPDATE_REPO || 'git-updater';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const EXE = IS_WIN ? 'git-updater.exe' : 'git-updater';

// --- AppImage ------------------------------------------------------------------
// Run as an AppImage, process.execPath is inside the image's read-only squashfs mount
// (/tmp/.mount_XXXX/), which also vanishes when the process exits — so the app-<version>
// sibling model has nowhere to write and nothing to hand off to (EROFS on mkdtemp). The
// AppImage runtime exports the image's own path as $APPIMAGE, and that FILE is the unit
// to update: write the new image beside it and rename it over the old one. A rename never
// disturbs the running copy (its mount holds the old inode), and the user's shortcut,
// desktop entry or terminal habit keeps pointing at the same path.
function appImageFile(env = process.env, platform = process.platform) {
  const p = platform === 'linux' && env.APPIMAGE;
  if (!p || !path.isAbsolute(p)) return null;
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

function dirWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Whether a found update can be APPLIED in place on this platform, or only reported. An
// AppImage in a folder the user cannot write (e.g. /opt, installed by root) is reported
// only, and the UI offers the release page.
const canApply = (env = process.env, platform = process.platform) => {
  if (platform === 'darwin') return false;
  const img = appImageFile(env, platform);
  return img ? dirWritable(path.dirname(img)) : true;
};
const VERSION_DIR = /^app-(\d.*)$/;
const STAGE_PREFIX = '.git-updater-selfupdate-stage-';
const SELF_ROOT = path.join(paths.dataDir(), 'self-update');
const APPLY_MARKER = path.join(SELF_ROOT, 'last-apply.json');
const DAY_MS = 24 * 60 * 60 * 1000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Inside Electron, Node's fs is patched to treat any path containing ".asar" as an archive —
// so writing, chmod-ing, or deleting the new build's resources\app.asar fails (ENOENT/ENOTDIR).
// process.noAsar turns that patch off; a no-op under plain Node.
async function withoutAsar(fn) {
  const prev = process.noAsar;
  process.noAsar = true;
  try {
    return await fn();
  } finally {
    process.noAsar = prev;
  }
}

// --- layout -------------------------------------------------------------------

// Where the install root is, given the running exe: either the launcher itself
// (<root>\git-updater.exe) or a versioned copy (<root>\app-x.y.z\git-updater.exe).
function layout(execPath) {
  const dir = path.dirname(execPath);
  const m = VERSION_DIR.exec(path.basename(dir));
  return m ? { root: path.dirname(dir), versionDir: dir } : { root: dir, versionDir: null };
}

// app-* folders under root that contain the exe, newest first.
function listVersions(root) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = VERSION_DIR.exec(name);
    if (!m) continue;
    const dir = path.join(root, name);
    if (fs.existsSync(path.join(dir, EXE))) out.push({ version: m[1], dir });
  }
  return out.sort((a, b) => core.cmpVersion(b.version, a.version));
}

// The version folder the launcher should hand off to, or null to run itself.
function newestNewerThan(root, currentVersion) {
  const top = listVersions(root)[0];
  return top && core.cmpVersion(top.version, currentVersion) > 0 ? top : null;
}

// Hand-off decision for the running exe. Never hands off to the folder it is already running
// from — a folder whose name overstates the build inside would otherwise relaunch forever.
function handoffTarget(execPath, currentVersion) {
  const { root, versionDir } = layout(execPath);
  const target = newestNewerThan(root, currentVersion);
  return target && target.dir !== versionDir ? target : null;
}

// A freshly extracted Electron build needs its launcher marked executable, and on Linux
// its bundled chrome-sandbox too — without them the new version refuses to start, which
// looks exactly like a corrupt update. The archive normally carries these bits and
// extractArchive preserves them; this is the belt-and-braces pass for an archive built
// without Unix attributes.
function makeExecutable(dir) {
  if (IS_WIN) return;
  for (const rel of [EXE, 'chrome-sandbox']) {
    const p = path.join(dir, rel);
    try {
      if (fs.existsSync(p)) fs.chmodSync(p, rel === 'chrome-sandbox' ? 0o4755 : 0o755);
    } catch {}
  }
}

// Errors that mean "another process is holding a handle" — a real-time scanner mid-scan,
// not a genuine conflict — so a copy that only needs read access can still get through.
const RENAME_LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

// Move the freshly extracted build to its final app-<tag> folder. The self-update payload
// is ~150 MB of just-written executables, and on an EDR-managed machine a real-time scan
// can hold handles on them for many seconds — well past install.js's default ~1.5 s retry
// budget — so an exclusive directory rename (MoveFileEx) keeps failing with EPERM even
// though nothing legitimately owns the folder. Give the rename a much longer window here,
// then fall back to a plain recursive copy: a copy only needs READ access, which the
// scanner allows concurrently, whereas the move demands exclusive access it will not yield.
function moveIntoPlace(srcDir, target, opts = {}) {
  const waits = opts.waits || [200, 400, 800, 1600, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]; // ~19 s
  try {
    install.renameWithRetry(srcDir, target, { ...opts, waits });
  } catch (e) {
    if (!RENAME_LOCKED.has(e.code)) throw e;
    log(`  self-update: rename blocked (${e.code}) after retries; copying into place instead`);
    fs.rmSync(target, { recursive: true, force: true }); // clear any partial the failed move left
    fs.cpSync(srcDir, target, { recursive: true });
    makeExecutable(target); // cpSync should carry the mode, but re-assert it to be safe
  }
}

function launch(dir, args = []) {
  spawn(path.join(dir, EXE), args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

// `--wait-pid <pid>`: the relaunch after an update — wait for the updating process to exit
// (it still holds the single-instance lock) before handing off to the new version.
function waitPidArg(argv) {
  const i = argv.indexOf('--wait-pid');
  const pid = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function waitForExit(pid, deps = {}) {
  const alive = deps.pidAlive || state.pidAlive;
  const sleep = deps.wait || wait;
  for (let i = 0; i < 150 && alive(pid); i++) await sleep(200); // ~30s ceiling
  return !alive(pid);
}

// --- check --------------------------------------------------------------------

// The assets this updater can update ITSELF from, which is a narrower set than the ones
// it can install for other apps.
//
// (A run FROM an AppImage updates the image file itself instead — see appImageFile.)
// The launcher model needs a DIRECTORY: app-<version>/ containing an executable named
// git-updater, sitting beside the launcher. An AppImage is a single self-contained file,
// so there is nothing to put a versioned sibling inside and nothing at app-<version>/
// git-updater to hand off to. The generic asset picker prefers an AppImage on Linux —
// correctly, for a tracked app — so our own release would have been picked as the one
// shape this mechanism cannot use, and prepareUpdate would fail at the "downloaded build
// has no git-updater" check after downloading the whole thing.
//
// Dropping it here rather than teaching the picker about it: preferring an AppImage is
// right for every OTHER app, and this is the only caller with a layout requirement.
function selfUpdateAssets(assets) {
  const list = assets || [];
  const usable = list.filter((a) => !/\.appimage$/i.test(a.name || ''));
  // If a release somehow ships nothing else, let the picker report that rather than
  // throwing "no assets" from here with less context.
  return usable.length ? usable : list;
}

// opts.prerelease: when true, the newest release INCLUDING betas/prereleases is considered
// (the self-update beta channel); otherwise only the latest stable release, GitHub's default.
async function checkForUpdate(currentVersion, opts = {}) {
  const rel = await github.getLatestRelease(REPO_OWNER, REPO_NAME, opts.prerelease ? { prerelease: true } : {});
  const tag = core.normTag(rel.tag_name || '');
  return core.cmpVersion(tag, currentVersion) > 0 ? { rel, version: tag } : null;
}

// --- prepare: download + verify + extract into <root>\app-<tag> -----------------

// Runs in the running process. Extracts into a stage dir under root, then renames it to
// its final app-<tag> name — a rename of a fresh, unreferenced folder into a path that
// never existed, the same operation every tracked-app fresh install already does. A
// failure anywhere leaves the running version and the launcher completely untouched.
async function prepareUpdate(root, currentVersion, onProgress = () => {}, opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const img = appImageFile(env, platform);
  if (!canApply(env, platform)) {
    throw new Error(
      img
        ? `can't replace ${img} — its folder is not writable. Download the new version from the release page instead.`
        : 'applying an update in place is not supported on this platform'
    );
  }
  const found = await checkForUpdate(currentVersion, opts);
  if (!found) throw new Error('no newer release found');
  const { rel, version: tag } = found;

  const asset = img ? appImageAsset(rel.assets) : core.pickAsset(selfUpdateAssets(rel.assets), 'portable');

  const downloadDir = path.join(SELF_ROOT, tag);
  fs.mkdirSync(downloadDir, { recursive: true });
  const file = path.join(downloadDir, asset.name);

  onProgress('downloading', 0);
  await github.downloadAsset(asset.browser_download_url, file, (pct) => onProgress('downloading', pct));

  onProgress('verifying');
  let digest = asset.digest;
  if (!digest) {
    const sums = await github.fetchChecksumFromRelease(rel, asset.name);
    if (sums) digest = `${sums.algo}:${sums.expected}`;
  }
  const v = github.verifyDigest(file, digest);
  if (v && v.skipped) log(`  WARN self-update: ${v.note}`);

  onProgress('installing');
  if (img) {
    replaceFile(file, img);
    fs.rmSync(downloadDir, { recursive: true, force: true });
    log(`self-update: ${tag} written to ${img}`);
    return { tag, dir: path.dirname(img), appImage: img };
  }
  const target = path.join(root, `app-${tag}`);
  await withoutAsar(async () => {
    fs.rmSync(target, { recursive: true, force: true }); // a previous partial attempt
    const stage = fs.mkdtempSync(path.join(root, STAGE_PREFIX));
    try {
      const { srcDir } = await install.extractArchive(file, stage);
      if (!fs.existsSync(path.join(srcDir, EXE))) throw new Error(`downloaded build has no ${EXE}`);
      makeExecutable(srcDir);
      moveIntoPlace(srcDir, target);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });
  fs.rmSync(downloadDir, { recursive: true, force: true });
  log(`self-update: ${tag} extracted to ${target}`);
  return { tag, dir: target };
}

// The AppImage among a release's assets for this machine's architecture.
function appImageAsset(assets) {
  const list = (assets || []).filter((a) => /\.appimage$/i.test(a.name || ''));
  if (!list.length) throw new Error('this release has no AppImage to update to — download it from the release page');
  return core.pickAsset(list, 'portable', null, null, 'linux');
}

// Copy beside the target (same filesystem, so the final step is an atomic rename), mark it
// executable, then rename over the old image. The running process keeps its mount of the
// old inode; the next launch of the same path gets the new build.
function replaceFile(src, target) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.new-${process.pid}`);
  try {
    fs.copyFileSync(src, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// The AppImage runtime's own variables, and library paths into THIS image's mount, must
// not leak into the relaunched image: its runtime sets fresh ones, and the old mount is
// gone the moment this process exits.
function relaunchEnv(env = process.env) {
  const out = { ...env };
  const appDir = env.APPDIR;
  for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete out[k];
  if (appDir) {
    for (const k of ['LD_LIBRARY_PATH', 'PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR', 'PYTHONPATH', 'PERLLIB', 'QT_PLUGIN_PATH']) {
      if (out[k] == null) continue;
      const kept = String(out[k]).split(':').filter((p) => p && !p.startsWith(appDir));
      if (kept.length) out[k] = kept.join(':');
      else delete out[k];
    }
  }
  return out;
}

// The launcher restarts the app into the newest version once this process is gone. An
// AppImage relaunches its own (now replaced) file instead — there is no launcher folder.
function relaunchViaLauncher(root, pid, env = process.env) {
  const img = appImageFile(env);
  if (img) {
    spawn(img, ['--wait-pid', String(pid)], { detached: true, stdio: 'ignore', env: relaunchEnv(env) }).unref();
    return;
  }
  launch(root, ['--wait-pid', String(pid)]);
}

// --- post-relaunch version check ----------------------------------------------

function writeApplyMarker({ expectVersion }) {
  try {
    fs.mkdirSync(SELF_ROOT, { recursive: true });
    fs.writeFileSync(APPLY_MARKER, JSON.stringify({ expectVersion, appliedAt: new Date().toISOString() }));
  } catch {}
}

// Reads + deletes the marker once. null when none is present (the normal case).
function consumeApplyMarker(actualVersion) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(APPLY_MARKER, 'utf8'));
  } catch {
    return null;
  }
  try {
    fs.rmSync(APPLY_MARKER, { force: true });
  } catch {}
  if (!data || !data.expectVersion) return null;
  return {
    ok: core.normTag(actualVersion) === core.normTag(data.expectVersion),
    expectVersion: data.expectVersion,
    actualVersion,
  };
}

// --- startup cleanup -----------------------------------------------------------

// Best-effort, never throws. Removes app-* folders OLDER than the running version (nothing
// runs from them any more — a still-exiting one just fails with EBUSY and is retried next
// start), any stage dir (only ever live during an update in THIS process), and day-old
// downloads.
async function cleanupLeftovers(root, currentVersion) {
  const dayAgo = Date.now() - DAY_MS;
  const sweep = (dir, matches, minAgeMs) => {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!matches(name)) continue;
      const p = path.join(dir, name);
      try {
        if (!minAgeMs || fs.statSync(p).mtimeMs < dayAgo) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  };
  await withoutAsar(async () => {
    for (const v of listVersions(root)) {
      if (core.cmpVersion(v.version, currentVersion) >= 0) continue;
      try {
        fs.rmSync(v.dir, { recursive: true, force: true });
      } catch {}
    }
    sweep(root, (name) => name.startsWith(STAGE_PREFIX), 0);
  });
  sweep(SELF_ROOT, (name) => name !== path.basename(APPLY_MARKER), DAY_MS);
}

module.exports = {
  selfUpdateAssets,
  appImageFile,
  appImageAsset,
  replaceFile,
  relaunchEnv,
  REPO: { owner: REPO_OWNER, repo: REPO_NAME },
  canApply,
  makeExecutable,
  moveIntoPlace,
  layout,
  listVersions,
  newestNewerThan,
  handoffTarget,
  launch,
  waitPidArg,
  waitForExit,
  checkForUpdate,
  prepareUpdate,
  relaunchViaLauncher,
  writeApplyMarker,
  consumeApplyMarker,
  cleanupLeftovers,
};
