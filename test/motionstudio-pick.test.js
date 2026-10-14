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
  assert.equal(findPickArgument(['/x/Sound Shelf', '--pick-request', '/p/r.txt']), '/p/r.txt');
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
