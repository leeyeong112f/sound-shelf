// macOS Finder에서 ⌘C로 복사한 파일을 읽어내는 부분.
//
// Chromium이 붙여넣기판의 파일을 clipboardData.files로 넘겨주지 않는 경우가
// 있다. 그때는 macOS 붙여넣기판(pasteboard)을 메인 프로세스에서 직접 읽어야
// 하는데, 형식이 두 가지다. NSFilenamesPboardType에는 경로 목록이 plist로
// 들어오고, 그것이 없으면 public.file-url에 첫 파일의 URL만 들어온다.
//
// plist는 예전 XML 형식일 때도 있고 이진(bplist00) 형식일 때도 있다. 요즘
// macOS는 이진으로 주는 쪽이 많아 둘 다 읽는다.
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

function readBigEndian(buffer, start, size) {
  let value = 0;
  for (let index = 0; index < size; index += 1) value = value * 256 + buffer.readUInt8(start + index);
  return value;
}

// 이진 plist의 객체 하나를 읽는다. 문자열이면 돌려주고 그 밖의 형식이면 null이다.
// 앞 4비트가 형식(0x5 아스키, 0x6 UTF-16BE), 뒤 4비트가 길이다. 길이가 15를
// 넘으면 뒤따르는 정수 객체에 실제 길이가 들어 있다.
function readBinaryPlistString(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) return null;
  const marker = buffer.readUInt8(offset);
  const kind = marker >> 4;
  if (kind !== 0x5 && kind !== 0x6) return null;
  let count = marker & 0x0f;
  let start = offset + 1;
  if (count === 0x0f) {
    if (start >= buffer.length) return null;
    const sizeMarker = buffer.readUInt8(start);
    if (sizeMarker >> 4 !== 0x1) return null;
    const width = 1 << (sizeMarker & 0x0f);
    if (start + 1 + width > buffer.length) return null;
    count = readBigEndian(buffer, start + 1, width);
    start += 1 + width;
  }
  const length = kind === 0x5 ? count : count * 2;
  if (length < 0 || start + length > buffer.length) return null;
  if (kind === 0x5) return buffer.toString('latin1', start, start + length);
  // Node에는 UTF-16BE 디코더가 없어 바이트를 뒤집어 UTF-16LE로 읽는다.
  return Buffer.from(buffer.subarray(start, start + length)).swap16().toString('utf16le');
}

// 객체 표를 순서대로 훑어 문자열만 모은다. NSFilenamesPboardType의 이진 형태는
// 경로 문자열만 담긴 배열이라, 참조를 따라가지 않아도 복사한 순서가 그대로 나온다.
function parseBinaryPlist(buffer) {
  // 머리말 8바이트 + 꼬리말 32바이트보다 짧으면 해석할 것이 없다.
  if (buffer.length < 40) return [];
  const trailer = buffer.length - 32;
  const offsetSize = buffer.readUInt8(trailer + 6);
  if (offsetSize < 1 || offsetSize > 8) return [];
  const objectCount = Number(buffer.readBigUInt64BE(trailer + 8));
  const offsetTable = Number(buffer.readBigUInt64BE(trailer + 24));
  const paths = [];
  for (let index = 0; index < objectCount; index += 1) {
    const entry = offsetTable + index * offsetSize;
    if (entry + offsetSize > trailer) break;
    const value = readBinaryPlistString(buffer, readBigEndian(buffer, entry, offsetSize));
    if (value && value.startsWith('/')) paths.push(value);
  }
  return paths;
}

// NSFilenamesPboardType은 POSIX 경로가 담긴 plist 배열이다. 버퍼로 받으면
// 이진 형식까지 읽고, 문자열로 받으면 XML로만 본다.
function parseFilenamesPlist(plistData) {
  const buffer = Buffer.isBuffer(plistData)
    ? plistData
    : Buffer.from(typeof plistData === 'string' ? plistData : '', 'utf8');
  if (!buffer.length) return [];
  if (buffer.subarray(0, 6).toString('latin1') === 'bplist') {
    try {
      return parseBinaryPlist(buffer);
    } catch {
      // 형식이 예상과 다르면 부르는 쪽이 public.file-url로 넘어가면 된다.
      return [];
    }
  }
  const paths = [];
  for (const match of buffer.toString('utf8').matchAll(/<string>([\s\S]*?)<\/string>/g)) {
    const value = decodeXmlEntities(match[1]).trim();
    if (value.startsWith('/')) paths.push(value);
  }
  return paths;
}

// public.file-url은 file:// URL 한 줄이다. 퍼센트 인코딩과 한글 자모 분리가
// 섞여 있을 수 있어 fileURLToPath에 맡긴다.
function parseFileUrl(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('file://')) return null;
  try {
    return fileURLToPath(text);
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
