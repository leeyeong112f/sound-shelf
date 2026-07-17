const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

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
  playPause: 'Space'
};

let mainWindow;
let dbPath;
let db = { version: 1, sounds: [], categories: [], settings: { watchedFolders: [] } };
let saveTimer;
let shortcutCapture = false;
const waveformCache = new Map();

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
    version: 1,
    sounds: Array.isArray(candidate?.sounds) ? candidate.sounds : [],
    categories: Array.isArray(candidate?.categories) ? candidate.categories : [],
    settings: {
      watchedFolders: Array.isArray(candidate?.settings?.watchedFolders)
        ? candidate.settings.watchedFolders
        : [],
      shortcuts: { ...DEFAULT_SHORTCUTS, ...(candidate?.settings?.shortcuts || {}) },
      previewVolume: Number.isFinite(Number(candidate?.settings?.previewVolume))
        ? Math.max(0, Math.min(1, Number(candidate.settings.previewVolume)))
        : 0.8
    }
  };
}

async function loadDb() {
  dbPath = path.join(app.getPath('userData'), 'sound-library.json');
  try {
    db = cleanDb(JSON.parse(await fsp.readFile(dbPath, 'utf8')));
    for (const sound of db.sounds) {
      const inferred = inferCategoryPath(sound.path);
      sound.categoryPath = sound.categoryPath || (inferred !== '미분류' ? inferred : sound.category || '미분류');
      sound.category = sound.categoryPath.split('/').filter(Boolean).pop() || '미분류';
    }
    db.categories = [...new Set(db.sounds.map((sound) => sound.categoryPath).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'ko'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load library:', error);
    await saveDb();
  }
}

async function saveDb() {
  await fsp.mkdir(path.dirname(dbPath), { recursive: true });
  const temporary = `${dbPath}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(db, null, 2), 'utf8');
  await fsp.rename(temporary, dbPath);
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDb().catch(console.error), 150);
}

function publicSound(sound) {
  return { ...sound, missing: !fs.existsSync(sound.path) };
}

function librarySnapshot() {
  return {
    sounds: db.sounds.map(publicSound),
    categories: db.categories,
    categoryPaths: [...new Set(db.sounds.map((sound) => sound.categoryPath || sound.category).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'ko')),
    watchedFolders: db.settings.watchedFolders,
    shortcuts: db.settings.shortcuts,
    previewVolume: db.settings.previewVolume
  };
}

function stableId(filePath) {
  return crypto.createHash('sha1').update(path.resolve(filePath)).digest('hex');
}

function inferCategory(filePath) {
  const parent = path.basename(path.dirname(filePath));
  return parent && parent !== path.parse(filePath).root ? parent : '미분류';
}

function inferCategoryPath(filePath) {
  const absolute = path.resolve(filePath);
  const roots = [...db.settings.watchedFolders]
    .map((folder) => path.resolve(folder))
    .sort((a, b) => b.length - a.length);
  const root = roots.find((folder) => {
    const relative = path.relative(folder, absolute);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  if (!root) return inferCategory(filePath);
  const relativeFolder = path.dirname(path.relative(root, absolute));
  if (!relativeFolder || relativeFolder === '.') return '미분류';
  return relativeFolder.split(path.sep).filter(Boolean).join('/');
}

async function probeAudio(filePath) {
  try {
    const { stdout } = await execFileAsync(findMediaTool('ffprobe'), [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
    ], { maxBuffer: 1024 * 1024 * 8 });
    const info = JSON.parse(stdout);
    const audio = info.streams?.find((stream) => stream.codec_type === 'audio') || {};
    return {
      duration: Number(info.format?.duration || audio.duration || 0),
      sampleRate: Number(audio.sample_rate || 0),
      channels: Number(audio.channels || 0),
      codec: audio.codec_name || '',
      bitRate: Number(info.format?.bit_rate || audio.bit_rate || 0)
    };
  } catch {
    return { duration: 0, sampleRate: 0, channels: 0, codec: '', bitRate: 0 };
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

async function indexFiles(filePaths) {
  const existingById = new Map(db.sounds.map((sound) => [sound.id, sound]));
  let added = 0;
  let updated = 0;
  const total = filePaths.length;

  for (let index = 0; index < total; index += 1) {
    const filePath = path.resolve(filePaths[index]);
    const id = stableId(filePath);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;

    const current = existingById.get(id);
    const needsProbe = !current || current.modifiedAt !== stat.mtimeMs || current.size !== stat.size;
    const technical = needsProbe ? await probeAudio(filePath) : current;
    const categoryPath = current?.categoryPath || inferCategoryPath(filePath);
    const next = {
      id,
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
      bitRate: technical.bitRate || 0
    };

    if (current) {
      Object.assign(current, next);
      updated += 1;
    } else {
      db.sounds.push(next);
      existingById.set(id, next);
      added += 1;
    }

    if (index % 5 === 0 || index === total - 1) {
      mainWindow?.webContents.send('scan-progress', { current: index + 1, total, fileName: path.basename(filePath) });
    }
  }

  db.categories = [...new Set(db.sounds.map((sound) => sound.categoryPath || sound.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  await saveDb();
  return { ...librarySnapshot(), scanResult: { added, updated, total } };
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

async function moveSoundToFolder(sound, folder, categoryPath) {
  await fsp.mkdir(folder, { recursive: true });
  const destination = path.resolve(path.dirname(sound.path)) === path.resolve(folder)
    ? sound.path
    : uniqueDestination(folder, sound.fileName);
  if (path.resolve(sound.path) !== path.resolve(destination)) await moveFile(sound.path, destination);
  const oldId = sound.id;
  const stat = await fsp.stat(destination);
  sound.path = destination;
  sound.fileName = path.basename(destination);
  sound.id = stableId(destination);
  sound.categoryPath = categoryPath || inferCategoryPath(destination);
  sound.category = sound.categoryPath.split('/').filter(Boolean).pop() || inferCategory(destination);
  sound.modifiedAt = stat.mtimeMs;
  sound.size = stat.size;
  waveformCache.clear();
  db.categories = [...new Set([...db.categories, sound.categoryPath].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  await saveDb();
  return { ...librarySnapshot(), moved: { oldId, id: sound.id, path: destination } };
}

async function createWindow() {
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
  await mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (shortcutCapture) return;
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    const shortcut = normalizedShortcutFromInput(input);
    if (shortcut === 'Space') return;
    if (!Object.values(db.settings.shortcuts).includes(shortcut)) return;
    event.preventDefault();
    mainWindow.webContents.send('shortcut-triggered', shortcut);
  });
}

app.whenReady().then(async () => {
  await loadDb();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('library:get', () => librarySnapshot());

ipcMain.handle('library:add-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '사운드 파일 추가',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS].map((ext) => ext.slice(1)) }]
  });
  if (result.canceled) return null;
  return indexFiles(result.filePaths);
});

ipcMain.handle('library:add-paths', async (_event, paths) => {
  const files = [];
  for (const itemPath of [...new Set(paths || [])]) {
    const stat = await fsp.stat(itemPath).catch(() => null);
    if (stat?.isDirectory()) {
      if (!db.settings.watchedFolders.includes(itemPath)) db.settings.watchedFolders.push(itemPath);
      files.push(...await walkAudioFiles(itemPath));
    }
    else if (stat?.isFile() && AUDIO_EXTENSIONS.has(path.extname(itemPath).toLowerCase())) files.push(itemPath);
  }
  return indexFiles([...new Set(files)]);
});

ipcMain.handle('library:add-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '사운드 폴더 추가',
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  const folder = result.filePaths[0];
  if (!db.settings.watchedFolders.includes(folder)) db.settings.watchedFolders.push(folder);
  const files = await walkAudioFiles(folder);
  return indexFiles(files);
});

ipcMain.handle('library:rescan', async () => {
  const groups = await Promise.all(db.settings.watchedFolders.map(walkAudioFiles));
  return indexFiles([...new Set(groups.flat())]);
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

ipcMain.handle('library:move-folder', async (_event, id) => {
  const sound = db.sounds.find((item) => item.id === id);
  if (!sound || !fs.existsSync(sound.path)) throw new Error('원본 파일을 찾을 수 없습니다.');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `“${sound.title}” 이동할 폴더 선택`,
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled) return null;
  return moveSoundToFolder(sound, result.filePaths[0]);
});

ipcMain.handle('library:move-category', async (_event, { id, category }) => {
  const sound = db.sounds.find((item) => item.id === id);
  const categoryParts = String(category || '').split(/[\\/>]+/)
    .map((part) => part.trim().replace(/[:*?"<>|]/g, '-')).filter(Boolean);
  const safeCategory = categoryParts.join('/');
  if (!sound || !fs.existsSync(sound.path)) throw new Error('원본 파일을 찾을 수 없습니다.');
  if (!safeCategory) throw new Error('카테고리 이름을 입력해 주세요.');
  const source = path.resolve(sound.path);
  let root = db.settings.watchedFolders.find((folder) => {
    const relative = path.relative(path.resolve(folder), source);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  }) || db.settings.watchedFolders[0];
  if (!root) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '카테고리 폴더를 만들 라이브러리 위치 선택',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled) return null;
    root = result.filePaths[0];
    db.settings.watchedFolders.push(root);
  }
  return moveSoundToFolder(sound, path.join(root, ...categoryParts), safeCategory);
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
  const cacheKey = `${sound.id}:${sound.modifiedAt}:${sound.size}`;
  if (waveformCache.has(cacheKey)) return waveformCache.get(cacheKey);
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
    return waveform;
  } catch (error) {
    console.error('Waveform generation failed:', error.message);
    return { left: [], right: [] };
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

ipcMain.on('library:start-drag', (event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    const iconBuffer = fs.readFileSync(path.join(__dirname, 'drag-icon.png'));
    const icon = nativeImage.createFromBuffer(iconBuffer).resize({ width: 48, height: 48 });
    if (icon.isEmpty()) throw new Error('드래그 아이콘을 읽을 수 없습니다.');
    event.sender.startDrag({ file: path.resolve(filePath), icon });
  } catch (error) {
    console.error('Native drag failed:', error);
    event.sender.send('drag-error', error.message);
  }
});
