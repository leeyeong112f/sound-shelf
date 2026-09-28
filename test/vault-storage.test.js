const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { VaultStorage, writeJsonAtomic } = require('../src/vault-storage');

async function tempDirectory() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sound-shelf-test-'));
}

test('writeJsonAtomic 을 동시에 여러 번 호출해도 파일이 잘리지 않는다', async (t) => {
  const directory = await tempDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'edits.json');
  // 임시 파일 이름이 고정이면 두 쓰기가 같은 파일을 truncate 하고,
  // 먼저 끝난 rename 이 아직 쓰는 중인 내용을 본 자리로 옮겨 JSON 이 깨진다.
  const payloads = Array.from({ length: 12 }, (_, index) => ({
    index,
    filler: 'x'.repeat(200000)
  }));
  await Promise.all(payloads.map((payload) => writeJsonAtomic(target, payload)));
  const parsed = JSON.parse(await fsp.readFile(target, 'utf8'));
  assert.ok(Number.isInteger(parsed.index));
  assert.equal(parsed.filler.length, 200000);
  // 임시 파일이 남지 않아야 한다.
  const leftovers = (await fsp.readdir(directory)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('create:false 는 vault.json 이 없는 폴더를 새 볼트로 만들지 않는다', async (t) => {
  const directory = await tempDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const userData = await tempDirectory();
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));

  const storage = new VaultStorage(directory, userData);
  await assert.rejects(
    () => storage.initialize({ create: false }),
    (error) => error.code === 'ENOVAULTMANIFEST'
  );
  // 실패한 열기가 제어 폴더를 남겨서도 안 된다. 남기면 다음 시도에서 진짜 볼트처럼 보인다.
  assert.equal(fs.existsSync(path.join(directory, '.sound-shelf', 'vault.json')), false);
});

test('create:true 는 새 볼트를 만들고, 그 뒤에는 create:false 로도 열린다', async (t) => {
  const directory = await tempDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const userData = await tempDirectory();
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));

  const created = new VaultStorage(directory, userData);
  const info = await created.initialize({ create: true });
  created.close();
  assert.ok(info.id);

  const reopened = new VaultStorage(directory, userData);
  const again = await reopened.initialize({ create: false });
  reopened.close();
  assert.equal(again.id, info.id);
});

test('읽을 수 없는 자기 편집 파일은 건너뛰지 않고 예외를 던진다', async (t) => {
  const directory = await tempDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const userData = await tempDirectory();
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));

  const storage = new VaultStorage(directory, userData);
  await storage.initialize({ create: true });
  t.after(() => storage.close());

  await storage.saveEdits('mac-a', 'Mac A', { sounds: { s1: { id: 's1', updatedAt: 1 } } });
  // Drive 가 아직 내려받는 중이면 반쯤 쓰인 파일이 보인다.
  await fsp.writeFile(path.join(directory, '.sound-shelf', 'edits', 'mac-b.json'), '{"sounds":', 'utf8');

  // 남의 파일이 깨진 것은 이번 회차만 건너뛰면 된다.
  const sources = await storage.loadEditSources({ ownMachineId: 'mac-a' });
  assert.deepEqual(sources.map((source) => source.machineId), ['mac-a']);

  // 내 파일이 깨졌는데 조용히 건너뛰면, 호출자가 ownEdits 를 빈 값으로 보고
  // 다음 저장에서 내 과거 편집을 통째로 덮어쓴다.
  await assert.rejects(
    () => storage.loadEditSources({ ownMachineId: 'mac-b' }),
    (error) => error.code === 'EOWNEDITSUNREADABLE'
  );
});

test('integrityCheck 는 metadata 에 없는 캐시 잔여 행을 센다', async (t) => {
  const directory = await tempDirectory();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const userData = await tempDirectory();
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));

  const storage = new VaultStorage(directory, userData);
  await storage.initialize({ create: true });
  t.after(() => storage.close());

  await fsp.writeFile(path.join(directory, 'live.wav'), 'x', 'utf8');
  await storage.overwriteBaseMetadata([{ id: 'live', relativePath: 'live.wav' }]);
  storage.replaceTechnicalCache([
    { id: 'live', relativePath: 'live.wav', fileName: 'live.wav' },
    { id: 'gone', relativePath: 'gone.wav', fileName: 'gone.wav' }
  ]);

  const report = await storage.integrityCheck();
  assert.equal(report.total, 1);
  assert.equal(report.missingFiles, 0);
  assert.equal(report.cacheEntries, 2);
  assert.equal(report.staleCacheRows, 1);
});
