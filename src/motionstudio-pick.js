// Motion Studio(DaVinci Resolve OFX 플러그인) 연동: "Pick in Sound Shelf" 고르기 요청을 읽고 응답을 쓴다.
// 흐름: 플러그인이 요청 파일을 쓰고 `open -n -a "Sound Shelf" --args --pick-request <파일>` 로 띄움
//   → Sound Shelf 가 고르기 모드로 앞에 뜸 → 소리를 누르면 응답 파일(path=...)을 쓰고
//   → Motion Studio 의 배치 스크립트(고정 경로)로 그 클립의 In/Out 시점에 타임라인 배치·프리셋 저장.
// 요청 파일은 다른 프로그램이 쓰므로 믿지 않는다: 요청·응답 경로는 고르기 폴더 안만, 실행하는 스크립트는 고정 경로만.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PICK_ARG = '--pick-request';

function pickDirectory(home = os.homedir()) {
  return path.join(home, 'Library', 'Application Support', 'MotionStudio', 'pick');
}

function placeScriptPath(home = os.homedir()) {
  return path.join(home, 'Library', 'Application Support', 'Blackmagic Design', 'DaVinci Resolve', 'Fusion', 'Scripts', 'Utility', 'Motion Studio Sounds.py');
}

function findPickArgument(argv = []) {
  const index = argv.indexOf(PICK_ARG);
  return index >= 0 && typeof argv[index + 1] === 'string' && argv[index + 1] ? argv[index + 1] : null;
}

// Motion Studio 의 key=value 형식(msp::escape: \\ 와 \n 만 이스케이프)
function unescapeValue(value) {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\\' && i + 1 < value.length) {
      out += value[i + 1] === 'n' ? '\n' : value[i + 1];
      i += 1;
    } else out += value[i];
  }
  return out;
}

function escapeValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function parseKeyValues(text) {
  const values = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    values[line.slice(0, eq)] = unescapeValue(line.slice(eq + 1));
  }
  return values;
}

function isInside(directory, file) {
  const relative = path.relative(directory, file);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/// 요청 파일 → { file, slot, label, reply }. 형식이 틀리거나 고르기 폴더 밖이면 예외.
function loadPickRequest(file, { home = os.homedir() } = {}) {
  const directory = pickDirectory(home);
  const realDirectory = fs.existsSync(directory) ? fs.realpathSync(directory) : directory;
  const realFile = fs.realpathSync(file);
  if (!isInside(realDirectory, realFile)) throw new Error('Motion Studio 고르기 요청 위치가 올바르지 않습니다.');
  const values = parseKeyValues(fs.readFileSync(realFile, 'utf8'));
  if (values.version !== '1' || values.app !== 'MotionStudio') throw new Error('지원하지 않는 Motion Studio 요청입니다.');
  if (values.slot !== 'in' && values.slot !== 'out') throw new Error('Motion Studio 요청의 슬롯이 올바르지 않습니다.');
  // 응답 파일은 아직 없으므로 폴더만 실제 경로로 풀어 비교한다(macOS 의 /var → /private/var 같은 링크)
  const replyRaw = path.resolve(values.reply || '');
  const replyParent = fs.existsSync(path.dirname(replyRaw)) ? fs.realpathSync(path.dirname(replyRaw)) : path.dirname(replyRaw);
  const reply = path.join(replyParent, path.basename(replyRaw));
  if (!isInside(realDirectory, reply) || path.extname(reply) !== '.txt') throw new Error('Motion Studio 응답 위치가 올바르지 않습니다.');
  const label = String(values.label || `Motion Studio · ${values.slot === 'in' ? 'In' : 'Out'} Sound`).slice(0, 80);
  return { file: realFile, slot: values.slot, label, reply };
}

/// 고른 소리를 응답 파일로(원자적 쓰기). 플러그인이 다음 상호작용 때 읽어 파라미터에 넣는다.
async function writePickReply(request, sound) {
  const body = `# Sound Shelf -> Motion Studio pick reply\npath=${escapeValue(sound.path)}\nname=${escapeValue(sound.title || path.basename(sound.path))}\nat=${new Date().toISOString()}\n`;
  const temporary = `${request.reply}.tmp`;
  await fsp.mkdir(path.dirname(request.reply), { recursive: true });
  await fsp.writeFile(temporary, body, 'utf8');
  await fsp.rename(temporary, request.reply);
}

module.exports = { PICK_ARG, pickDirectory, placeScriptPath, findPickArgument, parseKeyValues, escapeValue, unescapeValue, loadPickRequest, writePickReply };
