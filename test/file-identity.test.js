const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesRenameFingerprint, matchesStableFileFingerprint, normalizedRelativeParent } = require('../src/file-identity');

test('relative parent normalization handles Korean paths and separators', () => {
  assert.equal(normalizedRelativeParent('BGM\\클래식\\아베마리아.wav'), 'BGM/클래식');
});

test('a renamed file matches when parent, size, and mtime are unchanged', () => {
  const sound = {
    relativePath: 'BGM/클래식/Ada Ragimov - Ave Maria.wav',
    size: 68799828,
    modifiedAt: 1784354560988.8936
  };
  const candidate = {
    relativePath: 'BGM/클래식/아베마리아.wav',
    size: 68799828,
    modifiedAt: 1784354560988
  };
  assert.equal(matchesRenameFingerprint(sound, candidate), true);
});

test('rename fingerprint rejects a different folder, size, or mtime', () => {
  const sound = {
    relativePath: 'BGM/클래식/original.wav',
    size: 100,
    modifiedAt: 10000
  };
  assert.equal(matchesRenameFingerprint(sound, {
    relativePath: 'BGM/팝/renamed.wav', size: 100, modifiedAt: 10000
  }), false);
  assert.equal(matchesRenameFingerprint(sound, {
    relativePath: 'BGM/클래식/renamed.wav', size: 101, modifiedAt: 10000
  }), false);
  assert.equal(matchesRenameFingerprint(sound, {
    relativePath: 'BGM/클래식/renamed.wav', size: 100, modifiedAt: 13000
  }), false);
});

test('stable file fingerprint can reconnect a uniquely moved and renamed file', () => {
  const sound = {
    relativePath: '한글_번역본/014 - 슬픈 트롬본 - 효과음 (HD).mp3',
    size: 65852,
    modifiedAt: 1780798332424.8801
  };
  assert.equal(matchesStableFileFingerprint(sound, {
    relativePath: '예능 효과음/슬픈 트롬본.mp3',
    size: 65852,
    modifiedAt: 1780798332424.8801
  }), true);
  assert.equal(matchesStableFileFingerprint(sound, {
    relativePath: '예능 효과음/다른 파일.mp3',
    size: 65853,
    modifiedAt: 1780798332424.8801
  }), false);
});

// --- 재연결 후보를 고를 때의 함정 ---
// 아래 두 경우는 실제 앱에서 멀쩡한 사운드의 태그·별점이 엉뚱한 파일로 옮겨가게 만들었다.
// matchesStableFileFingerprint 자체는 옳게 동작하지만, 호출부가 후보를 거르지 않으면
// "같은 지문"이 곧 "같은 파일"이 아니라는 점이 문제가 된다.

test('한 배치로 만든 파일은 크기·mtime 이 같아 서로 구분되지 않는다', () => {
  // 같은 설정으로 연달아 렌더링한 효과음. 지문만으로는 어느 것이 어느 것인지 알 수 없다.
  const rendered = { size: 192078, modifiedAt: 1784354560000 };
  const sibling = { size: 192078, modifiedAt: 1784354560900 };
  assert.equal(matchesStableFileFingerprint(rendered, sibling), true,
    '지문이 같으므로, 후보가 둘 이상이면 호출부가 재연결을 포기해야 한다');
});

test('cp -p 로 만든 복사본은 원본과 지문이 완전히 같다', () => {
  const original = { size: 192078, modifiedAt: 1784354560988 };
  const copied = { size: 192078, modifiedAt: 1784354560988 };
  assert.equal(matchesStableFileFingerprint(original, copied), true,
    '살아있는 사운드와 지문이 겹치는 후보는 옮겨진 파일이 아니라 복사본이다');
});

test('크기가 다르면 mtime 이 같아도 다른 파일이다', () => {
  const a = { size: 192078, modifiedAt: 1784354560988 };
  const b = { size: 384156, modifiedAt: 1784354560988 };
  assert.equal(matchesStableFileFingerprint(a, b), false);
});

// ---- 수정 시각 없이 같은 파일 알아보기 (2026-10-11 iMac 사례) ----
const { matchesRenamedByIdentity, matchesTechnicalIdentity, relatedFileNames } = require('../src/file-identity');

test('복사·충돌 꼬리 하나만 다른 이름은 같은 이름으로 본다', () => {
  assert.equal(relatedFileNames('또잇.wav', '또잇 2.wav'), true);
  assert.equal(relatedFileNames('뽁 2.wav', '뽁 2 2.wav'), true);
  assert.equal(relatedFileNames('hit.mp3', 'hit (1).mp3'), true);
  assert.equal(relatedFileNames('hit.mp3', 'hit copy.mp3'), true);
  assert.equal(relatedFileNames('hit.mp3', 'hit 복사본.mp3'), true);
  assert.equal(relatedFileNames('Hit.MP3', 'hit 2.mp3'), true);
  assert.equal(relatedFileNames('또잇.wav', '또잇.wav'), true);
});

test('다른 렌더일 수 있는 이름은 같은 이름으로 보지 않는다', () => {
  assert.equal(relatedFileNames('hit 2.wav', 'hit 3.wav'), false);
  assert.equal(relatedFileNames('hit.wav', 'hit 2 2.wav'), false);
  assert.equal(relatedFileNames('a.wav', 'b.wav'), false);
  assert.equal(relatedFileNames('a.wav', 'a.mp3'), false);
  assert.equal(relatedFileNames('', 'a.wav'), false);
});

test('크기와 기술 정보가 모두 같아야 같은 파일이다', () => {
  const sound = { size: 333180, duration: 1.73, sampleRate: 48000, channels: 2, codec: 'pcm_s24le' };
  assert.equal(matchesTechnicalIdentity(sound, { ...sound }), true);
  assert.equal(matchesTechnicalIdentity(sound, { ...sound, duration: 1.735 }), true);
  assert.equal(matchesTechnicalIdentity(sound, { ...sound, duration: 1.9 }), false);
  assert.equal(matchesTechnicalIdentity(sound, { ...sound, size: 333181 }), false);
  assert.equal(matchesTechnicalIdentity(sound, { ...sound, sampleRate: 44100 }), false);
  assert.equal(matchesTechnicalIdentity(sound, { ...sound, channels: 1 }), false);
  assert.equal(matchesTechnicalIdentity(sound, { ...sound, codec: 'pcm_s16le' }), false);
  // 모르는 값은 비교에서 빼되, 아는 값이 하나도 없으면 성질 비교가 아니다.
  assert.equal(matchesTechnicalIdentity(sound, { size: 333180, duration: 1.73 }), true);
  assert.equal(matchesTechnicalIdentity({ size: 10 }, { size: 10 }), false);
});

test('같은 폴더에서 꼬리만 달라진 같은 성질의 파일은 이름 변경이다', () => {
  const sound = { relativePath: '예능 효과음/pop (뽁)/또잇.wav', fileName: '또잇.wav', size: 333180, duration: 1.73, sampleRate: 48000, channels: 2, codec: 'pcm_s24le' };
  const renamed = { relativePath: '예능 효과음/pop (뽁)/또잇 2.wav', fileName: '또잇 2.wav', size: 333180, duration: 1.73, sampleRate: 48000, channels: 2, codec: 'pcm_s24le' };
  assert.equal(matchesRenamedByIdentity(sound, renamed), true);
  assert.equal(matchesRenamedByIdentity(sound, { ...renamed, relativePath: '다른 폴더/또잇 2.wav' }), false);
  assert.equal(matchesRenamedByIdentity(sound, { ...renamed, fileName: '또익 2.wav', relativePath: '예능 효과음/pop (뽁)/또익 2.wav' }), false);
  assert.equal(matchesRenamedByIdentity(sound, { ...renamed, duration: 2.5 }), false);
  // 루트 파일끼리도 본다.
  assert.equal(matchesRenamedByIdentity({ ...sound, relativePath: '샤킨.mp3', fileName: '샤킨.mp3' }, { ...renamed, relativePath: '샤킨 2.mp3', fileName: '샤킨 2.mp3' }), true);
});
