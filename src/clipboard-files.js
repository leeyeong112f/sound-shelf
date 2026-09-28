// macOS Finder에서 ⌘C로 복사한 파일을 읽어내는 부분.
//
// 렌더러의 paste 이벤트로는 Finder가 복사한 파일이 넘어오지 않는다. macOS
// 붙여넣기판(pasteboard)을 메인 프로세스에서 직접 읽어야 하는데, 형식이 두
// 가지다. 여러 개를 복사하면 NSFilenamesPboardType에 경로 목록이 plist로
// 들어오고, 그것이 없으면 public.file-url에 첫 파일의 URL만 들어온다.
//
// 이 파일은 그 원시 데이터를 경로 배열로 바꾸는 일만 한다. Electron에 의존하지
// 않으므로 따로 테스트할 수 있다.
const { fileURLToPath } = require('node:url');

const XML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'"
};

function decodeXmlEntities(value) {
  return String(value).replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity) => {
    if (XML_ENTITIES[entity]) return XML_ENTITIES[entity];
    const decimal = /^&#(\d+);$/.exec(entity);
    if (decimal) return String.fromCodePoint(Number(decimal[1]));
    const hex = /^&#x([0-9a-fA-F]+);$/.exec(entity);
    if (hex) return String.fromCodePoint(parseInt(hex[1], 16));
    return entity;
  });
}

// NSFilenamesPboardType은 POSIX 경로가 담긴 XML plist 배열이다.
// 이진 plist(bplist00)로 오는 경우는 해석하지 않고 빈 배열을 돌려준다.
// 호출한 쪽이 public.file-url로 넘어가면 된다.
function parseFilenamesPlist(plistText) {
  const text = typeof plistText === 'string' ? plistText : '';
  if (!text || text.startsWith('bplist')) return [];
  const paths = [];
  for (const match of text.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
    const value = decodeXmlEntities(match[1]).trim();
    if (value.startsWith('/')) paths.push(value);
  }
  return paths;
}

// public.file-url은 file:// URL 한 줄이다. 퍼센트 인코딩과 한글 자모 분리가
// 섞여 있을 수 있어 fileURLToPath에 맡긴다.
//
// Finder는 여기에 실제 경로가 아니라 file:///.file/id=6571367.2157376445 같은
// 파일 참조 URL을 넣는다. 이 경로는 Cocoa만 풀 수 있고 stat조차 되지 않으므로
// 경로로 쓰지 않는다. Finder가 복사한 것이라면 NSFilenamesPboardType에 진짜
// 경로가 함께 들어 있다.
function parseFileUrl(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('file://')) return null;
  try {
    const filePath = fileURLToPath(text);
    return filePath.startsWith('/.file/id=') ? null : filePath;
  } catch {
    return null;
  }
}

// 붙여넣기판에서 읽은 두 형식을 합쳐 경로 목록으로 만든다.
function clipboardFilePaths({ filenamesPlist = '', fileUrl = '' } = {}) {
  const paths = parseFilenamesPlist(filenamesPlist);
  if (!paths.length) {
    const single = parseFileUrl(fileUrl);
    if (single) paths.push(single);
  }
  return [...new Set(paths.filter(Boolean))];
}

module.exports = { clipboardFilePaths, parseFilenamesPlist, parseFileUrl };
