// 사운드 팩이 함께 배포하는 메타데이터 파일(AI 용 카탈로그)을 읽고 고친다.
//
// 형식: sounds.json = { sounds: [{ file, name, description, use_for, avoid_for, tags, sync, level, ... }] }
// (wyzowl/sfx-kit). 직접 만드는 팩도 이 형식을 따르면 읽힌다. 음악 팩용 bpm·key·moods 같은 필드도 같이 보여준다.
//
// 팩 파일이 원본이다. 볼트 메타데이터(태그·별점·메모)와 섞지 않고, 읽은 내용은 메모리에만 둔다.
// 그래서 팩을 새로 받아 덮어써도 내 태그는 그대로고, 두 Mac 이 같은 정보를 따로 동기화할 일도 없다.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PACK_FILE_NAMES = new Set(['sounds.json']);
const MAX_PACK_FILE_BYTES = 20 * 1024 * 1024;

// 필드 v2 — AI 가 덜 헷갈리게 값을 정해 둔 필드. 자유 태그보다 이 목록에서 고르게 한다.
const ROLES = [
  { id: 'transition', label: '전환' },
  { id: 'accent', label: '강조' },
  { id: 'foley', label: '폴리' },
  { id: 'ui', label: 'UI·알림' },
  { id: 'ambience', label: '앰비언스' },
  { id: 'music', label: '음악' },
  { id: 'voice', label: '목소리' }
];
const INTENSITIES = ['soft', 'medium', 'hard'];
const SYNC_MEETS = ['instant', 'action-start', 'move-peak', 'arrival', 'release'];

// 앱에서 고칠 수 있는 필드. 키는 화면에서 쓰는 이름, 값은 파일 안 필드 이름.
const EDITABLE_FIELDS = {
  description: { key: 'description', kind: 'text' },
  useFor: { key: 'use_for', kind: 'list' },
  avoidFor: { key: 'avoid_for', kind: 'list' },
  tags: { key: 'tags', kind: 'list' }
};

function nfc(value) {
  return String(value || '').normalize('NFC');
}

function isPackFileName(name) {
  return PACK_FILE_NAMES.has(String(name || '').toLowerCase());
}

function detectFormat(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const hasFiles = (list) => Array.isArray(list) && list.some((entry) => entry && typeof entry.file === 'string');
  return hasFiles(json.sounds) ? 'sounds' : null;
}

function entriesOf(json, format) {
  return format === 'sounds' ? json.sounds : [];
}

function stringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function finiteOrNull(value) {
  const number = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(number) ? number : null;
}

// 화면·검색에 쓰는 요약. 모르는 필드는 extra 에 원문 그대로 남긴다.
function summarizeEntry(entry, format) {
  const known = new Set(['file', 'id', 'name', 'title', 'category', 'description', 'use_for', 'avoid_for', 'tags',
    'mood', 'moods', 'styles', 'genres', 'bpm', 'key', 'tempo', 'energy', 'character', 'duration', 'durationS',
    'sync', 'level', 'lufs', 'under_voiceover_db', 'pairs_with', 'loopable', 'license', 'attribution', 'variant',
    'sha256', 'bytes', 'channels', 'fits_seconds', 'aliases', 'role', 'intensity']);
  const range = (value) => (Array.isArray(value) && value.length === 2 && value.every((item) => Number.isFinite(Number(item)))
    ? value.map(Number) : null);
  const level = entry.level && typeof entry.level === 'object' ? entry.level : {};
  const sync = entry.sync && typeof entry.sync === 'object' ? entry.sync : null;
  const moods = stringList(entry.moods);
  if (!moods.length && entry.mood) moods.push(String(entry.mood));
  return {
    format,
    id: String(entry.id || ''),
    name: String(entry.name || entry.title || ''),
    category: String(entry.category || ''),
    description: String(entry.description || ''),
    useFor: stringList(entry.use_for),
    aliases: stringList(entry.aliases),
    role: String(entry.role || ''),
    intensity: String(entry.intensity || entry.variant?.intensity || ''),
    avoidFor: stringList(entry.avoid_for),
    tags: stringList(entry.tags),
    moods,
    styles: stringList(entry.styles),
    genres: stringList(entry.genres),
    variant: entry.variant && typeof entry.variant === 'object' ? entry.variant : null,
    character: String(entry.character || ''),
    bpm: finiteOrNull(entry.bpm),
    key: String(entry.key || ''),
    tempo: String(entry.tempo || ''),
    energy: String(entry.energy || ''),
    duration: finiteOrNull(entry.duration ?? entry.durationS),
    loopable: typeof entry.loopable === 'boolean' ? entry.loopable : null,
    fitsSeconds: range(entry.fits_seconds),
    rateRange: range(entry.adapt?.rate),
    sync: sync ? { at: finiteOrNull(sync.at), meets: String(sync.meets || ''), how: String(sync.how || '') } : null,
    lufs: finiteOrNull(level.lufs ?? entry.lufs),
    truePeak: finiteOrNull(level.true_peak_dbtp),
    underVoiceoverDb: finiteOrNull(entry.under_voiceover_db),
    pairsWith: Array.isArray(entry.pairs_with)
      ? entry.pairs_with.map((pair) => ({ category: String(pair?.category || ''), how: String(pair?.how || '') }))
      : [],
    license: String(entry.license || ''),
    attribution: String(entry.attribution || ''),
    extra: Object.fromEntries(Object.entries(entry).filter(([key]) => !known.has(key)))
  };
}

function searchTextOf(summary) {
  const roleLabel = ROLES.find((role) => role.id === summary.role)?.label || '';
  return [summary.name, summary.id, summary.category, summary.description, summary.character, summary.key,
    summary.tempo, summary.energy, summary.role, roleLabel, ...summary.useFor, ...summary.tags, ...summary.aliases,
    ...summary.moods, ...summary.styles,
    ...summary.genres, ...Object.values(summary.variant || {})]
    .filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase('ko');
}

// entry.file 로 실제 오디오 파일을 찾는다. 파일이 그 자리에 없으면(예: 팩을 받으며 하위 폴더를
// 평평하게 풀었을 때) 팩 폴더 아래 같은 이름 파일이 딱 하나일 때만 그것으로 잇는다.
function resolveEntryPath(packDir, entry, { exists, filesByBaseName }) {
  const direct = path.resolve(packDir, String(entry.file || ''));
  if (!path.relative(packDir, direct).startsWith('..') && exists(direct)) return nfc(direct);
  const candidates = filesByBaseName.get(nfc(path.basename(String(entry.file || ''))).toLowerCase()) || [];
  const inside = candidates.filter((candidate) => !path.relative(packDir, candidate).startsWith('..'));
  return inside.length === 1 ? nfc(inside[0]) : null;
}

// 팩 파일 하나를 읽어 { 오디오 경로 → 항목 } 목록을 만든다. 형식이 아니면 null.
function indexPack(packFile, json, { exists, filesByBaseName }) {
  const format = detectFormat(json);
  if (!format) return null;
  const packDir = path.dirname(packFile);
  const packName = String(json.name || path.basename(packDir));
  const items = [];
  entriesOf(json, format).forEach((entry, index) => {
    if (!entry || typeof entry.file !== 'string') return;
    const audioPath = resolveEntryPath(packDir, entry, { exists, filesByBaseName });
    if (!audioPath) return;
    const summary = summarizeEntry(entry, format);
    items.push({ audioPath, index, file: entry.file, summary, searchText: searchTextOf(summary) });
  });
  return { packFile: nfc(packFile), packName, format, license: String(json.license || ''), items };
}

function detectIndent(text) {
  const match = /^\{\s*\n([ \t]+)\S/.exec(String(text || ''));
  return match ? match[1] : '  ';
}

function cleanEditValue(kind, value) {
  if (kind === 'text') return String(value ?? '').trim();
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,\n]+/);
  return [...new Set(list.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

// edits 는 EDITABLE_FIELDS 의 화면 키로 온다. entry.file 이 같은 항목만 고친다 —
// 다른 곳에서 파일이 바뀌어 순서가 달라졌으면 index 대신 file 로 다시 찾는다.
function applyEdits(json, { index, file }, edits) {
  const format = detectFormat(json);
  if (!format) throw new Error('팩 메타데이터 형식이 아닙니다.');
  const next = structuredClone(json);
  const list = entriesOf(next, format);
  const target = list[locateEntry(list, { index, file })];
  for (const [name, value] of Object.entries(edits || {})) {
    const field = EDITABLE_FIELDS[name];
    if (!field) throw new Error(`고칠 수 없는 필드입니다: ${name}`);
    const cleaned = cleanEditValue(field.kind, value);
    const empty = field.kind === 'text' ? !cleaned : !cleaned.length;
    if (empty && !(field.key in target)) continue;
    target[field.key] = cleaned;
  }
  return next;
}

function locateEntry(list, { index, file }) {
  if (list[index] && list[index].file === file) return index;
  const matches = list.map((entry, position) => (entry && entry.file === file ? position : -1)).filter((position) => position >= 0);
  if (matches.length !== 1) throw new Error('팩 파일에서 이 소리를 찾지 못했습니다. 팩 파일이 바뀌었을 수 있습니다.');
  return matches[0];
}

function entryOf(json, where) {
  const format = detectFormat(json);
  if (!format) throw new Error('팩 메타데이터 형식이 아닙니다.');
  const list = entriesOf(json, format);
  return list[locateEntry(list, where)];
}

// 팝업에서 원문으로 고친 항목을 검사한다. 앱과 AI 가 기대는 필드의 모양만 본다 — 나머지 필드는 자유.
function validateEntry(entry, expectedFile) {
  const problems = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ['항목은 { } 로 감싼 객체여야 합니다.'];
  if (entry.file !== expectedFile) problems.push(`"file" 은 바꿀 수 없습니다 ("${expectedFile}" 그대로 두세요). 다른 파일을 잇는 일은 팩 파일에서 직접 하세요.`);
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
  const numberAt = (label, value) => { if (value !== undefined && value !== null && !isNumber(value)) problems.push(`"${label}" 은 숫자여야 합니다.`); };
  const stringList = (label, value) => {
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) problems.push(`"${label}" 은 문자열 목록이어야 합니다. 예: ["자막 등장", "아이콘 등장"]`);
  };
  for (const key of ['name', 'title', 'id', 'category', 'description', 'character', 'key', 'license']) {
    if (entry[key] !== undefined && typeof entry[key] !== 'string') problems.push(`"${key}" 은 문자열이어야 합니다.`);
  }
  for (const key of ['use_for', 'avoid_for', 'tags', 'aliases', 'moods', 'styles', 'genres']) stringList(key, entry[key]);
  if (entry.role !== undefined && entry.role !== '' && !ROLES.some((role) => role.id === entry.role)) {
    problems.push(`"role" 은 ${ROLES.map((role) => role.id).join(', ')} 중 하나여야 합니다.`);
  }
  if (entry.intensity !== undefined && entry.intensity !== '' && !INTENSITIES.includes(entry.intensity)) {
    problems.push(`"intensity" 는 ${INTENSITIES.join(', ')} 중 하나여야 합니다.`);
  }
  for (const key of ['duration', 'bpm', 'under_voiceover_db']) numberAt(key, entry[key]);
  if (entry.sync !== undefined) {
    if (!entry.sync || typeof entry.sync !== 'object' || Array.isArray(entry.sync)) problems.push('"sync" 는 { "at": 초, ... } 객체여야 합니다.');
    else {
      numberAt('sync.at', entry.sync.at);
      if (entry.sync.meets !== undefined && !SYNC_MEETS.includes(entry.sync.meets)) problems.push(`"sync.meets" 는 ${SYNC_MEETS.join(', ')} 중 하나여야 합니다.`);
    }
  }
  if (entry.level !== undefined) {
    if (!entry.level || typeof entry.level !== 'object' || Array.isArray(entry.level)) problems.push('"level" 은 { "lufs": 숫자, ... } 객체여야 합니다.');
    else { numberAt('level.lufs', entry.level.lufs); numberAt('level.true_peak_dbtp', entry.level.true_peak_dbtp); }
  }
  if (entry.fits_seconds !== undefined && !(Array.isArray(entry.fits_seconds) && entry.fits_seconds.length === 2 && entry.fits_seconds.every(isNumber))) {
    problems.push('"fits_seconds" 는 [최소초, 최대초] 두 숫자여야 합니다.');
  }
  return problems;
}

function replaceEntry(json, where, entry) {
  const format = detectFormat(json);
  if (!format) throw new Error('팩 메타데이터 형식이 아닙니다.');
  const problems = validateEntry(entry, where.file);
  if (problems.length) throw new Error(problems.join('\n'));
  const next = structuredClone(json);
  const list = entriesOf(next, format);
  list[locateEntry(list, where)] = structuredClone(entry);
  return next;
}

// 팩에 없는 사운드의 항목을 넣을 곳: 사운드 폴더에서 볼트 루트까지 올라가며 처음 만나는 sounds.json.
// 하나도 없으면 볼트 루트의 sounds.json (처음 저장할 때 만든다).
function nearestPackFile(audioPath, vaultRoot, exists = fs.existsSync) {
  const root = path.resolve(vaultRoot);
  let current = path.dirname(path.resolve(audioPath));
  while (!path.relative(root, current).startsWith('..')) {
    const candidate = path.join(current, 'sounds.json');
    if (exists(candidate)) return candidate;
    if (current === root) break;
    current = path.dirname(current);
  }
  return path.join(root, 'sounds.json');
}

function slugOf(value) {
  return nfc(value).normalize('NFKC').toLocaleLowerCase('ko').replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'sound';
}

// 새 항목 틀. file 은 팩 파일 폴더 기준 상대 경로(/ 구분). 설명·쓸 곳·피할 곳은 사람이 채운다.
function templateEntry(sound, packFile) {
  const relative = path.relative(path.dirname(packFile), sound.path).split(path.sep).join('/');
  const entry = {
    id: slugOf(sound.fileName || path.basename(sound.path)),
    name: String(sound.title || path.basename(sound.path)),
    category: String(sound.category || ''),
    file: nfc(relative),
    description: '',
    use_for: [],
    avoid_for: [],
    tags: Array.isArray(sound.tags) ? [...sound.tags] : []
  };
  if (Number(sound.duration) > 0) entry.duration = Number(Number(sound.duration).toFixed(3));
  if (Number(sound.channels) > 0) entry.channels = Number(sound.channels);
  return entry;
}

// 새 카탈로그 또는 기존 sounds.json 에 항목을 더한다. 같은 file 이 이미 있으면 거절한다.
function addEntry(json, entry, expectedFile) {
  const problems = validateEntry(entry, expectedFile);
  if (problems.length) throw new Error(problems.join('\n'));
  let next;
  if (json === null || json === undefined) {
    next = {
      name: 'Sound Shelf 카탈로그',
      generator: 'Sound Shelf',
      description: 'Sound Shelf 에서 직접 정리한 사운드 목록. 항목 형식은 wyzowl/sfx-kit 의 sounds.json 을 따르고, aliases(부르는 말)·role(역할)·intensity(세기)를 더한다. 한 줄 요약은 옆의 catalogue.md.',
      sounds: []
    };
  } else {
    if (!json || typeof json !== 'object' || Array.isArray(json) || (json.sounds !== undefined && !Array.isArray(json.sounds))) {
      throw new Error('이 sounds.json 은 { "sounds": [...] } 형식이 아니라 항목을 더할 수 없습니다.');
    }
    next = structuredClone(json);
    if (!Array.isArray(next.sounds)) next.sounds = [];
  }
  if (next.sounds.some((item) => item && nfc(item.file) === nfc(entry.file))) {
    throw new Error('이 파일은 이미 sounds.json 에 있습니다. 목록을 새로 고친 뒤 다시 열어 주세요.');
  }
  next.sounds.push(structuredClone(entry));
  return next;
}

function isOwnCatalog(json) {
  // generator 표시를 넣기 전에 만든 카탈로그도 이름으로 알아본다.
  return Boolean(json && typeof json === 'object' && (json.generator === 'Sound Shelf' || json.name === 'Sound Shelf 카탈로그'));
}

// AI 가 수백 개를 한 번에 훑기 좋은 한 줄 목록. Sound Shelf 가 만든 카탈로그에만 쓴다 —
// 남의 팩(예: wyzowl 의 catalogue.md)은 덮어쓰지 않는다.
function catalogueMarkdown(json) {
  const lines = [`# ${json.name || 'Sound Shelf 카탈로그'}`, '',
    '한 줄에 소리 하나. 형식: **이름** `파일` — 설명 · 쓸 곳 · 피할 곳 · 부르는 말 · 태그 · 역할/세기 · 맞출 지점 · 레벨 · 길이.',
    'Sound Shelf 가 sounds.json 을 저장할 때마다 다시 만든다. 직접 고치지 말 것.', ''];
  for (const entry of entriesOf(json, 'sounds')) {
    if (!entry || typeof entry.file !== 'string') continue;
    const s = summarizeEntry(entry, 'sounds');
    const parts = [s.description || '(설명 없음)'];
    if (s.useFor.length) parts.push(`쓸 곳: ${s.useFor.join('; ')}`);
    if (s.avoidFor.length) parts.push(`피할 곳: ${s.avoidFor.join('; ')}`);
    if (s.aliases.length) parts.push(`부르는 말: ${s.aliases.join(', ')}`);
    if (s.tags.length) parts.push(`태그: ${s.tags.join(', ')}`);
    if (s.role || s.intensity) parts.push(`역할 ${[s.role, s.intensity].filter(Boolean).join('/')}`);
    if (s.sync?.at !== null && s.sync?.at !== undefined) parts.push(`맞출 지점 ${s.sync.at}s${s.sync.meets ? ` (${s.sync.meets})` : ''}`);
    if (s.lufs !== null) parts.push(`${s.lufs} LUFS`);
    if (s.duration !== null) parts.push(`${s.duration}s`);
    lines.push(`- **${s.name || s.id || path.basename(entry.file)}** \`${entry.file}\` — ${parts.join(' · ')}`);
  }
  return `${lines.join('\n')}\n`;
}

async function writeCatalogue(packFile, json) {
  if (!isOwnCatalog(json)) return false;
  const target = path.join(path.dirname(packFile), 'catalogue.md');
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fsp.writeFile(temporary, catalogueMarkdown(json), 'utf8');
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
  return true;
}

async function readPackFile(packFile) {
  const stat = await fsp.stat(packFile);
  if (stat.size > MAX_PACK_FILE_BYTES) throw new Error('팩 메타데이터 파일이 너무 큽니다.');
  const text = await fsp.readFile(packFile, 'utf8');
  return { text, json: JSON.parse(text), mtimeMs: stat.mtimeMs };
}

// 들여쓰기와 끝 줄바꿈을 원래대로 두고 원자적으로 쓴다. 읽은 뒤 다른 곳에서 바뀌었으면 쓰지 않는다.
async function writePackFile(packFile, json, { originalText, expectedMtimeMs, create = false }) {
  const stat = await fsp.stat(packFile).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!stat && !create) throw new Error('팩 파일이 사라졌습니다. 목록을 새로 고친 뒤 다시 열어 주세요.');
  if (stat && create) throw new Error('그 사이 sounds.json 이 새로 생겼습니다. 다시 열어 주세요.');
  if (stat && expectedMtimeMs && Math.abs(stat.mtimeMs - expectedMtimeMs) > 1) {
    throw new Error('팩 파일이 그 사이 바뀌었습니다. 다시 열어 고쳐 주세요.');
  }
  const ending = String(originalText || '').endsWith('\n') ? '\n' : '';
  const body = `${JSON.stringify(json, null, detectIndent(originalText))}${ending}`;
  const temporary = `${packFile}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fsp.writeFile(temporary, body, 'utf8');
    await fsp.rename(temporary, packFile);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function walkPackFiles(rootPath) {
  const results = [];
  const stack = [rootPath];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && isPackFileName(entry.name)) results.push(fullPath);
    }
  }
  return results;
}

// 볼트 전체의 팩 인덱스. mtime 이 그대로인 팩 파일은 다시 파싱하지 않는다.
class PackIndex {
  constructor() {
    this.packs = new Map();   // packFile → { mtimeMs, text, pack }
    this.byAudio = new Map(); // audioPath(NFC) → { packFile, index, file, summary, searchText }
  }

  async refresh(roots, audioPaths) {
    const filesByBaseName = new Map();
    for (const audioPath of audioPaths) {
      const key = nfc(path.basename(audioPath)).toLowerCase();
      if (!filesByBaseName.has(key)) filesByBaseName.set(key, []);
      filesByBaseName.get(key).push(path.resolve(audioPath));
    }
    const exists = (filePath) => fs.existsSync(filePath);
    const found = new Set();
    for (const root of roots) {
      for (const packFile of await walkPackFiles(root)) {
        found.add(nfc(packFile));
        const cached = this.packs.get(nfc(packFile));
        let stat;
        try {
          stat = await fsp.stat(packFile);
        } catch {
          continue;
        }
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.audioCount === audioPaths.length) continue;
        try {
          const { text, json, mtimeMs } = await readPackFile(packFile);
          const pack = indexPack(packFile, json, { exists, filesByBaseName });
          this.packs.set(nfc(packFile), { mtimeMs, text, pack, audioCount: audioPaths.length });
        } catch (error) {
          // JSON 이 아니거나 깨진 파일은 팩이 아닌 것으로 본다.
          this.packs.set(nfc(packFile), { mtimeMs: stat.mtimeMs, text: '', pack: null, audioCount: audioPaths.length, error: error.message });
        }
      }
    }
    for (const packFile of [...this.packs.keys()]) if (!found.has(packFile)) this.packs.delete(packFile);
    this.rebuild();
  }

  rebuild() {
    this.byAudio = new Map();
    for (const { pack } of this.packs.values()) {
      if (!pack) continue;
      for (const item of pack.items) {
        if (!this.byAudio.has(item.audioPath)) {
          this.byAudio.set(item.audioPath, { packFile: pack.packFile, packName: pack.packName, format: pack.format, license: pack.license, ...item });
        }
      }
    }
  }

  lookup(audioPath) {
    return this.byAudio.get(nfc(path.resolve(String(audioPath || '')))) || null;
  }

  packCount() {
    return [...this.packs.values()].filter(({ pack }) => pack).length;
  }
}

// 렌더러로 보내는 모양. 팩 파일 경로는 볼트 기준 상대 경로로 보여준다.
function publicPackInfo(entry, vaultRoot) {
  if (!entry) return null;
  // 설정의 볼트 경로가 NFD 로 저장돼 있을 수 있다 (Google Drive). 양쪽을 NFC 로 맞춰 비교한다.
  const relative = vaultRoot ? path.relative(nfc(path.resolve(vaultRoot)), entry.packFile) : entry.packFile;
  return {
    packName: entry.packName,
    packFile: relative.startsWith('..') ? entry.packFile : relative,
    format: entry.format,
    license: entry.summary.license || entry.license,
    ...entry.summary,
    searchText: entry.searchText
  };
}

module.exports = {
  EDITABLE_FIELDS,
  INTENSITIES,
  ROLES,
  SYNC_MEETS,
  catalogueMarkdown,
  isOwnCatalog,
  writeCatalogue,
  PackIndex,
  addEntry,
  applyEdits,
  detectFormat,
  detectIndent,
  entryOf,
  indexPack,
  isPackFileName,
  nearestPackFile,
  publicPackInfo,
  readPackFile,
  replaceEntry,
  resolveEntryPath,
  searchTextOf,
  summarizeEntry,
  templateEntry,
  validateEntry,
  walkPackFiles,
  writePackFile
};
