const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const { VaultStorage, normalizedRelativePath, relativePathInside, writeJsonAtomic } = require('./vault-storage');
const { mergeVaultState, pruneRedundantEdits } = require('./vault-sync');
const { matchesRenameFingerprint, matchesStableFileFingerprint } = require('./file-identity');
const { failedProbeMetadata, mediaErrorMessage, needsTechnicalProbe } = require('./media-health');
const { clipboardFilePaths } = require('./clipboard-files');
const { isCurrentKeyAnalysis, keyAnalysisErrorMessage } = require('./key-analysis');
const { canonicalYouTubeUrl, parseDownloadProgress, safeFileStem, youtubeImportErrorMessage } = require('./youtube-import');

const execFileAsync = promisify(execFile);
const AUDIO_EXTENSIONS = new Set([
  '.wav', '.wave', '.aif', '.aiff', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.caf'
]);
const DEFAULT_SHORTCUTS = {
  search: 'Meta+S',
  categorySearch: 'Meta+Shift+S',
  moveCategory: 'Meta+M',
  editTags: 'Meta+T',
  addFiles: 'Meta+O',
  addFolder: 'Meta+Shift+O',
  trash: 'Meta+Backspace',
  reveal: 'Meta+Shift+R',
  favorite: 'Meta+Shift+F',
  settings: 'Meta+Comma',
  playPause: 'Space',
  renameSound: 'Enter',
  insertResolve: 'Meta+F',
  newSubfolder: 'Meta+Shift+N'
};

let mainWindow;
let dbPath;
let db = { version: 1, sounds: [], categories: [], categoryOrder: [], settings: { watchedFolders: [], shortcuts: { ...DEFAULT_SHORTCUTS }, previewVolume: 0.8, machineId: '' } };
let vaultStorage = null;
let activeVault = null;
let saveTimer;
// 진행 중인 로컬 변경 보유 수. boolean이면 겹친 보유자(디바운스 저장 + 배치 작업)
// 중 먼저 끝난 쪽이 플래그를 꺼서 나머지가 무방비가 된다. 카운터는 각자 자기 몫만 해제한다.
let localMutations = 0;
let shortcutCapture = false;
let updateStartupTimer;
let updateCheckTimer;
let updateDialogShown = false;
let automaticUpdaterAvailable = false;
const GITHUB_RELEASES_URL = 'https://github.com/leeyeong112f/sound-shelf/releases/latest';
const GITHUB_LATEST_RELEASE_API = 'https://api.github.com/repos/leeyeong112f/sound-shelf/releases/latest';
let updateStatus = {
  phase: 'idle',
  currentVersion: '',
  latestVersion: '',
  message: '업데이트 확인 버튼을 눌러 최신 버전을 확인하세요.',
  progress: 0,
  releaseUrl: GITHUB_RELEASES_URL,
  automatic: false
};
const waveformCache = new Map();
const waveformJobs = new Map();
const waveformQueue = [];
let activeWaveformJobs = 0;
const MAX_WAVEFORM_JOBS = 2;
const folderWatchers = new Map();
let watcherTimer;
let autoScanRunning = false;
let autoScanPending = false;
const pendingScanFolders = new Set();
const AUTO_RESCAN_DEBOUNCE_MS = 900;
const AUTO_RESCAN_MAX_WAIT_MS = 4000;
let autoRescanFirstRequestAt = 0;
let lastFullScanAt = 0;
let startupLoading = true;
let syncBaseline = new Map();
let ownEdits = { sounds: {}, folderOrder: null, settings: null };
let deletedSoundTombstones = new Map();
let deletedRelativePaths = new Set();
let lastEditStamps = '';
// 기동 시 라이브러리 파손을 복구했거나 볼트를 열지 못했을 때 설정 화면에 알리기 위한 상태.
let libraryRecovery = null;
let vaultActivationError = '';
let syncPollTimer;
const SYNC_POLL_MS = 7000;
let performanceStats = { storage: '볼트 + 로컬 SQLite 캐시', loadMs: 0, fileSize: 0, soundCount: 0, sqliteRecommended: false };
const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) app.quit();
else app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

// Sound Shelf never needs a secondary browser window. In particular, deny
// Chromium's built-in audio document viewer if a file URL is accidentally
// opened by a native drag/drop gesture.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

function findMediaTool(name) {
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || name;
}

function findPython() {
  const candidates = [
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/bin/python3'
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'python3';
}

// Electron 앱은 셸 PATH를 물려받지 못하므로 Homebrew·pip 설치 위치를 직접 찾는다.
// SOUND_SHELF_YT_DLP 환경 변수로 다른 실행 파일을 지정할 수 있다.
function findYtDlp() {
  const override = String(process.env.SOUND_SHELF_YT_DLP || '').trim();
  if (override && fs.existsSync(override)) return override;
  const candidates = [
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    path.join(os.homedir(), '.local', 'bin', 'yt-dlp'),
    path.join(os.homedir(), 'Library', 'Python', '3.13', 'bin', 'yt-dlp'),
    path.join(os.homedir(), 'Library', 'Python', '3.12', 'bin', 'yt-dlp'),
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/yt-dlp',
    '/usr/bin/yt-dlp'
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'yt-dlp';
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 앱을 끄거나 타임아웃이 걸렸을 때 정리해야 할, 오래 도는 자식 프로세스들.
const activeChildProcesses = new Set();

function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    // 음수 pid 는 프로세스 그룹 전체를 뜻한다. detached 로 띄운 자식에만 쓸 수 있다.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 이미 끝난 프로세스 */ }
  }
}

function setDeletedSoundTombstones(records = []) {
  deletedSoundTombstones = new Map((records || []).filter((record) => record?.id)
    .map((record) => [record.id, { ...record, deleted: true }]));
  deletedRelativePaths = new Set([...deletedSoundTombstones.values()]
    .map((record) => normalizedRelativePath(record.relativePath || ''))
    .filter(Boolean));
}

function setSyncBaseline(merged) {
  const live = merged?.sounds || [];
  const deleted = merged?.deletedSounds || [];
  syncBaseline = new Map([...live, ...deleted].filter((sound) => sound?.id)
    .map((sound) => [sound.id, sound]));
  setDeletedSoundTombstones(deleted);
}

function cleanDb(candidate) {
  return {
    version: 3,
    sounds: Array.isArray(candidate?.sounds) ? candidate.sounds : [],
    categories: Array.isArray(candidate?.categories) ? candidate.categories : [],
    categoryOrder: Array.isArray(candidate?.categoryOrder) ? candidate.categoryOrder : [],
    settings: {
      watchedFolders: Array.isArray(candidate?.settings?.watchedFolders)
        ? candidate.settings.watchedFolders
        : [],
      shortcuts: { ...DEFAULT_SHORTCUTS, ...(candidate?.settings?.shortcuts || {}) },
      previewVolume: Number.isFinite(Number(candidate?.settings?.previewVolume))
        ? Math.max(0, Math.min(1, Number(candidate.settings.previewVolume)))
        : 0.8,
      currentVaultRoot: candidate?.settings?.currentVaultRoot || candidate?.settings?.watchedFolders?.[0] || '',
      currentVaultId: candidate?.settings?.currentVaultId || '',
      // 이 Mac만의 ID. 볼트에 저장하면 동기화되어 두 Mac이 같은 ID를 갖게 되므로
      // 반드시 로컬 userData에만 둔다.
      machineId: candidate?.settings?.machineId || crypto.randomUUID()
    }
  };
}

function backupDirectory() {
  return path.join(app.getPath('userData'), 'backups');
}

function backupFileName(prefix = 'automatic') {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
}

async function createAutomaticBackup(reason = 'automatic') {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const directory = backupDirectory();
  await fsp.mkdir(directory, { recursive: true });
  const destination = path.join(directory, backupFileName(reason));
  await fsp.copyFile(dbPath, destination);
  const backups = (await fsp.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => ({ name: entry.name, path: path.join(directory, entry.name), time: fs.statSync(path.join(directory, entry.name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  await Promise.all(backups.slice(15).map((item) => fsp.unlink(item.path).catch(() => {})));
  return destination;
}

// 손상된 라이브러리 JSON을 빈 DB로 덮어쓰면 볼트 연결과 감시 폴더 설정이 함께 사라진다.
// 파손 파일은 지우지 말고 따로 옮겨 두고, 최신 백업부터 차례로 읽어 복구를 시도한다.
async function quarantineCorruptLibrary() {
  if (!dbPath || !fs.existsSync(dbPath)) return '';
  const destination = path.join(path.dirname(dbPath), backupFileName('corrupt'));
  try {
    await fsp.rename(dbPath, destination);
    return destination;
  } catch (error) {
    console.error('Could not quarantine corrupt library:', error.message);
    return '';
  }
}

async function recoverLibraryFromBackups() {
  const directory = backupDirectory();
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (stat) backups.push({ name: entry.name, path: filePath, time: stat.mtimeMs });
  }
  backups.sort((a, b) => b.time - a.time);
  for (const backup of backups) {
    try {
      const candidate = JSON.parse(await fsp.readFile(backup.path, 'utf8'));
      // 방금 만든 startup 백업은 이미 손상된 파일의 사본일 수 있으므로 형태를 확인한다.
      validateImportedDb(candidate);
      return { db: cleanDb(candidate), from: backup.name };
    } catch {
      continue;
    }
  }
  return null;
}

function temporaryClipDirectory() {
  return path.join(app.getPath('temp'), 'sound-shelf-clips');
}

function isTemporaryClipPath(filePath) {
  if (!filePath) return false;
  return relativePathInside(temporaryClipDirectory(), filePath) !== null;
}

async function pruneTemporaryClips(maxAgeMs = 24 * 60 * 60 * 1000) {
  const clipDirectory = temporaryClipDirectory();
  const entries = await fsp.readdir(clipDirectory, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const filePath = path.join(clipDirectory, entry.name);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fsp.unlink(filePath).catch(() => {});
  }));
}

function validateImportedDb(candidate) {
  if (!candidate || !Array.isArray(candidate.sounds) || !candidate.settings) {
    throw new Error('올바른 Sound Shelf 백업 파일이 아닙니다.');
  }
  return cleanDb(candidate);
}

function normalizedFsPath(filePath) {
  return path.resolve(filePath).normalize('NFC');
}

function normalizedAudioBaseName(value) {
  const fileName = path.basename(String(value || '')).normalize('NFKC').trim();
  const extension = path.extname(fileName);
  const baseName = AUDIO_EXTENSIONS.has(extension.toLowerCase())
    ? fileName.slice(0, -extension.length)
    : fileName;
  return baseName.replace(/\s+/g, ' ').trim().toLocaleLowerCase('ko');
}

function normalizedTagKey(value) {
  return String(value || '').normalize('NFKC').replace(/^#+/, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ko');
}

function cleanTagList(values) {
  const unique = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const label = String(value || '').normalize('NFKC').replace(/^#+/, '').replace(/\s+/g, ' ').trim();
    const key = normalizedTagKey(label);
    if (key && !unique.has(key)) unique.set(key, label);
  }
  return [...unique.values()];
}

function canonicalizeWatchedFolders(folders) {
  const unique = [...new Map((folders || []).map((folder) => [normalizedFsPath(folder), path.resolve(folder)])).values()];
  return unique.sort((a, b) => normalizedFsPath(a).length - normalizedFsPath(b).length).filter((folder, index, sorted) => {
    return !sorted.slice(0, index).some((parent) => {
      const relative = path.relative(normalizedFsPath(parent), normalizedFsPath(folder));
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
  });
}

function deduplicateSoundsByPath(sounds) {
  const unique = new Map();
  for (const sound of sounds || []) {
    if (!sound?.path) continue;
    const key = normalizedFsPath(sound.path);
    const existing = unique.get(key);
    sound.id ||= crypto.randomUUID();
    if (!existing) {
      unique.set(key, sound);
      continue;
    }
    existing.tags = [...new Set([...(existing.tags || []), ...(sound.tags || [])])];
    existing.favorite = Boolean(existing.favorite || sound.favorite);
    existing.rating = Math.max(Number(existing.rating || 0), Number(sound.rating || 0));
    existing.notes = existing.notes || sound.notes || '';
    existing.keyAnalysis = existing.keyAnalysis || sound.keyAnalysis || null;
    existing.title = existing.title || sound.title || path.basename(existing.path, path.extname(existing.path));
    existing.createdAt = Math.min(Number(existing.createdAt || Date.now()), Number(sound.createdAt || Date.now()));
    existing.modifiedAt = Math.max(Number(existing.modifiedAt || 0), Number(sound.modifiedAt || 0));
    existing.size = Math.max(Number(existing.size || 0), Number(sound.size || 0));
  }
  return [...unique.values()];
}

function activeVaultRoot() {
  return activeVault?.root || db.settings.currentVaultRoot || db.settings.watchedFolders[0] || '';
}

function soundRelativePath(filePath) {
  const root = activeVaultRoot();
  return root ? relativePathInside(root, filePath) : null;
}

function isRenamedSoundMatch(sound, filePath, stat) {
  const relativePath = soundRelativePath(filePath);
  if (!relativePath) return false;
  return matchesRenameFingerprint(sound, {
    relativePath,
    size: stat?.size,
    modifiedAt: stat?.mtimeMs
  });
}

function portableSound(sound) {
  const relativePath = sound.relativePath || soundRelativePath(sound.path);
  if (!relativePath) return null;
  return {
    id: sound.id || crypto.randomUUID(),
    relativePath,
    fileName: sound.fileName || path.basename(relativePath),
    title: sound.title || path.basename(relativePath, path.extname(relativePath)),
    tags: [...new Set(sound.tags || [])],
    notes: sound.notes || '',
    favorite: Boolean(sound.favorite),
    rating: Number(sound.rating || 0),
    createdAt: Number(sound.createdAt || Date.now()),
    modifiedAt: Number(sound.modifiedAt || 0),
    size: Number(sound.size || 0),
    contentHash: sound.contentHash || '',
    keyAnalysis: sound.keyAnalysis || null
  };
}

function hydratePortableSound(metadata, cache, root) {
  const relativePath = normalizedRelativePath(metadata.relativePath);
  const filePath = path.join(root, ...relativePath.split('/'));
  const categoryPath = inferCategoryPath(filePath);
  return {
    ...(cache || {}),
    id: metadata.id || cache?.id || crypto.randomUUID(),
    relativePath,
    path: filePath,
    fileName: path.basename(filePath),
    title: metadata.title || path.basename(filePath, path.extname(filePath)),
    categoryPath,
    category: categoryPath.split('/').filter(Boolean).pop() || '미분류',
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    notes: metadata.notes || '',
    favorite: Boolean(metadata.favorite),
    rating: Number(metadata.rating || 0),
    createdAt: Number(metadata.createdAt || Date.now()),
    modifiedAt: Number(cache?.modifiedAt || metadata.modifiedAt || 0),
    size: Number(cache?.size || metadata.size || 0),
    duration: Number(cache?.duration || 0),
    sampleRate: Number(cache?.sampleRate || 0),
    channels: Number(cache?.channels || 0),
    codec: cache?.codec || '',
    bitRate: Number(cache?.bitRate || 0),
    embeddedMetadata: cache?.embeddedMetadata || {},
    embeddedTags: cache?.embeddedTags || [],
    metadataVersion: Number(cache?.metadataVersion || 0),
    technicalCached: Boolean(cache),
    contentHash: metadata.contentHash || cache?.contentHash || '',
    contentHashKey: cache?.contentHashKey || '',
    keyAnalysis: metadata.keyAnalysis || null
  };
}

let vaultActivationQueue = Promise.resolve();

// Serialize vault activations: opening a vault from the UI while the startup
// activation is still scanning must not run two scans (and folder repairs)
// concurrently against the same tree.
function activateVault(rootPath, options) {
  const run = vaultActivationQueue.catch(() => {}).then(() => activateVaultNow(rootPath, options));
  vaultActivationQueue = run.catch(() => {});
  return run;
}

// 변경 여부는 id 목록이 아니라 사용자 편집 필드까지 비교해야 한다. 태그만 바뀌고
// 목록 구성이 그대로인 경우가 이 기능의 주 사용 사례이기 때문이다.
function editSignature(sounds) {
  return JSON.stringify(sounds
    .map((sound) => [sound.id, sound.relativePath, sound.title, sound.tags, sound.notes, sound.favorite, sound.rating])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

// 다른 Mac 이 추가한 사운드는 내 로컬 SQLite 에 sound_id 가 없다. 상대 경로로도 찾지 않으면
// 길이·샘플레이트가 전부 0 으로 뜨고 재스캔이 돌 때까지 그대로 남는다.
function hydrateMergedSounds(mergedSounds, root) {
  const cached = vaultStorage?.cachedSounds() || [];
  const cacheById = new Map(cached.map((sound) => [sound.id, sound]));
  const cacheByRelativePath = new Map(cached.map((sound) => [normalizedRelativePath(sound.relativePath), sound]));
  return mergedSounds
    .filter((sound) => sound?.relativePath)
    .map((sound) => hydratePortableSound(
      sound,
      cacheById.get(sound.id) || cacheByRelativePath.get(normalizedRelativePath(sound.relativePath)),
      root
    ));
}

function applyMergedState(merged) {
  const before = editSignature(db.sounds.map(portableSound).filter(Boolean));
  const beforeOrder = JSON.stringify(db.categoryOrder || []);
  const beforeVolume = db.settings.previewVolume;
  db.sounds = deduplicateSoundsByPath(hydrateMergedSounds(merged.sounds, activeVault.root));
  if (merged.folderOrder.length) db.categoryOrder = merged.folderOrder;
  if (merged.previewVolume !== null) db.settings.previewVolume = merged.previewVolume;
  // 원격 반영이 빈 카테고리 폴더를 사이드바에서 지우지 않도록 기존 목록과
  // 합집합한다. 삭제된 폴더의 정리는 지금처럼 다음 폴더 재스캔이 담당한다.
  db.categories = [...new Set([...db.categories, ...db.sounds.map((sound) => sound.categoryPath).filter(Boolean)])]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  setSyncBaseline(merged);
  // 원격에서 삭제된 사운드의 캐시 행이 남으면, 같은 상대 경로의 새 파일이 옛 기술 정보를
  // 물려받는다. 병합 결과를 캐시에 바로 반영한다.
  try {
    vaultStorage?.replaceTechnicalCache(db.sounds.filter((sound) => sound.relativePath));
  } catch (error) {
    console.error('Technical cache rebuild failed after merge:', error.message);
  }
  const soundsChanged = before !== editSignature(db.sounds.map(portableSound).filter(Boolean));
  const orderChanged = beforeOrder !== JSON.stringify(db.categoryOrder || []);
  const volumeChanged = beforeVolume !== db.settings.previewVolume;
  return soundsChanged || orderChanged || volumeChanged;
}

async function activateVaultNow(rootPath, { legacySounds = [], legacyCategoryOrder = db.categoryOrder || [], preserveSettings = true, create = true } = {}) {
  const root = path.resolve(rootPath);
  const previousSettings = preserveSettings ? { ...db.settings } : {};
  vaultStorage?.close();
  vaultStorage = new VaultStorage(root, app.getPath('userData'));
  activeVault = await vaultStorage.initialize({ create });
  db.settings = {
    ...previousSettings,
    shortcuts: { ...DEFAULT_SHORTCUTS, ...(previousSettings.shortcuts || {}) },
    previewVolume: Number.isFinite(Number(previousSettings.previewVolume)) ? Number(previousSettings.previewVolume) : 0.8,
    watchedFolders: [root],
    currentVaultRoot: root,
    currentVaultId: activeVault.id,
    machineId: previousSettings.machineId || crypto.randomUUID()
  };
  let portableMetadata;
  let savedFolderOrder;
  let editSources;
  try {
    [portableMetadata, savedFolderOrder, editSources] = await Promise.all([
      vaultStorage.loadMetadata(),
      vaultStorage.loadFolderOrder(),
      vaultStorage.loadEditSources({ ownMachineId: db.settings.machineId })
    ]);
  } catch (error) {
    // 볼트를 반쯤 연 채로 두면 다음 saveDb 가 아직 다 못 받은 내 편집 파일을 빈 내용으로
    // 덮어쓴다. 연결을 완전히 되돌려 로컬 JSON 경로로만 저장하게 한다.
    vaultStorage?.close();
    vaultStorage = null;
    activeVault = null;
    throw error;
  }
  const merged = mergeVaultState(
    { sounds: portableMetadata.sounds, folderOrder: savedFolderOrder },
    editSources
  );
  // 내 편집 파일의 내용을 메모리로 되살린다. 이걸 하지 않으면 다음 saveDb에서
  // 내 과거 편집이 담긴 파일을 빈 내용으로 덮어써 유실된다.
  const mine = editSources.find((source) => source.machineId === db.settings.machineId);
  ownEdits = {
    sounds: mine?.sounds ? { ...mine.sounds } : {},
    folderOrder: mine?.folderOrder || null,
    settings: mine?.settings || null
  };
  // 베이스와 동일해 병합에 기여하지 않는 군더더기 레코드를 정리한다. 과거에
  // 기술 필드 변화만으로 기록된 전 사운드 레코드가 여기서 줄어들고, 다음
  // saveDb 때 슬림해진 자기 편집 파일만 저장된다.
  ownEdits.sounds = pruneRedundantEdits(ownEdits.sounds, portableMetadata.sounds, EDITABLE_FIELDS);
  const hydrated = hydrateMergedSounds(merged.sounds, root);
  const byRelativePath = new Map(hydrated.map((sound) => [sound.relativePath, sound]));

  for (const legacy of legacySounds || []) {
    if (!legacy?.path) continue;
    const relativePath = relativePathInside(root, legacy.path);
    // 볼트 밖(null)과 루트 자신('') 둘 다 사운드가 될 수 없다.
    if (!relativePath) continue;
    const current = byRelativePath.get(relativePath);
    if (current) {
      current.tags = [...new Set([...(current.tags || []), ...(legacy.tags || [])])];
      current.notes ||= legacy.notes || '';
      current.keyAnalysis ||= legacy.keyAnalysis || null;
      current.favorite = Boolean(current.favorite || legacy.favorite);
      current.rating = Math.max(Number(current.rating || 0), Number(legacy.rating || 0));
      continue;
    }
    const filePath = path.join(root, ...relativePath.split('/'));
    const categoryPath = inferCategoryPath(filePath);
    const migrated = {
      ...legacy,
      id: legacy.id || crypto.randomUUID(),
      relativePath,
      path: filePath,
      fileName: path.basename(filePath),
      categoryPath,
      category: categoryPath.split('/').filter(Boolean).pop() || '미분류',
      technicalCached: Boolean(legacy.codec || legacy.duration || legacy.sampleRate || legacy.metadataVersion)
    };
    hydrated.push(migrated);
    byRelativePath.set(relativePath, migrated);
  }

  db.sounds = deduplicateSoundsByPath(hydrated);
  db.categoryOrder = merged.folderOrder.length ? merged.folderOrder : legacyCategoryOrder;
  if (merged.previewVolume !== null) db.settings.previewVolume = merged.previewVolume;
  setSyncBaseline(merged);
  db.categories = [...new Set(db.sounds.map((sound) => sound.categoryPath).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  // Show the cached library right away — the folder repair and full rescan
  // below can take minutes when the vault lives on cloud storage.
  mainWindow?.webContents.send('library-updated', { ...librarySnapshot(), updateReason: 'vault-cached' });
  await repairDuplicateCategoryFolders();
  await rescanWatchedFolders({ reportProgress: false });
  await vaultStorage.backupPortableMetadata('startup').catch((error) => console.error('Vault backup failed:', error.message));
  refreshFolderWatchers();
  return librarySnapshot();
}

async function repairDuplicateCategoryFolders() {
  for (const root of db.settings.watchedFolders) {
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      let entries = [];
      try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith('.'))) {
        const folder = path.join(current, entry.name);
        const duplicateName = entry.name.normalize('NFC') === path.basename(current).normalize('NFC');
        if (current !== root && duplicateName) {
          const audioFiles = await walkAudioFiles(folder);
          const children = await fsp.readdir(folder, { withFileTypes: true }).catch(() => []);
          const canMerge = audioFiles.length === 0 && children.every((child) => !fs.existsSync(path.join(current, child.name)));
          if (canMerge) {
            for (const child of children) await fsp.rename(path.join(folder, child.name), path.join(current, child.name));
            await fsp.rmdir(folder).catch(() => {});
            for (const child of children.filter((item) => item.isDirectory())) stack.push(path.join(current, child.name));
            continue;
          }
        }
        stack.push(folder);
      }
    }
  }
}

async function loadDb() {
  dbPath = path.join(app.getPath('userData'), 'sound-library.json');
  const startedAt = performance.now();
  await createAutomaticBackup('startup').catch((error) => console.error('Automatic backup failed:', error.message));

  // 읽기·파싱과 볼트 활성화를 분리한다. 하나의 try 로 묶으면 볼트 오류까지 "라이브러리
  // 없음"으로 취급되어 빈 DB 가 저장된다.
  let loaded = null;
  try {
    loaded = cleanDb(JSON.parse(await fsp.readFile(dbPath, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') {
      loaded = null;
    } else {
      console.error('Could not read library:', error);
      const quarantined = await quarantineCorruptLibrary();
      const recovered = await recoverLibraryFromBackups();
      loaded = recovered?.db || null;
      libraryRecovery = { quarantined, recoveredFrom: recovered?.from || '' };
      if (recovered) console.error(`Recovered library from backup: ${recovered.from}`);
      else console.error('No usable backup found; starting with an empty library.');
    }
  }

  try {
    if (!loaded) {
      await saveDb();
    } else {
      db = loaded;
      db.settings.watchedFolders = canonicalizeWatchedFolders(db.settings.watchedFolders);
      const preferredRoot = db.settings.currentVaultRoot || db.settings.watchedFolders.find((folder) => fs.existsSync(folder));
      if (preferredRoot && fs.existsSync(preferredRoot)) {
        // 이미 아는 볼트(currentVaultId 존재)의 로컬 JSON은 캐시 스냅샷일 뿐 원본이
        // 아니다. 원격에서 삭제·수정된 사운드가 오래된 스냅샷에 남아 legacy 마이그레이션
        // 루프로 부활하지 않도록, 진짜 legacy(볼트 이전 버전) 라이브러리일 때만 넘긴다.
        const legacySounds = db.settings.currentVaultId ? [] : db.sounds;
        // 이미 아는 볼트인데 vault.json 이 안 보이면 아직 동기화 중인 것이다. 새로 만들지 않는다.
        await activateVault(preferredRoot, { legacySounds, create: !db.settings.currentVaultId });
      } else {
        db.sounds = deduplicateSoundsByPath(db.sounds);
        await saveDb();
      }
    }
  } catch (error) {
    console.error('Startup vault activation failed:', error);
    vaultActivationError = error.message || String(error);
  }
  const stat = await fsp.stat(dbPath).catch(() => ({ size: 0 }));
  performanceStats = {
    storage: activeVault ? '볼트 + 로컬 SQLite 캐시' : 'JSON 호환 모드',
    loadMs: Number((performance.now() - startedAt).toFixed(2)),
    fileSize: Number(stat.size || 0),
    soundCount: db.sounds.length,
    sqliteRecommended: db.sounds.length >= 10000 || stat.size >= 20 * 1024 * 1024
  };
}

// 사용자 편집으로 취급해 동기화할 필드. modifiedAt/size/contentHash 같은 기술
// 필드는 각 Mac의 로컬 SQLite 캐시가 담당하므로 diff에서 제외한다. 포함하면
// 전체 스캔 한 번에 전 사운드가 편집됨으로 기록되어 편집 파일이 비대해진다.
const EDITABLE_FIELDS = ['relativePath', 'fileName', 'title', 'tags', 'notes', 'favorite', 'rating', 'createdAt', 'keyAnalysis'];

function sameSound(left, right) {
  if (!left || !right) return false;
  return EDITABLE_FIELDS.every((field) => JSON.stringify(left[field] ?? null) === JSON.stringify(right[field] ?? null));
}

// saveDb 호출 지점이 코드 전역에 30곳 있다. 각 편집 지점에서 손으로 updatedAt을
// 찍게 하면 하나만 빠뜨려도 그 편집이 조용히 동기화되지 않는다. 대신 저장 시점에
// 베이스라인과 비교해 달라진 것만 골라낸다. 누락이 원천적으로 불가능하다.
function collectLocalEdits() {
  const now = Date.now();
  const current = new Map();
  for (const sound of db.sounds.map(portableSound).filter(Boolean)) current.set(sound.id, sound);

  for (const [id, sound] of current) {
    const baseline = syncBaseline.get(id);
    // 한 번 삭제한 ID는 명시적인 복원 기능 없이는 일반 스캔 결과로 되살리지 않는다.
    if (ownEdits.sounds[id]?.deleted || deletedSoundTombstones.has(id)) continue;
    if (baseline && !baseline.deleted && sameSound(baseline, sound)) continue;
    ownEdits.sounds[id] = { ...sound, updatedAt: now };
  }

  const known = new Map(syncBaseline);
  for (const [id, record] of Object.entries(ownEdits.sounds)) {
    if (!known.has(id)) known.set(id, { ...record, id });
  }
  for (const [id, baseline] of known) {
    if (current.has(id) || baseline.deleted) continue;
    ownEdits.sounds[id] = { ...baseline, id, updatedAt: now, deleted: true };
  }

  const order = [...new Set(db.categoryOrder || [])];
  if (JSON.stringify(order) !== JSON.stringify(ownEdits.folderOrder?.order || null)) {
    ownEdits.folderOrder = { updatedAt: now, order };
  }

  const volume = Number(db.settings.previewVolume);
  if (Number.isFinite(volume) && volume !== ownEdits.settings?.previewVolume) {
    ownEdits.settings = { updatedAt: now, previewVolume: volume };
  }

  syncBaseline = new Map([...current].map(([id, sound]) => [id, { ...sound, updatedAt: ownEdits.sounds[id]?.updatedAt ?? syncBaseline.get(id)?.updatedAt ?? 0 }]));
  const tombstones = [...deletedSoundTombstones.values()];
  for (const [id, record] of Object.entries(ownEdits.sounds)) {
    if (!record.deleted) continue;
    const tombstone = { ...record, id, deleted: true };
    syncBaseline.set(id, tombstone);
    tombstones.push(tombstone);
  }
  setDeletedSoundTombstones(tombstones);
}

// saveDb 는 디바운스 저장, IPC 핸들러, 자동 재스캔 세 경로에서 동시에 불린다. 직렬화하지
// 않으면 두 쓰기가 겹쳐 라이브러리 JSON 이 잘린 채 남고, 다음 기동에서 loadDb 가 그것을
// 복구해야 하는 상황이 된다. 큐에 얹어 항상 한 번에 하나만 실행한다.
let savingChain = Promise.resolve();

function saveDb() {
  const run = savingChain.catch(() => {}).then(saveDbNow);
  savingChain = run.catch(() => {});
  return run;
}

async function saveDbNow() {
  if (vaultStorage && activeVault) {
    for (const sound of db.sounds) {
      const relativePath = soundRelativePath(sound.path);
      // relativePathInside 는 볼트 밖이면 null, 볼트 루트 자신이면 '' 을 돌려준다. truthy
      // 검사만 하면 볼트 밖으로 나간 파일이 옛 상대 경로를 그대로 들고 있어, 그 경로가
      // 편집 파일과 technical_cache 의 UNIQUE 제약에 유령으로 남는다.
      if (relativePath === null) sound.relativePath = '';
      else sound.relativePath = relativePath;
    }
    collectLocalEdits();
    // 볼트에는 내 편집 파일 하나만 쓴다. metadata.json / folder-order.json /
    // vault.json 은 공유 파일이므로 정상 경로에서 건드리지 않는다.
    await vaultStorage.saveEdits(db.settings.machineId, os.hostname(), ownEdits);
    // 로컬 캐시는 재생성 가능한 파생물이다. 여기서 실패해도 아래 라이브러리 JSON 쓰기까지
    // 중단시키면 볼트 편집 파일만 갱신되고 로컬은 뒤처져 불일치가 남는다.
    try {
      vaultStorage.replaceTechnicalCache(db.sounds.filter((sound) => sound.relativePath));
    } catch (error) {
      console.error('Technical cache rebuild failed:', error.message);
    }
  }
  await fsp.mkdir(path.dirname(dbPath), { recursive: true });
  const temporary = `${dbPath}.tmp-${crypto.randomUUID()}`;
  try {
    await fsp.writeFile(temporary, JSON.stringify(db, null, 2), 'utf8');
    await fsp.rename(temporary, dbPath);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
  const stat = await fsp.stat(dbPath).catch(() => ({ size: 0 }));
  performanceStats.fileSize = Number(stat.size || 0);
  performanceStats.soundCount = db.sounds.length;
  performanceStats.storage = activeVault ? '볼트 + 로컬 SQLite 캐시' : 'JSON 호환 모드';
  performanceStats.sqliteRecommended = false;
}

function queueSave() {
  // 대기 중인 타이머(아직 안 발화)가 있으면 그 보유분을 해제하고 새로 잡는다.
  // 발화한 타이머는 콜백 첫 줄에서 saveTimer를 비우므로 이중 해제가 없다.
  if (saveTimer) {
    clearTimeout(saveTimer);
    localMutations -= 1;
  }
  localMutations += 1;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDb().catch(console.error).finally(() => { localMutations -= 1; });
  }, 150);
}

// 장시간 로컬 배치(파일 이동·ffprobe·해시)가 db.sounds 를 여러 await 에 걸쳐
// 바꾸는 동안 폴링이 끼어들어 applyMergedState 로 통째 교체하면 그 작업이 유실된다.
// 이 래퍼로 감싸면 작업 내내 보유 수가 올라가 폴링이 병합을 건너뛴다.
async function withLocalMutation(work) {
  localMutations += 1;
  try {
    return await work();
  } finally {
    localMutations -= 1;
  }
}

// db.sounds 나 db.settings 를 여러 await 에 걸쳐 바꾸는 핸들러는 이 래퍼로 등록한다.
// 등록 지점에서 감싸 두면 새 핸들러를 추가할 때 보호를 빠뜨리기 어렵다.
// 다이얼로그처럼 사용자를 무한정 기다리는 구간이 있는 핸들러는 여기에 넣지 말고,
// 기다림이 끝난 뒤에 withLocalMutation 을 직접 쓰고 대상을 id 로 다시 조회해야 한다.
function handleMutation(channel, handler) {
  ipcMain.handle(channel, (event, payload) => withLocalMutation(() => handler(event, payload)));
}

function publicSound(sound) {
  return { ...sound, missing: !fs.existsSync(sound.path) };
}

function vaultSnapshot() {
  if (activeVault) {
    return {
      ...activeVault,
      connected: fs.existsSync(activeVault.root),
      soundCount: db.sounds.length,
      metadataPath: vaultStorage?.metadataPath || '',
      folderOrderPath: vaultStorage?.folderOrderPath || ''
    };
  }
  if (!db.settings.currentVaultId) return null;
  return {
    id: db.settings.currentVaultId,
    name: path.basename(db.settings.currentVaultRoot || '이동된 볼트').normalize('NFC'),
    root: db.settings.currentVaultRoot || '',
    connected: false,
    soundCount: db.sounds.length,
    metadataPath: '',
    folderOrderPath: ''
  };
}

function librarySnapshot() {
  const orderedEmptyFolders = [...new Set(db.categoryOrder || [])].filter((category) => {
    if (!category || category === '미분류') return false;
    const folder = categoryFolderPath(category);
    return Boolean(folder && fs.existsSync(folder));
  });
  const categoryPaths = [...new Set([
    ...db.categories,
    ...orderedEmptyFolders,
    ...db.sounds.map((sound) => sound.categoryPath || sound.category)
  ].filter(Boolean))];
  const savedOrder = [...new Set(db.categoryOrder || [])].filter((category) => categoryPaths.includes(category));
  const unordered = categoryPaths
    .filter((category) => !savedOrder.includes(category))
    .sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  db.categoryOrder = [...savedOrder, ...unordered];
  return {
    loading: startupLoading,
    sounds: db.sounds.map(publicSound),
    categories: db.categories,
    categoryPaths: categoryPaths.sort((a, b) => a.localeCompare(b, 'ko')),
    categoryOrder: db.categoryOrder,
    watchedFolders: db.settings.watchedFolders,
    shortcuts: db.settings.shortcuts,
    previewVolume: db.settings.previewVolume,
    vault: vaultSnapshot(),
    libraryRecovery,
    vaultActivationError,
    performance: { ...performanceStats, soundCount: db.sounds.length }
  };
}

function waveformCacheKey(sound) {
  return crypto.createHash('sha1')
    .update(`v3:${sound.id}:${sound.modifiedAt}:${sound.size}`)
    .digest('hex');
}

function waveformCachePath(cacheKey) {
  return path.join(app.getPath('userData'), 'waveform-cache', `${cacheKey}.json`);
}

async function readWaveformDiskCache(cacheKey) {
  try {
    const waveform = JSON.parse(await fsp.readFile(waveformCachePath(cacheKey), 'utf8'));
    if (!Array.isArray(waveform?.left) || !Array.isArray(waveform?.right)) return null;
    return waveform;
  } catch {
    return null;
  }
}

async function writeWaveformDiskCache(cacheKey, waveform) {
  const cachePath = waveformCachePath(cacheKey);
  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.tmp-${crypto.randomUUID()}`;
  try {
    await fsp.writeFile(temporary, JSON.stringify(waveform), 'utf8');
    await fsp.rename(temporary, cachePath);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
}

function runWaveformJob(task) {
  return new Promise((resolve, reject) => {
    waveformQueue.push({ task, resolve, reject });
    const drain = () => {
      while (activeWaveformJobs < MAX_WAVEFORM_JOBS && waveformQueue.length) {
        const job = waveformQueue.shift();
        activeWaveformJobs += 1;
        Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
          activeWaveformJobs -= 1;
          drain();
        });
      }
    };
    drain();
  });
}

async function pruneWaveformDiskCache() {
  const directory = path.join(app.getPath('userData'), 'waveform-cache');
  const valid = new Set(db.sounds.map((sound) => `${waveformCacheKey(sound)}.json`));
  const entries = await fsp.readdir(directory).catch(() => []);
  await Promise.all(entries.filter((name) => name.endsWith('.json') && !valid.has(name))
    .map((name) => fsp.unlink(path.join(directory, name)).catch(() => {})));
}

function inferCategory(filePath) {
  const parent = path.basename(path.dirname(filePath));
  return parent && parent !== path.parse(filePath).root ? parent : '미분류';
}

function inferCategoryPath(filePath) {
  const absolute = normalizedFsPath(filePath);
  const roots = [...db.settings.watchedFolders]
    .map((folder) => normalizedFsPath(folder))
    .sort((a, b) => b.length - a.length);
  const root = roots.find((folder) => {
    const relative = path.relative(folder, absolute);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  if (!root) return inferCategory(filePath);
  const relativeFolder = path.dirname(path.relative(root, absolute));
  if (!relativeFolder || relativeFolder === '.') return '미분류';
  return relativeFolder.split(path.sep).filter(Boolean).join('/').normalize('NFC');
}

async function probeAudio(filePath) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(findMediaTool('ffprobe'), [
        '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath
      ], { maxBuffer: 1024 * 1024 * 8, timeout: 30000 });
      const info = JSON.parse(stdout);
      const audio = info.streams?.find((stream) => stream.codec_type === 'audio');
      if (!audio) throw new Error('Input does not contain any audio stream');
      const rawMetadata = { ...(info.format?.tags || {}), ...(audio.tags || {}) };
      const embeddedMetadata = Object.fromEntries(Object.entries(rawMetadata)
        .filter(([, value]) => value !== null && value !== undefined && String(value).trim())
        .map(([key, value]) => [String(key).toLowerCase(), String(value).trim()]));
      const keywordSource = [embeddedMetadata.keywords, embeddedMetadata.keyword, embeddedMetadata.genre]
        .filter(Boolean).join(',');
      const metadata = {
        duration: Number(info.format?.duration || audio.duration || 0),
        sampleRate: Number(audio.sample_rate || 0),
        channels: Number(audio.channels || 0),
        codec: audio.codec_name || '',
        bitRate: Number(info.format?.bit_rate || audio.bit_rate || 0),
        embeddedMetadata,
        embeddedTags: [...new Set(keywordSource.split(/[,;]+/).map((tag) => tag.trim()).filter(Boolean))],
        metadataVersion: 1,
        technicalCached: true,
        technicalError: ''
      };
      if (!metadata.duration || !metadata.sampleRate || !metadata.channels || !metadata.codec) {
        throw new Error('Audio stream metadata is incomplete');
      }
      return metadata;
    } catch (error) {
      lastError = error;
      if (attempt < 2 && fs.existsSync(filePath)) await wait(350 * (attempt + 1));
    }
  }
  console.error(`Audio metadata probe failed (${path.basename(filePath)}):`, lastError?.message || lastError);
  return failedProbeMetadata(lastError, fs.existsSync(filePath));
}

async function walkAudioFiles(rootPath) {
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
      else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) results.push(fullPath);
    }
  }
  return results;
}

async function findDuplicateAudioName(name, currentPath) {
  const targetName = normalizedAudioBaseName(name);
  const currentNormalizedPath = normalizedFsPath(currentPath);
  const indexedMatch = db.sounds.find((sound) => {
    if (!sound?.path || !fs.existsSync(sound.path)) return false;
    if (normalizedFsPath(sound.path) === currentNormalizedPath) return false;
    return normalizedAudioBaseName(sound.fileName || sound.path || sound.title) === targetName;
  });
  if (indexedMatch) return indexedMatch.path;

  const roots = [...new Set((db.settings.watchedFolders || [])
    .map((folder) => path.resolve(folder))
    .filter((folder) => fs.existsSync(folder)))];
  const physicalFiles = (await Promise.all(roots.map(walkAudioFiles))).flat();
  return physicalFiles.find((filePath) => normalizedFsPath(filePath) !== currentNormalizedPath
    && normalizedAudioBaseName(filePath) === targetName) || null;
}

async function walkCategoryFolders(rootPath) {
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
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);
      const relative = path.relative(rootPath, fullPath).split(path.sep).filter(Boolean).join('/').normalize('NFC');
      if (relative) results.push(relative);
      stack.push(fullPath);
    }
  }
  return results;
}

async function indexFiles(filePaths, { reportProgress = true, categoryFolders = null, allowRestore = false } = {}) {
  const existingByPath = new Map(db.sounds.map((sound) => [normalizedFsPath(sound.path), sound]));
  const existingByRelativePath = new Map(db.sounds
    .filter((sound) => sound.relativePath)
    .map((sound) => [normalizedRelativePath(sound.relativePath), sound]));
  let added = 0;
  let updated = 0;
  const total = filePaths.length;

  for (let index = 0; index < total; index += 1) {
    const filePath = path.resolve(filePaths[index]);
    // Resolve range drags need a real filesystem path, but the generated file
    // is a disposable transport artifact and must never become library data.
    if (isTemporaryClipPath(filePath)) continue;
    const relativePath = soundRelativePath(filePath);
    const indexedCurrent = existingByPath.get(normalizedFsPath(filePath))
      || (relativePath ? existingByRelativePath.get(relativePath) : null);
    if (!allowRestore && !indexedCurrent && relativePath
      && deletedRelativePaths.has(normalizedRelativePath(relativePath))) continue;
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;

    let current = indexedCurrent;
    let discoveredRename = false;
    if (!current) {
      const normalizedName = path.basename(filePath).normalize('NFC').toLocaleLowerCase('ko');
      const missingMatches = db.sounds.filter((sound) => !fs.existsSync(sound.path)
        && path.basename(sound.path).normalize('NFC').toLocaleLowerCase('ko') === normalizedName
        && Number(sound.size) === Number(stat.size));
      if (missingMatches.length === 1) current = missingMatches[0];
    }
    if (!current) {
      const renamedMatches = db.sounds.filter((sound) => !fs.existsSync(sound.path)
        && isRenamedSoundMatch(sound, filePath, stat));
      if (renamedMatches.length === 1) {
        current = renamedMatches[0];
        discoveredRename = true;
      }
    }
    const id = current?.id || crypto.randomUUID();
    const needsProbe = needsTechnicalProbe(current, stat);
    const technical = needsProbe ? await probeAudio(filePath) : current;
    const categoryPath = current?.categoryPath || inferCategoryPath(filePath);
    const next = {
      id,
      relativePath: relativePath || current?.relativePath || '',
      path: filePath,
      fileName: path.basename(filePath),
      title: discoveredRename ? path.basename(filePath, path.extname(filePath)) : (current?.title || path.basename(filePath, path.extname(filePath))),
      categoryPath,
      category: categoryPath.split('/').filter(Boolean).pop() || current?.category || inferCategory(filePath),
      tags: current?.tags || [],
      notes: current?.notes || '',
      favorite: Boolean(current?.favorite),
      rating: Number(current?.rating || 0),
      createdAt: current?.createdAt || Date.now(),
      modifiedAt: stat.mtimeMs,
      size: stat.size,
      duration: technical.duration || 0,
      sampleRate: technical.sampleRate || 0,
      channels: technical.channels || 0,
      codec: technical.codec || '',
      bitRate: technical.bitRate || 0,
      embeddedMetadata: technical.embeddedMetadata || current?.embeddedMetadata || {},
      embeddedTags: technical.embeddedTags || current?.embeddedTags || [],
      metadataVersion: Number.isFinite(Number(technical.metadataVersion))
        ? Number(technical.metadataVersion)
        : Number(current?.metadataVersion || 0),
      technicalCached: technical.technicalCached !== false,
      technicalError: technical.technicalError || '',
      contentHash: needsProbe ? '' : (current?.contentHash || ''),
      contentHashKey: needsProbe ? '' : (current?.contentHashKey || '')
    };

    if (current) {
      Object.assign(current, next);
      existingByPath.set(normalizedFsPath(filePath), current);
      if (relativePath) existingByRelativePath.set(relativePath, current);
      updated += 1;
    } else {
      db.sounds.push(next);
      existingByPath.set(normalizedFsPath(filePath), next);
      if (relativePath) existingByRelativePath.set(relativePath, next);
      added += 1;
    }

    if (reportProgress && (index % 5 === 0 || index === total - 1)) {
      mainWindow?.webContents.send('scan-progress', { current: index + 1, total, fileName: path.basename(filePath) });
    }
  }

  db.categories = [...new Set([...(categoryFolders || db.categories), ...db.sounds.map((sound) => sound.categoryPath || sound.category)].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  db.sounds = deduplicateSoundsByPath(db.sounds);
  await saveDb();
  return { ...librarySnapshot(), scanResult: { added, updated, total } };
}

async function relinkMissingFromFiles(filePaths) {
  const missing = db.sounds.filter((sound) => !fs.existsSync(sound.path));
  const existingByPath = new Map(
    db.sounds
      .filter((sound) => fs.existsSync(sound.path))
      .map((sound) => [normalizedFsPath(sound.path), sound])
  );
  const candidates = new Map();
  const candidateStats = [];
  for (const filePath of filePaths) {
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat) continue;
    candidateStats.push({ filePath, size: stat.size, modifiedAt: stat.mtimeMs });
    const key = `${path.basename(filePath).normalize('NFC').toLocaleLowerCase('ko')}:${stat.size}`;
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(filePath);
  }
  const idChanges = {};
  const mergedIds = new Set();
  const candidateHashes = new Map();
  let relinked = 0;
  for (const sound of missing) {
    const key = `${path.basename(sound.path).normalize('NFC').toLocaleLowerCase('ko')}:${sound.size}`;
    let matches = candidates.get(key) || [];
    let discoveredRename = false;
    if (matches.length !== 1) {
      const renamedMatches = candidateStats
        .filter((candidate) => isRenamedSoundMatch(sound, candidate.filePath, {
          size: candidate.size,
          mtimeMs: candidate.modifiedAt
        }))
        .map((candidate) => candidate.filePath);
      if (renamedMatches.length === 1) {
        matches = renamedMatches;
        discoveredRename = true;
      }
    }
    if (matches.length !== 1) {
      const movedAndRenamedMatches = candidateStats
        .filter((candidate) => matchesStableFileFingerprint(sound, {
          size: candidate.size,
          modifiedAt: candidate.modifiedAt
        }))
        .map((candidate) => candidate.filePath);
      if (movedAndRenamedMatches.length === 1) {
        matches = movedAndRenamedMatches;
        discoveredRename = true;
      }
    }
    if (matches.length !== 1 && sound.contentHash) {
      const contentMatches = [];
      for (const candidate of candidateStats.filter((item) => Number(item.size) === Number(sound.size))) {
        let contentHash = candidateHashes.get(candidate.filePath);
        if (!contentHash) {
          contentHash = await hashFile(candidate.filePath).catch(() => '');
          candidateHashes.set(candidate.filePath, contentHash);
        }
        if (contentHash === sound.contentHash) contentMatches.push(candidate.filePath);
      }
      if (contentMatches.length === 1) matches = contentMatches;
    }
    if (matches.length !== 1) continue;
    const oldId = sound.id;
    const matchPath = matches[0];
    const existing = existingByPath.get(normalizedFsPath(matchPath));
    if (existing && existing !== sound) {
      existing.tags = [...new Set([...(existing.tags || []), ...(sound.tags || [])])];
      existing.embeddedTags = [...new Set([...(existing.embeddedTags || []), ...(sound.embeddedTags || [])])];
      if (!existing.notes && sound.notes) existing.notes = sound.notes;
      if (!existing.keyAnalysis && sound.keyAnalysis) existing.keyAnalysis = sound.keyAnalysis;
      existing.favorite = Boolean(existing.favorite || sound.favorite);
      existing.rating = Math.max(Number(existing.rating || 0), Number(sound.rating || 0));
      existing.createdAt = Math.min(Number(existing.createdAt || Date.now()), Number(sound.createdAt || Date.now()));
      idChanges[oldId] = existing.id;
      mergedIds.add(oldId);
    } else {
      sound.path = matchPath;
      sound.fileName = path.basename(matchPath);
      if (discoveredRename) sound.title = path.basename(matchPath, path.extname(matchPath));
      sound.relativePath = soundRelativePath(matchPath) || sound.relativePath || '';
      sound.categoryPath = inferCategoryPath(matchPath);
      sound.category = sound.categoryPath.split('/').pop();
      existingByPath.set(normalizedFsPath(matchPath), sound);
      idChanges[oldId] = oldId;
    }
    relinked += 1;
  }
  if (mergedIds.size) db.sounds = db.sounds.filter((sound) => !mergedIds.has(sound.id));
  db.sounds = deduplicateSoundsByPath(db.sounds);
  return { missing: missing.length, relinked, unresolved: missing.length - relinked, idChanges };
}

async function rescanWatchedFolders({ reportProgress = true, allowRestore = false } = {}) {
  const [groups, categoryGroups] = await Promise.all([
    Promise.all(db.settings.watchedFolders.map(walkAudioFiles)),
    Promise.all(db.settings.watchedFolders.map(walkCategoryFolders))
  ]);
  const files = [...new Set(groups.flat())];
  lastFullScanAt = Date.now();
  const relinkResult = await relinkMissingFromFiles(files);
  const snapshot = await indexFiles(files, {
    reportProgress,
    categoryFolders: [...new Set(categoryGroups.flat())],
    allowRestore
  });
  db.categories = [...new Set([...categoryGroups.flat(), ...db.sounds.map((sound) => sound.categoryPath)].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  await saveDb();
  return { ...librarySnapshot(), idChanges: relinkResult.idChanges, relinkResult };
}

async function rescanChangedFolders(folders, { reportProgress = false } = {}) {
  const root = activeVaultRoot();
  if (!root) return rescanWatchedFolders({ reportProgress });
  const usable = [...new Set(folders || [])]
    .map((folder) => path.resolve(folder))
    .filter((folder) => relativePathInside(root, folder) !== null && fs.existsSync(folder));
  if (!usable.length) return rescanWatchedFolders({ reportProgress });
  const minimal = usable.filter((folder, index, all) => !all.some((other, otherIndex) => {
    if (index === otherIndex) return false;
    const relative = path.relative(other, folder);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  }));
  const files = [...new Set((await Promise.all(minimal.map(walkAudioFiles))).flat())];
  const relinkResult = await relinkMissingFromFiles(files);
  await indexFiles(files, { reportProgress });
  const categoryGroups = await Promise.all(db.settings.watchedFolders.map(walkCategoryFolders));
  db.categories = [...new Set([...categoryGroups.flat(), ...db.sounds.map((sound) => sound.categoryPath)].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  await saveDb();
  return { ...librarySnapshot(), idChanges: relinkResult.idChanges, relinkResult, partialScan: true };
}

async function runAutoRescan(reason = 'folder-change') {
  if (startupLoading) return;
  if (autoScanRunning) {
    autoScanPending = true;
    return;
  }
  autoScanRunning = true;
  try {
    const changedFolders = [...pendingScanFolders];
    pendingScanFolders.clear();
    const snapshot = changedFolders.length && reason !== 'window-focus'
      ? await rescanChangedFolders(changedFolders, { reportProgress: false })
      : await rescanWatchedFolders({ reportProgress: false });
    mainWindow?.webContents.send('library-updated', { ...snapshot, updateReason: reason });
  } catch (error) {
    console.error('Automatic library refresh failed:', error);
  } finally {
    autoScanRunning = false;
    if (autoScanPending) {
      autoScanPending = false;
      scheduleAutoRescan('pending-change');
    }
  }
}

// 매 이벤트마다 타이머를 리셋하기만 하면, Google Drive 가 수천 개를 내려받는 동안
// 900ms 가 한 번도 비지 않아 재스캔이 영영 실행되지 않는다. 첫 이벤트로부터
// AUTO_RESCAN_MAX_WAIT_MS 가 지나면 더 미루지 않는다.
function scheduleAutoRescan(reason = 'folder-change', changedPath = '') {
  if (changedPath) pendingScanFolders.add(changedPath);
  const now = Date.now();
  if (!autoRescanFirstRequestAt) autoRescanFirstRequestAt = now;
  const remaining = AUTO_RESCAN_MAX_WAIT_MS - (now - autoRescanFirstRequestAt);
  clearTimeout(watcherTimer);
  watcherTimer = setTimeout(() => {
    autoRescanFirstRequestAt = 0;
    // 스캔도 볼트 활성화 큐에 얹는다. 큐를 우회하면 vault:open/move 의 활성화 스캔과
    // 같은 트리를 동시에 훑게 된다.
    vaultActivationQueue = vaultActivationQueue
      .catch(() => {})
      .then(() => runAutoRescan(reason))
      .catch((error) => console.error('Automatic library refresh failed:', error));
  }, Math.max(0, Math.min(AUTO_RESCAN_DEBOUNCE_MS, remaining)));
}

// fs.watch 를 쓰지 않는 이유: Google Drive 가상 파일시스템이 macOS FSEvents 를
// 제대로 발생시키는지 보장할 수 없다. mtime 폴링은 확실히 동작하고, Drive 자체의
// 내려받기 지연이 훨씬 크므로 7초면 충분하다.
async function pollRemoteEdits() {
  if (startupLoading || !vaultStorage || !activeVault) return;
  if (!fs.existsSync(activeVault.root)) return;
  // 로컬 편집이 자기 편집 파일에 안착하기 전에 병합하면, applyMergedState의 전체
  // 교체가 방금 편집을 되돌리고 다음 saveDb가 그것을 baseline과 같다고 보아 영구
  // 유실시킨다. 저장 대기 중이거나 스캔 중이면 이번 회차를 건너뛴다.
  if (localMutations > 0 || autoScanRunning) return;
  const stamps = await vaultStorage.editFileStamps(db.settings.machineId).catch(() => null);
  if (!stamps) return;
  const fingerprint = JSON.stringify(stamps);
  if (fingerprint === lastEditStamps) return;

  const [portableMetadata, savedFolderOrder, editSources] = await Promise.all([
    vaultStorage.loadMetadata(),
    vaultStorage.loadFolderOrder(),
    vaultStorage.loadEditSources({ ownMachineId: db.settings.machineId })
  ]);
  // await 사이에 로컬 편집이 들어왔으면 이번 회차를 포기한다. fingerprint를 저장하지
  // 않으므로 다음 tick에서 다시 시도한다. 이 지점 이후는 동기 실행이라 안전하다.
  if (localMutations > 0 || autoScanRunning) return;
  lastEditStamps = fingerprint;
  const merged = mergeVaultState(
    { sounds: portableMetadata.sounds, folderOrder: savedFolderOrder },
    editSources
  );
  const changed = applyMergedState(merged);
  if (!changed) return;
  mainWindow?.webContents.send('library-updated', { ...librarySnapshot(), updateReason: 'remote-sync' });
}

function startSyncPolling() {
  stopSyncPolling();
  syncPollTimer = setInterval(() => {
    // 볼트 활성화 큐에 얹어 스캔과 병합이 겹치지 않게 직렬화한다.
    vaultActivationQueue = vaultActivationQueue
      .catch(() => {})
      .then(() => pollRemoteEdits())
      .catch((error) => console.error('Remote sync poll failed:', error));
  }, SYNC_POLL_MS);
}

function stopSyncPolling() {
  clearInterval(syncPollTimer);
  syncPollTimer = null;
}

// 볼트 제어 폴더와 Finder 가 수시로 건드리는 부산물은 재스캔 대상이 아니다. .DS_Store 는
// 폴더 창을 열기만 해도 바뀌어서, 거르지 않으면 앱을 쓰지 않는 동안에도 전체 재스캔이 돈다.
const IGNORED_WATCH_NAMES = new Set(['.DS_Store', '.localized', 'Icon\r']);

function isWatchWorthyChange(relativeName) {
  const parts = relativeName.split(path.sep).filter(Boolean);
  if (parts.includes('.sound-shelf')) return false;
  const base = parts[parts.length - 1] || '';
  if (IGNORED_WATCH_NAMES.has(base)) return false;
  // 내려받는 중인 Drive 임시 파일과 우리가 쓰는 원자적 임시 파일도 무시한다.
  // 확장자로 오디오 여부를 거르지는 않는다. "Drums 2.0" 같은 폴더가 파일로 오인돼
  // 폴더 생성·이름 변경이 반영되지 않기 때문이다.
  return !/\.(tmp|part|crdownload|download)$/i.test(base) && !base.includes('.tmp-');
}

function refreshFolderWatchers() {
  const watched = new Set(db.settings.watchedFolders.map((folder) => path.resolve(folder)));
  for (const [folder, watcher] of folderWatchers) {
    if (!watched.has(folder)) {
      watcher.close();
      folderWatchers.delete(folder);
    }
  }
  for (const folder of watched) {
    if (folderWatchers.has(folder) || !fs.existsSync(folder)) continue;
    try {
      const watcher = fs.watch(folder, { recursive: process.platform === 'darwin' }, (_eventType, fileName) => {
        const relativeName = String(fileName || '');
        if (!relativeName || !isWatchWorthyChange(relativeName)) return;
        const changedPath = path.join(folder, relativeName);
        // 콜백은 메인 프로세스 이벤트 루프에서 돈다. Google Drive 경로의 statSync 는
        // 네트워크 왕복이라 이벤트가 몰리면 UI 가 통째로 멈춘다. 비동기로 확인하고,
        // 확인 전에도 부모 폴더는 바로 예약해 이벤트를 놓치지 않는다.
        scheduleAutoRescan('folder-change', path.dirname(changedPath));
        fsp.stat(changedPath)
          .then((stat) => { if (stat.isDirectory()) scheduleAutoRescan('folder-change', changedPath); })
          .catch(() => { /* 삭제·이동된 경로. 부모 폴더 예약만으로 충분하다 */ });
      });
      watcher.on('error', (error) => console.error(`Folder watcher failed (${folder}):`, error.message));
      folderWatchers.set(folder, watcher);
    } catch (error) {
      console.error(`Could not watch folder (${folder}):`, error.message);
    }
  }
}

function normalizedShortcutFromInput(input) {
  const parts = [];
  if (input.meta) parts.push('Meta');
  if (input.control) parts.push('Control');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  let key = input.key;
  if (key === ',') key = 'Comma';
  if (key === ' ') key = 'Space';
  if (key === 'Delete') key = 'Backspace';
  if (key?.length === 1) key = key.toUpperCase();
  if (!['Meta', 'Control', 'Alt', 'Shift'].includes(key)) parts.push(key);
  return parts.join('+');
}

function uniqueDestination(folder, fileName) {
  const parsed = path.parse(fileName);
  let candidate = path.join(folder, fileName);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(folder, `${parsed.name} ${counter}${parsed.ext}`);
    counter += 1;
  }
  return candidate;
}

async function moveFile(source, destination) {
  try {
    await fsp.rename(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fsp.copyFile(source, destination);
    await fsp.unlink(source);
  }
}

function isTrashPath(filePath) {
  return normalizedFsPath(filePath).split(path.sep)
    .some((part) => ['.Trash', '.Trashes', '$RECYCLE.BIN'].includes(part));
}

async function moveDirectory(source, destination) {
  try {
    await fsp.rename(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fsp.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    await fsp.rm(source, { recursive: true, force: false });
  }
}

function watchedRootForFile(filePath) {
  const absolute = normalizedFsPath(filePath);
  return [...db.settings.watchedFolders]
    .sort((a, b) => normalizedFsPath(b).length - normalizedFsPath(a).length)
    .find((folder) => {
      const relative = path.relative(normalizedFsPath(folder), absolute);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    });
}

function normalizeCategoryPath(categoryPath) {
  return String(categoryPath || '').split(/[\\/>]+/)
    .map((part) => part.trim().replace(/[:*?"<>|]/g, '-').normalize('NFC')).filter(Boolean).join('/');
}

function categoryFolderPath(categoryPath) {
  const normalized = normalizeCategoryPath(categoryPath);
  const matchingSound = db.sounds.find((sound) => {
    const soundCategory = sound.categoryPath || sound.category;
    return soundCategory === normalized || soundCategory?.startsWith(`${normalized}/`);
  });
  const root = (matchingSound && watchedRootForFile(matchingSound.path)) || db.settings.watchedFolders[0];
  if (!root) return null;
  if (!normalized || normalized === '미분류') return path.resolve(root);
  return path.join(path.resolve(root), ...normalized.split('/'));
}

function categoryPathForFolder(folderPath) {
  const absolute = path.resolve(folderPath);
  for (const categoryPath of db.categories) {
    const candidate = categoryFolderPath(categoryPath);
    if (candidate && normalizedFsPath(candidate) === normalizedFsPath(absolute)) return categoryPath;
  }
  return null;
}

function updateSoundsForCategoryMove(sourceCategory, destinationCategory, sourceFolder, destinationFolder) {
  const idChanges = {};
  for (const sound of db.sounds) {
    const currentCategory = sound.categoryPath || sound.category;
    if (currentCategory !== sourceCategory && !currentCategory?.startsWith(`${sourceCategory}/`)) continue;
    const oldId = sound.id;
    const suffix = currentCategory.slice(sourceCategory.length).replace(/^\//, '');
    sound.categoryPath = suffix ? `${destinationCategory}/${suffix}` : destinationCategory;
    sound.category = sound.categoryPath.split('/').pop();
    const relativeFile = path.relative(sourceFolder, sound.path);
    sound.path = path.join(destinationFolder, relativeFile);
    sound.fileName = path.basename(sound.path);
    sound.relativePath = soundRelativePath(sound.path) || sound.relativePath || '';
    idChanges[oldId] = sound.id;
  }
  db.categories = [...new Set(db.categories.map((category) => {
    if (category === sourceCategory) return destinationCategory;
    if (category.startsWith(`${sourceCategory}/`)) return `${destinationCategory}${category.slice(sourceCategory.length)}`;
    return category;
  }))].sort((a, b) => a.localeCompare(b, 'ko'));
  db.categoryOrder = [...new Set((db.categoryOrder || []).map((category) => {
    if (category === sourceCategory) return destinationCategory;
    if (category.startsWith(`${sourceCategory}/`)) return `${destinationCategory}${category.slice(sourceCategory.length)}`;
    return category;
  }))];
  waveformCache.clear();
  return idChanges;
}

async function moveCategoryDirectory(sourceCategory, targetCategory) {
  const source = normalizeCategoryPath(sourceCategory);
  const target = normalizeCategoryPath(targetCategory);
  if (!source || source === '미분류') throw new Error('미분류 루트 폴더는 이동할 수 없습니다.');
  if (target === source || target.startsWith(`${source}/`)) throw new Error('폴더를 자기 자신이나 하위 폴더로 이동할 수 없습니다.');
  const sourceFolder = categoryFolderPath(source);
  const targetFolder = categoryFolderPath(target);
  if (!sourceFolder || !targetFolder || !fs.existsSync(sourceFolder)) throw new Error('이동할 폴더를 찾을 수 없습니다.');
  await fsp.mkdir(targetFolder, { recursive: true });
  const destinationFolder = path.join(targetFolder, path.basename(sourceFolder));
  if (path.resolve(destinationFolder) === path.resolve(sourceFolder)) return librarySnapshot();
  if (fs.existsSync(destinationFolder)) throw new Error('대상 폴더에 같은 이름의 폴더가 이미 있습니다.');
  await moveFile(sourceFolder, destinationFolder);
  const destinationCategory = target === '미분류'
    ? path.basename(sourceFolder)
    : `${target}/${path.basename(sourceFolder)}`;
  const idChanges = updateSoundsForCategoryMove(source, destinationCategory, sourceFolder, destinationFolder);
  await saveDb();
  refreshFolderWatchers();
  return { ...librarySnapshot(), idChanges, categoryMove: { from: source, to: destinationCategory } };
}

async function moveFileIntoCategory(filePath, categoryPath) {
  if (isTemporaryClipPath(filePath)) {
    throw new Error('Resolve 전송용 임시 구간은 라이브러리로 이동할 수 없습니다. “선택 구간 파일 만들기”를 이용해 주세요.');
  }
  const folder = categoryFolderPath(categoryPath);
  if (!folder) throw new Error('대상 카테고리 폴더를 찾을 수 없습니다.');
  await fsp.mkdir(folder, { recursive: true });
  const destination = uniqueDestination(folder, path.basename(filePath));
  await moveFile(filePath, destination);
  return destination;
}

async function moveSoundToFolder(sound, folder, categoryPath, { save = true } = {}) {
  const folderStat = await fsp.stat(folder).catch(() => null);
  if (!folderStat?.isDirectory()) throw new Error('선택한 카테고리 폴더가 존재하지 않습니다. 기존 폴더를 선택해 주세요.');
  const destination = path.resolve(path.dirname(sound.path)) === path.resolve(folder)
    ? sound.path
    : uniqueDestination(folder, sound.fileName);
  if (path.resolve(sound.path) !== path.resolve(destination)) await moveFile(sound.path, destination);
  const oldId = sound.id;
  const stat = await fsp.stat(destination);
  sound.path = destination;
  sound.fileName = path.basename(destination);
  sound.relativePath = soundRelativePath(destination) || sound.relativePath || '';
  sound.categoryPath = categoryPath || inferCategoryPath(destination);
  sound.category = sound.categoryPath.split('/').filter(Boolean).pop() || inferCategory(destination);
  sound.modifiedAt = stat.mtimeMs;
  sound.size = stat.size;
  waveformCache.clear();
  db.categories = [...new Set([...db.categories, sound.categoryPath].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  if (save) await saveDb();
  return { ...librarySnapshot(), moved: { oldId, id: sound.id, path: destination } };
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function createWindow() {
  const appPage = path.join(__dirname, 'index.html');
  const appPageUrl = pathToFileURL(appPage).href;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#101114',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl === appPageUrl || navigationUrl.startsWith(`${appPageUrl}#`)) return;
    event.preventDefault();
  });
  await mainWindow.loadFile(appPage);
  mainWindow.on('focus', () => {
    if (Date.now() - lastFullScanAt > 5 * 60 * 1000) scheduleAutoRescan('window-focus');
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (shortcutCapture) return;
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    const shortcut = normalizedShortcutFromInput(input);
    if (shortcut === 'Space' || shortcut === 'Enter') return;
    if (!Object.values(db.settings.shortcuts).includes(shortcut)) return;
    event.preventDefault();
    mainWindow.webContents.send('shortcut-triggered', shortcut);
  });
}

function configureAutoUpdates() {
  const updateConfiguration = path.join(process.resourcesPath, 'app-update.yml');
  if (!app.isPackaged || !fs.existsSync(updateConfiguration)) return;
  automaticUpdaterAvailable = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => publishUpdateStatus({
    phase: 'checking',
    message: 'GitHub에서 최신 버전을 확인하고 있습니다.',
    progress: 0,
    automatic: true
  }));
  autoUpdater.on('update-available', (info) => publishUpdateStatus({
    phase: 'downloading',
    latestVersion: info.version || updateStatus.latestVersion,
    message: `새 버전 ${info.version || ''}을 다운로드하고 있습니다.`,
    progress: 0,
    automatic: true
  }));
  autoUpdater.on('update-not-available', (info) => publishUpdateStatus({
    phase: 'current',
    latestVersion: info.version || updateStatus.latestVersion || app.getVersion(),
    message: '현재 최신 버전을 사용하고 있습니다.',
    progress: 100,
    automatic: true
  }));
  autoUpdater.on('download-progress', (progress) => publishUpdateStatus({
    phase: 'downloading',
    message: `새 버전을 다운로드하고 있습니다. ${Math.round(progress.percent || 0)}%`,
    progress: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
    automatic: true
  }));
  autoUpdater.on('error', (error) => {
    console.error('Automatic update failed:', error.message);
    publishUpdateStatus({
      phase: 'error',
      message: `자동 업데이트를 완료하지 못했습니다. GitHub 배포 페이지에서 직접 받을 수 있습니다.`,
      automatic: true
    });
  });
  autoUpdater.on('update-downloaded', async (info) => {
    publishUpdateStatus({
      phase: 'downloaded',
      latestVersion: info.version || updateStatus.latestVersion,
      message: '업데이트 준비가 끝났습니다. 재시작하면 새 버전이 적용됩니다.',
      progress: 100,
      automatic: true
    });
    if (updateDialogShown) return;
    updateDialogShown = true;
    const options = {
      type: 'info',
      buttons: ['재시작하고 업데이트', '나중에'],
      defaultId: 0,
      cancelId: 1,
      title: 'Sound Shelf 업데이트 준비 완료',
      message: `새 버전 ${info.version}을 다운로드했습니다.`,
      detail: '지금 재시작하면 업데이트가 적용됩니다. 나중에 선택하면 앱을 종료할 때 자동으로 적용됩니다.'
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) autoUpdater.quitAndInstall(false, true);
    else updateDialogShown = false;
  });
  const checkForUpdates = () => autoUpdater.checkForUpdates().catch((error) => {
    console.error('Could not check for updates:', error.message);
  });
  updateStartupTimer = setTimeout(checkForUpdates, 12000);
  updateCheckTimer = setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
}

function compareVersions(first, second) {
  const normalize = (value) => {
    const cleaned = String(value || '').trim().replace(/^v/i, '');
    const [core = '0', prerelease = ''] = cleaned.split('-', 2);
    return {
      numbers: core.split('.').slice(0, 4).map((part) => Number.parseInt(part, 10) || 0),
      prerelease
    };
  };
  const left = normalize(first);
  const right = normalize(second);
  const width = Math.max(left.numbers.length, right.numbers.length, 3);
  for (let index = 0; index < width; index += 1) {
    const difference = (left.numbers[index] || 0) - (right.numbers[index] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease, undefined, { numeric: true });
}

function currentUpdateStatus() {
  return {
    ...updateStatus,
    currentVersion: app.getVersion(),
    automatic: automaticUpdaterAvailable
  };
}

function publishUpdateStatus(patch = {}) {
  updateStatus = { ...updateStatus, ...patch, currentVersion: app.getVersion() };
  const status = currentUpdateStatus();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', status);
  return status;
}

async function latestGitHubRelease() {
  const response = await fetch(GITHUB_LATEST_RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Sound-Shelf-Updater',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub 응답 ${response.status}`);
  const release = await response.json();
  return {
    version: String(release.tag_name || release.name || '').replace(/^v/i, ''),
    url: release.html_url || GITHUB_RELEASES_URL
  };
}

async function checkForApplicationUpdate() {
  publishUpdateStatus({
    phase: 'checking',
    message: 'GitHub에서 최신 버전을 확인하고 있습니다.',
    progress: 0
  });
  try {
    const release = await latestGitHubRelease();
    if (!release?.version) {
      return publishUpdateStatus({
        phase: 'no-release',
        latestVersion: '',
        message: 'GitHub에 아직 공개된 배포 버전이 없습니다.',
        releaseUrl: GITHUB_RELEASES_URL,
        progress: 0
      });
    }
    const patch = { latestVersion: release.version, releaseUrl: release.url };
    if (compareVersions(release.version, app.getVersion()) <= 0) {
      return publishUpdateStatus({
        ...patch,
        phase: 'current',
        message: `현재 최신 버전 ${app.getVersion()}을 사용하고 있습니다.`,
        progress: 100
      });
    }
    if (!automaticUpdaterAvailable) {
      return publishUpdateStatus({
        ...patch,
        phase: 'manual-available',
        message: `새 버전 ${release.version}이 있습니다. GitHub에서 내려받아 설치할 수 있습니다.`,
        progress: 0
      });
    }
    publishUpdateStatus({
      ...patch,
      phase: 'downloading',
      message: `새 버전 ${release.version}을 다운로드할 준비를 하고 있습니다.`,
      progress: 0
    });
    await autoUpdater.checkForUpdates();
    return currentUpdateStatus();
  } catch (error) {
    console.error('Manual update check failed:', error.message);
    return publishUpdateStatus({
      phase: 'error',
      message: `업데이트를 확인하지 못했습니다: ${error.message}`,
      progress: 0
    });
  }
}

if (singleInstanceLock) app.whenReady().then(async () => {
  // Show the window immediately; the vault scan (potentially slow on cloud
  // storage like Google Drive) runs afterwards and pushes 'library-updated'.
  await createWindow();
  configureAutoUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  try {
    await loadDb();
    await pruneWaveformDiskCache();
    await pruneTemporaryClips();
    await pruneYouTubeTemporaryFiles();
  } catch (error) {
    console.error('Startup library load failed:', error);
  } finally {
    startupLoading = false;
    refreshFolderWatchers();
    startSyncPolling();
    mainWindow?.webContents.send('library-updated', { ...librarySnapshot(), updateReason: 'startup' });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitFlushDone = false;
app.on('before-quit', (event) => {
  clearTimeout(updateStartupTimer);
  clearInterval(updateCheckTimer);
  stopSyncPolling();
  clearTimeout(watcherTimer);
  // 15분짜리 유튜브 다운로드가 돌고 있으면 앱을 꺼도 백그라운드에 남는다.
  for (const child of activeChildProcesses) killProcessTree(child);
  activeChildProcesses.clear();
  for (const watcher of folderWatchers.values()) watcher.close();
  folderWatchers.clear();
  // 대기 중인 디바운스 저장이 있거나 저장·배치가 진행 중이면 종료를 한 번 미루고
  // 마무리를 기다린다(최대 3초). 마지막 편집이 파일에 닿기 전에 죽는 것을 막는다.
  if (!quitFlushDone && (saveTimer || localMutations > 0)) {
    event.preventDefault();
    quitFlushDone = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      saveDb().catch(console.error).finally(() => { localMutations -= 1; });
    }
    const deadline = Date.now() + 3000;
    const wait = setInterval(() => {
      if (localMutations <= 0 || Date.now() >= deadline) {
        clearInterval(wait);
        app.quit();
      }
    }, 50);
    return;
  }
  vaultStorage?.close();
});

ipcMain.handle('library:get', () => librarySnapshot());

ipcMain.handle('update:status', () => currentUpdateStatus());

ipcMain.handle('update:check', () => checkForApplicationUpdate());

ipcMain.handle('update:install', () => {
  if (!automaticUpdaterAvailable || updateStatus.phase !== 'downloaded') {
    throw new Error('아직 설치할 업데이트가 준비되지 않았습니다.');
  }
  publishUpdateStatus({ phase: 'installing', message: '앱을 재시작해 업데이트를 적용합니다.' });
  setTimeout(() => autoUpdater.quitAndInstall(false, true), 120);
  return currentUpdateStatus();
});

ipcMain.handle('update:open-release', async () => {
  // releaseUrl 은 GitHub API 응답에서 그대로 받은 값이다. 스킴을 확인하지 않으면
  // 임의 스킴이 shell.openExternal 로 넘어간다.
  const candidate = String(updateStatus.releaseUrl || '');
  let target = GITHUB_RELEASES_URL;
  try {
    if (new URL(candidate).protocol === 'https:') target = candidate;
  } catch { /* 잘못된 URL 이면 기본 릴리스 페이지를 연다 */ }
  await shell.openExternal(target);
  return true;
});

ipcMain.handle('library:add-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '볼트로 이동할 사운드 파일 선택',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS].map((ext) => ext.slice(1)) }]
  });
  if (result.canceled) return null;
  if (result.filePaths.some(isTemporaryClipPath)) {
    throw new Error('Resolve 전송용 임시 구간은 라이브러리에 추가되지 않습니다. “선택 구간 파일 만들기” 버튼을 이용해 주세요.');
  }
  const root = activeVaultRoot();
  if (!root) throw new Error('먼저 사운드 볼트를 열어 주세요.');
  // 다이얼로그 대기는 밖에 두고, 파일 이동과 인덱싱만 보호한다.
  return withLocalMutation(async () => {
    const moved = [];
    for (const filePath of result.filePaths) {
      if (relativePathInside(root, filePath) !== null) moved.push(filePath);
      else {
        const destination = uniqueDestination(root, path.basename(filePath));
        await moveFile(filePath, destination);
        moved.push(destination);
      }
    }
    return indexFiles(moved, { allowRestore: true });
  });
});

async function addPathsToLibrary(paths) {
  const files = [];
  const root = activeVaultRoot();
  if (!root) throw new Error('먼저 사운드 볼트를 열어 주세요.');
  const uniquePaths = [...new Set(paths || [])];
  if (uniquePaths.some(isTemporaryClipPath)) {
    throw new Error('Resolve 전송용 임시 구간은 라이브러리에 추가되지 않습니다. “선택 구간 파일 만들기” 버튼을 이용해 주세요.');
  }
  for (const itemPath of uniquePaths) {
    const stat = await fsp.stat(itemPath).catch(() => null);
    if (stat && isTrashPath(itemPath)) {
      throw new Error('휴지통 파일은 왼쪽의 원하는 카테고리 또는 선택한 카테고리 화면에 놓아주세요.');
    }
    if (stat?.isDirectory()) {
      if (relativePathInside(root, itemPath) !== null) files.push(...await walkAudioFiles(itemPath));
      else {
        const destination = uniqueDestination(root, path.basename(itemPath));
        await moveDirectory(itemPath, destination);
        files.push(...await walkAudioFiles(destination));
      }
    }
    else if (stat?.isFile() && AUDIO_EXTENSIONS.has(path.extname(itemPath).toLowerCase())) {
      if (relativePathInside(root, itemPath) !== null) files.push(itemPath);
      else {
        const destination = uniqueDestination(root, path.basename(itemPath));
        await moveFile(itemPath, destination);
        files.push(destination);
      }
    }
  }
  refreshFolderWatchers();
  return indexFiles([...new Set(files)], { allowRestore: true });
}

handleMutation('library:add-paths', async (_event, paths) => addPathsToLibrary(paths));

// Finder에서 ⌘C로 복사한 파일은 렌더러의 paste 이벤트에 실려 오지 않는다.
// macOS 붙여넣기판을 메인 프로세스에서 직접 읽어야 한다.
function pasteboardFilePaths() {
  let filenamesPlist = '';
  try {
    filenamesPlist = clipboard.readBuffer('NSFilenamesPboardType').toString('utf8');
  } catch {
    // 이 형식이 없는 경우다. 아래 public.file-url로 넘어간다.
  }
  let fileUrl = '';
  try {
    fileUrl = clipboard.read('public.file-url');
  } catch {
    // macOS가 아닌 환경.
  }
  return clipboardFilePaths({ filenamesPlist, fileUrl });
}

// 붙여넣기는 드래그앤드롭과 같은 일을 한다. 카테고리를 보고 있으면 그 폴더로,
// 아니면 볼트 루트로 파일을 옮긴 뒤 등록한다.
handleMutation('library:paste-clipboard-files', async (_event, { category = null } = {}) => {
  const paths = pasteboardFilePaths();
  if (!paths.length) return { ok: false, reason: 'empty' };
  const usable = [];
  for (const itemPath of paths) {
    const stat = await fsp.stat(itemPath).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory() || AUDIO_EXTENSIONS.has(path.extname(itemPath).toLowerCase())) usable.push(itemPath);
  }
  if (!usable.length) return { ok: false, reason: 'unsupported', total: paths.length };
  const snapshot = category
    ? await dropPathsIntoCategory(category, usable)
    : await addPathsToLibrary(usable);
  return { ok: true, count: usable.length, snapshot };
});

ipcMain.handle('library:add-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Sound Shelf 볼트 열기',
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  await saveDb();
  // 이 버튼은 첫 실행 온보딩 경로이기도 하다. 아직 볼트를 모를 때만 새로 만들고,
  // 이미 볼트를 아는 상태에서는 만들지 않는다. .sound-shelf 가 아직 동기화되지 않은
  // 폴더를 열었을 때 새 UUID 를 발급하면 태그·별점·메모가 통째로 날아간다.
  return activateVault(result.filePaths[0], {
    legacySounds: [],
    legacyCategoryOrder: [],
    create: !db.settings.currentVaultId
  });
});

ipcMain.handle('vault:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '기존 Sound Shelf 볼트 열기',
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  await saveDb();
  return activateVault(result.filePaths[0], { legacySounds: [], legacyCategoryOrder: [], create: false });
});

ipcMain.handle('vault:create', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '새 볼트로 사용할 폴더 선택 또는 생성',
    buttonLabel: '이 폴더를 볼트로 사용',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled) return null;
  const selected = result.filePaths[0];
  const manifestPath = path.join(selected, '.sound-shelf', 'vault.json');
  if (fs.existsSync(manifestPath)) throw new Error('이미 Sound Shelf 볼트인 폴더입니다. “기존 볼트 열기”를 사용해 주세요.');
  await saveDb();
  return activateVault(selected, { legacySounds: [], legacyCategoryOrder: [] });
});

ipcMain.handle('vault:locate', async () => {
  const expectedVaultId = activeVault?.id || db.settings.currentVaultId;
  if (!expectedVaultId) throw new Error('다시 연결할 볼트 정보가 없습니다.');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '이동된 현재 볼트의 새 위치 선택',
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  const selected = result.filePaths[0];
  const manifestPath = path.join(selected, '.sound-shelf', 'vault.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8').catch(() => {
    throw new Error('선택한 폴더에 Sound Shelf 볼트 정보가 없습니다.');
  }));
  if (manifest.id !== expectedVaultId) throw new Error('현재 볼트와 다른 볼트입니다. 다른 볼트는 “기존 볼트 열기”로 열어 주세요.');
  return activateVault(selected, { legacySounds: [], legacyCategoryOrder: [] });
});

ipcMain.handle('vault:move', async () => {
  const root = activeVaultRoot();
  if (!activeVault || !root || !fs.existsSync(root)) throw new Error('이동할 현재 볼트를 찾을 수 없습니다.');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '현재 볼트를 옮길 상위 폴더 선택',
    buttonLabel: '이 위치로 이동',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled) return null;
  const parent = path.resolve(result.filePaths[0]);
  const relativeToVault = path.relative(root, parent);
  if (!relativeToVault.startsWith('..') && !path.isAbsolute(relativeToVault)) {
    throw new Error('현재 볼트의 하위 폴더 안으로는 볼트를 이동할 수 없습니다.');
  }
  const destination = path.join(parent, path.basename(root));
  if (normalizedFsPath(destination) === normalizedFsPath(root)) return librarySnapshot();
  if (fs.existsSync(destination)) throw new Error('대상 위치에 같은 이름의 폴더가 이미 있습니다.');
  // 캐시를 닫고 폴더를 옮기는 동안 동기화 폴링이 끼어들면, 이미 사라진 옛 루트를 기준으로
  // 병합해 라이브러리를 통째로 망가뜨린다. 이동이 끝나 볼트를 다시 열 때까지 막는다.
  await withLocalMutation(async () => {
    await saveDb();
    await vaultStorage.backupPortableMetadata('before-move');
    for (const watcher of folderWatchers.values()) watcher.close();
    folderWatchers.clear();
    vaultStorage.close();
    try {
      await moveDirectory(root, destination);
    } catch (error) {
      if (fs.existsSync(root)) await activateVault(root, { legacySounds: [], legacyCategoryOrder: [] });
      throw error;
    }
  });
  return activateVault(destination, { legacySounds: [], legacyCategoryOrder: [] });
});

ipcMain.handle('vault:check', async () => {
  if (!vaultStorage) throw new Error('현재 열린 볼트가 없습니다.');
  const result = await vaultStorage.integrityCheck();
  return { ...result, vault: activeVault };
});

ipcMain.handle('vault:compact', () => withLocalMutation(async () => {
  if (!vaultStorage || !activeVault) throw new Error('현재 열린 볼트가 없습니다.');
  if (!fs.existsSync(activeVault.root)) throw new Error('볼트 폴더에 연결되어 있지 않습니다.');
  // 스캔·폴링·활성화와 겹치지 않게 활성화 큐에 얹어 단독 실행을 보장한다.
  const run = vaultActivationQueue.catch(() => {}).then(async () => {
    await saveDb();
    await vaultStorage.backupPortableMetadata('pre-compact');
    const [portableMetadata, savedFolderOrder, editSources] = await Promise.all([
      vaultStorage.loadMetadata(),
      vaultStorage.loadFolderOrder(),
      vaultStorage.loadEditSources({ ownMachineId: db.settings.machineId })
    ]);
    const merged = mergeVaultState(
      { sounds: portableMetadata.sounds, folderOrder: savedFolderOrder },
      editSources
    );
    // 병합 결과를 새 베이스로 굳힌다. 이 두 줄이 이 앱에서 공유 파일을 쓰는
    // 유일한 순간이며, 위의 확인·직렬화 가드가 그 전제다.
    await vaultStorage.overwriteBaseMetadata(merged.sounds.map(({ updatedAt, ...sound }) => sound));
    await vaultStorage.saveFolderOrder(merged.folderOrder);
    const removedFiles = await vaultStorage.clearEditFiles();
    // 삭제 표식은 새 베이스에 실리지 않으므로 내 편집 파일이 승계해 보관한다.
    // 잃어버리면 파일이 남아있는 record-only 삭제가 다음 스캔에서 부활한다.
    ownEdits = { sounds: {}, folderOrder: null, settings: null };
    for (const record of merged.deletedSounds) {
      ownEdits.sounds[record.id] = { ...record, deleted: true };
    }
    await vaultStorage.saveEdits(db.settings.machineId, os.hostname(), ownEdits);
    setSyncBaseline(merged);
    lastEditStamps = '';
    mainWindow?.webContents.send('library-updated', { ...librarySnapshot(), updateReason: 'vault-compacted' });
    return {
      sounds: merged.sounds.length,
      tombstones: merged.deletedSounds.length,
      editFilesRemoved: removedFiles
    };
  });
  vaultActivationQueue = run.catch(() => {});
  return run;
}));

ipcMain.handle('vault:reveal', async () => {
  const root = activeVaultRoot();
  if (!root || !fs.existsSync(root)) throw new Error('현재 볼트 폴더를 찾을 수 없습니다.');
  shell.showItemInFolder(path.join(root, '.sound-shelf'));
  return true;
});

handleMutation('library:rescan', async () => {
  // 자동 재스캔·원격 병합과 같은 큐에 얹어 같은 트리를 동시에 훑지 않게 한다.
  autoRescanFirstRequestAt = 0;
  clearTimeout(watcherTimer);
  pendingScanFolders.clear();
  const run = vaultActivationQueue
    .catch(() => {})
    .then(() => rescanWatchedFolders());
  vaultActivationQueue = run.catch(() => {});
  return run;
});

handleMutation('library:update', async (_event, payload) => {
  const sound = db.sounds.find((item) => item.id === payload.id);
  if (!sound) throw new Error('Sound not found');
  const allowed = ['title', 'category', 'tags', 'notes', 'favorite', 'rating'];
  for (const key of allowed) {
    if (Object.hasOwn(payload, key)) sound[key] = key === 'tags' ? cleanTagList(payload[key]) : payload[key];
  }
  if (Object.hasOwn(payload, 'category')) {
    sound.categoryPath = String(payload.category || '미분류').split(/[\\/>]+/).map((part) => part.trim()).filter(Boolean).join('/') || '미분류';
    sound.category = sound.categoryPath.split('/').pop();
  }
  if (sound.categoryPath && !db.categories.includes(sound.categoryPath)) db.categories.push(sound.categoryPath);
  db.categories.sort((a, b) => a.localeCompare(b, 'ko'));
  queueSave();
  return librarySnapshot();
});

ipcMain.handle('library:rename', (_event, { id, name }) => withLocalMutation(async () => {
  const sound = db.sounds.find((item) => item.id === id);
  if (!sound || !fs.existsSync(sound.path)) throw new Error('이름을 바꿀 원본 파일을 찾을 수 없습니다.');
  const safeName = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').trim();
  if (!safeName) throw new Error('새 사운드 이름을 입력해 주세요.');
  const duplicatePath = await findDuplicateAudioName(safeName, sound.path);
  if (duplicatePath) {
    const root = activeVaultRoot();
    const relativePath = root && relativePathInside(root, duplicatePath) !== null
      ? path.relative(root, duplicatePath).split(path.sep).join('/')
      : duplicatePath;
    throw new Error(`같은 이름의 사운드가 이미 있습니다: ${relativePath}`);
  }
  const extension = path.extname(sound.path);
  const destination = path.join(path.dirname(sound.path), `${safeName}${extension}`);
  const oldId = sound.id;
  if (normalizedFsPath(destination) !== normalizedFsPath(sound.path)) {
    if (fs.existsSync(destination)) throw new Error('같은 이름의 파일이 이미 있습니다.');
    await fsp.rename(sound.path, destination);
  }
  const stat = await fsp.stat(destination);
  sound.path = destination;
  sound.fileName = path.basename(destination);
  sound.title = safeName;
  sound.relativePath = soundRelativePath(destination) || sound.relativePath || '';
  sound.modifiedAt = stat.mtimeMs;
  sound.size = stat.size;
  waveformCache.clear();
  await saveDb();
  return { ...librarySnapshot(), idChanges: { [oldId]: sound.id }, moved: { oldId, id: sound.id, path: destination } };
}));

ipcMain.handle('library:update-batch', (_event, { ids, updates, addTags, removeTags }) => withLocalMutation(async () => {
  const selected = new Set(ids || []);
  const allowed = ['favorite', 'rating'];
  const additions = cleanTagList(addTags);
  const removals = new Set(cleanTagList(removeTags).map(normalizedTagKey));
  for (const sound of db.sounds) {
    if (!selected.has(sound.id)) continue;
    for (const key of allowed) if (Object.hasOwn(updates || {}, key)) sound[key] = updates[key];
    const nextTags = cleanTagList(sound.tags).filter((tag) => !removals.has(normalizedTagKey(tag)));
    const existingKeys = new Set(nextTags.map(normalizedTagKey));
    for (const tag of additions) {
      const key = normalizedTagKey(tag);
      if (key && !existingKeys.has(key)) {
        nextTags.push(tag);
        existingKeys.add(key);
      }
    }
    sound.tags = nextTags;
  }
  await saveDb();
  return librarySnapshot();
}));

ipcMain.handle('library:set-tags-batch', (_event, { items }) => withLocalMutation(async () => {
  const tagsById = new Map((items || []).map((item) => [item.id, cleanTagList(item.tags)]));
  for (const sound of db.sounds) {
    if (tagsById.has(sound.id)) sound.tags = tagsById.get(sound.id);
  }
  await saveDb();
  return librarySnapshot();
}));

ipcMain.handle('library:move-category-batch', (_event, { ids, category }) => withLocalMutation(async () => {
  const normalizedCategory = normalizeCategoryPath(category);
  const rootCategory = normalizedCategory === '미분류';
  const categoryParts = rootCategory ? [] : normalizedCategory.split('/').filter(Boolean);
  if (!rootCategory && !categoryParts.length) throw new Error('카테고리 이름을 입력해 주세요.');
  const targetFolder = categoryFolderPath(normalizedCategory);
  const targetStat = targetFolder ? await fsp.stat(targetFolder).catch(() => null) : null;
  if (!targetStat?.isDirectory()) throw new Error('해당 카테고리 폴더가 없습니다. 목록에 있는 기존 폴더만 선택해 주세요.');
  const selected = db.sounds.filter((sound) => (ids || []).includes(sound.id));
  const idChanges = {};
  let moved = 0;
  let skippedMissing = 0;
  for (const sound of selected) {
    if (!fs.existsSync(sound.path)) {
      skippedMissing += 1;
      continue;
    }
    const root = watchedRootForFile(sound.path) || db.settings.watchedFolders[0];
    if (!root) throw new Error('라이브러리 루트 폴더를 찾을 수 없습니다.');
    const oldId = sound.id;
    await moveSoundToFolder(sound, targetFolder, rootCategory ? '미분류' : categoryParts.join('/'), { save: false });
    idChanges[oldId] = sound.id;
    moved += 1;
  }
  await saveDb();
  return {
    ...librarySnapshot(),
    idChanges,
    moveResult: { requested: (ids || []).length, matched: selected.length, moved, skippedMissing }
  };
}));

ipcMain.handle('library:remove-batch', (_event, { ids }) => withLocalMutation(async () => {
  const selected = new Set(ids || []);
  const removing = db.sounds.filter((sound) => selected.has(sound.id));
  for (const sound of removing) if (fs.existsSync(sound.path)) await shell.trashItem(sound.path);
  db.sounds = db.sounds.filter((sound) => !selected.has(sound.id));
  waveformCache.clear();
  await saveDb();
  return librarySnapshot();
}));

ipcMain.handle('library:backup-export', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Sound Shelf 라이브러리 백업',
    defaultPath: path.join(app.getPath('documents'), `Sound-Shelf-Backup-${new Date().toISOString().slice(0, 10)}.json`),
    filters: [{ name: 'Sound Shelf Backup', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return null;
  // 백업 도중 원격 병합이 db.sounds 를 갈아치우면 반쯤 섞인 스냅샷이 저장된다.
  return withLocalMutation(() => exportBackupTo(result.filePath));
});

async function exportBackupTo(filePath) {
  await saveDb();
  if (vaultStorage && activeVault) {
    await writeJsonAtomic(filePath, {
      type: 'sound-shelf-portable-backup',
      schemaVersion: 1,
      vault: { id: activeVault.id, name: activeVault.name },
      metadata: {
        type: 'sound-shelf-metadata',
        schemaVersion: 1,
        vaultId: activeVault.id,
        updatedAt: new Date().toISOString(),
        // 편집 내용이 빠진 백업은 쓸모가 없다. 병합된 현재 상태를 쓴다.
        sounds: db.sounds.map(portableSound).filter(Boolean)
      },
      folderOrder: await vaultStorage.loadFolderOrder(),
      createdAt: new Date().toISOString()
    });
  } else {
    await fsp.copyFile(dbPath, filePath);
  }
  return { ok: true, path: filePath };
}

handleMutation('library:backup-import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Sound Shelf 백업 복원', properties: ['openFile'],
    filters: [{ name: 'Sound Shelf Backup', extensions: ['json'] }]
  });
  if (result.canceled) return null;
  const candidate = JSON.parse(await fsp.readFile(result.filePaths[0], 'utf8'));
  await createAutomaticBackup('before-restore');
  if (candidate.type === 'sound-shelf-portable-backup' && candidate.metadata?.sounds && vaultStorage) {
    await vaultStorage.backupPortableMetadata('before-restore');
    await vaultStorage.overwriteBaseMetadata(candidate.metadata.sounds);
    await vaultStorage.saveFolderOrder(candidate.folderOrder || []);
    return activateVault(activeVaultRoot(), { legacySounds: [] });
  }
  const imported = validateImportedDb(candidate);
  const root = activeVaultRoot() || imported.settings.watchedFolders[0];
  if (!root) throw new Error('백업을 복원할 볼트 폴더를 찾을 수 없습니다.');
  // machineId는 이 Mac의 신원이다. 다른 Mac에서 내보낸 백업을 복원해도 절대
  // 넘겨받지 않는다 — 두 Mac이 같은 ID로 같은 편집 파일을 쓰면 Drive 충돌
  // 사본이 다시 생긴다. 비어 있으면 activateVaultNow가 새로 발급한다.
  db.settings = { ...db.settings, ...imported.settings, machineId: db.settings.machineId };
  return activateVault(root, { legacySounds: imported.sounds });
});

ipcMain.handle('library:collect-metadata', () => withLocalMutation(async () => {
  let updated = 0;
  const existing = db.sounds.filter((sound) => {
    if (!fs.existsSync(sound.path)) return false;
    try {
      return needsTechnicalProbe(sound, fs.statSync(sound.path));
    } catch {
      return false;
    }
  });
  for (let index = 0; index < existing.length; index += 1) {
    const sound = existing[index];
    const metadata = await probeAudio(sound.path);
    Object.assign(sound, metadata);
    updated += 1;
    if (index % 5 === 0 || index === existing.length - 1) {
      mainWindow?.webContents.send('scan-progress', { current: index + 1, total: existing.length, fileName: sound.fileName });
    }
  }
  await saveDb();
  return { ...librarySnapshot(), metadataResult: { updated } };
}));

ipcMain.handle('library:find-duplicates', () => withLocalMutation(async () => {
  const sizeGroups = new Map();
  for (const sound of db.sounds) {
    if (sound.missing || !fs.existsSync(sound.path) || !sound.size) continue;
    if (!sizeGroups.has(sound.size)) sizeGroups.set(sound.size, []);
    sizeGroups.get(sound.size).push(sound);
  }
  const candidates = [...sizeGroups.values()].filter((group) => group.length > 1).flat();
  for (let index = 0; index < candidates.length; index += 1) {
    const sound = candidates[index];
    const key = `${sound.size}:${sound.modifiedAt}`;
    if (!sound.contentHash || sound.contentHashKey !== key) {
      sound.contentHash = await hashFile(sound.path);
      sound.contentHashKey = key;
    }
    if (index % 3 === 0 || index === candidates.length - 1) {
      mainWindow?.webContents.send('scan-progress', { current: index + 1, total: candidates.length, fileName: sound.fileName });
    }
  }
  const hashes = new Map();
  for (const sound of candidates) {
    if (!sound.contentHash) continue;
    if (!hashes.has(sound.contentHash)) hashes.set(sound.contentHash, []);
    hashes.get(sound.contentHash).push(publicSound(sound));
  }
  await saveDb();
  const groups = [...hashes.values()].filter((group) => group.length > 1);
  return { groups, checked: candidates.length };
}));

ipcMain.handle('library:relink-missing', () => withLocalMutation(async () => {
  const allFiles = (await Promise.all(db.settings.watchedFolders.map(walkAudioFiles))).flat();
  const result = await relinkMissingFromFiles(allFiles);
  const categoryGroups = await Promise.all(db.settings.watchedFolders.map(walkCategoryFolders));
  db.categories = [...new Set([...categoryGroups.flat(), ...db.sounds.map((sound) => sound.categoryPath)].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  await saveDb();
  return { ...librarySnapshot(), idChanges: result.idChanges, relinkResult: result };
}));

ipcMain.handle('library:relink-one', async (_event, id) => {
  const sound = db.sounds.find((item) => item.id === id);
  if (!sound) throw new Error('재연결할 항목을 찾을 수 없습니다.');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `“${sound.title}” 원본 파일 재연결`, properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS].map((ext) => ext.slice(1)) }]
  });
  if (result.canceled) return null;
  let filePath = result.filePaths[0];
  const root = activeVaultRoot();
  if (root && relativePathInside(root, filePath) === null) {
    const folder = categoryFolderPath(sound.categoryPath || sound.category || '미분류') || root;
    await fsp.mkdir(folder, { recursive: true });
    const destination = uniqueDestination(folder, path.basename(filePath));
    await moveFile(filePath, destination);
    filePath = destination;
  }
  const stat = await fsp.stat(filePath);
  const technical = await probeAudio(filePath);
  // 다이얼로그가 떠 있는 동안 원격 동기화가 db.sounds 를 통째로 교체했을 수 있다. 위에서
  // 잡은 sound 는 그러면 어느 배열에도 속하지 않는 고아 객체라, 여기서 바꿔도 저장되지
  // 않는다. 기다림이 끝난 뒤 id 로 다시 조회한다.
  return withLocalMutation(async () => {
    const target = db.sounds.find((item) => item.id === id);
    if (!target) throw new Error('재연결할 항목을 찾을 수 없습니다.');
    const oldId = target.id;
    target.path = filePath;
    target.fileName = path.basename(filePath);
    target.relativePath = soundRelativePath(filePath) || target.relativePath || '';
    target.size = stat.size;
    target.modifiedAt = stat.mtimeMs;
    target.categoryPath = inferCategoryPath(filePath);
    target.category = target.categoryPath.split('/').pop();
    Object.assign(target, technical);
    db.sounds = deduplicateSoundsByPath(db.sounds);
    await saveDb();
    return { ...librarySnapshot(), idChanges: { [oldId]: target.id } };
  });
});

ipcMain.handle('library:move-folder', async (_event, id) => {
  const sound = db.sounds.find((item) => item.id === id);
  if (!sound || !fs.existsSync(sound.path)) throw new Error('원본 파일을 찾을 수 없습니다.');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `“${sound.title}” 이동할 폴더 선택`,
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled) return null;
  const selectedFolder = result.filePaths[0];
  const root = activeVaultRoot();
  if (!root || relativePathInside(root, selectedFolder) === null) {
    throw new Error('사운드는 현재 볼트 안의 폴더로만 이동할 수 있습니다.');
  }
  // 다이얼로그 대기 중 db.sounds 가 교체됐을 수 있으므로 id 로 다시 조회한다.
  return withLocalMutation(async () => {
    const target = db.sounds.find((item) => item.id === id);
    if (!target || !fs.existsSync(target.path)) throw new Error('원본 파일을 찾을 수 없습니다.');
    return moveSoundToFolder(target, selectedFolder, inferCategoryPath(path.join(selectedFolder, target.fileName)));
  });
});

handleMutation('library:move-category', async (_event, { id, category }) => {
  const sound = db.sounds.find((item) => item.id === id);
  const categoryParts = String(category || '').split(/[\\/>]+/)
    .map((part) => part.trim().replace(/[:*?"<>|]/g, '-')).filter(Boolean);
  const safeCategory = categoryParts.join('/');
  if (!sound || !fs.existsSync(sound.path)) throw new Error('원본 파일을 찾을 수 없습니다.');
  if (!safeCategory) throw new Error('카테고리 이름을 입력해 주세요.');
  const root = watchedRootForFile(sound.path) || activeVaultRoot();
  if (!root) throw new Error('현재 사운드 볼트를 찾을 수 없습니다.');
  const targetFolder = categoryFolderPath(safeCategory);
  const targetStat = targetFolder ? await fsp.stat(targetFolder).catch(() => null) : null;
  if (!targetStat?.isDirectory()) throw new Error('해당 카테고리 폴더가 없습니다. 목록에 있는 기존 폴더만 선택해 주세요.');
  return moveSoundToFolder(sound, targetFolder, safeCategory);
});

handleMutation('category:create', async (_event, { parentCategory, name }) => {
  const parent = normalizeCategoryPath(parentCategory);
  const rootLevel = !parent || parent === '미분류';
  const safeName = normalizeCategoryPath(name).split('/').pop();
  if (!safeName) throw new Error('새 폴더 이름을 입력해 주세요.');
  const parentFolder = categoryFolderPath(rootLevel ? '' : parent);
  if (!parentFolder) throw new Error('상위 폴더를 찾을 수 없습니다.');
  const folder = path.join(parentFolder, safeName);
  if (fs.existsSync(folder)) throw new Error('같은 이름의 폴더가 이미 있습니다.');
  await fsp.mkdir(folder, { recursive: true });
  const categoryPath = rootLevel ? safeName : `${parent}/${safeName}`;
  if (!db.categories.includes(categoryPath)) db.categories.push(categoryPath);
  db.categoryOrder = [...new Set([...(db.categoryOrder || []), categoryPath])];
  db.categories.sort((a, b) => a.localeCompare(b, 'ko'));
  await saveDb();
  return librarySnapshot();
});

handleMutation('category:rename', async (_event, { category, name }) => {
  const sourceCategory = normalizeCategoryPath(category);
  const safeName = normalizeCategoryPath(name).split('/').pop();
  if (!sourceCategory || sourceCategory === '미분류') throw new Error('미분류 루트는 이름을 바꿀 수 없습니다.');
  if (!safeName) throw new Error('새 폴더 이름을 입력해 주세요.');
  const sourceFolder = categoryFolderPath(sourceCategory);
  if (!sourceFolder || !fs.existsSync(sourceFolder)) throw new Error('원본 폴더를 찾을 수 없습니다.');
  const destinationFolder = path.join(path.dirname(sourceFolder), safeName);
  if (fs.existsSync(destinationFolder)) throw new Error('같은 이름의 폴더가 이미 있습니다.');
  await fsp.rename(sourceFolder, destinationFolder);
  const parentCategory = sourceCategory.includes('/') ? sourceCategory.slice(0, sourceCategory.lastIndexOf('/')) : '';
  const destinationCategory = parentCategory ? `${parentCategory}/${safeName}` : safeName;
  const idChanges = updateSoundsForCategoryMove(sourceCategory, destinationCategory, sourceFolder, destinationFolder);
  await saveDb();
  return { ...librarySnapshot(), idChanges, categoryMove: { from: sourceCategory, to: destinationCategory } };
});

handleMutation('category:move-up', async (_event, category) => {
  const source = normalizeCategoryPath(category);
  const parts = source.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('이미 최상위 폴더입니다.');
  const target = parts.slice(0, -2).join('/') || '미분류';
  return moveCategoryDirectory(source, target);
});

handleMutation('category:reorder', async (_event, { categories, referenceCategory, position }) => {
  const reference = normalizeCategoryPath(referenceCategory);
  const requested = [...new Set((categories || []).map(normalizeCategoryPath))]
    .filter(Boolean);
  const sources = requested.filter((category) => !requested.some((other) => other !== category && category.startsWith(`${other}/`)));
  const rootDrop = position === 'root';
  if ((!reference && !rootDrop) || !sources.length) throw new Error('이동할 폴더 위치를 찾을 수 없습니다.');
  if (sources.includes(reference)) return librarySnapshot();
  const targetParent = rootDrop
    ? ''
    : position === 'inside'
      ? reference
      : reference.includes('/') ? reference.slice(0, reference.lastIndexOf('/')) : '';
  const moved = [];
  const idChanges = {};
  let categoryMove = null;
  for (const source of sources) {
    if (source === '미분류') {
      if (targetParent) throw new Error('미분류는 최상위 카테고리 안에서 순서만 변경할 수 있습니다.');
      moved.push(source);
      continue;
    }
    if (targetParent === source || targetParent.startsWith(`${source}/`)) {
      throw new Error('폴더를 자기 하위 위치로 이동할 수 없습니다.');
    }
    const sourceParent = source.includes('/') ? source.slice(0, source.lastIndexOf('/')) : '';
    let destination = source;
    if (sourceParent !== targetParent) {
      const snapshot = await moveCategoryDirectory(source, targetParent || '미분류');
      destination = targetParent ? `${targetParent}/${source.split('/').pop()}` : source.split('/').pop();
      Object.assign(idChanges, snapshot.idChanges || {});
      categoryMove = { from: source, to: destination };
    }
    moved.push(destination);
  }
  const directSiblings = db.categories.filter((category) => {
    const parent = category.includes('/') ? category.slice(0, category.lastIndexOf('/')) : '';
    return parent === targetParent;
  });
  const orderIndex = new Map((db.categoryOrder || []).map((category, index) => [category, index]));
  directSiblings.sort((a, b) => {
    const ai = orderIndex.has(a) ? orderIndex.get(a) : Number.MAX_SAFE_INTEGER;
    const bi = orderIndex.has(b) ? orderIndex.get(b) : Number.MAX_SAFE_INTEGER;
    return ai - bi || a.localeCompare(b, 'ko', { numeric: true });
  });
  const ordered = directSiblings.filter((category) => !moved.includes(category));
  let insertAt = ['before', 'after'].includes(position) ? ordered.indexOf(reference) : ordered.length;
  if (insertAt < 0) insertAt = ordered.length;
  else if (position === 'after') insertAt += 1;
  ordered.splice(insertAt, 0, ...moved);
  const siblingSet = new Set(directSiblings);
  db.categoryOrder = [...(db.categoryOrder || []).filter((category) => !siblingSet.has(category)), ...ordered];
  await saveDb();
  return { ...librarySnapshot(), idChanges, categoryMove };
});

handleMutation('category:trash', async (_event, category) => {
  const normalized = normalizeCategoryPath(category);
  if (!normalized || normalized === '미분류') throw new Error('미분류 루트는 삭제할 수 없습니다.');
  const folder = categoryFolderPath(normalized);
  if (!folder || !fs.existsSync(folder)) throw new Error('삭제할 폴더를 찾을 수 없습니다.');
  await shell.trashItem(folder);
  db.sounds = db.sounds.filter((sound) => {
    const soundCategory = sound.categoryPath || sound.category;
    return soundCategory !== normalized && !soundCategory?.startsWith(`${normalized}/`);
  });
  db.categories = db.categories.filter((item) => item !== normalized && !item.startsWith(`${normalized}/`));
  db.categoryOrder = (db.categoryOrder || []).filter((item) => item !== normalized && !item.startsWith(`${normalized}/`));
  waveformCache.clear();
  await saveDb();
  return librarySnapshot();
});

handleMutation('category:trash-batch', async (_event, categories) => {
  const normalized = [...new Set((categories || []).map(normalizeCategoryPath))].filter((item) => item && item !== '미분류');
  const targets = normalized.filter((item) => !normalized.some((other) => other !== item && item.startsWith(`${other}/`)));
  if (!targets.length) throw new Error('삭제할 폴더가 없습니다.');
  for (const category of targets) {
    const folder = categoryFolderPath(category);
    if (folder && fs.existsSync(folder)) await shell.trashItem(folder);
    db.sounds = db.sounds.filter((sound) => {
      const soundCategory = sound.categoryPath || sound.category;
      return soundCategory !== category && !soundCategory?.startsWith(`${category}/`);
    });
    db.categories = db.categories.filter((item) => item !== category && !item.startsWith(`${category}/`));
    db.categoryOrder = (db.categoryOrder || []).filter((item) => item !== category && !item.startsWith(`${category}/`));
  }
  waveformCache.clear();
  await saveDb();
  return librarySnapshot();
});

ipcMain.handle('category:reveal', async (_event, category) => {
  const folder = categoryFolderPath(category);
  if (!folder || !fs.existsSync(folder)) throw new Error('폴더를 찾을 수 없습니다.');
  shell.showItemInFolder(folder);
  return true;
});

ipcMain.handle('category:add-files', async (_event, category) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `“${category}” 폴더에 파일 추가`,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS].map((ext) => ext.slice(1)) }]
  });
  if (result.canceled) return null;
  // 다이얼로그 대기는 밖에 두고, 파일 이동과 인덱싱만 보호한다.
  return withLocalMutation(async () => {
    const moved = [];
    for (const filePath of result.filePaths) moved.push(await moveFileIntoCategory(filePath, category));
    return indexFiles(moved, { allowRestore: true });
  });
});

async function dropPathsIntoCategory(category, paths) {
  const targetCategory = normalizeCategoryPath(category);
  const targetFolder = categoryFolderPath(targetCategory);
  if (!targetFolder) throw new Error('대상 폴더를 찾을 수 없습니다.');
  let snapshot = null;
  const movedFiles = [];
  let needsRescan = false;
  const uniquePaths = [...new Set(paths || [])];
  if (uniquePaths.some(isTemporaryClipPath)) {
    throw new Error('Resolve 전송용 임시 구간은 카테고리로 이동할 수 없습니다. “선택 구간 파일 만들기” 버튼을 이용해 주세요.');
  }
  for (const itemPath of uniquePaths) {
    const stat = await fsp.stat(itemPath).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const sourceCategory = categoryPathForFolder(itemPath);
      if (sourceCategory) {
        snapshot = await moveCategoryDirectory(sourceCategory, targetCategory);
      } else {
        const destination = uniqueDestination(targetFolder, path.basename(itemPath));
        await moveDirectory(itemPath, destination);
        needsRescan = true;
      }
      continue;
    }
    if (!stat.isFile() || !AUDIO_EXTENSIONS.has(path.extname(itemPath).toLowerCase())) continue;
    const existing = db.sounds.find((sound) => normalizedFsPath(sound.path) === normalizedFsPath(itemPath));
    if (existing) snapshot = await moveSoundToFolder(existing, targetFolder, targetCategory);
    else if (isTrashPath(itemPath)) {
      const destination = uniqueDestination(targetFolder, path.basename(itemPath));
      await moveFile(itemPath, destination);
      movedFiles.push(destination);
    } else movedFiles.push(await moveFileIntoCategory(itemPath, targetCategory));
  }
  if (movedFiles.length) snapshot = await indexFiles(movedFiles, { allowRestore: true });
  if (needsRescan) snapshot = await rescanWatchedFolders({ reportProgress: false, allowRestore: true });
  if (!snapshot) snapshot = await rescanWatchedFolders({ reportProgress: false });
  return snapshot;
}

handleMutation('category:drop-paths', async (_event, { category, paths }) => dropPathsIntoCategory(category, paths));

handleMutation('shortcuts:set', async (_event, shortcuts) => {
  db.settings.shortcuts = { ...DEFAULT_SHORTCUTS, ...(shortcuts || {}) };
  await saveDb();
  return librarySnapshot();
});

handleMutation('preview-volume:set', async (_event, volume) => {
  db.settings.previewVolume = Math.max(0, Math.min(1, Number(volume) || 0));
  queueSave();
  return db.settings.previewVolume;
});

ipcMain.on('shortcuts:capture', (_event, active) => { shortcutCapture = Boolean(active); });

ipcMain.handle('library:remove', (_event, { id }) => withLocalMutation(async () => {
  const index = db.sounds.findIndex((item) => item.id === id);
  if (index < 0) return librarySnapshot();
  const [sound] = db.sounds.splice(index, 1);
  if (fs.existsSync(sound.path)) await shell.trashItem(sound.path);
  await saveDb();
  return librarySnapshot();
}));

ipcMain.handle('library:reveal', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('library:waveform', async (_event, id) => {
  const sound = db.sounds.find((item) => item.id === id);
  if (!sound || !fs.existsSync(sound.path)) {
    return { left: [], right: [], status: 'missing', error: '원본 파일을 찾을 수 없습니다.' };
  }
  const cacheKey = waveformCacheKey(sound);
  if (waveformCache.has(cacheKey)) return waveformCache.get(cacheKey);
  const diskCached = await readWaveformDiskCache(cacheKey);
  if (diskCached) {
    waveformCache.set(cacheKey, diskCached);
    return diskCached;
  }
  if (waveformJobs.has(cacheKey)) return waveformJobs.get(cacheKey);
  const job = runWaveformJob(async () => {
    let lastError = null;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const { stdout } = await execFileAsync(findMediaTool('ffmpeg'), [
            '-v', 'error', '-i', sound.path, '-map', '0:a:0', '-ac', '2', '-ar', '8000', '-f', 's16le', 'pipe:1'
          ], { encoding: null, maxBuffer: 1024 * 1024 * 64, timeout: 45000 });
          const frameCount = Math.floor(stdout.length / 4);
          if (!frameCount) throw new Error('Audio stream produced no samples');
          const targetCount = 1200;
          const bucketSize = Math.max(1, Math.ceil(frameCount / targetCount));
          const left = [];
          const right = [];
          for (let offset = 0; offset < frameCount; offset += bucketSize) {
            let leftPeak = 0;
            let rightPeak = 0;
            const limit = Math.min(frameCount, offset + bucketSize);
            for (let index = offset; index < limit; index += 1) {
              leftPeak = Math.max(leftPeak, Math.abs(stdout.readInt16LE(index * 4)) / 32768);
              rightPeak = Math.max(rightPeak, Math.abs(stdout.readInt16LE(index * 4 + 2)) / 32768);
            }
            left.push(Math.min(1, leftPeak));
            right.push(Math.min(1, rightPeak));
          }
          const waveform = { left, right, status: 'ready', error: '' };
          waveformCache.set(cacheKey, waveform);
          await writeWaveformDiskCache(cacheKey, waveform).catch((error) => console.error('Waveform cache write failed:', error.message));
          return waveform;
        } catch (error) {
          lastError = error;
          if (attempt === 0 && fs.existsSync(sound.path)) await wait(700);
        }
      }
      console.error(`Waveform generation failed (${path.basename(sound.path)}):`, lastError?.message || lastError);
      return {
        left: [],
        right: [],
        status: fs.existsSync(sound.path) ? 'error' : 'missing',
        error: mediaErrorMessage(lastError, { fileExists: fs.existsSync(sound.path), waveform: true })
      };
    } finally {
      waveformJobs.delete(cacheKey);
    }
  });
  waveformJobs.set(cacheKey, job);
  return job;
});

ipcMain.handle('library:analyze-key', async (_event, { id, force = false }) => {
  const sound = db.sounds.find((item) => item.id === id);
  if (!sound || !fs.existsSync(sound.path)) throw new Error('분석할 원본 사운드 파일을 찾을 수 없습니다.');
  const cached = sound.keyAnalysis;
  if (!force && isCurrentKeyAnalysis(cached, sound)) {
    return { ...librarySnapshot(), keyAnalysisResult: { id: sound.id, analysis: cached, cached: true } };
  }
  try {
    const script = await fsp.readFile(path.join(__dirname, 'key_detect.py'), 'utf8');
    const { stdout } = await execFileAsync(findPython(), [
      '-c', script,
      sound.path,
      findMediaTool('ffmpeg')
    ], { maxBuffer: 1024 * 1024 * 4, timeout: 240000 });
    const line = stdout.trim().split('\n').filter(Boolean).pop();
    if (!line) throw new Error('조성 분석 결과가 없습니다.');
    const result = JSON.parse(line);
    if (!result.ok) throw new Error(result.message || '조성 분석에 실패했습니다.');
    const analysis = {
      ...result,
      analyzedAt: Date.now(),
      sourceModifiedAt: sound.modifiedAt
    };
    // python 실행은 최대 240초다. 그 사이 원격 동기화가 db.sounds 를 교체했을 수 있으므로
    // 결과를 붙일 때 id 로 다시 조회한다. 분석 자체를 withLocalMutation 으로 감싸면
    // 4분 동안 다른 Mac 의 편집이 들어오지 못한다.
    return withLocalMutation(async () => {
      const target = db.sounds.find((item) => item.id === id);
      if (!target) throw new Error('분석 대상을 라이브러리에서 찾을 수 없습니다.');
      target.keyAnalysis = analysis;
      await saveDb();
      return { ...librarySnapshot(), keyAnalysisResult: { id: target.id, analysis, cached: false } };
    });
  } catch (error) {
    throw new Error(`조성 분석 실패: ${keyAnalysisErrorMessage(error)}`);
  }
});

ipcMain.handle('library:prepare-clip', async (_event, payload) => {
  const sound = db.sounds.find((item) => item.id === payload?.id);
  if (!sound || !fs.existsSync(sound.path)) {
    return { ok: false, message: '원본 사운드 파일을 찾을 수 없습니다.' };
  }
  const start = Math.max(0, Number(payload.start || 0));
  const end = Math.min(Number(sound.duration || 0), Number(payload.end || 0));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.05) {
    return { ok: false, message: '0.05초 이상의 구간을 선택해 주세요.' };
  }
  try {
    const clipDirectory = temporaryClipDirectory();
    await fsp.mkdir(clipDirectory, { recursive: true });
    const safeTitle = (sound.title || 'sound')
      .normalize('NFC')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 80);
    const range = `${start.toFixed(3)}-${end.toFixed(3)}`;
    const fingerprint = crypto.createHash('sha1').update(`${sound.path}:${sound.modifiedAt}:${range}`).digest('hex').slice(0, 10);
    const outputPath = path.join(clipDirectory, `${safeTitle}_${range}_${fingerprint}.wav`);
    if (!fs.existsSync(outputPath)) {
      await execFileAsync(findMediaTool('ffmpeg'), [
        '-v', 'error', '-y', '-i', sound.path,
        '-ss', start.toFixed(6), '-t', (end - start).toFixed(6),
        '-map', '0:a:0', '-vn', '-c:a', 'pcm_s24le', outputPath
      ], { maxBuffer: 1024 * 1024 * 4, timeout: 60000 });
    }
    return { ok: true, path: outputPath, start, end, duration: end - start };
  } catch (error) {
    console.error('Clip preparation failed:', error);
    return { ok: false, message: `선택 구간을 만들지 못했습니다: ${error.message}` };
  }
});

ipcMain.handle('library:create-clip', async (_event, payload) => {
  const sound = db.sounds.find((item) => item.id === payload?.id);
  if (!sound || !fs.existsSync(sound.path)) throw new Error('원본 사운드 파일을 찾을 수 없습니다.');
  const start = Math.max(0, Number(payload.start || 0));
  const end = Math.min(Number(sound.duration || 0), Number(payload.end || 0));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.05) {
    throw new Error('0.05초 이상의 구간을 선택해 주세요.');
  }
  const safeTitle = (sound.title || 'sound')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 80);
  const outputPath = uniqueDestination(
    path.dirname(sound.path),
    `${safeTitle} - 구간 ${start.toFixed(3)}-${end.toFixed(3)}.wav`
  );
  try {
    await execFileAsync(findMediaTool('ffmpeg'), [
      '-v', 'error', '-y', '-i', sound.path,
      '-ss', start.toFixed(6), '-t', (end - start).toFixed(6),
      '-map', '0:a:0', '-vn', '-c:a', 'pcm_s24le', outputPath
    ], { maxBuffer: 1024 * 1024 * 4, timeout: 60000 });
    // ffmpeg 실행은 밖에서 끝내고, db.sounds 를 건드리는 등록 단계만 보호한다.
    const created = await withLocalMutation(async () => {
      await indexFiles([outputPath], { reportProgress: false, allowRestore: true });
      const registered = db.sounds.find((item) => normalizedFsPath(item.path) === normalizedFsPath(outputPath));
      if (!registered) throw new Error('생성된 파일을 라이브러리에 추가하지 못했습니다.');
      registered.tags = [...new Set(sound.tags || [])];
      registered.rating = Number(sound.rating || 0);
      registered.categoryPath = sound.categoryPath || inferCategoryPath(outputPath);
      registered.category = registered.categoryPath.split('/').filter(Boolean).pop() || inferCategory(outputPath);
      await saveDb();
      return registered;
    });
    return {
      ...librarySnapshot(),
      createdClip: { ...publicSound(created), start, end, sourceId: sound.id }
    };
  } catch (error) {
    await fsp.unlink(outputPath).catch(() => {});
    throw new Error(`선택 구간 파일을 만들지 못했습니다: ${error.message}`);
  }
});

// ---- 유튜브 주소 붙여넣기 → WAV 자동 저장 -------------------------------------
// yt-dlp로 최고 음질 오디오 스트림만 임시 폴더에 받고, ffmpeg로 24bit WAV로 바꾼 뒤
// 볼트(현재 보고 있는 카테고리 폴더)로 옮겨 라이브러리에 등록한다.
// 임시 폴더를 거치는 이유: 받다 만 파일이 볼트 감시 스캔에 잡히지 않게 하기 위해서다.
const youtubeImports = new Map();
const YOUTUBE_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const YOUTUBE_CONVERT_TIMEOUT_MS = 10 * 60 * 1000;

function temporaryYouTubeDirectory() {
  return path.join(app.getPath('temp'), 'sound-shelf-youtube');
}

// 앱은 단일 인스턴스이므로 시작 시점에 남아 있는 작업 폴더는 모두 지난 실행이 남긴 찌꺼기다.
async function pruneYouTubeTemporaryFiles() {
  await fsp.rm(temporaryYouTubeDirectory(), { recursive: true, force: true }).catch(() => {});
}

function mediaToolEnvironment() {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
  const current = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return { ...process.env, PATH: [...new Set([...current, ...extra])].join(path.delimiter) };
}

function sendYouTubeProgress(payload) {
  mainWindow?.webContents.send('youtube-progress', payload);
}

function runYtDlp(url, jobDirectory, onProgress) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = findMediaTool('ffmpeg');
    const args = [
      '--no-playlist', '--no-warnings', '--newline', '--progress', '--no-mtime',
      '--no-write-playlist-metafiles', '--write-info-json',
      '-f', 'bestaudio/best',
      '-o', path.join(jobDirectory, 'source.%(ext)s')
    ];
    if (path.isAbsolute(ffmpegPath)) args.push('--ffmpeg-location', path.dirname(ffmpegPath));
    args.push('--', url);
    // detached 로 띄워 자기 프로세스 그룹을 갖게 한다. 그러지 않으면 kill 이 yt-dlp 하나만
    // 죽이고, yt-dlp 가 먹싱용으로 띄운 ffmpeg 은 살아남아 곧 지워질 작업 폴더에 계속 쓴다.
    const child = spawn(findYtDlp(), args, { env: mediaToolEnvironment(), windowsHide: true, detached: true });
    activeChildProcesses.add(child);
    let stderr = '';
    let pendingStdout = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildProcesses.delete(child);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(Object.assign(new Error('yt-dlp timed out'), { code: 'ETIMEDOUT' }));
    }, YOUTUBE_DOWNLOAD_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      pendingStdout += chunk.toString();
      const lines = pendingStdout.split(/\r?\n/);
      pendingStdout = lines.pop();
      for (const line of lines) {
        const percent = parseDownloadProgress(line);
        if (percent !== null) onProgress(percent);
      }
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16000); });
    child.on('error', (error) => finish(Object.assign(error, { stderr })));
    child.on('close', (code, signal) => {
      if (code === 0) finish();
      else finish(Object.assign(new Error(stderr.trim() || `yt-dlp exited with ${code ?? signal}`), { stderr, exitCode: code }));
    });
  });
}

async function readYouTubeInfo(jobDirectory) {
  const infoPath = path.join(jobDirectory, 'source.info.json');
  try {
    const info = JSON.parse(await fsp.readFile(infoPath, 'utf8'));
    return {
      title: String(info.title || '').trim(),
      uploader: String(info.uploader || info.channel || '').trim(),
      webpageUrl: String(info.webpage_url || '').trim(),
      duration: Number(info.duration || 0)
    };
  } catch {
    return { title: '', uploader: '', webpageUrl: '', duration: 0 };
  }
}

async function downloadedSourceFile(jobDirectory) {
  const entries = await fsp.readdir(jobDirectory, { withFileTypes: true }).catch(() => []);
  const media = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('source.') && !entry.name.endsWith('.json') && !entry.name.endsWith('.part'))
    .map((entry) => path.join(jobDirectory, entry.name));
  return media[0] || null;
}

async function convertToWav(sourcePath, outputPath) {
  await execFileAsync(findMediaTool('ffmpeg'), [
    '-v', 'error', '-y', '-i', sourcePath,
    '-map', '0:a:0', '-vn', '-c:a', 'pcm_s24le', outputPath
  ], { maxBuffer: 1024 * 1024 * 4, timeout: YOUTUBE_CONVERT_TIMEOUT_MS, env: mediaToolEnvironment() });
}

function youtubeDestinationFolder(category) {
  const root = activeVaultRoot();
  if (!root) throw new Error('먼저 사운드 볼트를 열어 주세요.');
  const normalized = normalizeCategoryPath(category);
  if (!normalized || normalized === '미분류') return path.resolve(root);
  const folder = categoryFolderPath(normalized);
  return folder && fs.existsSync(folder) ? folder : path.resolve(root);
}

async function importYouTubeAudio(url, category) {
  const destinationFolder = youtubeDestinationFolder(category);
  const jobDirectory = path.join(temporaryYouTubeDirectory(), crypto.randomUUID());
  await fsp.mkdir(jobDirectory, { recursive: true });
  let destination = '';
  try {
    sendYouTubeProgress({ url, phase: 'download', percent: 0 });
    let lastPercent = -1;
    await runYtDlp(url, jobDirectory, (percent) => {
      if (Math.floor(percent) === Math.floor(lastPercent)) return;
      lastPercent = percent;
      sendYouTubeProgress({ url, phase: 'download', percent });
    });
    const sourcePath = await downloadedSourceFile(jobDirectory);
    if (!sourcePath) throw new Error('yt-dlp가 오디오 파일을 만들지 않았습니다.');
    const info = await readYouTubeInfo(jobDirectory);
    sendYouTubeProgress({ url, phase: 'convert', percent: 100, title: info.title });
    const wavPath = path.join(jobDirectory, 'converted.wav');
    await convertToWav(sourcePath, wavPath);

    // 다운로드는 수 분이 걸릴 수 있으므로 db.sounds 를 건드리는 등록 단계만 동기화 병합에서 보호한다.
    return await withLocalMutation(async () => {
      await fsp.mkdir(destinationFolder, { recursive: true });
      destination = uniqueDestination(destinationFolder, `${safeFileStem(info.title)}.wav`);
      await moveFile(wavPath, destination);
      await indexFiles([destination], { reportProgress: false, allowRestore: true });
      const created = db.sounds.find((item) => normalizedFsPath(item.path) === normalizedFsPath(destination));
      if (!created) throw new Error('변환한 파일을 라이브러리에 추가하지 못했습니다.');
      created.categoryPath = inferCategoryPath(destination);
      created.category = created.categoryPath.split('/').filter(Boolean).pop() || inferCategory(destination);
      const sourceNote = `출처: ${info.webpageUrl || url}${info.uploader ? ` · ${info.uploader}` : ''}`;
      if (!String(created.notes || '').includes(info.webpageUrl || url)) {
        created.notes = created.notes ? `${created.notes}\n${sourceNote}` : sourceNote;
      }
      await saveDb();
      refreshFolderWatchers();
      return { ...librarySnapshot(), importedSound: publicSound(created) };
    });
  } catch (error) {
    if (destination) await fsp.unlink(destination).catch(() => {});
    throw error;
  } finally {
    await fsp.rm(jobDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

ipcMain.handle('youtube:import', async (_event, payload) => {
  const url = canonicalYouTubeUrl(payload?.url);
  if (!url) throw new Error('유튜브 영상 또는 뮤직 주소가 아닙니다.');
  if (youtubeImports.has(url)) throw new Error('같은 영상을 이미 가져오는 중입니다.');
  const job = importYouTubeAudio(url, payload?.category || '');
  youtubeImports.set(url, job);
  try {
    return await job;
  } catch (error) {
    console.error('YouTube import failed:', error);
    throw new Error(youtubeImportErrorMessage(error));
  } finally {
    youtubeImports.delete(url);
  }
});

// 다른 핸들러와 달리 렌더러가 보낸 객체의 path 를 그대로 쓰면 라이브러리에 없는 임의
// 경로가 python 으로 넘어간다. 사운드는 id 로 조회하고, 구간 삽입용 경로는 prepareClip 이
// 만든 임시 폴더 안의 것만 받는다.
ipcMain.handle('resolve:insert', async (_event, payload) => {
  const sound = db.sounds.find((item) => item.id === payload?.id);
  if (!sound?.path) return { ok: false, message: '원본 사운드 파일을 찾을 수 없습니다.' };
  const clipPath = String(payload?.clipPath || '');
  const useClip = Boolean(clipPath) && isTemporaryClipPath(clipPath);
  const target = useClip ? clipPath : sound.path;
  const duration = useClip ? Number(payload?.duration || 0) : Number(sound.duration || 0);
  if (!fs.existsSync(target)) {
    return { ok: false, message: '원본 사운드 파일을 찾을 수 없습니다.' };
  }
  try {
    const script = await fsp.readFile(path.join(__dirname, 'resolve_insert.py'), 'utf8');
    const { stdout } = await execFileAsync(findPython(), [
      '-c', script,
      target,
      String(duration),
      String(sound.sampleRate || 0)
    ], { maxBuffer: 1024 * 1024, timeout: 30000 });
    const line = stdout.trim().split('\n').filter(Boolean).pop();
    return JSON.parse(line);
  } catch (error) {
    const output = error.stdout?.trim().split('\n').filter(Boolean).pop();
    if (output) {
      try { return JSON.parse(output); } catch { /* use generic message below */ }
    }
    return { ok: false, message: `Resolve 연결에 실패했습니다: ${error.message}` };
  }
});

function startNativeDrag(event, filePaths) {
  const files = (Array.isArray(filePaths) ? filePaths : [filePaths])
    .filter((filePath) => filePath && fs.existsSync(filePath))
    .map((filePath) => path.resolve(filePath));
  if (!files.length) return;
  try {
    const iconBuffer = fs.readFileSync(path.join(__dirname, 'drag-icon.png'));
    const icon = nativeImage.createFromBuffer(iconBuffer).resize({ width: 48, height: 48 });
    if (icon.isEmpty()) throw new Error('드래그 아이콘을 읽을 수 없습니다.');
    if (files.length === 1) event.sender.startDrag({ file: files[0], icon });
    else event.sender.startDrag({ files, icon });
  } catch (error) {
    console.error('Native drag failed:', error);
    event.sender.send('drag-error', error.message);
  }
}

ipcMain.on('library:start-drag', startNativeDrag);
ipcMain.on('category:start-drag', (event, categories) => {
  const folders = (Array.isArray(categories) ? categories : [categories]).map((category) => categoryFolderPath(category));
  startNativeDrag(event, folders);
});
