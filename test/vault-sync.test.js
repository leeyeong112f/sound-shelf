const test = require('node:test');
const assert = require('node:assert');
const { mergeVaultState, pruneRedundantEdits, reconcileOwnTombstones } = require('../src/vault-sync');

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

// --- 명시적 복원 ---
// 삭제한 파일을 같은 자리에 되돌려 놓고 앱이 "같은 파일"임을 확인했을 때만 붙는 표식이다.
// 일반 편집과 달리 삭제를 이겨야 하지만, 그 외에는 삭제 우선 원칙이 그대로 유지돼야 한다.

test('명시적 복원은 더 최신이면 삭제를 이긴다', () => {
  const merged = mergeVaultState(
    { sounds: [{ id: 's1', relativePath: 'a.wav', title: '원본' }], folderOrder: [] },
    [
      { machineId: 'mac-a', sounds: { s1: { id: 's1', relativePath: 'a.wav', updatedAt: 100, deleted: true } } },
      { machineId: 'mac-b', sounds: { s1: { id: 's1', relativePath: 'a.wav', title: '복원됨', tags: ['x'], updatedAt: 200, restored: true } } }
    ]
  );
  assert.equal(merged.sounds.length, 1);
  assert.equal(merged.sounds[0].title, '복원됨');
  assert.deepEqual(merged.sounds[0].tags, ['x']);
  assert.equal(merged.deletedSounds.length, 0);
});

test('복원보다 더 최신인 삭제는 다시 삭제로 이긴다', () => {
  const merged = mergeVaultState(
    { sounds: [{ id: 's1', relativePath: 'a.wav' }], folderOrder: [] },
    [
      { machineId: 'mac-b', sounds: { s1: { id: 's1', relativePath: 'a.wav', updatedAt: 200, restored: true } } },
      { machineId: 'mac-a', sounds: { s1: { id: 's1', relativePath: 'a.wav', updatedAt: 300, deleted: true } } }
    ]
  );
  assert.equal(merged.sounds.length, 0);
  assert.equal(merged.deletedSounds.length, 1);
});

test('복원 병합은 편집 파일 순서와 무관하다', () => {
  const remove = { machineId: 'mac-a', sounds: { s1: { id: 's1', relativePath: 'a.wav', updatedAt: 100, deleted: true } } };
  const restore = { machineId: 'mac-b', sounds: { s1: { id: 's1', relativePath: 'a.wav', updatedAt: 200, restored: true } } };
  const base = { sounds: [{ id: 's1', relativePath: 'a.wav' }], folderOrder: [] };
  const forward = mergeVaultState(base, [remove, restore]);
  const backward = mergeVaultState(base, [restore, remove]);
  assert.equal(forward.sounds.length, 1);
  assert.deepEqual(forward.sounds.map((s) => s.id), backward.sounds.map((s) => s.id));
  assert.deepEqual(forward.deletedSounds.map((s) => s.id), backward.deletedSounds.map((s) => s.id));
});

test('복원 표식이 없는 일반 편집은 여전히 삭제를 이기지 못한다', () => {
  const merged = mergeVaultState(
    { sounds: [{ id: 's1', relativePath: 'a.wav' }], folderOrder: [] },
    [
      { machineId: 'mac-a', sounds: { s1: { id: 's1', relativePath: 'a.wav', updatedAt: 100, deleted: true } } },
      { machineId: 'mac-b', sounds: { s1: { id: 's1', relativePath: 'a.wav', tags: ['늦은편집'], updatedAt: 999 } } }
    ]
  );
  assert.equal(merged.sounds.length, 0);
  assert.equal(merged.deletedSounds.length, 1);
});

test('복원 레코드는 베이스와 같아 보여도 정리되지 않는다', () => {
  const base = [{ id: 's1', relativePath: 'a.wav', title: 'a', tags: [] }];
  const own = { s1: { id: 's1', relativePath: 'a.wav', title: 'a', tags: [], updatedAt: 200, restored: true } };
  const kept = pruneRedundantEdits(own, base, ['relativePath', 'title', 'tags']);
  assert.ok(kept.s1, '복원 표식을 지우면 베이스의 삭제 표식이 다시 이겨 사운드가 또 사라진다');
  assert.equal(kept.s1.restored, true);
});

// 내가 누락 정리로 지운 사운드를 다른 Mac 이 되살렸는데 내 표식이 그대로면, 이후 내 태그
// 편집이 편집 파일에 기록되지 않고 다음 병합에서 사라진다.
test('병합에 들어간 내 삭제 표식이 복원에 졌으면 복원 기록으로 바꾼다', () => {
  const tombstone = { ...sound('x'), updatedAt: 100, deleted: true, restored: false, reason: 'missing', liveUpdatedAt: 50 };
  const own = { x: tombstone };
  const live = [{ ...sound('x'), updatedAt: 200, deleted: false, restored: true }];
  const next = reconcileOwnTombstones(own, live, { x: tombstone });
  assert.strictEqual(next.x.deleted, false);
  assert.strictEqual(next.x.restored, true);
  assert.strictEqual(next.x.updatedAt, 200);
  assert.strictEqual('reason' in next.x, false);
  assert.strictEqual('liveUpdatedAt' in next.x, false);
  assert.strictEqual(own.x.deleted, true);
});

// 저장에 실패해 메모리에만 있는 표식은 병합에 참여하지 않았다. 저장되면 이길 표식을 뒤집으면
// 사용자의 삭제가 영구히 취소된다.
test('디스크에 없는 내 표식은 병합 결과가 살아 있어도 그대로 둔다', () => {
  const own = { x: { ...sound('x'), updatedAt: 300, deleted: true } };
  const live = [{ ...sound('x'), updatedAt: 400 }];
  assert.strictEqual(reconcileOwnTombstones(own, live, {}).x.deleted, true);
  const olderDisk = { x: { ...sound('x'), updatedAt: 100, deleted: true } };
  assert.strictEqual(reconcileOwnTombstones(own, live, olderDisk).x.deleted, true);
  assert.strictEqual(reconcileOwnTombstones(own, live, undefined).x.deleted, true);
});

test('살아 있는 내 기록과 병합 결과에 없는 표식은 건드리지 않는다', () => {
  const own = {
    live: { ...sound('live'), updatedAt: 100 },
    gone: { ...sound('gone'), updatedAt: 100, deleted: true }
  };
  const next = reconcileOwnTombstones(own, [{ ...sound('live'), updatedAt: 200 }], own);
  assert.deepStrictEqual(next, own);
});

// 복원한 Mac 의 편집 파일이 아직 안 보이는 Mac 에서도, 조정한 내 기록만으로 제3의 Mac 이 가진
// 더 오래된 삭제 표식을 이겨야 한다. 표식을 지우는 구현이면 이 경우 삭제가 이긴다.
test('조정한 내 기록은 복원한 Mac 없이도 더 오래된 삭제 표식을 이긴다', () => {
  const mine = { ...sound('x'), updatedAt: 100, deleted: true, reason: 'missing' };
  const A = { machineId: 'a', sounds: { x: mine } };
  const B = { machineId: 'b', sounds: { x: { ...sound('x'), updatedAt: 200, deleted: false, restored: true } } };
  const C = { machineId: 'c', sounds: { x: { ...sound('x'), updatedAt: 50, deleted: true } } };
  const merged = mergeVaultState({ sounds: [] }, [A, B, C]);
  const A2 = { ...A, sounds: reconcileOwnTombstones(A.sounds, merged.sounds, A.sounds) };
  for (const sources of [[A2, C], [C, A2]]) {
    assert.deepStrictEqual(mergeVaultState({ sounds: [] }, sources).sounds.map((s) => s.id), ['x']);
  }
  for (const sources of [[A, C], [C, A]]) {
    assert.deepStrictEqual(mergeVaultState({ sounds: [] }, sources).sounds, []);
  }
});

// A 가 복원하고 B 가 그 뒤 태그만 바꿨다. 내 기록에 B 의 시각을 복원 시각으로 옮기면, 그 사이
// A 가 다시 지운 삭제를 일반 편집으로는 이길 수 없는데도 내 기록이 이긴다.
test('승자가 일반 편집이면 조정한 복원 기록은 내 표식 시각을 유지한다', () => {
  const mine = { ...sound('x'), updatedAt: 1000, deleted: true, reason: 'missing' };
  const merged = [{ ...sound('x'), tags: ['B'], updatedAt: 3000 }];
  const next = reconcileOwnTombstones({ x: mine }, merged, { x: mine });
  assert.strictEqual(next.x.updatedAt, 1000);
  assert.strictEqual(next.x.restored, true);
  const ME = { machineId: 'm', sounds: next };
  const A = { machineId: 'n', sounds: { x: { ...sound('x'), updatedAt: 2500, deleted: true } } };
  for (const sources of [[ME, A], [A, ME]]) {
    assert.deepStrictEqual(mergeVaultState({ sounds: [] }, sources).sounds, []);
  }
});

test('이긴 삭제 표식의 reason 과 liveUpdatedAt 만 남는다', () => {
  const missing = { machineId: 'a', sounds: { x: { ...sound('x'), updatedAt: 1000, deleted: true, reason: 'missing', liveUpdatedAt: 500 } } };
  const oldBuildTrash = { machineId: 'c', sounds: { x: { ...sound('x'), tags: ['휴지통'], updatedAt: 1500, deleted: true } } };
  for (const sources of [[missing, oldBuildTrash], [oldBuildTrash, missing]]) {
    const [deleted] = mergeVaultState({ sounds: [] }, sources).deletedSounds;
    assert.strictEqual('reason' in deleted, false);
    assert.strictEqual('liveUpdatedAt' in deleted, false);
    assert.deepStrictEqual(deleted.tags, ['휴지통']);
  }
});
