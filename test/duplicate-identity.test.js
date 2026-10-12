const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseSurvivor, findDuplicateRecords, looksLikeSameFile, mergedSoundFields } = require('../src/duplicate-identity');

// 2026-10-11 pop (뽁) 사례: 옛 레코드(별점 4)는 파일 없음, 새 이름은 새 레코드.
function record(id, relativePath, overrides = {}) {
  const fileName = relativePath.split('/').pop();
  return {
    id, relativePath, fileName, title: fileName.replace(/\.[^.]+$/, ''),
    tags: [], notes: '', favorite: false, rating: 0, keyAnalysis: null,
    createdAt: 1784206724844, size: 333180, duration: 1.73, sampleRate: 48000, channels: 2, codec: 'pcm_s24le',
    ...overrides
  };
}
const OLD = record('old', '예능 효과음/pop (뽁)/또잇.wav', { rating: 4 });
const NEW = record('new', '예능 효과음/pop (뽁)/또잇 2.wav', { createdAt: 1791712730975 });

test('꼬리만 다른 같은 성질의 파일은 같은 파일이다', () => {
  assert.equal(looksLikeSameFile(OLD, NEW), true);
  assert.equal(looksLikeSameFile(OLD, { ...NEW, size: 1 }), false);
  assert.equal(looksLikeSameFile(OLD, { ...NEW, duration: 3 }), false);
  assert.equal(looksLikeSameFile(OLD, { ...NEW, fileName: '또익 2.wav' }), false);
  // 다른 폴더로 옮기며 꼬리가 붙은 경우도 성질이 같으면 같은 파일이다.
  assert.equal(looksLikeSameFile(OLD, { ...NEW, relativePath: '요리/또잇 2.wav' }), true);
});

test('기술 정보를 모르면 같은 폴더의 같은 이름만 믿는다', () => {
  const blind = { duration: 0, sampleRate: 0, channels: 0, codec: '' };
  assert.equal(looksLikeSameFile({ ...OLD, ...blind }, { ...NEW, ...blind }), false);
  assert.equal(looksLikeSameFile({ ...OLD, ...blind }, { ...NEW, ...blind, relativePath: '예능 효과음/pop (뽁)/또잇.wav', fileName: '또잇.wav' }), true);
  assert.equal(looksLikeSameFile({ ...OLD, ...blind }, { ...NEW, ...blind, relativePath: '요리/또잇.wav', fileName: '또잇.wav' }), false);
});

test('후보가 하나일 때만 짝짓고, 같은 live 를 두 번 쓰지 않는다', () => {
  const result = findDuplicateRecords([OLD, record('old2', '예능 효과음/pop (뽁)/또잇.wav')], [NEW]);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].missing.id, 'old');
  assert.equal(result.pairs[0].live.id, 'new');
  const twoLive = findDuplicateRecords([OLD], [NEW, record('new2', '예능 효과음/pop (뽁)/또잇 (1).wav')]);
  assert.equal(twoLive.pairs.length, 0);
  assert.equal(twoLive.ambiguous, 1);
  assert.equal(findDuplicateRecords([OLD], [record('other', '예능 효과음/pop (뽁)/뽁.wav')]).pairs.length, 0);
});

test('더 먼저 만든 레코드가 살아남는다', () => {
  assert.equal(chooseSurvivor(OLD, NEW).survivor.id, 'old');
  assert.equal(chooseSurvivor({ ...OLD, createdAt: NEW.createdAt + 1 }, NEW).survivor.id, 'new');
  assert.equal(chooseSurvivor({ ...OLD, createdAt: 0 }, NEW).survivor.id, 'new');
  assert.equal(chooseSurvivor({ ...OLD, createdAt: NEW.createdAt }, NEW).survivor.id, 'new');
});

test('사용자 정보는 합치고 경로는 파일이 있는 쪽을 쓴다', () => {
  const merged = mergedSoundFields(OLD, { ...NEW, tags: ['효과'], favorite: true, notes: '2화', rating: 2 }, NEW);
  assert.equal(merged.id, 'old');
  assert.equal(merged.rating, 4);
  assert.equal(merged.favorite, true);
  assert.deepEqual(merged.tags, ['효과']);
  assert.equal(merged.notes, '2화');
  assert.equal(merged.createdAt, OLD.createdAt);
  // 둘 다 기본 제목이면 파일이 있는 쪽 이름을 따른다.
  assert.equal(merged.title, '또잇 2');
});

test('직접 붙인 제목은 어느 쪽 것이든 지킨다', () => {
  assert.equal(mergedSoundFields({ ...OLD, title: '또잇 (놀람)' }, NEW, NEW).title, '또잇 (놀람)');
  assert.equal(mergedSoundFields(OLD, { ...NEW, title: '뽁 소리' }, NEW).title, '뽁 소리');
  assert.equal(mergedSoundFields({ ...OLD, notes: '앞' }, { ...NEW, notes: '뒤' }, NEW).notes, '앞\n뒤');
  assert.equal(mergedSoundFields({ ...OLD, notes: '같음' }, { ...NEW, notes: '같음' }, NEW).notes, '같음');
});
