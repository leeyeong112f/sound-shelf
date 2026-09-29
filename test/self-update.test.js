const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  SWAP_SCRIPT,
  bundlePathFromExecutable,
  isUpdateLeftover,
  manifestChecksum,
  parseUpdateManifest,
  pickReleaseAssets,
  previousBundlePath,
  selfUpdateBlocker,
  stagingDirectory,
  swapScriptArguments
} = require('../src/self-update');

const asset = (name, size = 10) => ({
  name,
  size,
  browser_download_url: `https://github.com/leeyeong112f/sound-shelf/releases/download/v0.1.57/${name}`
});

const RELEASE = {
  tag_name: 'v0.1.57',
  html_url: 'https://github.com/leeyeong112f/sound-shelf/releases/tag/v0.1.57',
  assets: [
    asset('latest-mac.yml', 525),
    asset('Sound-Shelf-0.1.57-universal.dmg', 221140515),
    asset('Sound-Shelf-0.1.57-universal.dmg.blockmap', 229792),
    asset('Sound-Shelf-0.1.57-universal.zip', 219962440),
    asset('Sound-Shelf-0.1.57-universal.zip.blockmap', 228976)
  ]
};

const MANIFEST = `version: 0.1.57
files:
  - url: Sound-Shelf-0.1.57-universal.zip
    sha512: L/lGg2J0FPOpV+/BX2eQa3Il/71uqTwBAgvKynVFU12ehgqWfVZbjWOoSV/6DtTbeKVOIlgLKyMqBvMBG6gJOw==
    size: 219962440
  - url: Sound-Shelf-0.1.57-universal.dmg
    sha512: tHLczOd+yx1p3Ts85C376+fGPOB1AKp5uDk/f9RzWOQ/0hugZhdz75U8oKTpVbDG1onlK1jqNHoO11MXwCAM9g==
    size: 221140515
path: Sound-Shelf-0.1.57-universal.zip
sha512: L/lGg2J0FPOpV+/BX2eQa3Il/71uqTwBAgvKynVFU12ehgqWfVZbjWOoSV/6DtTbeKVOIlgLKyMqBvMBG6gJOw==
releaseDate: '2026-09-28T01:51:53.595Z'
`;

test('릴리스에서 universal zip 과 매니페스트를 고르고 blockmap 은 무시한다', () => {
  const picked = pickReleaseAssets(RELEASE, { arch: 'arm64' });
  assert.equal(picked.version, '0.1.57');
  assert.equal(picked.url, RELEASE.html_url);
  assert.equal(picked.zip.name, 'Sound-Shelf-0.1.57-universal.zip');
  assert.equal(picked.zip.size, 219962440);
  assert.match(picked.zip.url, /universal\.zip$/);
  assert.equal(picked.manifest.name, 'latest-mac.yml');
});

test('universal zip 이 없으면 현재 아키텍처 zip 으로 대체한다', () => {
  const release = { tag_name: 'v0.2.0', assets: [asset('Sound-Shelf-0.2.0-x64.zip'), asset('Sound-Shelf-0.2.0-arm64.zip')] };
  assert.equal(pickReleaseAssets(release, { arch: 'arm64' }).zip.name, 'Sound-Shelf-0.2.0-arm64.zip');
  assert.equal(pickReleaseAssets(release, { arch: 'x64' }).zip.name, 'Sound-Shelf-0.2.0-x64.zip');
});

test('설치 파일이 없는 릴리스는 zip 과 매니페스트가 null 이다', () => {
  const picked = pickReleaseAssets({ tag_name: 'v0.3.0', assets: [asset('Sound-Shelf-0.3.0.dmg')] });
  assert.equal(picked.version, '0.3.0');
  assert.equal(picked.zip, null);
  assert.equal(picked.manifest, null);
  assert.deepEqual(pickReleaseAssets(null), { version: '', url: '', zip: null, manifest: null });
});

test('latest-mac.yml 에서 파일별 sha512 를 읽는다', () => {
  const manifest = parseUpdateManifest(MANIFEST);
  assert.equal(manifest.version, '0.1.57');
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files[0].url, 'Sound-Shelf-0.1.57-universal.zip');
  assert.equal(manifest.files[0].size, 219962440);
  assert.equal(
    manifestChecksum(manifest, 'Sound-Shelf-0.1.57-universal.zip'),
    'L/lGg2J0FPOpV+/BX2eQa3Il/71uqTwBAgvKynVFU12ehgqWfVZbjWOoSV/6DtTbeKVOIlgLKyMqBvMBG6gJOw=='
  );
  assert.equal(
    manifestChecksum(manifest, 'Sound-Shelf-0.1.57-universal.dmg'),
    'tHLczOd+yx1p3Ts85C376+fGPOB1AKp5uDk/f9RzWOQ/0hugZhdz75U8oKTpVbDG1onlK1jqNHoO11MXwCAM9g=='
  );
  assert.equal(manifestChecksum(manifest, 'missing.zip'), null);
});

test('빈 매니페스트를 안전하게 처리한다', () => {
  assert.deepEqual(parseUpdateManifest(''), { version: '', files: [] });
  assert.deepEqual(parseUpdateManifest(null), { version: '', files: [] });
  assert.equal(manifestChecksum(null, 'a.zip'), null);
});

test('실행 파일 경로에서 .app 번들을 찾는다', () => {
  assert.equal(
    bundlePathFromExecutable('/Applications/Sound Shelf.app/Contents/MacOS/Sound Shelf'),
    '/Applications/Sound Shelf.app'
  );
  assert.equal(bundlePathFromExecutable('/usr/local/bin/electron'), null);
  assert.equal(bundlePathFromExecutable('/x/Sound Shelf.app/Contents/Frameworks/Helper'), null);
  assert.equal(bundlePathFromExecutable(''), null);
});

test('자체 교체가 가능한 조건에서만 차단 사유가 없다', () => {
  const ok = { platform: 'darwin', packaged: true, bundlePath: '/Applications/Sound Shelf.app', writable: true };
  assert.equal(selfUpdateBlocker(ok), null);
  assert.match(selfUpdateBlocker({ ...ok, platform: 'linux' }), /macOS/);
  assert.match(selfUpdateBlocker({ ...ok, packaged: false }), /개발 실행/);
  assert.match(selfUpdateBlocker({ ...ok, bundlePath: null }), /번들 위치/);
  assert.match(
    selfUpdateBlocker({ ...ok, bundlePath: '/private/var/folders/x/AppTranslocation/1234/d/Sound Shelf.app' }),
    /응용 프로그램 폴더로 옮긴/
  );
  assert.match(selfUpdateBlocker({ ...ok, writable: false }), /쓸 수 없어/);
});

test('준비 폴더와 이전 번들 경로를 앱 옆에 둔다', () => {
  assert.equal(stagingDirectory('/Applications/Sound Shelf.app', '0.1.58'), '/Applications/.sound-shelf-update-0.1.58');
  assert.equal(previousBundlePath('/Applications/Sound Shelf.app'), '/Applications/Sound Shelf.app.previous');
  assert.equal(isUpdateLeftover('.sound-shelf-update-0.1.58', 'Sound Shelf.app'), true);
  assert.equal(isUpdateLeftover('Sound Shelf.app.previous', 'Sound Shelf.app'), true);
  assert.equal(isUpdateLeftover('Sound Shelf.app', 'Sound Shelf.app'), false);
  assert.equal(isUpdateLeftover('Other.app.previous', 'Sound Shelf.app'), false);
});

test('교체 스크립트 인자는 pid, 현재 번들, 새 번들, 재실행 순서다', () => {
  assert.deepEqual(
    swapScriptArguments({ pid: 42, bundlePath: '/A/S.app', stagedBundlePath: '/A/.sound-shelf-update-1/S.app', relaunch: true }),
    ['sh', '42', '/A/S.app', '/A/.sound-shelf-update-1/S.app', '1', '', '60']
  );
  assert.equal(swapScriptArguments({ pid: 1, bundlePath: '/a', stagedBundlePath: '/b', relaunch: false })[4], '0');
  assert.equal(swapScriptArguments({ pid: 1, bundlePath: '/a', stagedBundlePath: '/b', relaunch: false, logFile: '/L/x.log' })[5], '/L/x.log');
  assert.equal(swapScriptArguments({ pid: 1, bundlePath: '/a', stagedBundlePath: '/b', relaunch: false, graceSeconds: 2 })[6], '2');
});

function makeBundle(dir, version) {
  fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Contents', 'Info.plist'), `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
}

function runSwap(args) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', SWAP_SCRIPT, ...args], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code));
  });
}

test('교체 스크립트는 앱이 끝난 뒤 번들을 바꿔 끼우고 흔적을 지운다', { skip: process.platform !== 'darwin' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-shelf-swap-'));
  const bundle = path.join(root, 'Sound Shelf.app');
  const staging = stagingDirectory(bundle, '0.2.0');
  const staged = path.join(staging, 'Sound Shelf.app');
  makeBundle(bundle, '0.1.0');
  makeBundle(staged, '0.2.0');
  // 앱 프로세스 역할: 잠시 살아 있다가 끝난다.
  const fake = spawn('/bin/sleep', ['0.6'], { stdio: 'ignore' });
  const logFile = path.join(root, 'self-update.log');
  const code = await runSwap(swapScriptArguments({ pid: fake.pid, bundlePath: bundle, stagedBundlePath: staged, relaunch: false, logFile }));
  assert.equal(code, 0);
  assert.match(fs.readFileSync(logFile, 'utf8'), /swap start[\s\S]*swap done/);
  assert.match(fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8'), /0\.2\.0/);
  assert.equal(fs.existsSync(previousBundlePath(bundle)), false);
  assert.equal(fs.existsSync(staging), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('앱이 유예 시간 안에 끝나지 않으면 직접 끝내고 교체한다', { skip: process.platform !== 'darwin' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-shelf-swap-'));
  const bundle = path.join(root, 'Sound Shelf.app');
  const staged = path.join(stagingDirectory(bundle, '0.2.0'), 'Sound Shelf.app');
  makeBundle(bundle, '0.1.0');
  makeBundle(staged, '0.2.0');
  // 종료 중 멈춘 앱 역할: 신호를 받지 않으면 오래 살아 있다.
  const stuck = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  const logFile = path.join(root, 'self-update.log');
  const started = Date.now();
  const code = await runSwap(swapScriptArguments({ pid: stuck.pid, bundlePath: bundle, stagedBundlePath: staged, relaunch: false, logFile, graceSeconds: 1 }));
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 15000);
  assert.equal(stuck.exitCode === null && stuck.signalCode === null, false);
  assert.match(fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8'), /0\.2\.0/);
  assert.match(fs.readFileSync(logFile, 'utf8'), /sending TERM[\s\S]*swap done/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('새 번들이 없으면 원래 번들을 되돌리고 실패한다', { skip: process.platform !== 'darwin' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-shelf-swap-'));
  const bundle = path.join(root, 'Sound Shelf.app');
  makeBundle(bundle, '0.1.0');
  const fake = spawn('/bin/sleep', ['0.2'], { stdio: 'ignore' });
  const code = await runSwap(swapScriptArguments({ pid: fake.pid, bundlePath: bundle, stagedBundlePath: path.join(root, 'missing', 'S.app'), relaunch: false }));
  assert.equal(code, 1);
  assert.match(fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8'), /0\.1\.0/);
  assert.equal(fs.existsSync(previousBundlePath(bundle)), false);
  fs.rmSync(root, { recursive: true, force: true });
});
