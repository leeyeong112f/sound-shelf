const test = require('node:test');
const assert = require('node:assert');
const { mergeVaultState, pruneRedundantEdits } = require('../src/vault-sync');

const FIELDS = ['relativePath', 'fileName', 'title', 'tags', 'notes', 'favorite', 'rating', 'createdAt', 'keyAnalysis'];

function sound(id, overrides = {}) {
  return {
    id,
    relativePath: `액션/${id}.wav`,
    fileName: `${id}.wav`,
    title: id,
    tags: [],
    notes: '',
    favorite: false,
    rating: 0,
    createdAt: 1000,
    modifiedAt: 1000,
    size: 100,
    contentHash: '',
    keyAnalysis: null,
    ...overrides
  };
}

test('베이스만 있으면 베이스를 그대로 돌려준다', () => {
  const base = { sounds: [sound('a'), sound('b')], folderOrder: ['액션'] };
  const result = mergeVaultState(base, []);
  assert.strictEqual(result.sounds.length, 2);
  assert.deepStrictEqual(result.folderOrder, ['액션']);
  assert.strictEqual(result.previewVolume, null);
});

test('편집이 베이스를 이긴다', () => {
  const base = { sounds: [sound('a', { tags: [] })], folderOrder: [] };
  const edits = [{
    machineId: 'mac-1',
    sounds: { a: { ...sound('a', { tags: ['액션'] }), updatedAt: 500 } }
  }];
  const result = mergeVaultState(base, edits);
  assert.deepStrictEqual(result.sounds[0].tags, ['액션']);
});

test('나중 updatedAt이 이긴다', () => {
  const base = { sounds: [sound('a')], folderOrder: [] };
  const edits = [
    { machineId: 'mac-1', sounds: { a: { ...sound('a', { title: '먼저' }), updatedAt: 100 } } },
    { machineId: 'mac-2', sounds: { a: { ...sound('a', { title: '나중' }), updatedAt: 200 } } }
  ];
  const result = mergeVaultState(base, edits);
  assert.strictEqual(result.sounds[0].title, '나중');
});

test('한쪽이 만지지 않은 사운드는 덮이지 않는다', () => {
  const base = { sounds: [sound('a'), sound('b')], folderOrder: [] };
  const edits = [
    { machineId: 'mac-1', sounds: { a: { ...sound('a', { title: 'A가 고침' }), updatedAt: 900 } } },
    { machineId: 'mac-2', sounds: { b: { ...sound('b', { title: 'B가 고침' }), updatedAt: 100 } } }
  ];
  const result = mergeVaultState(base, edits);
  const byId = Object.fromEntries(result.sounds.map((item) => [item.id, item]));
  assert.strictEqual(byId.a.title, 'A가 고침');
  assert.strictEqual(byId.b.title, 'B가 고침');
});

test('동률이면 machineId 사전순으로 결정적이다', () => {
  const base = { sounds: [sound('a')], folderOrder: [] };
  const edits = [
    { machineId: 'mac-z', sounds: { a: { ...sound('a', { title: 'Z' }), updatedAt: 500 } } },
    { machineId: 'mac-a', sounds: { a: { ...sound('a', { title: 'A' }), updatedAt: 500 } } }
  ];
  assert.strictEqual(mergeVaultState(base, edits).sounds[0].title, 'Z');
  assert.strictEqual(mergeVaultState(base, [...edits].reverse()).sounds[0].title, 'Z');
});

test('병합 순서를 바꿔도 같은 결과가 나온다', () => {
  const base = { sounds: [sound('a'), sound('b')], folderOrder: [] };
  const edits = [
    { machineId: 'mac-1', sounds: { a: { ...sound('a', { title: 'A1' }), updatedAt: 300 } } },
    { machineId: 'mac-2', sounds: { a: { ...sound('a', { title: 'A2' }), updatedAt: 400 } } }
  ];
  const forward = mergeVaultState(base, edits);
  const backward = mergeVaultState(base, [...edits].reverse());
  assert.deepStrictEqual(forward.sounds, backward.sounds);
});

test('삭제 표식이 이기면 결과에서 빠진다', () => {
  const base = { sounds: [sound('a'), sound('b')], folderOrder: [] };
  const edits = [{ machineId: 'mac-1', sounds: { a: { updatedAt: 500, deleted: true } } }];
  const result = mergeVaultState(base, edits);
  assert.deepStrictEqual(result.sounds.map((item) => item.id), ['b']);
});

test('삭제 표식은 더 새로운 일반 편집보다 우선한다', () => {
  const base = { sounds: [sound('a')], folderOrder: [] };
  const edits = [
    { machineId: 'mac-1', sounds: { a: { ...sound('a'), updatedAt: 500, deleted: true } } },
    { machineId: 'mac-2', sounds: { a: { ...sound('a', { title: '부활' }), updatedAt: 600 } } }
  ];
  const result = mergeVaultState(base, edits);
  assert.strictEqual(result.sounds.length, 0);
  assert.strictEqual(result.deletedSounds.length, 1);
  assert.strictEqual(result.deletedSounds[0].relativePath, '액션/a.wav');
});

test('삭제 우선 병합은 편집 파일 순서와 무관하다', () => {
  const base = { sounds: [sound('a')], folderOrder: [] };
  const edits = [
    { machineId: 'mac-1', sounds: { a: { ...sound('a'), updatedAt: 700, deleted: true } } },
    { machineId: 'mac-2', sounds: { a: { ...sound('a', { title: '더 최신 편집' }), updatedAt: 900 } } }
  ];
  assert.deepStrictEqual(mergeVaultState(base, edits), mergeVaultState(base, [...edits].reverse()));
});

test('같은 경로의 다른 ID도 삭제 시각보다 오래됐으면 되살아나지 않는다', () => {
  const relativePath = '클래식/삭제한 곡.wav';
  const edits = [
    {
      machineId: 'mac-old',
      sounds: { old: { ...sound('old', { relativePath }), updatedAt: 500 } }
    },
    {
      machineId: 'mac-new',
      sounds: { current: { ...sound('current', { relativePath }), updatedAt: 500, deleted: true } }
    }
  ];
  const result = mergeVaultState({ sounds: [], folderOrder: [] }, edits);
  assert.strictEqual(result.sounds.length, 0);
  assert.strictEqual(result.deletedSounds.length, 1);
});

test('삭제 뒤 명시적으로 다시 추가한 같은 경로의 새 ID는 복원된다', () => {
  const relativePath = '클래식/복원한 곡.wav';
  const edits = [
    {
      machineId: 'mac-old',
      sounds: { old: { ...sound('old', { relativePath }), updatedAt: 500, deleted: true } }
    },
    {
      machineId: 'mac-new',
      sounds: { restored: { ...sound('restored', { relativePath }), updatedAt: 501 } }
    }
  ];
  const result = mergeVaultState({ sounds: [], folderOrder: [] }, edits);
  assert.deepStrictEqual(result.sounds.map((item) => item.id), ['restored']);
});

test('베이스에 없는 사운드도 편집으로 추가된다', () => {
  const base = { sounds: [], folderOrder: [] };
  const edits = [{ machineId: 'mac-1', sounds: { z: { ...sound('z'), updatedAt: 100 } } }];
  assert.strictEqual(mergeVaultState(base, edits).sounds[0].id, 'z');
});

test('폴더 순서는 최신 것이 이긴다', () => {
  const base = { sounds: [], folderOrder: ['베이스'] };
  const edits = [
    { machineId: 'mac-1', sounds: {}, folderOrder: { updatedAt: 100, order: ['먼저'] } },
    { machineId: 'mac-2', sounds: {}, folderOrder: { updatedAt: 200, order: ['나중'] } }
  ];
  assert.deepStrictEqual(mergeVaultState(base, edits).folderOrder, ['나중']);
});

test('미리듣기 볼륨은 최신 것이 이긴다', () => {
  const base = { sounds: [], folderOrder: [] };
  const edits = [
    { machineId: 'mac-1', sounds: {}, settings: { updatedAt: 100, previewVolume: 0.2 } },
    { machineId: 'mac-2', sounds: {}, settings: { updatedAt: 200, previewVolume: 0.9 } }
  ];
  assert.strictEqual(mergeVaultState(base, edits).previewVolume, 0.9);
});

test('깨진 편집 소스는 무시하고 나머지를 병합한다', () => {
  const base = { sounds: [sound('a')], folderOrder: [] };
  const edits = [
    null,
    { machineId: 'broken' },
    { machineId: 'mac-1', sounds: { a: { ...sound('a', { title: '정상' }), updatedAt: 100 } } }
  ];
  assert.strictEqual(mergeVaultState(base, edits).sounds[0].title, '정상');
});

test('updatedAt이 없는 편집 레코드는 베이스를 이기지 못한다', () => {
  const base = { sounds: [sound('a', { title: '베이스' })], folderOrder: [] };
  const edits = [{ machineId: 'mac-1', sounds: { a: { ...sound('a', { title: '무효' }) } } }];
  assert.strictEqual(mergeVaultState(base, edits).sounds[0].title, '베이스');
});

test('베이스와 같은 레코드는 정리된다', () => {
  const base = [sound('a')];
  const own = { a: { ...sound('a'), updatedAt: 100 } };
  assert.deepStrictEqual(pruneRedundantEdits(own, base, FIELDS), {});
});

test('사용자 필드가 다른 레코드는 유지된다', () => {
  const base = [sound('a')];
  const own = { a: { ...sound('a', { tags: ['액션'] }), updatedAt: 100 } };
  assert.strictEqual(Object.keys(pruneRedundantEdits(own, base, FIELDS)).length, 1);
});

test('기술 필드만 다른 레코드는 정리된다', () => {
  const base = [sound('a')];
  const own = { a: { ...sound('a', { modifiedAt: 9999, size: 777, contentHash: 'x' }), updatedAt: 100 } };
  assert.deepStrictEqual(pruneRedundantEdits(own, base, FIELDS), {});
});

test('삭제 표식은 절대 정리되지 않는다', () => {
  const base = [sound('a')];
  const own = { a: { updatedAt: 100, deleted: true } };
  assert.strictEqual(pruneRedundantEdits(own, base, FIELDS).a.deleted, true);
});

test('베이스에 없는 신규 사운드는 유지된다', () => {
  const own = { z: { ...sound('z'), updatedAt: 100 } };
  assert.strictEqual(Object.keys(pruneRedundantEdits(own, [], FIELDS)).length, 1);
});
