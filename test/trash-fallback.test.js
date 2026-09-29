const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { moveToTrash, trashDestination, userTrashDirectory } = require('../src/trash-fallback');

const denied = async () => { throw new Error('연결할 수 있는 권한이 없기 때문에 휴지통으로 이동할 수 없습니다.'); };

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-shelf-trash-'));
  const trashDir = path.join(root, 'Trash');
  fs.mkdirSync(trashDir);
  return { root, trashDir };
}

test('휴지통 폴더는 홈의 .Trash 다', () => {
  assert.equal(userTrashDirectory('/Users/me'), '/Users/me/.Trash');
  assert.throws(() => userTrashDirectory(''), /홈 폴더/);
});

test('휴지통에 같은 이름이 있으면 번호를 붙인다', () => {
  const taken = new Set(['/T/a.wav', '/T/a 2.wav']);
  assert.equal(trashDestination('/T', 'a.wav', (p) => taken.has(p)), '/T/a 3.wav');
  assert.equal(trashDestination('/T', 'b.wav', (p) => taken.has(p)), '/T/b.wav');
  assert.equal(trashDestination('/T', 'folder', () => false), '/T/folder');
});

test('시스템 휴지통 이동이 되면 그것을 쓴다', async () => {
  const { root, trashDir } = scratch();
  const file = path.join(root, 'x.wav');
  fs.writeFileSync(file, 'x');
  const calls = [];
  const result = await moveToTrash(file, { trashItem: async (p) => { calls.push(p); fs.unlinkSync(p); }, trashDir });
  assert.equal(result.method, 'system');
  assert.deepEqual(calls, [file]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('거부되면 rename 으로 휴지통에 넣는다', async () => {
  const { root, trashDir } = scratch();
  const file = path.join(root, '일론머스크 예언.mp3');
  fs.writeFileSync(file, 'audio');
  const result = await moveToTrash(file, { trashItem: denied, trashDir });
  assert.equal(result.method, 'rename');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(trashDir, '일론머스크 예언.mp3'), 'utf8'), 'audio');
  fs.rmSync(root, { recursive: true, force: true });
});

test('휴지통에 같은 이름이 있으면 덮어쓰지 않고 번호를 붙인다', async () => {
  const { root, trashDir } = scratch();
  fs.writeFileSync(path.join(trashDir, 'a.wav'), 'old');
  const file = path.join(root, 'a.wav');
  fs.writeFileSync(file, 'new');
  const result = await moveToTrash(file, { trashItem: denied, trashDir });
  assert.equal(result.destination, path.join(trashDir, 'a 2.wav'));
  assert.equal(fs.readFileSync(path.join(trashDir, 'a.wav'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(trashDir, 'a 2.wav'), 'utf8'), 'new');
  fs.rmSync(root, { recursive: true, force: true });
});

test('폴더도 통째로 휴지통에 넣는다', async () => {
  const { root, trashDir } = scratch();
  const folder = path.join(root, '예능 효과음');
  fs.mkdirSync(path.join(folder, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'inner', 'b.wav'), 'b');
  const result = await moveToTrash(folder, { trashItem: denied, trashDir });
  assert.equal(result.method, 'rename');
  assert.equal(fs.existsSync(folder), false);
  assert.equal(fs.readFileSync(path.join(trashDir, '예능 효과음', 'inner', 'b.wav'), 'utf8'), 'b');
  fs.rmSync(root, { recursive: true, force: true });
});

test('파일이 없으면 원래 오류를 그대로 던진다', async () => {
  const { root, trashDir } = scratch();
  await assert.rejects(moveToTrash(path.join(root, 'missing.wav'), { trashItem: denied, trashDir }), /연결할 수 있는 권한/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('폴백까지 실패하면 원래 오류를 던지고 복사본을 남기지 않는다', async () => {
  const { root, trashDir } = scratch();
  const file = path.join(root, 'c.wav');
  fs.writeFileSync(file, 'c');
  // 휴지통 폴더를 없애 rename 과 복사가 모두 실패하게 한다.
  fs.rmSync(trashDir, { recursive: true, force: true });
  await assert.rejects(moveToTrash(file, { trashItem: denied, trashDir }), /연결할 수 있는 권한/);
  assert.equal(fs.existsSync(file), true);
  fs.rmSync(root, { recursive: true, force: true });
});
