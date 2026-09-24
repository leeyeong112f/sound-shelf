const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
