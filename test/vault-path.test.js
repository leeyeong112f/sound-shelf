const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { relativePathInside, normalizedRelativePath } = require('../src/vault-storage');

// macOS 는 같은 한글 이름을 NFC 로도 NFD 로도 저장한다. Finder 로 만든 폴더가 NFD 이고
// 앱이 만든 경로가 NFC 인 조합이 실제로 생기며, 정규화 전에 비교하면 볼트 안의 파일이
// "볼트 밖"으로 판정되어 동기화에서 통째로 빠진다.
const NFC_ROOT = '/Users/me/효과음_통합'.normalize('NFC');
const NFD_ROOT = '/Users/me/효과음_통합'.normalize('NFD');

test('NFD 볼트 루트와 NFC 파일 경로를 같은 볼트로 본다', () => {
  const filePath = path.join(NFC_ROOT, '타격', '펀치.wav').normalize('NFC');
  assert.equal(relativePathInside(NFD_ROOT, filePath), '타격/펀치.wav'.normalize('NFC'));
});

test('NFC 볼트 루트와 NFD 파일 경로도 같은 볼트로 본다', () => {
  const filePath = path.join(NFD_ROOT, '타격', '펀치.wav').normalize('NFD');
  assert.equal(relativePathInside(NFC_ROOT, filePath), '타격/펀치.wav'.normalize('NFC'));
});

test('반환한 상대 경로는 항상 NFC 다', () => {
  const filePath = path.join(NFD_ROOT, '드럼.wav').normalize('NFD');
  const relative = relativePathInside(NFD_ROOT, filePath);
  assert.equal(relative, relative.normalize('NFC'));
  assert.equal(relative, '드럼.wav'.normalize('NFC'));
});

test('볼트 루트 자신은 빈 문자열, 볼트 밖은 null 이다', () => {
  assert.equal(relativePathInside(NFC_ROOT, NFC_ROOT), '');
  assert.equal(relativePathInside(NFC_ROOT, NFD_ROOT), '');
  assert.equal(relativePathInside(NFC_ROOT, '/Users/me/다른폴더/a.wav'), null);
  assert.equal(relativePathInside(NFC_ROOT, '/Users/me'), null);
});

// '' 와 null 을 구분하지 않으면 볼트 루트 폴더 자체를 드롭했을 때 자기 안으로 옮기려다 깨진다.
test('빈 문자열과 null 은 서로 다른 뜻이다', () => {
  assert.notEqual(relativePathInside(NFC_ROOT, NFC_ROOT), null);
  assert.strictEqual(relativePathInside(NFC_ROOT, NFC_ROOT), '');
});

test('상위로 빠져나가는 경로는 볼트 밖이다', () => {
  assert.equal(relativePathInside(NFC_ROOT, path.join(NFC_ROOT, '..', 'x.wav')), null);
});

test('normalizedRelativePath 는 구분자와 정규화를 통일한다', () => {
  assert.equal(normalizedRelativePath('타격\\\\펀치.wav'.normalize('NFD')), '타격/펀치.wav'.normalize('NFC'));
  assert.equal(normalizedRelativePath('./타격//./펀치.wav'), '타격/펀치.wav'.normalize('NFC'));
  assert.equal(normalizedRelativePath(''), '');
});
