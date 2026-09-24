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
