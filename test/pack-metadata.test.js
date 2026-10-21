const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  PackIndex, applyEdits, detectFormat, detectIndent, indexPack, publicPackInfo, readPackFile, writePackFile
} = require('../src/pack-metadata');

const WHOOSH = {
  id: 'whoosh-fast-soft',
  name: 'Whoosh, fast and soft',
  category: 'whooshes',
  file: 'sounds/whooshes/whoosh-fast-soft.wav',
  variant: { speed: 'fast', intensity: 'soft' },
  description: 'A quick, gentle puff of air.',
  use_for: ['Small icons sliding in'],
  avoid_for: ['Heavy objects'],
  tags: ['whoosh', 'transition', 'subtle'],
  duration: 0.25,
  sync: { at: 0.099, meets: 'move-peak', how: 'Put the sync point at the middle of the move.' },
  level: { lufs: -24, true_peak_dbtp: -13.5, tier: 'soft' },
  under_voiceover_db: -2,
  pairs_with: [{ category: 'impacts', how: 'Whoosh on the move, impact on landing.' }],
  sha256: 'abc'
};

async function makePack(files, json, text) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pack-test-'));
  for (const file of files) {
    await fsp.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fsp.writeFile(path.join(root, file), 'RIFF');
  }
  await fsp.writeFile(path.join(root, 'sounds.json'), text ?? `${JSON.stringify(json, null, 2)}\n`);
  return root;
}

test('sounds.json 만 팩 형식으로 본다 (manifest.json 의 tracks 는 읽지 않는다)', () => {
  assert.equal(detectFormat({ sounds: [WHOOSH] }), 'sounds');
  assert.equal(detectFormat({ tracks: [{ file: 'a.ogg' }] }), null);
  assert.equal(detectFormat({ sounds: [{ name: 'file 없음' }] }), null);
  assert.equal(detectFormat([WHOOSH]), null);
});

test('항목을 실제 오디오 경로와 잇고 용도·싱크·레벨을 요약한다', () => {
  const packDir = '/vault/무료팩/Kit';
  const audio = path.join(packDir, WHOOSH.file);
  const pack = indexPack(path.join(packDir, 'sounds.json'), { name: 'Kit', sounds: [WHOOSH] },
    { exists: (p) => p === audio, filesByBaseName: new Map() });
  assert.equal(pack.items.length, 1);
  const { summary, searchText, audioPath } = pack.items[0];
  assert.equal(audioPath, audio);
  assert.deepEqual(summary.useFor, ['Small icons sliding in']);
  assert.deepEqual(summary.avoidFor, ['Heavy objects']);
  assert.equal(summary.sync.at, 0.099);
  assert.equal(summary.lufs, -24);
  assert.equal(summary.underVoiceoverDb, -2);
  assert.equal(summary.pairsWith[0].category, 'impacts');
  assert.ok(searchText.includes('subtle') && searchText.includes('small icons'));
  assert.ok(!searchText.includes('heavy objects'), '피할 곳은 검색에 넣지 않는다');
  assert.equal(summary.extra.sha256, undefined);
});

test('자리에 없는 파일은 팩 폴더 안에 같은 이름이 하나뿐일 때만 잇는다', () => {
  const packDir = '/vault/Kit';
  const one = new Map([['whoosh-fast-soft.wav', ['/vault/Kit/flat/whoosh-fast-soft.wav']]]);
  const two = new Map([['whoosh-fast-soft.wav', ['/vault/Kit/a/whoosh-fast-soft.wav', '/vault/Kit/b/whoosh-fast-soft.wav']]]);
  const outside = new Map([['whoosh-fast-soft.wav', ['/vault/Other/whoosh-fast-soft.wav']]]);
  const run = (filesByBaseName) => indexPack('/vault/Kit/sounds.json', { sounds: [WHOOSH] }, { exists: () => false, filesByBaseName });
  assert.equal(run(one).items[0].audioPath, '/vault/Kit/flat/whoosh-fast-soft.wav');
  assert.equal(run(two).items.length, 0);
  assert.equal(run(outside).items.length, 0);
});

test('팩 밖으로 나가는 경로(..)는 잇지 않는다', () => {
  const evil = { ...WHOOSH, file: '../secret.wav' };
  const pack = indexPack('/vault/Kit/sounds.json', { sounds: [evil] }, { exists: () => true, filesByBaseName: new Map() });
  assert.equal(pack.items.length, 0);
});

test('편집은 고칠 수 있는 필드만, 원본을 건드리지 않고 새 객체로 적용한다', () => {
  const json = { sounds: [WHOOSH] };
  const next = applyEdits(json, { index: 0, file: WHOOSH.file }, {
    description: '  부드러운 바람  ', useFor: '자막 등장, 아이콘 등장,  ', avoidFor: [], tags: ['whoosh', 'whoosh', '전환']
  });
  assert.equal(next.sounds[0].description, '부드러운 바람');
  assert.deepEqual(next.sounds[0].use_for, ['자막 등장', '아이콘 등장']);
  assert.deepEqual(next.sounds[0].avoid_for, []);
  assert.deepEqual(next.sounds[0].tags, ['whoosh', '전환']);
  assert.deepEqual(next.sounds[0].sync, WHOOSH.sync, '다른 필드는 그대로');
  assert.equal(json.sounds[0].description, WHOOSH.description, '원본 불변');
  assert.throws(() => applyEdits(json, { index: 0, file: WHOOSH.file }, { sync: 1 }), /고칠 수 없는/);
});

test('빈 값은 원래 없던 필드를 새로 만들지 않는다', () => {
  const bare = { file: 'x.wav' };
  const next = applyEdits({ sounds: [bare] }, { index: 0, file: 'x.wav' }, { description: '', useFor: [] });
  assert.deepEqual(next.sounds[0], bare);
});

test('순서가 바뀌었으면 file 로 다시 찾고, 못 찾으면 거절한다', () => {
  const other = { ...WHOOSH, file: 'other.wav' };
  const next = applyEdits({ sounds: [other, WHOOSH] }, { index: 0, file: WHOOSH.file }, { description: '바뀜' });
  assert.equal(next.sounds[1].description, '바뀜');
  assert.equal(next.sounds[0].description, WHOOSH.description);
  assert.throws(() => applyEdits({ sounds: [other] }, { index: 0, file: WHOOSH.file }, { description: 'x' }), /찾지 못했/);
});

test('들여쓰기와 끝 줄바꿈을 지키며 쓰고, 그 사이 바뀐 파일은 덮어쓰지 않는다', async () => {
  const text = `{\n\t"sounds": [\n\t\t${JSON.stringify(WHOOSH)}\n\t]\n}`;
  const root = await makePack([WHOOSH.file], null, text);
  const file = path.join(root, 'sounds.json');
  assert.equal(detectIndent(text), '\t');
  const read = await readPackFile(file);
  const next = applyEdits(read.json, { index: 0, file: WHOOSH.file }, { description: '탭 유지' });
  await writePackFile(file, next, { originalText: read.text, expectedMtimeMs: read.mtimeMs });
  const written = await fsp.readFile(file, 'utf8');
  assert.ok(written.startsWith('{\n\t"sounds"'));
  assert.ok(!written.endsWith('\n'));
  assert.equal(JSON.parse(written).sounds[0].description, '탭 유지');
  await assert.rejects(writePackFile(file, next, { originalText: read.text, expectedMtimeMs: read.mtimeMs - 5000 }), /바뀌었습니다/);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('.tmp-')), []);
});

test('PackIndex 는 볼트를 훑어 오디오 경로로 찾고, 파일이 사라지면 지운다', async () => {
  const root = await makePack([WHOOSH.file], { name: 'Kit', sounds: [WHOOSH] });
  const audio = path.join(root, WHOOSH.file);
  const index = new PackIndex();
  await index.refresh([root], [audio]);
  assert.equal(index.packCount(), 1);
  const entry = index.lookup(audio);
  assert.equal(entry.summary.name, 'Whoosh, fast and soft');
  const info = publicPackInfo(entry, root);
  assert.equal(info.packFile, 'sounds.json');
  const nfdVault = publicPackInfo({ ...entry, packFile: '/v/내 드라이브/Kit/sounds.json' }, '/v/내 드라이브'.normalize('NFD'));
  assert.equal(nfdVault.packFile, 'Kit/sounds.json', '볼트 경로가 NFD 여도 상대 경로로 보여준다');
  assert.equal(info.packName, 'Kit');
  await fsp.rm(path.join(root, 'sounds.json'));
  await index.refresh([root], [audio]);
  assert.equal(index.lookup(audio), null);
});

test('깨진 sounds.json 은 무시하고 다른 팩은 계속 읽는다', async () => {
  const root = await makePack([WHOOSH.file], { sounds: [WHOOSH] });
  await fsp.mkdir(path.join(root, 'broken'));
  await fsp.writeFile(path.join(root, 'broken', 'sounds.json'), '{ not json');
  const index = new PackIndex();
  await index.refresh([root], [path.join(root, WHOOSH.file)]);
  assert.equal(index.packCount(), 1);
  assert.ok(index.lookup(path.join(root, WHOOSH.file)));
});

const { addEntry, entryOf, nearestPackFile, replaceEntry, templateEntry, validateEntry } = require('../src/pack-metadata');

test('팝업 원문 편집: 항목을 통째로 바꾸되 file 은 못 바꾸고 모양이 틀리면 거절한다', () => {
  const json = { name: 'Kit', sounds: [WHOOSH] };
  const where = { index: 0, file: WHOOSH.file };
  assert.equal(entryOf(json, where).id, 'whoosh-fast-soft');
  const edited = { ...WHOOSH, description: '새 설명', sections: [{ name: 'A', start: 0 }] };
  const next = replaceEntry(json, where, edited);
  assert.equal(next.sounds[0].description, '새 설명');
  assert.deepEqual(next.sounds[0].sections, [{ name: 'A', start: 0 }], '모르는 필드도 그대로 저장');
  assert.equal(json.sounds[0].description, WHOOSH.description);
  assert.throws(() => replaceEntry(json, where, { ...WHOOSH, file: 'other.wav' }), /file.*바꿀 수 없/);
  assert.throws(() => replaceEntry(json, where, { ...WHOOSH, sync: { at: '0.1' } }), /sync\.at.*숫자/);
  assert.throws(() => replaceEntry(json, where, { ...WHOOSH, use_for: '자막' }), /use_for.*문자열 목록/);
  assert.throws(() => replaceEntry(json, where, [WHOOSH]), /객체/);
  assert.deepEqual(validateEntry({ ...WHOOSH, fits_seconds: [0.1] }, WHOOSH.file).length, 1);
});

test('새 항목은 가장 가까운 sounds.json, 없으면 볼트 루트에 넣는다', () => {
  const have = new Set(['/v/무료팩/Kit/sounds.json']);
  const exists = (p) => have.has(p);
  assert.equal(nearestPackFile('/v/무료팩/Kit/sounds/whooshes/a.wav', '/v', exists), '/v/무료팩/Kit/sounds.json');
  assert.equal(nearestPackFile('/v/예능 효과음/pop/b.wav', '/v', exists), '/v/sounds.json');
  have.add('/v/sounds.json');
  assert.equal(nearestPackFile('/v/c.wav', '/v', exists), '/v/sounds.json');
});

test('새 항목 틀은 팩 파일 기준 상대 경로와 사운드 정보로 채운다', () => {
  const sound = { path: '/v/예능 효과음/pop (뽁)/또잇.wav', fileName: '또잇.wav', title: '또잇', category: 'pop (뽁)', duration: 1.1234, channels: 2, tags: ['당황'] };
  const entry = templateEntry(sound, '/v/sounds.json');
  assert.equal(entry.file, '예능 효과음/pop (뽁)/또잇.wav');
  assert.equal(entry.id, '또잇');
  assert.equal(entry.duration, 1.123);
  assert.deepEqual(entry.tags, ['당황']);
  assert.deepEqual(entry.use_for, []);
  assert.deepEqual(validateEntry(entry, entry.file), []);
});

test('항목 추가: 새 카탈로그를 만들거나 기존 목록 끝에 붙이고, 같은 file 은 거절한다', () => {
  const entry = { file: 'a/b.wav', description: '뽁' };
  const created = addEntry(null, entry, 'a/b.wav');
  assert.equal(created.sounds.length, 1);
  assert.ok(created.name);
  const appended = addEntry({ name: 'Kit', sounds: [WHOOSH] }, entry, 'a/b.wav');
  assert.equal(appended.sounds.length, 2);
  assert.equal(appended.name, 'Kit');
  assert.throws(() => addEntry(appended, entry, 'a/b.wav'), /이미/);
  assert.throws(() => addEntry({ sounds: {} }, entry, 'a/b.wav'), /형식이 아니라/);
  assert.throws(() => addEntry(null, { file: 'x.wav' }, 'a/b.wav'), /바꿀 수 없/);
});

test('새 sounds.json 은 create 일 때만 만들고, 그 사이 생긴 파일은 덮어쓰지 않는다', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pack-new-'));
  const file = path.join(root, 'sounds.json');
  await assert.rejects(writePackFile(file, { sounds: [] }, { originalText: '' }), /사라졌/);
  await writePackFile(file, addEntry(null, { file: 'x.wav' }, 'x.wav'), { originalText: '', create: true });
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).sounds[0].file, 'x.wav');
  await assert.rejects(writePackFile(file, { sounds: [] }, { originalText: '', create: true }), /새로 생겼/);
});
