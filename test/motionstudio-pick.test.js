const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findPickArgument, parseKeyValues, escapeValue, unescapeValue, loadPickRequest, writePickReply, pickDirectory, placeScriptPath } = require('../src/motionstudio-pick');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-home-'));
  const dir = pickDirectory(home);
  fs.mkdirSync(dir, { recursive: true });
  return { home, dir };
}

function request(dir, extra = {}) {
  const values = { version: '1', app: 'MotionStudio', slot: 'in', label: 'Motion Studio · In Sound', cueId: 'abc', reply: path.join(dir, 'reply-abc-in.txt'), ...extra };
  const file = path.join(dir, 'request-abc-in.txt');
  fs.writeFileSync(file, `# Motion Studio -> Sound Shelf pick request\n${Object.entries(values).map(([k, v]) => `${k}=${escapeValue(v)}`).join('\n')}\n`);
  return file;
}

test('finds the pick request argument', () => {
  const req = '/Users/u/Library/Application Support/MotionStudio/pick/request-abc-in.txt';
  assert.equal(findPickArgument(['/x/Sound Shelf', `--pick-request=${req}`]), req);
  assert.equal(findPickArgument(['/x/Sound Shelf', '--pick-request', req]), req);
  // second-instance 실측 순서: 스위치는 앞으로, 경로는 맨 뒤로
  assert.equal(findPickArgument(['/x/Electron', '--pick-request', '--allow-file-access-from-files', '--enable-avfoundation', '.', req]), req);
  assert.equal(findPickArgument(['/x/Sound Shelf', '--pick-request', '/p/r.txt']), null);
  assert.equal(findPickArgument(['/x/Sound Shelf', req]), null);
  assert.equal(findPickArgument(['/x/Sound Shelf']), null);
  assert.equal(findPickArgument(['--pick-request']), null);
});

test('key=value escaping matches Motion Studio', () => {
  assert.equal(unescapeValue(escapeValue('a\\b\nc')), 'a\\b\nc');
  assert.deepEqual(parseKeyValues('# c\nslot=in\nbad\n=x\npath=/a b/c.wav\r\n'), { slot: 'in', path: '/a b/c.wav' });
});

test('loads a valid request inside the pick folder', () => {
  const { home, dir } = sandbox();
  const r = loadPickRequest(request(dir), { home });
  assert.equal(r.slot, 'in');
  assert.equal(r.label, 'Motion Studio · In Sound');
  assert.equal(r.reply, path.join(fs.realpathSync(dir), 'reply-abc-in.txt'));
});

test('rejects requests outside the pick folder or with a bad reply path', () => {
  const { home, dir } = sandbox();
  const outside = path.join(home, 'request.txt');
  fs.copyFileSync(request(dir), outside);
  assert.throws(() => loadPickRequest(outside, { home }), /위치/);
  assert.throws(() => loadPickRequest(request(dir, { reply: path.join(home, 'evil.txt') }), { home }), /응답/);
  assert.throws(() => loadPickRequest(request(dir, { reply: path.join(dir, 'x.sh') }), { home }), /응답/);
  assert.throws(() => loadPickRequest(request(dir, { slot: 'mid' }), { home }), /슬롯/);
  assert.throws(() => loadPickRequest(request(dir, { app: 'Other' }), { home }), /지원하지/);
});

test('writes the reply the plugin reads', async () => {
  const { home, dir } = sandbox();
  const r = loadPickRequest(request(dir), { home });
  await writePickReply(r, { path: '/Sounds/Pop\\1.wav', title: 'Pop 1' });
  const reply = parseKeyValues(fs.readFileSync(r.reply, 'utf8'));
  assert.equal(reply.path, '/Sounds/Pop\\1.wav');
  assert.equal(reply.name, 'Pop 1');
  assert.ok(!fs.existsSync(`${r.reply}.tmp`));
});

test('placement script path is the fixed Resolve Utility script', () => {
  assert.equal(placeScriptPath('/Users/u'), '/Users/u/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/Motion Studio Sounds.py');
});

// ---- Motion 프리셋(모션 + 효과음) ----
const { readPreset, listPresets, updatePresetKeys, soundValues, savePresetAs, writePresetReply, autoAlignFor, presetRoot, soundRoot } = require('../src/motionstudio-pick');

function presetSandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-home-'));
  const dir = path.join(presetRoot(home), 'Reference');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Price Pop.mspreset');
  fs.writeFileSync(file, '# MotionStudio preset\ncategory=Reference\nname=Price Pop\nmsInFamily=zoom\nmsInVariant=pop\nmsInSound=Pops/pop.wav\nmsInSoundVol=-6\nmsInSoundHit=0.12\nmsOutFamily=slide\nmsOutVariant=slide.left\n');
  return { home, dir, file };
}

test('reads a preset with sound settings and the effective sync moment', () => {
  const { home, file } = presetSandbox();
  const p = readPreset(file, { home });
  assert.equal(p.category, 'Reference');
  assert.equal(p.name, 'Price Pop');
  assert.equal(p.in.soundPath, path.join(soundRoot(home), 'Pops/pop.wav'));
  assert.equal(p.in.volume, -6);
  assert.equal(p.in.hit, 0.12);
  assert.equal(p.in.align, 0);
  assert.equal(p.in.effectiveAlign, 3);   // zoom → 도착
  assert.equal(p.out.effectiveAlign, 2);  // slide → 가장 빠른 순간
  assert.equal(p.out.sound, '');
  assert.equal(listPresets({ home }).length, 1);
  assert.throws(() => readPreset(path.join(home, 'x.mspreset'), { home }), /폴더 밖/);
});

test('auto sync moment follows the Motion Studio rule', () => {
  assert.equal(autoAlignFor('droprise'), 3);
  assert.equal(autoAlignFor('flip'), 3);
  assert.equal(autoAlignFor('spin'), 2);
  assert.equal(autoAlignFor('reference'), 2);
  assert.equal(autoAlignFor('fade'), 1);
  assert.equal(autoAlignFor('reveal'), 1);
});

test('updates only the given keys and keeps comments and order', async () => {
  const { home, file } = presetSandbox();
  const values = soundValues('Out', { sound: '/Lib/whoosh.wav', volume: '-3.5', hit: -1, align: 9, offset: 0.033 });
  assert.deepEqual(values, { msOutSound: '/Lib/whoosh.wav', msOutSoundVol: '-3.5', msOutSoundOffset: '0.033', msOutSoundHit: '0', msOutSoundAlign: '3' });
  const p = await updatePresetKeys(file, { ...values, msInSoundHit: '0.2' }, { home });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('# MotionStudio preset\ncategory=Reference\n'));
  assert.equal(text.match(/msInSoundHit=/g).length, 1);
  assert.equal(p.in.hit, 0.2);
  assert.equal(p.out.soundPath, '/Lib/whoosh.wav');
  assert.equal(p.out.align, 3);
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('save as copies the preset under a new safe name', async () => {
  const { home, file } = presetSandbox();
  const copy = await savePresetAs(file, 'Reference', 'Price/Pop 2', { home });
  assert.equal(copy.name, 'Price-Pop 2');
  assert.equal(copy.in.hit, 0.12);
  assert.ok(fs.existsSync(path.join(presetRoot(home), 'Reference', 'Price-Pop 2.mspreset')));
  await assert.rejects(() => savePresetAs(file, 'Reference', 'Price-Pop 2', { home }), /이미/);
});

test('preset requests are accepted and the reply names the preset file', async () => {
  const { home, dir } = sandbox();
  const r = loadPickRequest(request(dir, { slot: 'preset', fps: '24', preset: 'Reference/Price Pop' }), { home });
  assert.equal(r.slot, 'preset');
  assert.equal(r.fps, 24);
  assert.equal(r.preset, 'Reference/Price Pop');
  await writePresetReply(r, '/p/Reference/Price Pop.mspreset');
  assert.equal(parseKeyValues(fs.readFileSync(r.reply, 'utf8')).preset, '/p/Reference/Price Pop.mspreset');
});
