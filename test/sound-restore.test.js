const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MISSING,
  UNLINKED,
  isSameFileAsTombstone,
  restorableTombstone,
  restoredSoundFields,
  tombstoneReason,
  unlinkedRelativePaths
} = require('../src/sound-restore');

const MTIME = 1784354560988;

function tombstone(overrides = {}) {
  return {
    id: 'sound-1',
    relativePath: '타격/펀치.wav',
    size: 192078,
    modifiedAt: MTIME,
    title: '펀치',
    tags: ['타격', '단단함'],
    notes: '2화 오프닝',
    favorite: true,
    rating: 4,
    keyAnalysis: { detected: true, display: 'C minor' },
    createdAt: 1700000000000,
    deleted: true,
    ...overrides
  };
}

test('reason 이 없는 옛 표식은 trashed 로 본다', () => {
  assert.equal(tombstoneReason(tombstone()), 'trashed');
  assert.equal(tombstoneReason(tombstone({ reason: UNLINKED })), 'unlinked');
  assert.equal(tombstoneReason(null), 'trashed');
});

test('같은 자리로 돌아온 같은 파일은 복원 대상이다', () => {
  const found = restorableTombstone([tombstone()], {
    relativePath: '타격/펀치.wav',
    size: 192078,
    modifiedAt: MTIME
  });
  assert.equal(found?.id, 'sound-1');
});

// 누락 자동 정리는 파일이 사라진 것을 확인하고 뺀 것이다. 같은 파일이 돌아오면 되살린다.
test('missing 표식은 trashed 처럼 복원 대상이다', () => {
  assert.equal(tombstoneReason(tombstone({ reason: MISSING })), 'trashed');
  const found = restorableTombstone([tombstone({ reason: MISSING })], {
    relativePath: '타격/펀치.wav',
    size: 192078,
    modifiedAt: MTIME
  });
  assert.equal(found?.id, 'sound-1');
  assert.equal(unlinkedRelativePaths([tombstone({ reason: MISSING })]).size, 0);
});

test('크기가 다르면 같은 이름이어도 복원하지 않는다', () => {
  const found = restorableTombstone([tombstone()], {
    relativePath: '타격/펀치.wav',
    size: 999999,
    modifiedAt: MTIME
  });
  assert.equal(found, null);
});

// 삭제한 자리에 완전히 다른 파일을 같은 이름으로 넣는 경우다. 새 항목으로 등록돼야 한다.
test('크기가 같아도 mtime 이 멀면 복원하지 않는다', () => {
  const found = restorableTombstone([tombstone()], {
    relativePath: '타격/펀치.wav',
    size: 192078,
    modifiedAt: MTIME + 60000
  });
  assert.equal(found, null);
});

test('해시를 양쪽 다 알면 해시가 최종 판정이다', () => {
  const withHash = tombstone({ contentHash: 'abc' });
  // mtime 이 멀어도 해시가 같으면 같은 파일이다.
  assert.equal(restorableTombstone([withHash], {
    relativePath: '타격/펀치.wav',
    size: 192078,
    modifiedAt: MTIME + 999999,
    contentHash: 'abc'
  })?.id, 'sound-1');
  // mtime 이 같아도 해시가 다르면 다른 파일이다.
  assert.equal(restorableTombstone([withHash], {
    relativePath: '타격/펀치.wav',
    size: 192078,
    modifiedAt: MTIME,
    contentHash: 'zzz'
  }), null);
});

test('경로가 다르면 복원이 아니라 이동이므로 여기서 다루지 않는다', () => {
  const found = restorableTombstone([tombstone()], {
    relativePath: '앰비언스/펀치.wav',
    size: 192078,
    modifiedAt: MTIME
  });
  assert.equal(found, null);
});

test('NFD 로 들어온 상대 경로도 같은 경로로 본다', () => {
  const found = restorableTombstone([tombstone({ relativePath: '타격/펀치.wav'.normalize('NFD') })], {
    relativePath: '타격/펀치.wav'.normalize('NFC'),
    size: 192078,
    modifiedAt: MTIME
  });
  assert.equal(found?.id, 'sound-1');
});

// "라이브러리에서만 제거"는 파일을 그대로 두는 게 정상이므로 자동 스캔이 되돌리면 안 된다.
test('unlinked 표식은 자동 복원 대상이 아니다', () => {
  const found = restorableTombstone([tombstone({ reason: UNLINKED })], {
    relativePath: '타격/펀치.wav',
    size: 192078,
    modifiedAt: MTIME
  });
  assert.equal(found, null);
});

test('unlinkedRelativePaths 는 unlinked 표식의 경로만 모은다', () => {
  const paths = unlinkedRelativePaths([
    tombstone({ id: 'a', relativePath: '타격/펀치.wav', reason: UNLINKED }),
    tombstone({ id: 'b', relativePath: '앰비언스/바람.wav' }),
    tombstone({ id: 'c', relativePath: '', reason: UNLINKED })
  ]);
  assert.deepEqual([...paths], ['타격/펀치.wav'.normalize('NFC')]);
});

test('복원은 사용자가 넣은 값만 되살리고 기술 필드는 되살리지 않는다', () => {
  const fields = restoredSoundFields(tombstone({ duration: 12, codec: 'mp3', size: 1 }));
  assert.equal(fields.id, 'sound-1');
  assert.deepEqual(fields.tags, ['타격', '단단함']);
  assert.equal(fields.notes, '2화 오프닝');
  assert.equal(fields.favorite, true);
  assert.equal(fields.rating, 4);
  assert.deepEqual(fields.keyAnalysis, { detected: true, display: 'C minor' });
  assert.equal(fields.createdAt, 1700000000000);
  assert.equal('duration' in fields, false);
  assert.equal('codec' in fields, false);
  assert.equal('size' in fields, false);
});

test('크기가 0 이거나 알 수 없으면 같은 파일로 보지 않는다', () => {
  assert.equal(isSameFileAsTombstone(tombstone({ size: 0 }), { size: 0, modifiedAt: MTIME }), false);
  assert.equal(isSameFileAsTombstone(tombstone(), { size: NaN, modifiedAt: MTIME }), false);
  assert.equal(isSameFileAsTombstone(null, { size: 1, modifiedAt: MTIME }), false);
});

// missing 표식의 사용자 필드는 늘 비어 있다. 이 Mac 이 그 사이 붙인 태그가 표식 값에
// 덮이면 사용자 결정(정보 있는 항목은 자동 정리하지 않음)이 뒤집힌다.
test('missing 표식을 되살릴 때는 이 Mac 의 더 새로운 기록에서 사용자 필드를 가져온다', () => {
  const missing = tombstone({ reason: MISSING, title: '펀치', tags: [], notes: '', favorite: false, rating: 0, keyAnalysis: null, liveUpdatedAt: 100 });
  const own = { id: 'sound-1', title: '펀치 강', tags: ['폭발'], notes: '메모', favorite: true, rating: 5, keyAnalysis: { display: 'A minor' }, updatedAt: 200 };
  const fields = restoredSoundFields(missing, own);
  assert.equal(fields.id, 'sound-1');
  assert.equal(fields.title, '펀치 강');
  assert.deepEqual(fields.tags, ['폭발']);
  assert.equal(fields.notes, '메모');
  assert.equal(fields.favorite, true);
  assert.equal(fields.rating, 5);
  assert.deepEqual(fields.keyAnalysis, { display: 'A minor' });
  assert.equal(fields.createdAt, missing.createdAt);
});

test('휴지통 표식이나 이 Mac 기록이 삭제 상태면 표식 값으로 되살린다', () => {
  const own = { id: 'sound-1', tags: ['폭발'], updatedAt: 200 };
  assert.deepEqual(restoredSoundFields(tombstone(), own).tags, ['타격', '단단함']);
  const missing = tombstone({ reason: MISSING, tags: [] });
  assert.deepEqual(restoredSoundFields(missing, { ...own, deleted: true }).tags, []);
  assert.deepEqual(restoredSoundFields(missing).tags, []);
});

// A 가 태그를 붙인 뒤 B 가 지웠고, 그다음 C 가 파일을 못 봐 정리했다. A 가 자기 옛 기록으로
// 되살리면 B 에서 일부러 지운 태그가 돌아온다.
test('이 Mac 기록이 표식을 쓴 Mac 이 본 편집보다 오래됐으면 표식 값으로 되살린다', () => {
  const missing = tombstone({ reason: MISSING, tags: [], liveUpdatedAt: 200 });
  assert.deepEqual(restoredSoundFields(missing, { id: 'sound-1', tags: ['A-old'], updatedAt: 100 }).tags, []);
  assert.deepEqual(restoredSoundFields(missing, { id: 'sound-1', tags: ['A-old'], updatedAt: 200 }).tags, []);
});

// liveUpdatedAt 이 없는 표식은 지금과 같이 이 Mac 의 살아 있는 기록을 따른다.
test('liveUpdatedAt 이 없는 missing 표식은 이 Mac 의 살아 있는 기록을 따른다', () => {
  const missing = tombstone({ reason: MISSING, tags: [] });
  assert.deepEqual(restoredSoundFields(missing, { id: 'sound-1', tags: ['A'], updatedAt: 1 }).tags, ['A']);
});
