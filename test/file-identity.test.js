const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesRenameFingerprint, normalizedRelativeParent } = require('../src/file-identity');

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
