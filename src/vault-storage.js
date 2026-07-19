const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const VAULT_SCHEMA_VERSION = 1;
const METADATA_SCHEMA_VERSION = 1;
const EDITS_SCHEMA_VERSION = 1;

function normalizedRelativePath(value) {
  return String(value || '')
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.')
    .join('/')
    .normalize('NFC');
}

function relativePathInside(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || relative === '.') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return normalizedRelativePath(relative);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filePath);
}

class VaultStorage {
  constructor(root, userDataPath) {
    this.root = path.resolve(root);
    this.userDataPath = userDataPath;
    this.controlDirectory = path.join(this.root, '.sound-shelf');
    this.manifestPath = path.join(this.controlDirectory, 'vault.json');
    this.metadataPath = path.join(this.controlDirectory, 'metadata.json');
    this.folderOrderPath = path.join(this.controlDirectory, 'folder-order.json');
    this.editsDirectory = path.join(this.controlDirectory, 'edits');
    this.database = null;
    this.manifest = null;
    this.cachePath = '';
  }

  async initialize({ create = true, name = '' } = {}) {
    const stat = await fsp.stat(this.root).catch(() => null);
    if (!stat && create) await fsp.mkdir(this.root, { recursive: true });
    else if (!stat?.isDirectory()) throw new Error('볼트 폴더를 찾을 수 없습니다.');
    await fsp.mkdir(this.controlDirectory, { recursive: true });

    let manifest = await readJson(this.manifestPath, null);
    if (!manifest) {
      manifest = {
        type: 'sound-shelf-vault',
        schemaVersion: VAULT_SCHEMA_VERSION,
        id: crypto.randomUUID(),
        name: String(name || path.basename(this.root)).normalize('NFC'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await writeJsonAtomic(this.manifestPath, manifest);
    }
    if (manifest.type !== 'sound-shelf-vault' || !manifest.id) {
      throw new Error('올바른 Sound Shelf 볼트가 아닙니다.');
    }
    this.manifest = manifest;
    await this.openCache();
    return this.info();
  }

  async openCache() {
    const cacheDirectory = path.join(this.userDataPath, 'vault-cache');
    await fsp.mkdir(cacheDirectory, { recursive: true });
    this.cachePath = path.join(cacheDirectory, `${this.manifest.id}.sqlite`);
    this.database?.close();
    this.database = new DatabaseSync(this.cachePath);
    this.database.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=NORMAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS technical_cache (
        sound_id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        modified_at REAL NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        sample_rate INTEGER NOT NULL DEFAULT 0,
        channels INTEGER NOT NULL DEFAULT 0,
        codec TEXT NOT NULL DEFAULT '',
        bit_rate INTEGER NOT NULL DEFAULT 0,
        embedded_metadata TEXT NOT NULL DEFAULT '{}',
        embedded_tags TEXT NOT NULL DEFAULT '[]',
        metadata_version INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL DEFAULT '',
        content_hash_key TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS technical_cache_filename_size
      ON technical_cache(file_name, size);
      CREATE TABLE IF NOT EXISTS search_cache (
        sound_id TEXT PRIMARY KEY,
        search_text TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  info() {
    if (!this.manifest) return null;
    return {
      id: this.manifest.id,
      name: this.manifest.name,
      root: this.root,
      schemaVersion: Number(this.manifest.schemaVersion || VAULT_SCHEMA_VERSION),
      controlDirectory: this.controlDirectory,
      cachePath: this.cachePath
    };
  }

  async loadMetadata() {
    const candidate = await readJson(this.metadataPath, null);
    if (!candidate) {
      return {
        type: 'sound-shelf-metadata',
        schemaVersion: METADATA_SCHEMA_VERSION,
        vaultId: this.manifest.id,
        updatedAt: new Date().toISOString(),
        sounds: []
      };
    }
    if (candidate.vaultId && candidate.vaultId !== this.manifest.id) {
      throw new Error('메타데이터의 볼트 ID가 현재 볼트와 다릅니다.');
    }
    return {
      type: 'sound-shelf-metadata',
      schemaVersion: Number(candidate.schemaVersion || METADATA_SCHEMA_VERSION),
      vaultId: this.manifest.id,
      updatedAt: candidate.updatedAt || new Date().toISOString(),
      sounds: Array.isArray(candidate.sounds) ? candidate.sounds : []
    };
  }

  // 베이스 스냅샷을 통째로 덮어쓴다. 두 Mac이 동시에 호출하면 Drive 충돌 사본이
  // 생기므로 정상 편집 경로에서 호출하면 안 된다. 볼트 생성·가져오기처럼
  // 단독 실행이 보장된 경우에만 쓴다.
  async overwriteBaseMetadata(sounds) {
    const payload = {
      type: 'sound-shelf-metadata',
      schemaVersion: METADATA_SCHEMA_VERSION,
      vaultId: this.manifest.id,
      updatedAt: new Date().toISOString(),
      sounds
    };
    await writeJsonAtomic(this.metadataPath, payload);
    this.manifest.updatedAt = payload.updatedAt;
    await writeJsonAtomic(this.manifestPath, this.manifest);
  }

  async loadFolderOrder() {
    const candidate = await readJson(this.folderOrderPath, null);
    if (Array.isArray(candidate)) return candidate;
    return Array.isArray(candidate?.order) ? candidate.order : [];
  }

  async saveFolderOrder(order) {
    await writeJsonAtomic(this.folderOrderPath, {
      type: 'sound-shelf-folder-order',
      schemaVersion: 1,
      vaultId: this.manifest.id,
      updatedAt: new Date().toISOString(),
      order: [...new Set(order || [])]
    });
  }

  editFilePath(machineId) {
    return path.join(this.editsDirectory, `${machineId}.json`);
  }

  // edits/ 안의 *.json 을 전부 읽는다. Drive 충돌 사본(`mac-1 (1).json`)이
  // 생기더라도 그 안의 편집을 잃지 않으려면 이름을 가리지 않고 읽어야 한다.
  async loadEditSources() {
    let entries = [];
    try {
      entries = await fsp.readdir(this.editsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }
    // 읽는 순서가 병합 결과를 바꾸면 두 Mac이 영구히 갈라진다.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const sources = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(this.editsDirectory, entry.name);
      let candidate = null;
      try {
        candidate = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      } catch (error) {
        // Drive가 내려받는 중이면 반쯤 쓰인 파일이 보일 수 있다.
        // 이번 회차만 건너뛰고 다음 폴링에 다시 시도한다.
        console.error(`Skipping unreadable edit file (${entry.name}):`, error.message);
        continue;
      }
      if (candidate?.vaultId && candidate.vaultId !== this.manifest.id) continue;
      sources.push({
        machineId: String(candidate?.machineId || entry.name.replace(/\.json$/, '')),
        sounds: candidate?.sounds && typeof candidate.sounds === 'object' ? candidate.sounds : {},
        folderOrder: candidate?.folderOrder || null,
        settings: candidate?.settings || null,
        __fileName: entry.name
      });
    }
    return sources;
  }

  async editFileStamps(excludeMachineId = '') {
    let entries = [];
    try {
      entries = await fsp.readdir(this.editsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }
    const exclude = `${excludeMachineId}.json`;
    const stamps = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === exclude) continue;
      const stat = await fsp.stat(path.join(this.editsDirectory, entry.name)).catch(() => null);
      if (stat) stamps.push({ name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size });
    }
    return stamps.sort((a, b) => a.name.localeCompare(b.name));
  }

  // 이 Mac 자신의 파일만 쓴다. 두 Mac이 같은 파일을 건드리지 않는 것이
  // 이 설계의 핵심이며, Drive 충돌 사본을 구조적으로 막는다.
  async saveEdits(machineId, machineName, { sounds = {}, folderOrder = null, settings = null } = {}) {
    await fsp.mkdir(this.editsDirectory, { recursive: true });
    await writeJsonAtomic(this.editFilePath(machineId), {
      type: 'sound-shelf-edits',
      schemaVersion: EDITS_SCHEMA_VERSION,
      vaultId: this.manifest.id,
      machineId,
      machineName: String(machineName || '').normalize('NFC'),
      updatedAt: new Date().toISOString(),
      sounds,
      folderOrder,
      settings
    });
  }

  // 볼트 압축 전용. 편집 파일을 전부 지운다 — 호출자는 병합 결과를 새 베이스로
  // 굳힌 직후여야 하고, 삭제 표식을 자기 편집 파일로 승계할 책임이 있다.
  async clearEditFiles() {
    let entries = [];
    try {
      entries = await fsp.readdir(this.editsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      await fsp.unlink(path.join(this.editsDirectory, entry.name)).catch(() => {});
      removed += 1;
    }
    return removed;
  }

  cachedSounds() {
    if (!this.database) return [];
    const rows = this.database.prepare('SELECT * FROM technical_cache').all();
    return rows.map((row) => ({
      id: row.sound_id,
      relativePath: row.relative_path,
      fileName: row.file_name,
      modifiedAt: Number(row.modified_at || 0),
      size: Number(row.size || 0),
      duration: Number(row.duration || 0),
      sampleRate: Number(row.sample_rate || 0),
      channels: Number(row.channels || 0),
      codec: row.codec || '',
      bitRate: Number(row.bit_rate || 0),
      embeddedMetadata: JSON.parse(row.embedded_metadata || '{}'),
      embeddedTags: JSON.parse(row.embedded_tags || '[]'),
      metadataVersion: Number(row.metadata_version || 0),
      contentHash: row.content_hash || '',
      contentHashKey: row.content_hash_key || ''
    }));
  }

  replaceTechnicalCache(sounds) {
    if (!this.database) return;
    const statement = this.database.prepare(`
      INSERT INTO technical_cache (
        sound_id, relative_path, file_name, modified_at, size, duration,
        sample_rate, channels, codec, bit_rate, embedded_metadata, embedded_tags,
        metadata_version, content_hash, content_hash_key, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sound_id) DO UPDATE SET
        relative_path=excluded.relative_path, file_name=excluded.file_name,
        modified_at=excluded.modified_at, size=excluded.size, duration=excluded.duration,
        sample_rate=excluded.sample_rate, channels=excluded.channels, codec=excluded.codec,
        bit_rate=excluded.bit_rate, embedded_metadata=excluded.embedded_metadata,
        embedded_tags=excluded.embedded_tags, metadata_version=excluded.metadata_version,
        content_hash=excluded.content_hash, content_hash_key=excluded.content_hash_key,
        updated_at=excluded.updated_at
    `);
    const searchStatement = this.database.prepare('INSERT INTO search_cache (sound_id, search_text, updated_at) VALUES (?, ?, ?)');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec('DELETE FROM technical_cache');
      this.database.exec('DELETE FROM search_cache');
      for (const sound of sounds || []) {
        if (!sound.id || !sound.relativePath) continue;
        statement.run(
          sound.id,
          normalizedRelativePath(sound.relativePath),
          sound.fileName || path.basename(sound.relativePath),
          Number(sound.modifiedAt || 0),
          Number(sound.size || 0),
          Number(sound.duration || 0),
          Number(sound.sampleRate || 0),
          Number(sound.channels || 0),
          sound.codec || '',
          Number(sound.bitRate || 0),
          JSON.stringify(sound.embeddedMetadata || {}),
          JSON.stringify(sound.embeddedTags || []),
          Number(sound.metadataVersion || 0),
          sound.contentHash || '',
          sound.contentHashKey || '',
          Date.now()
        );
        const searchText = [
          sound.title,
          sound.fileName,
          sound.relativePath,
          sound.categoryPath,
          ...(sound.tags || []),
          sound.notes,
          ...(sound.embeddedTags || []),
          ...Object.values(sound.embeddedMetadata || {})
        ].filter(Boolean).join(' ').normalize('NFC').toLocaleLowerCase('ko');
        searchStatement.run(sound.id, searchText, Date.now());
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async backupPortableMetadata(reason = 'automatic') {
    const backupDirectory = path.join(this.controlDirectory, 'backups');
    await fsp.mkdir(backupDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDirectory, `${reason}-${stamp}.json`);
    const payload = {
      type: 'sound-shelf-portable-backup',
      schemaVersion: 1,
      vault: this.manifest,
      metadata: await this.loadMetadata(),
      folderOrder: await this.loadFolderOrder(),
      createdAt: new Date().toISOString()
    };
    await writeJsonAtomic(backupPath, payload);
    const backups = (await fsp.readdir(backupDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ path: path.join(backupDirectory, entry.name), time: fs.statSync(path.join(backupDirectory, entry.name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    await Promise.all(backups.slice(10).map((item) => fsp.unlink(item.path).catch(() => {})));
    return backupPath;
  }

  async integrityCheck() {
    const metadata = await this.loadMetadata();
    const ids = new Set();
    const paths = new Set();
    let duplicateIds = 0;
    let duplicatePaths = 0;
    let missingFiles = 0;
    let invalidPaths = 0;
    for (const sound of metadata.sounds) {
      const relative = normalizedRelativePath(sound.relativePath);
      if (!relative || relative.startsWith('../')) invalidPaths += 1;
      if (ids.has(sound.id)) duplicateIds += 1;
      if (paths.has(relative)) duplicatePaths += 1;
      ids.add(sound.id);
      paths.add(relative);
      if (!fs.existsSync(path.join(this.root, ...relative.split('/')))) missingFiles += 1;
    }
    return {
      ok: duplicateIds === 0 && duplicatePaths === 0 && invalidPaths === 0,
      total: metadata.sounds.length,
      duplicateIds,
      duplicatePaths,
      invalidPaths,
      missingFiles,
      cacheEntries: this.cachedSounds().length
    };
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

module.exports = {
  VaultStorage,
  EDITS_SCHEMA_VERSION,
  normalizedRelativePath,
  relativePathInside,
  readJson,
  writeJsonAtomic
};
