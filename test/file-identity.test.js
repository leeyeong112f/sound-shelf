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
