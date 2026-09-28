const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MISSING_CLEANUP_GRACE_MS,
  MISSING_CLEANUP_MAX_BATCH,
  hasUserMetadata,
  lastTouchedAt,
  selectMissingForCleanup
} = require('../src/missing-cleanup');

const NOW = 1790524135688;
const OLD = NOW - MISSING_CLEANUP_GRACE_MS - 1000;

// 2026-09-20 iMac 이 이름 변경 도중의 파일을 색인해 남긴 레코드와 같은 모양이다.
function ghost(overrides = {}) {
  return {
    id: 'a2838751',
    relativePath: '예능 효과음/일본북/신서유기 효과음 잘라서 사용 - 구간 3.287-4.932 2.wav',
    fileName: '신서유기 효과음 잘라서 사용 - 구간 3.287-4.932 2.wav',
    title: '신서유기 효과음 잘라서 사용 - 구간 3.287-4.932 2',
    tags: [],
    notes: '',
    favorite: false,
    rating: 0,
    keyAnalysis: null,
    createdAt: OLD,
    ...overrides
  };
}

test('사용자 정보 없는 오래된 누락 항목은 정리 대상이다', () => {
  const result = selectMissingForCleanup([ghost()], { now: NOW });
  assert.deepEqual(result.ids, ['a2838751']);
  assert.equal(result.blocked, false);
});

test('태그·메모·즐겨찾기·별점·Key 중 하나라도 있으면 남긴다', () => {
  const kept = [
    ghost({ id: 'tags', tags: ['타격'] }),
    ghost({ id: 'notes', notes: '2화 오프닝' }),
    ghost({ id: 'favorite', favorite: true }),
    ghost({ id: 'rating', rating: 3 }),
    ghost({ id: 'key', keyAnalysis: { detected: true, display: 'C minor' } })
  ];
  const result = selectMissingForCleanup(kept, { now: NOW });
  assert.deepEqual(result.ids, []);
  assert.equal(result.kept, 5);
});

test('직접 바꾼 제목도 사용자 정보로 본다', () => {
  assert.equal(hasUserMetadata(ghost({ title: '일본북 딩' })), true);
  assert.equal(hasUserMetadata(ghost()), false);
});

// 디스크에서 온 파일명은 NFD 일 수 있다. 제목(NFC)과 그대로 비교하면 손대지 않은 제목이
// 직접 바꾼 제목으로 읽혀 유령이 영영 정리되지 않는다.
test('NFD 파일명과 NFC 제목은 같은 이름으로 본다', () => {
  const sound = ghost({
    fileName: ghost().fileName.normalize('NFD'),
    title: ghost().title.normalize('NFC')
  });
  assert.equal(hasUserMetadata(sound), false);
});

test('공백뿐인 메모는 사용자 정보가 아니다', () => {
  assert.equal(hasUserMetadata(ghost({ notes: '  \n' })), false);
});

// 다른 Mac 이 방금 추가한 파일은 Drive 업로드가 끝나기 전까지 이 Mac 에서 누락으로 보인다.
test('마지막 편집 후 유예 시간이 지나지 않았으면 미룬다', () => {
  const recentCreate = ghost({ id: 'recent-create', createdAt: NOW - 60 * 1000 });
  const recentEdit = ghost({ id: 'recent-edit' });
  const result = selectMissingForCleanup([recentCreate, recentEdit], {
    now: NOW,
    baselineById: new Map([['recent-edit', { updatedAt: NOW - 60 * 1000 }]])
  });
  assert.deepEqual(result.ids, []);
  assert.equal(result.deferred, 2);
});

test('베이스 레코드는 updatedAt 이 0 이라 createdAt 만으로 판단한다', () => {
  assert.equal(lastTouchedAt(ghost({ createdAt: 5 }), { updatedAt: 0 }), 5);
  assert.equal(lastTouchedAt(ghost({ createdAt: 5 }), { updatedAt: 9 }), 9);
  assert.equal(lastTouchedAt(ghost({ createdAt: 0 }), undefined), 0);
});

// Drive 가 덜 마운트되면 수백 개가 한꺼번에 누락으로 보인다. 일부만 지워도 되돌릴 수 없다.
test('대상이 한도를 넘으면 하나도 정리하지 않는다', () => {
  const many = Array.from({ length: MISSING_CLEANUP_MAX_BATCH + 1 }, (_, index) => ghost({ id: `g${index}` }));
  const result = selectMissingForCleanup(many, { now: NOW });
  assert.equal(result.blocked, true);
  assert.deepEqual(result.ids, []);
  assert.equal(result.candidates, MISSING_CLEANUP_MAX_BATCH + 1);
});

test('한도와 같은 개수까지는 정리한다', () => {
  const many = Array.from({ length: MISSING_CLEANUP_MAX_BATCH }, (_, index) => ghost({ id: `g${index}` }));
  const result = selectMissingForCleanup(many, { now: NOW });
  assert.equal(result.blocked, false);
  assert.equal(result.ids.length, MISSING_CLEANUP_MAX_BATCH);
});

// 남겨 둘 항목과 미룬 항목은 한도 계산에 넣지 않는다. 태그 달린 누락 항목이 쌓여 있어도
// 정리할 것만 적으면 정리가 막히지 않아야 한다.
test('한도는 실제 정리 대상 수로만 센다', () => {
  const kept = Array.from({ length: MISSING_CLEANUP_MAX_BATCH + 5 }, (_, index) => ghost({ id: `k${index}`, tags: ['x'] }));
  const result = selectMissingForCleanup([...kept, ghost()], { now: NOW });
  assert.equal(result.blocked, false);
  assert.deepEqual(result.ids, ['a2838751']);
});

test('유예 시간이 정확히 지나면 정리 대상이다', () => {
  const sound = ghost({ createdAt: NOW - MISSING_CLEANUP_GRACE_MS });
  assert.deepEqual(selectMissingForCleanup([sound], { now: NOW }).ids, ['a2838751']);
  const almost = ghost({ createdAt: NOW - MISSING_CLEANUP_GRACE_MS + 1 });
  assert.deepEqual(selectMissingForCleanup([almost], { now: NOW }).ids, []);
});

// 지우는 기능은 입력이 이상하면 보류해야 한다.
test('현재 시각을 모르면 모두 미룬다', () => {
  const result = selectMissingForCleanup([ghost()], {});
  assert.deepEqual(result.ids, []);
  assert.equal(result.deferred, 1);
});

test('숫자가 아닌 createdAt 이 유효한 updatedAt 을 버리지 않는다', () => {
  const result = selectMissingForCleanup([ghost({ createdAt: 'abc' })], {
    now: NOW,
    baselineById: new Map([['a2838751', { updatedAt: NOW - 60 * 1000 }]])
  });
  assert.equal(result.deferred, 1);
});

// 재연결이 후보를 하나로 좁히지 못하면 옮겨진 파일은 새 레코드가 된다. 다른 Mac 의 이동 기록이
// 도착하기 전에 옛 레코드를 지우면, 그 Mac 이 붙인 태그를 삭제 표식이 이긴다.
test('이름과 크기가 같은 파일이 최근 새로 색인됐으면 미룬다', () => {
  const missing = ghost({ size: 435456 });
  const lookalike = {
    id: 'new',
    fileName: missing.fileName.normalize('NFD'),
    size: 435456,
    createdAt: NOW - 60 * 1000
  };
  const deferred = selectMissingForCleanup([missing], { now: NOW, presentSounds: [lookalike] });
  assert.deepEqual(deferred.ids, []);
  assert.equal(deferred.deferred, 1);

  const oldLookalike = { ...lookalike, createdAt: OLD };
  assert.deepEqual(selectMissingForCleanup([missing], { now: NOW, presentSounds: [oldLookalike] }).ids, ['a2838751']);
  const otherSize = { ...lookalike, size: 1 };
  assert.deepEqual(selectMissingForCleanup([missing], { now: NOW, presentSounds: [otherSize] }).ids, ['a2838751']);
});
