const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { VaultStorage, normalizedRelativePath, relativePathInside, writeJsonAtomic } = require('./vault-storage');

const execFileAsync = promisify(execFile);
const AUDIO_EXTENSIONS = new Set([
  '.wav', '.wave', '.aif', '.aiff', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.caf'
]);
const DEFAULT_SHORTCUTS = {
  search: 'Meta+S',
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
let db = { version: 1, sounds: [], categories: [], categoryOrder: [], settings: { watchedFolders: [], shortcuts: { ...DEFAULT_SHORTCUTS }, previewVolume: 0.8 } };
let vaultStorage = null;
let activeVault = null;
let saveTimer;
let shortcutCapture = false;
let updateStartupTimer;
let updateCheckTimer;
let updateDialogShown = false;
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
let lastFullScanAt = 0;
let startupLoading = true;
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
      currentVaultId: candidate?.settings?.currentVaultId || ''
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

async function pruneTemporaryClips(maxAgeMs = 24 * 60 * 60 * 1000) {
  const clipDirectory = path.join(app.getPath('temp'), 'sound-shelf-clips');
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

async function activateVaultNow(rootPath, { legacySounds = [], legacyCategoryOrder = db.categoryOrder || [], preserveSettings = true } = {}) {
  const root = path.resolve(rootPath);
  const previousSettings = preserveSettings ? { ...db.settings } : {};
  vaultStorage?.close();
  vaultStorage = new VaultStorage(root, app.getPath('userData'));
  activeVault = await vaultStorage.initialize({ create: true });
  db.settings = {
    ...previousSettings,
    shortcuts: { ...DEFAULT_SHORTCUTS, ...(previousSettings.shortcuts || {}) },
    previewVolume: Number.isFinite(Number(previousSettings.previewVolume)) ? Number(previousSettings.previewVolume) : 0.8,
    watchedFolders: [root],
    currentVaultRoot: root,
    currentVaultId: activeVault.id
  };
  const [portableMetadata, savedFolderOrder] = await Promise.all([
    vaultStorage.loadMetadata(),
    vaultStorage.loadFolderOrder()
  ]);
  const cached = vaultStorage.cachedSounds();
  const cacheById = new Map(cached.map((sound) => [sound.id, sound]));
  const cacheByRelativePath = new Map(cached.map((sound) => [normalizedRelativePath(sound.relativePath), sound]));
  const hydrated = portableMetadata.sounds
    .filter((sound) => sound?.relativePath)
    .map((sound) => hydratePortableSound(
      sound,
      cacheById.get(sound.id) || cacheByRelativePath.get(normalizedRelativePath(sound.relativePath)),
      root
    ));
  const byRelativePath = new Map(hydrated.map((sound) => [sound.relativePath, sound]));

  for (const legacy of legacySounds || []) {
    if (!legacy?.path) continue;
    const relativePath = relativePathInside(root, legacy.path);
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
  db.categoryOrder = savedFolderOrder.length ? savedFolderOrder : legacyCategoryOrder;
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
  try {
    await createAutomaticBackup('startup').catch((error) => console.error('Automatic backup failed:', error.message));
    db = cleanDb(JSON.parse(await fsp.readFile(dbPath, 'utf8')));
    db.settings.watchedFolders = canonicalizeWatchedFolders(db.settings.watchedFolders);
    const preferredRoot = db.settings.currentVaultRoot || db.settings.watchedFolders.find((folder) => fs.existsSync(folder));
    if (preferredRoot && fs.existsSync(preferredRoot)) {
      await activateVault(preferredRoot, { legacySounds: db.sounds });
    } else {
      db.sounds = deduplicateSoundsByPath(db.sounds);
      await saveDb();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load library:', error);
    await saveDb();
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

async function saveDb() {
  if (vaultStorage && activeVault) {
    for (const sound of db.sounds) {
      const relativePath = soundRelativePath(sound.path);
      if (relativePath) sound.relativePath = relativePath;
    }
    const portableSounds = db.sounds.map(portableSound).filter(Boolean);
    await Promise.all([
      vaultStorage.saveMetadata(portableSounds),
      vaultStorage.saveFolderOrder(db.categoryOrder || [])
    ]);
    vaultStorage.replaceTechnicalCache(db.sounds.filter((sound) => sound.relativePath));
  }
  await fsp.mkdir(path.dirname(dbPath), { recursive: true });
  const temporary = `${dbPath}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(db, null, 2), 'utf8');
  await fsp.rename(temporary, dbPath);
  const stat = await fsp.stat(dbPath).catch(() => ({ size: 0 }));
  performanceStats.fileSize = Number(stat.size || 0);
  performanceStats.soundCount = db.sounds.length;
  performanceStats.storage = activeVault ? '볼트 + 로컬 SQLite 캐시' : 'JSON 호환 모드';
  performanceStats.sqliteRecommended = false;
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDb().catch(console.error), 150);
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
  const categoryPaths = [...new Set([...db.categories, ...db.sounds.map((sound) => sound.categoryPath || sound.category)].filter(Boolean))];
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
  const temporary = `${cachePath}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(waveform), 'utf8');
  await fsp.rename(temporary, cachePath);
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
  try {
    const { stdout } = await execFileAsync(findMediaTool('ffprobe'), [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
    ], { maxBuffer: 1024 * 1024 * 8 });
    const info = JSON.parse(stdout);
    const audio = info.streams?.find((stream) => stream.codec_type === 'audio') || {};
    const rawMetadata = { ...(info.format?.tags || {}), ...(audio.tags || {}) };
    const embeddedMetadata = Object.fromEntries(Object.entries(rawMetadata)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim())
      .map(([key, value]) => [String(key).toLowerCase(), String(value).trim()]));
    const keywordSource = [embeddedMetadata.keywords, embeddedMetadata.keyword, embeddedMetadata.genre]
      .filter(Boolean).join(',');
    return {
      duration: Number(info.format?.duration || audio.duration || 0),
      sampleRate: Number(audio.sample_rate || 0),
      channels: Number(audio.channels || 0),
      codec: audio.codec_name || '',
      bitRate: Number(info.format?.bit_rate || audio.bit_rate || 0),
      embeddedMetadata,
      embeddedTags: [...new Set(keywordSource.split(/[,;]+/).map((tag) => tag.trim()).filter(Boolean))],
      metadataVersion: 1
    };
  } catch {
    return { duration: 0, sampleRate: 0, channels: 0, codec: '', bitRate: 0, embeddedMetadata: {}, embeddedTags: [], metadataVersion: 1 };
  }
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

async function indexFiles(filePaths, { reportProgress = true, categoryFolders = null } = {}) {
  const existingByPath = new Map(db.sounds.map((sound) => [normalizedFsPath(sound.path), sound]));
  const existingByRelativePath = new Map(db.sounds
    .filter((sound) => sound.relativePath)
    .map((sound) => [normalizedRelativePath(sound.relativePath), sound]));
  let added = 0;
  let updated = 0;
  const total = filePaths.length;

  for (let index = 0; index < total; index += 1) {
    const filePath = path.resolve(filePaths[index]);
    const relativePath = soundRelativePath(filePath);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;

    let current = existingByPath.get(normalizedFsPath(filePath))
      || (relativePath ? existingByRelativePath.get(relativePath) : null);
    if (!current) {
      const normalizedName = path.basename(filePath).normalize('NFC').toLocaleLowerCase('ko');
      const missingMatches = db.sounds.filter((sound) => !fs.existsSync(sound.path)
        && path.basename(sound.path).normalize('NFC').toLocaleLowerCase('ko') === normalizedName
        && Number(sound.size) === Number(stat.size));
      if (missingMatches.length === 1) current = missingMatches[0];
    }
    const id = current?.id || crypto.randomUUID();
    const needsProbe = !current || !current.technicalCached || current.modifiedAt !== stat.mtimeMs || current.size !== stat.size;
    const technical = needsProbe ? await probeAudio(filePath) : current;
    const categoryPath = current?.categoryPath || inferCategoryPath(filePath);
    const next = {
      id,
      relativePath: relativePath || current?.relativePath || '',
      path: filePath,
      fileName: path.basename(filePath),
      title: current?.title || path.basename(filePath, path.extname(filePath)),
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
      metadataVersion: technical.metadataVersion || current?.metadataVersion || 0,
      technicalCached: true,
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
    candidateStats.push({ filePath, size: stat.size });
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

async function rescanWatchedFolders({ reportProgress = true } = {}) {
  const [groups, categoryGroups] = await Promise.all([
    Promise.all(db.settings.watchedFolders.map(walkAudioFiles)),
    Promise.all(db.settings.watchedFolders.map(walkCategoryFolders))
  ]);
  const files = [...new Set(groups.flat())];
  lastFullScanAt = Date.now();
  const relinkResult = await relinkMissingFromFiles(files);
  const snapshot = await indexFiles(files, { reportProgress, categoryFolders: [...new Set(categoryGroups.flat())] });
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

function scheduleAutoRescan(reason = 'folder-change', changedPath = '') {
  if (changedPath) pendingScanFolders.add(changedPath);
  clearTimeout(watcherTimer);
  watcherTimer = setTimeout(() => runAutoRescan(reason), 900);
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
        if (!relativeName || relativeName.split(path.sep).includes('.sound-shelf')) return;
        const changedPath = path.join(folder, relativeName);
        const stat = fs.existsSync(changedPath) ? fs.statSync(changedPath) : null;
        scheduleAutoRescan('folder-change', stat?.isDirectory() ? changedPath : path.dirname(changedPath));
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
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (error) => console.error('Automatic update failed:', error.message));
  autoUpdater.on('update-downloaded', async (info) => {
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
  } catch (error) {
    console.error('Startup library load failed:', error);
  } finally {
    startupLoading = false;
    refreshFolderWatchers();
    mainWindow?.webContents.send('library-updated', { ...librarySnapshot(), updateReason: 'startup' });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  clearTimeout(updateStartupTimer);
  clearInterval(updateCheckTimer);
  clearTimeout(watcherTimer);
  for (const watcher of folderWatchers.values()) watcher.close();
  folderWatchers.clear();
  vaultStorage?.close();
});

ipcMain.handle('library:get', () => librarySnapshot());

ipcMain.handle('library:add-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '볼트로 이동할 사운드 파일 선택',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS].map((ext) => ext.slice(1)) }]
  });
  if (result.canceled) return null;
  const moved = [];
  const root = activeVaultRoot();
  if (!root) throw new Error('먼저 사운드 볼트를 열어 주세요.');
  for (const filePath of result.filePaths) {
    if (relativePathInside(root, filePath)) moved.push(filePath);
    else {
      const destination = uniqueDestination(root, path.basename(filePath));
      await moveFile(filePath, destination);
      moved.push(destination);
    }
  }
  return indexFiles(moved);
});

ipcMain.handle('library:add-paths', async (_event, paths) => {
  const files = [];
  const root = activeVaultRoot();
  if (!root) throw new Error('먼저 사운드 볼트를 열어 주세요.');
  for (const itemPath of [...new Set(paths || [])]) {
    const stat = await fsp.stat(itemPath).catch(() => null);
    if (stat && isTrashPath(itemPath)) {
      throw new Error('휴지통 파일은 왼쪽의 원하는 카테고리 또는 선택한 카테고리 화면에 놓아주세요.');
    }
    if (stat?.isDirectory()) {
      if (relativePathInside(root, itemPath)) files.push(...await walkAudioFiles(itemPath));
      else {
        const destination = uniqueDestination(root, path.basename(itemPath));
        await moveDirectory(itemPath, destination);
        files.push(...await walkAudioFiles(destination));
      }
    }
    else if (stat?.isFile() && AUDIO_EXTENSIONS.has(path.extname(itemPath).toLowerCase())) {
      if (relativePathInside(root, itemPath)) files.push(itemPath);
      else {
        const destination = uniqueDestination(root, path.basename(itemPath));
        await moveFile(itemPath, destination);
        files.push(destination);
      }
    }
  }
  refreshFolderWatchers();
  return indexFiles([...new Set(files)]);
});

ipcMain.handle('library:add-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Sound Shelf 볼트 열기',
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  await saveDb();
  return activateVault(result.filePaths[0], { legacySounds: [], legacyCategoryOrder: [] });
});

ipcMain.handle('vault:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '기존 Sound Shelf 볼트 열기',
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  await saveDb();
  return activateVault(result.filePaths[0], { legacySounds: [], legacyCategoryOrder: [] });
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
  return activateVault(destination, { legacySounds: [], legacyCategoryOrder: [] });
});

ipcMain.handle('vault:check', async () => {
  if (!vaultStorage) throw new Error('현재 열린 볼트가 없습니다.');
  const result = await vaultStorage.integrityCheck();
  return { ...result, vault: activeVault };
});

ipcMain.handle('vault:reveal', async () => {
  const root = activeVaultRoot();
  if (!root || !fs.existsSync(root)) throw new Error('현재 볼트 폴더를 찾을 수 없습니다.');
  shell.showItemInFolder(path.join(root, '.sound-shelf'));
  return true;
});

ipcMain.handle('library:rescan', async () => {
  return rescanWatchedFolders();
});

ipcMain.handle('library:update', async (_event, payload) => {
  const sound = db.sounds.find((item) => item.id === payload.id);
  if (!sound) throw new Error('Sound not found');
  const allowed = ['title', 'category', 'tags', 'notes', 'favorite', 'rating'];
  for (const key of allowed) {
    if (Object.hasOwn(payload, key)) sound[key] = payload[key];
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

ipcMain.handle('library:rename', async (_event, { id, name }) => {
  const sound = db.sounds.find((item) => item.id === id);
  if (!sound || !fs.existsSync(sound.path)) throw new Error('이름을 바꿀 원본 파일을 찾을 수 없습니다.');
  const safeName = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').trim();
  if (!safeName) throw new Error('새 사운드 이름을 입력해 주세요.');
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
});

ipcMain.handle('library:update-batch', async (_event, { ids, updates, addTags }) => {
  const selected = new Set(ids || []);
  const allowed = ['favorite', 'rating'];
  for (const sound of db.sounds) {
    if (!selected.has(sound.id)) continue;
    for (const key of allowed) if (Object.hasOwn(updates || {}, key)) sound[key] = updates[key];
    if (Array.isArray(addTags)) sound.tags = [...new Set([...(sound.tags || []), ...addTags])];
  }
  await saveDb();
  return librarySnapshot();
});

ipcMain.handle('library:move-category-batch', async (_event, { ids, category }) => {
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
});

ipcMain.handle('library:remove-batch', async (_event, { ids, trashFiles }) => {
  const selected = new Set(ids || []);
  const removing = db.sounds.filter((sound) => selected.has(sound.id));
  if (trashFiles) {
    for (const sound of removing) if (fs.existsSync(sound.path)) await shell.trashItem(sound.path);
  }
  db.sounds = db.sounds.filter((sound) => !selected.has(sound.id));
  waveformCache.clear();
  await saveDb();
  return librarySnapshot();
});

ipcMain.handle('library:backup-export', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Sound Shelf 라이브러리 백업',
    defaultPath: path.join(app.getPath('documents'), `Sound-Shelf-Backup-${new Date().toISOString().slice(0, 10)}.json`),
    filters: [{ name: 'Sound Shelf Backup', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return null;
  await saveDb();
  if (vaultStorage && activeVault) {
    await writeJsonAtomic(result.filePath, {
      type: 'sound-shelf-portable-backup',
      schemaVersion: 1,
      vault: { id: activeVault.id, name: activeVault.name },
      metadata: await vaultStorage.loadMetadata(),
      folderOrder: await vaultStorage.loadFolderOrder(),
      createdAt: new Date().toISOString()
    });
  } else {
    await fsp.copyFile(dbPath, result.filePath);
  }
  return { ok: true, path: result.filePath };
});

ipcMain.handle('library:backup-import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Sound Shelf 백업 복원', properties: ['openFile'],
    filters: [{ name: 'Sound Shelf Backup', extensions: ['json'] }]
  });
  if (result.canceled) return null;
  const candidate = JSON.parse(await fsp.readFile(result.filePaths[0], 'utf8'));
  await createAutomaticBackup('before-restore');
  if (candidate.type === 'sound-shelf-portable-backup' && candidate.metadata?.sounds && vaultStorage) {
    await vaultStorage.backupPortableMetadata('before-restore');
    await vaultStorage.saveMetadata(candidate.metadata.sounds);
    await vaultStorage.saveFolderOrder(candidate.folderOrder || []);
    return activateVault(activeVaultRoot(), { legacySounds: [] });
  }
  const imported = validateImportedDb(candidate);
  const root = activeVaultRoot() || imported.settings.watchedFolders[0];
  if (!root) throw new Error('백업을 복원할 볼트 폴더를 찾을 수 없습니다.');
  db.settings = { ...db.settings, ...imported.settings };
  return activateVault(root, { legacySounds: imported.sounds });
});

ipcMain.handle('library:collect-metadata', async () => {
  let updated = 0;
  const existing = db.sounds.filter((sound) => fs.existsSync(sound.path) && sound.metadataVersion !== 1);
  for (let index = 0; index < existing.length; index += 1) {
    const sound = existing[index];
    const metadata = await probeAudio(sound.path);
    Object.assign(sound, metadata);
    sound.technicalCached = true;
    updated += 1;
    if (index % 5 === 0 || index === existing.length - 1) {
      mainWindow?.webContents.send('scan-progress', { current: index + 1, total: existing.length, fileName: sound.fileName });
    }
  }
  await saveDb();
  return { ...librarySnapshot(), metadataResult: { updated } };
});

ipcMain.handle('library:find-duplicates', async () => {
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
});

ipcMain.handle('library:relink-missing', async () => {
  const allFiles = (await Promise.all(db.settings.watchedFolders.map(walkAudioFiles))).flat();
  const result = await relinkMissingFromFiles(allFiles);
  const categoryGroups = await Promise.all(db.settings.watchedFolders.map(walkCategoryFolders));
  db.categories = [...new Set([...categoryGroups.flat(), ...db.sounds.map((sound) => sound.categoryPath)].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  await saveDb();
  return { ...librarySnapshot(), idChanges: result.idChanges, relinkResult: result };
});

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
  if (root && !relativePathInside(root, filePath)) {
    const folder = categoryFolderPath(sound.categoryPath || sound.category || '미분류') || root;
    await fsp.mkdir(folder, { recursive: true });
    const destination = uniqueDestination(folder, path.basename(filePath));
    await moveFile(filePath, destination);
    filePath = destination;
  }
  const stat = await fsp.stat(filePath);
  const oldId = sound.id;
  sound.path = filePath;
  sound.fileName = path.basename(filePath);
  sound.relativePath = soundRelativePath(filePath) || sound.relativePath || '';
  sound.size = stat.size;
  sound.modifiedAt = stat.mtimeMs;
  sound.categoryPath = inferCategoryPath(filePath);
  sound.category = sound.categoryPath.split('/').pop();
  Object.assign(sound, await probeAudio(filePath));
  sound.technicalCached = true;
  db.sounds = deduplicateSoundsByPath(db.sounds);
  await saveDb();
  return { ...librarySnapshot(), idChanges: { [oldId]: sound.id } };
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
  return moveSoundToFolder(sound, selectedFolder, inferCategoryPath(path.join(selectedFolder, sound.fileName)));
});

ipcMain.handle('library:move-category', async (_event, { id, category }) => {
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

ipcMain.handle('category:create', async (_event, { parentCategory, name }) => {
  const parent = normalizeCategoryPath(parentCategory);
  const safeName = normalizeCategoryPath(name).split('/').pop();
  if (!safeName) throw new Error('새 폴더 이름을 입력해 주세요.');
  const parentFolder = categoryFolderPath(parent);
  if (!parentFolder) throw new Error('상위 폴더를 찾을 수 없습니다.');
  const folder = path.join(parentFolder, safeName);
  if (fs.existsSync(folder)) throw new Error('같은 이름의 폴더가 이미 있습니다.');
  await fsp.mkdir(folder, { recursive: true });
  const categoryPath = parent && parent !== '미분류' ? `${parent}/${safeName}` : safeName;
  if (!db.categories.includes(categoryPath)) db.categories.push(categoryPath);
  db.categoryOrder = [...new Set([...(db.categoryOrder || []), categoryPath])];
  db.categories.sort((a, b) => a.localeCompare(b, 'ko'));
  await saveDb();
  return librarySnapshot();
});

ipcMain.handle('category:rename', async (_event, { category, name }) => {
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

ipcMain.handle('category:move-up', async (_event, category) => {
  const source = normalizeCategoryPath(category);
  const parts = source.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('이미 최상위 폴더입니다.');
  const target = parts.slice(0, -2).join('/') || '미분류';
  return moveCategoryDirectory(source, target);
});

ipcMain.handle('category:reorder', async (_event, { categories, referenceCategory, position }) => {
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

ipcMain.handle('category:trash', async (_event, category) => {
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
  waveformCache.clear();
  await saveDb();
  return librarySnapshot();
});

ipcMain.handle('category:trash-batch', async (_event, categories) => {
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
  const moved = [];
  for (const filePath of result.filePaths) moved.push(await moveFileIntoCategory(filePath, category));
  return indexFiles(moved);
});

ipcMain.handle('category:drop-paths', async (_event, { category, paths }) => {
  const targetCategory = normalizeCategoryPath(category);
  const targetFolder = categoryFolderPath(targetCategory);
  if (!targetFolder) throw new Error('대상 폴더를 찾을 수 없습니다.');
  let snapshot = null;
  const movedFiles = [];
  let needsRescan = false;
  for (const itemPath of [...new Set(paths || [])]) {
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
  if (movedFiles.length) snapshot = await indexFiles(movedFiles);
  if (needsRescan) snapshot = await rescanWatchedFolders({ reportProgress: false });
  if (!snapshot) snapshot = await rescanWatchedFolders({ reportProgress: false });
  return snapshot;
});

ipcMain.handle('shortcuts:set', async (_event, shortcuts) => {
  db.settings.shortcuts = { ...DEFAULT_SHORTCUTS, ...(shortcuts || {}) };
  await saveDb();
  return librarySnapshot();
});

ipcMain.handle('preview-volume:set', async (_event, volume) => {
  db.settings.previewVolume = Math.max(0, Math.min(1, Number(volume) || 0));
  queueSave();
  return db.settings.previewVolume;
});

ipcMain.on('shortcuts:capture', (_event, active) => { shortcutCapture = Boolean(active); });

ipcMain.handle('library:remove', async (_event, { id, trashFile }) => {
  const index = db.sounds.findIndex((item) => item.id === id);
  if (index < 0) return librarySnapshot();
  const [sound] = db.sounds.splice(index, 1);
  if (trashFile && fs.existsSync(sound.path)) await shell.trashItem(sound.path);
  await saveDb();
  return librarySnapshot();
});

ipcMain.handle('library:reveal', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('library:waveform', async (_event, id) => {
  const sound = db.sounds.find((item) => item.id === id);
  if (!sound || !fs.existsSync(sound.path)) return [];
  const cacheKey = waveformCacheKey(sound);
  if (waveformCache.has(cacheKey)) return waveformCache.get(cacheKey);
  const diskCached = await readWaveformDiskCache(cacheKey);
  if (diskCached) {
    waveformCache.set(cacheKey, diskCached);
    return diskCached;
  }
  if (waveformJobs.has(cacheKey)) return waveformJobs.get(cacheKey);
  const job = runWaveformJob(async () => {
    try {
      const { stdout } = await execFileAsync(findMediaTool('ffmpeg'), [
        '-v', 'error', '-i', sound.path, '-map', '0:a:0', '-ac', '2', '-ar', '8000', '-f', 's16le', 'pipe:1'
      ], { encoding: null, maxBuffer: 1024 * 1024 * 64, timeout: 45000 });
      const frameCount = Math.floor(stdout.length / 4);
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
      const waveform = { left, right };
      waveformCache.set(cacheKey, waveform);
      await writeWaveformDiskCache(cacheKey, waveform).catch((error) => console.error('Waveform cache write failed:', error.message));
      return waveform;
    } catch (error) {
      console.error('Waveform generation failed:', error.message);
      return { left: [], right: [] };
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
  if (!force && cached && Number(cached.sourceModifiedAt) === Number(sound.modifiedAt)) {
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
    sound.keyAnalysis = analysis;
    await saveDb();
    return { ...librarySnapshot(), keyAnalysisResult: { id: sound.id, analysis, cached: false } };
  } catch (error) {
    throw new Error(`조성 분석 실패: ${error.message}`);
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
    const clipDirectory = path.join(app.getPath('temp'), 'sound-shelf-clips');
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
    await indexFiles([outputPath], { reportProgress: false });
    const created = db.sounds.find((item) => normalizedFsPath(item.path) === normalizedFsPath(outputPath));
    if (!created) throw new Error('생성된 파일을 라이브러리에 추가하지 못했습니다.');
    created.tags = [...new Set(sound.tags || [])];
    created.rating = Number(sound.rating || 0);
    created.categoryPath = sound.categoryPath || inferCategoryPath(outputPath);
    created.category = created.categoryPath.split('/').filter(Boolean).pop() || inferCategory(outputPath);
    await saveDb();
    return {
      ...librarySnapshot(),
      createdClip: { ...publicSound(created), start, end, sourceId: sound.id }
    };
  } catch (error) {
    await fsp.unlink(outputPath).catch(() => {});
    throw new Error(`선택 구간 파일을 만들지 못했습니다: ${error.message}`);
  }
});

ipcMain.handle('resolve:insert', async (_event, sound) => {
  if (!sound?.path || !fs.existsSync(sound.path)) {
    return { ok: false, message: '원본 사운드 파일을 찾을 수 없습니다.' };
  }
  try {
    const script = await fsp.readFile(path.join(__dirname, 'resolve_insert.py'), 'utf8');
    const { stdout } = await execFileAsync(findPython(), [
      '-c', script,
      sound.path,
      String(sound.duration || 0),
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
