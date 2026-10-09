const test = require('node:test');
const assert = require('node:assert/strict');
const { clipSourcePath, describeResolveRelink, planResolveRelinks } = require('../src/resolve-relink');

const VAULT = '/Users/me/Library/CloudStorage/GoogleDrive-me@gmail.com/내 드라이브/효과음_통합';

function library(paths) {
  const sounds = paths.map((relative, index) => ({ id: `s${index}`, path: `${VAULT}/${relative}` }));
  const existing = new Set(sounds.map((sound) => sound.path.normalize('NFC')));
  return { sounds, exists: (filePath) => existing.has(String(filePath).normalize('NFC')) };
}

function offline(id, relative) {
  return { id, name: relative.split('/').pop(), filePath: `${VAULT}/${relative}` };
}

// 2026-10-08 sounds/frying_sizzle.m4a 를 요리/ 로 옮긴 뒤 Resolve 가 보고한 모양이다.
test('폴더만 옮긴 파일은 같은 이름의 현재 파일로 연결한다', () => {
  const { sounds, exists } = library(['요리/frying_sizzle.m4a', 'sounds/frying_sizzle_2.m4a']);
  const plan = planResolveRelinks([offline('c1', 'sounds/frying_sizzle.m4a')], sounds, { exists });
  assert.equal(plan.relinks.length, 1);
  assert.equal(plan.relinks[0].clipId, 'c1');
  assert.equal(plan.relinks[0].to, `${VAULT}/요리/frying_sizzle.m4a`);
  assert.equal(plan.relinks[0].folder, `${VAULT}/요리`);
  assert.equal(plan.relinks[0].soundId, 's0');
  assert.deepEqual([plan.ambiguous, plan.unmatched, plan.skipped].map((list) => list.length), [0, 0, 0]);
});

test('같은 이름이 여러 폴더에 있으면 옛 상위 폴더 이름이 같은 쪽을 고른다', () => {
  const { sounds, exists } = library(['예능/타격/punch.wav', '게임/punch.wav']);
  const plan = planResolveRelinks([offline('c1', '옛폴더/타격/punch.wav')], sounds, { exists });
  assert.equal(plan.relinks.length, 1);
  assert.equal(plan.relinks[0].to, `${VAULT}/예능/타격/punch.wav`);
});

test('상위 폴더 이름으로도 하나로 좁혀지지 않으면 건드리지 않는다', () => {
  const { sounds, exists } = library(['예능/punch.wav', '게임/punch.wav']);
  const plan = planResolveRelinks([offline('c1', 'sounds/punch.wav')], sounds, { exists });
  assert.equal(plan.relinks.length, 0);
  assert.equal(plan.ambiguous.length, 1);
  assert.deepEqual(plan.ambiguous[0].candidates.sort(), [`${VAULT}/게임/punch.wav`, `${VAULT}/예능/punch.wav`].sort());
});

test('라이브러리에 같은 이름이 없으면 unmatched 로 남긴다', () => {
  const { sounds, exists } = library(['요리/boil.wav']);
  const plan = planResolveRelinks([offline('c1', 'sounds/renamed.wav')], sounds, { exists });
  assert.equal(plan.relinks.length, 0);
  assert.equal(plan.unmatched.length, 1);
  assert.equal(plan.unmatched[0].clipId, 'c1');
});

test('옛 경로에 파일이 아직 있으면 바꿔 끼우지 않는다', () => {
  const { sounds, exists } = library(['sounds/hit.wav', '요리/hit.wav']);
  const plan = planResolveRelinks([offline('c1', 'sounds/hit.wav')], sounds, { exists });
  assert.equal(plan.relinks.length, 0);
  assert.equal(plan.skipped.length, 1);
});

test('라이브러리에서도 사라진 파일은 후보가 아니다', () => {
  const sounds = [
    { id: 'gone', path: `${VAULT}/요리/hit.wav` },
    { id: 'live', path: `${VAULT}/주방/hit.wav` }
  ];
  const exists = (filePath) => filePath === `${VAULT}/주방/hit.wav`;
  const plan = planResolveRelinks([offline('c1', 'sounds/hit.wav')], sounds, { exists });
  assert.equal(plan.relinks.length, 1);
  assert.equal(plan.relinks[0].soundId, 'live');
});

test('NFD 로 온 한글 이름도 같은 파일로 본다', () => {
  const { sounds, exists } = library(['요리/볶음.wav']);
  const nfdName = '볶음.wav'.normalize('NFD');
  const plan = planResolveRelinks([{ id: 'c1', name: nfdName, filePath: `${VAULT}/sounds/${nfdName}` }], sounds, { exists });
  assert.equal(plan.relinks.length, 1);
  assert.equal(plan.relinks[0].to, `${VAULT}/요리/볶음.wav`);
});

test('파일 경로가 없는 항목과 id 없는 항목은 무시한다', () => {
  const { sounds, exists } = library(['요리/hit.wav']);
  const plan = planResolveRelinks([
    { id: 't1', name: 'Timeline 1', filePath: '' },
    { id: '', name: 'hit.wav', filePath: `${VAULT}/sounds/hit.wav` }
  ], sounds, { exists });
  assert.deepEqual([plan.relinks, plan.ambiguous, plan.unmatched, plan.skipped].map((list) => list.length), [0, 0, 0, 0]);
});

test('같은 파일을 가리키는 오프라인 클립이 여럿이면 모두 같은 폴더로 보낸다', () => {
  const { sounds, exists } = library(['요리/hit.wav']);
  const plan = planResolveRelinks([offline('c1', 'sounds/hit.wav'), offline('c2', 'sounds/hit.wav')], sounds, { exists });
  assert.deepEqual(plan.relinks.map((item) => item.clipId), ['c1', 'c2']);
  assert.ok(plan.relinks.every((item) => item.folder === `${VAULT}/요리`));
});

// Resolve 21.1 에서 Unlink 한 클립의 모양: File Path 는 "OFFLINE - ", File Name 과 Clip Directory 는 남는다.
function unlinked(id, directory, fileName) {
  return { id, name: fileName, filePath: 'OFFLINE - ', fileName, directory: `${VAULT}/${directory}` };
}

test('Unlink 된 클립은 File Name 과 Clip Directory 로 옛 경로를 복원한다', () => {
  assert.equal(clipSourcePath(unlinked('c1', '요리', 'hit.wav')), `${VAULT}/요리/hit.wav`);
  assert.equal(clipSourcePath({ id: 'c1', filePath: `${VAULT}/sounds/hit.wav`, fileName: 'hit.wav', directory: `${VAULT}/sounds` }), `${VAULT}/sounds/hit.wav`);
  assert.equal(clipSourcePath({ id: 'c1', filePath: 'OFFLINE - ', fileName: 'hit.wav', directory: '' }), 'hit.wav');
  assert.equal(clipSourcePath({ id: 't1', filePath: '', fileName: '', directory: '' }), '');
});

test('Unlink 된 클립의 파일이 제자리에 있고 라이브러리 사운드면 그 폴더로 되돌린다', () => {
  const { sounds, exists } = library(['요리/frying_sizzle.m4a']);
  const plan = planResolveRelinks([unlinked('c1', '요리', 'frying_sizzle.m4a')], sounds, { exists });
  assert.equal(plan.relinks.length, 1);
  assert.equal(plan.relinks[0].folder, `${VAULT}/요리`);
  assert.equal(plan.skipped.length, 0);
});

test('Unlink 된 클립의 폴더에 파일이 없으면 이름으로 새 위치를 찾는다', () => {
  const { sounds, exists } = library(['요리/frying_sizzle.m4a']);
  const plan = planResolveRelinks([unlinked('c1', 'sounds', 'frying_sizzle.m4a')], sounds, { exists });
  assert.equal(plan.relinks.length, 1);
  assert.equal(plan.relinks[0].to, `${VAULT}/요리/frying_sizzle.m4a`);
});

test('Unlink 된 클립이라도 라이브러리에 없는 파일은 되살리지 않는다', () => {
  const { sounds } = library(['요리/hit.wav']);
  const exists = (filePath) => filePath.endsWith('/hit.wav') || filePath.endsWith('/A001.mov');
  const plan = planResolveRelinks([{ id: 'v1', name: 'A001.mov', filePath: 'OFFLINE - ', fileName: 'A001.mov', directory: '/Volumes/A003' }], sounds, { exists });
  assert.equal(plan.relinks.length, 0);
  assert.equal(plan.skipped.length, 1);
});

test('결과 문구는 건수를 그대로 알린다', () => {
  assert.equal(describeResolveRelink({ ok: false, message: 'Resolve에서 프로젝트를 먼저 열어 주세요.' }), 'Resolve에서 프로젝트를 먼저 열어 주세요.');
  assert.equal(describeResolveRelink({ ok: true, scanned: 0 }), 'DaVinci Resolve 미디어 풀에 오프라인 클립이 없습니다.');
  assert.equal(
    describeResolveRelink({ ok: true, scanned: 4, relinked: 2, failed: 0, ambiguous: 1, unmatched: 1, skipped: 0 }),
    'DaVinci Resolve 오프라인 클립 4개 중 2개 재연결 · 1개는 같은 이름의 파일이 여러 개라 건너뜀 · 1개는 라이브러리에 같은 이름이 없음'
  );
});
