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

// second-instance 의 argv 는 Chromium 이 순서를 바꾼다(실측: 스위치는 앞으로, 경로는 맨 뒤로).
// 그래서 한 토큰 '--pick-request=<경로>' 를 쓰고, 떨어진 형태로 와도 요청 파일 모양의 인자를 찾는다.
const REQUEST_FILE = /[\\/]MotionStudio[\\/]pick[\\/]request-[^\\/]+\.txt$/;
function findPickArgument(argv = []) {
  const args = argv.filter((value) => typeof value === 'string');
  const joined = args.find((value) => value.startsWith(`${PICK_ARG}=`));
  if (joined) return joined.slice(PICK_ARG.length + 1) || null;
  if (!args.includes(PICK_ARG)) return null;
  const next = args[args.indexOf(PICK_ARG) + 1];
  if (next && !next.startsWith('--') && REQUEST_FILE.test(next)) return next;
  return args.find((value) => REQUEST_FILE.test(value)) || null;
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
  if (!['in', 'out', 'preset'].includes(values.slot)) throw new Error('Motion Studio 요청의 슬롯이 올바르지 않습니다.');
  // 응답 파일은 아직 없으므로 폴더만 실제 경로로 풀어 비교한다(macOS 의 /var → /private/var 같은 링크)
  const replyRaw = path.resolve(values.reply || '');
  const replyParent = fs.existsSync(path.dirname(replyRaw)) ? fs.realpathSync(path.dirname(replyRaw)) : path.dirname(replyRaw);
  const reply = path.join(replyParent, path.basename(replyRaw));
  if (!isInside(realDirectory, reply) || path.extname(reply) !== '.txt') throw new Error('Motion Studio 응답 위치가 올바르지 않습니다.');
  const label = String(values.label || `Motion Studio · ${values.slot === 'in' ? 'In' : values.slot === 'out' ? 'Out' : 'Presets'}`).slice(0, 80);
  const fps = Number(values.fps) > 0 ? Number(values.fps) : 30;
  return { file: realFile, slot: values.slot, label, reply, fps, preset: values.preset || '' };
}

/// 고른 소리를 응답 파일로(원자적 쓰기). 플러그인이 다음 상호작용 때 읽어 파라미터에 넣는다.
async function writePickReply(request, sound) {
  const body = `# Sound Shelf -> Motion Studio pick reply\npath=${escapeValue(sound.path)}\nname=${escapeValue(sound.title || path.basename(sound.path))}\nat=${new Date().toISOString()}\n`;
  const temporary = `${request.reply}.tmp`;
  await fsp.mkdir(path.dirname(request.reply), { recursive: true });
  await fsp.writeFile(temporary, body, 'utf8');
  await fsp.rename(temporary, request.reply);
}

// ---- Motion 프리셋(모션 + 효과음) ----
// 프리셋은 Motion Studio 의 key=value 텍스트 파일(~/Documents/MotionStudio Presets/<카테고리>/<이름>.mspreset).
// 효과음 키: ms{In,Out}Sound(경로: 절대 = Sound Shelf, 상대 = Documents/MotionStudio Sounds 기준), …SoundVol(dB), …SoundOffset(초),
//            …SoundHit(효과음 안의 맞출 지점, 초), …SoundAlign(0 자동 1 시작 2 가장 빠름 3 도착)
const PRESET_EXTENSION = '.mspreset';
const SOUND_KEYS = ['Sound', 'SoundVol', 'SoundOffset', 'SoundHit', 'SoundAlign'];
const ALIGN_NAMES = ['자동', '시작', '가장 빠른 순간', '도착'];

function presetRoot(home = os.homedir()) {
  return path.join(home, 'Documents', 'MotionStudio Presets');
}

function soundRoot(home = os.homedir()) {
  return path.join(home, 'Documents', 'MotionStudio Sounds');
}

function resolveSoundPath(value, home = os.homedir()) {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.join(soundRoot(home), value);
}

// Motion Studio 의 autoSoundAlign 과 같은 규칙(자동일 때 실제로 쓰이는 순간을 보여 주려고)
function autoAlignFor(family) {
  if (['droprise', 'zoom', 'flip'].includes(family)) return 3;
  if (['slide', 'spin', 'reference'].includes(family)) return 2;
  return 1;
}

function assertInsidePresets(file, home = os.homedir()) {
  const root = presetRoot(home);
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  const parent = fs.existsSync(path.dirname(file)) ? fs.realpathSync(path.dirname(file)) : path.dirname(file);
  const real = path.join(parent, path.basename(file));
  if (!isInside(realRoot, real) || path.extname(real) !== PRESET_EXTENSION) throw new Error('Motion 프리셋 폴더 밖의 파일입니다.');
  return real;
}

function slotSummary(values, slot, home) {
  const P = `ms${slot}`;
  const family = values[`${P}Family`] || 'none';
  const align = Number(values[`${P}SoundAlign`] || 0);
  return {
    family,
    variant: values[`${P}Variant`] || 'none',
    sound: values[`${P}Sound`] || '',
    soundPath: resolveSoundPath(values[`${P}Sound`] || '', home),
    volume: Number(values[`${P}SoundVol`] || 0),
    offset: Number(values[`${P}SoundOffset`] || 0),
    hit: Number(values[`${P}SoundHit`] || 0),
    align,
    effectiveAlign: align > 0 ? align : autoAlignFor(family)
  };
}

function readPreset(file, { home = os.homedir() } = {}) {
  const real = assertInsidePresets(file, home);
  const values = parseKeyValues(fs.readFileSync(real, 'utf8'));
  return {
    file: real,
    category: values.category || path.basename(path.dirname(real)),
    name: values.name || path.basename(real, PRESET_EXTENSION),
    in: slotSummary(values, 'In', home),
    out: slotSummary(values, 'Out', home)
  };
}

function listPresets({ home = os.homedir() } = {}) {
  const root = presetRoot(home);
  const out = [];
  for (const category of (fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : [])) {
    if (!category.isDirectory() || category.name.startsWith('.')) continue;
    for (const entry of fs.readdirSync(path.join(root, category.name), { withFileTypes: true })) {
      if (!entry.isFile() || path.extname(entry.name) !== PRESET_EXTENSION) continue;
      try { out.push(readPreset(path.join(root, category.name, entry.name), { home })); } catch { /* 깨진 파일은 건너뜀 */ }
    }
  }
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/// 주석·순서는 그대로 두고 주어진 키만 바꾼다(Motion Studio 의 msp::updateKeys 와 같은 동작)
async function updatePresetKeys(file, values, { home = os.homedir() } = {}) {
  const real = assertInsidePresets(file, home);
  const lines = (await fsp.readFile(real, 'utf8')).split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${escapeValue(value)}`;
    const index = lines.findIndex((item) => item && !item.startsWith('#') && item.startsWith(`${key}=`));
    if (index >= 0) lines[index] = line; else lines.push(line);
  }
  const temporary = `${real}.tmp`;
  await fsp.writeFile(temporary, `${lines.join('\n')}\n`, 'utf8');
  await fsp.rename(temporary, real);
  return readPreset(real, { home });
}

/// 슬롯(In/Out) 효과음 설정을 프리셋 키로
function soundValues(slot, settings) {
  const P = `ms${slot}`;
  const values = {};
  if ('sound' in settings) values[`${P}Sound`] = settings.sound || '';
  if ('volume' in settings) values[`${P}SoundVol`] = String(Number(settings.volume) || 0);
  if ('offset' in settings) values[`${P}SoundOffset`] = String(Number(settings.offset) || 0);
  if ('hit' in settings) values[`${P}SoundHit`] = String(Math.max(0, Number(settings.hit) || 0));
  if ('align' in settings) values[`${P}SoundAlign`] = String(Math.min(3, Math.max(0, Math.round(Number(settings.align) || 0))));
  return values;
}

function safeName(value) {
  return String(value || '').replace(/[/:\\\n\r\t]/g, '-').replace(/^[ .]+|[ ]+$/g, '');
}

/// 다른 이름으로 저장: 원본을 복사하고 category/name 을 바꾼다
async function savePresetAs(file, category, name, { home = os.homedir() } = {}) {
  const source = assertInsidePresets(file, home);
  const cat = safeName(category) || 'My Presets';
  const nm = safeName(name) || 'My Preset';
  const target = path.join(presetRoot(home), cat, `${nm}${PRESET_EXTENSION}`);
  if (fs.existsSync(target)) throw new Error('같은 이름의 프리셋이 이미 있습니다.');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(source, target);
  return updatePresetKeys(target, { category: cat, name: nm }, { home });
}

/// 프리셋 적용 응답: 플러그인이 모션 + 효과음을 통째로 불러오고 타임라인에 배치한다
async function writePresetReply(request, presetFile) {
  const body = `# Sound Shelf -> Motion Studio preset reply\npreset=${escapeValue(presetFile)}\nat=${new Date().toISOString()}\n`;
  const temporary = `${request.reply}.tmp`;
  await fsp.mkdir(path.dirname(request.reply), { recursive: true });
  await fsp.writeFile(temporary, body, 'utf8');
  await fsp.rename(temporary, request.reply);
}

module.exports = {
  PRESET_EXTENSION, SOUND_KEYS, ALIGN_NAMES, presetRoot, soundRoot, resolveSoundPath, autoAlignFor, readPreset, listPresets,
  updatePresetKeys, soundValues, savePresetAs, writePresetReply, PICK_ARG, pickDirectory, placeScriptPath, findPickArgument, parseKeyValues, escapeValue, unescapeValue, loadPickRequest, writePickReply };
