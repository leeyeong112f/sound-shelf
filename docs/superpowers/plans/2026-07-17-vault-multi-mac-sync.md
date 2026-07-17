# 볼트 다중 Mac 동기화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 두 대의 Mac에서 Sound Shelf를 동시에 켜둔 채 태그 등 라이브러리 변경사항을 수 초~수십 초 안에 서로 반영하고, 현재 존재하는 "통째로 덮어쓰기" 데이터 유실을 제거한다.

**Architecture:** 각 Mac은 볼트 안 `.sound-shelf/edits/<machineId>.json`에 **자기 편집만** 쓴다. 두 Mac이 같은 파일을 건드리지 않으므로 Google Drive가 충돌 사본을 만들 수 없다. 읽을 때 `metadata.json`(베이스)에 모든 편집 파일을 얹어 사운드 단위 last-writer-wins로 병합한다. 감지는 7초 폴링.

**Tech Stack:** Electron 43, Node 내장 모듈만 (`node:test`, `node:fs`, `node:crypto`). 새 의존성 없음.

## Global Constraints

- **새 npm 의존성 추가 금지.** 테스트는 Node 내장 `node:test`를 쓴다.
- **들여쓰기는 2스페이스.** 이 저장소의 JS 파일은 전부 2스페이스이고 탭은 한 줄도 없다. 주변 코드와 맞춘다.
- **커밋 메시지는 한글.** 형식 `[타입] 설명` (feat, fix, docs, refactor, test, chore).
- **정상 동작 중 볼트 공유 파일 쓰기는 0번.** `metadata.json`, `folder-order.json`, `vault.json`은 평상시 쓰지 않는다. 이 제약이 깨지면 설계 전체가 무의미해진다.
- **`machineId`는 절대 볼트에 저장하지 않는다.** 로컬 `db.settings.machineId`에만 둔다. 볼트에 넣으면 동기화되어 두 Mac이 같은 ID를 갖는다.
- **실제 Google Drive 볼트로 테스트 금지.** 사용자의 진짜 데이터다. 로컬 임시 폴더만 사용한다.
- **병합 로직은 순수 함수.** 파일 입출력·시계·Electron에 의존하지 않는다.
- 기준 브랜치: `feature/vault-multi-mac-sync` (설계문 커밋 `c3081ee` 위).
- 설계문: `docs/superpowers/specs/2026-07-17-vault-multi-mac-sync-design.md`

## File Structure

| 파일 | 책임 |
|------|------|
| `src/vault-sync.js` (신규) | 병합 규칙. 순수 함수만. 베이스 + 편집 소스들 → 병합 상태 |
| `test/vault-sync.test.js` (신규) | `vault-sync.js` 단위 테스트 (`node:test`) |
| `src/vault-storage.js` (수정) | 편집 파일 읽기·쓰기 입출력. `saveMetadata`의 공유 쓰기 제거 |
| `src/main.js` (수정) | `machineId` 생성, diff 기반 변경 감지, 폴링 루프, 병합 결과 적용 |
| `src/renderer.js` (수정) | `remote-sync` 토스트 |
| `package.json` (수정) | `npm test` 스크립트 |

---

### Task 1: 병합 순수 함수와 단위 테스트

**Files:**
- Create: `src/vault-sync.js`
- Create: `test/vault-sync.test.js`
- Modify: `package.json` (scripts에 `test` 추가)

**Interfaces:**
- Consumes: 없음 (이 계획의 첫 작업)
- Produces:
  - `mergeVaultState(base, editSources)` → `{ sounds, folderOrder, previewVolume }`
    - `base`: `{ sounds: Array<PortableSound>, folderOrder: string[] }`
    - `editSources`: `Array<{ machineId: string, sounds: Object, folderOrder?: {updatedAt, order}, settings?: {updatedAt, previewVolume} }>`
    - `sounds`: `Array<PortableSound & { updatedAt: number }>` — 삭제 표식은 제외됨
    - `folderOrder`: `string[]`
    - `previewVolume`: `number | null` (아무 소스도 주장하지 않으면 `null`)
  - `EDITS_SCHEMA_VERSION` = `1`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/vault-sync.test.js` 생성:

```js
const test = require('node:test');
const assert = require('node:assert');
const { mergeVaultState } = require('../src/vault-sync');

function sound(id, overrides = {}) {
  return {
    id,
    relativePath: `액션/${id}.wav`,
    fileName: `${id}.wav`,
    title: id,
    tags: [],
    notes: '',
    favorite: false,
    rating: 0,
    createdAt: 1000,
    modifiedAt: 1000,
    size: 100,
    contentHash: '',
    keyAnalysis: null,
    ...overrides
  };
}

test('베이스만 있으면 베이스를 그대로 돌려준다', () => {
  const base = { sounds: [sound('a'), sound('b')], folderOrder: ['액션'] };
  const result = mergeVaultState(base, []);
  assert.strictEqual(result.sounds.length, 2);
  assert.deepStrictEqual(result.folderOrder, ['액션']);
  assert.strictEqual(result.previewVolume, null);
});

test('편집이 베이스를 이긴다', () => {
  const base = { sounds: [sound('a', { tags: [] })], folderOrder: [] };
  const edits = [{
    machineId: 'mac-1',
    sounds: { a: { ...sound('a', { tags: ['액션'] }), updatedAt: 500 } }
  }];
  const result = mergeVaultState(base, edits);
  assert.deepStrictEqual(result.sounds[0].tags, ['액션']);
});

test('나중 updatedAt이 이긴다', () => {
  const base = { sounds: [sound('a')], folderOrder: [] };
  const edits = [
    { machineId: 'mac-1', sounds: { a: { ...sound('a', { title: '먼저' }), updatedAt: 100 } } },
    { machineId: 'mac-2', sounds: { a: { ...sound('a', { title: '나중' }), updatedAt: 200 } } }
  ];
  const result = mergeVaultState(base, edits);
  assert.strictEqual(result.sounds[0].title, '나중');
});

test('한쪽이 만지지 않은 사운드는 덮이지 않는다', () => {
  const base = { sounds: [sound('a'), sound('b')], folderOrder: [] };
  const edits = [
    { machineId: 'mac-1', sounds: { a: { ...sound('a', { title: 'A가 고침' }), updatedAt: 900 } } },
    { machineId: 'mac-2', sounds: { b: { ...sound('b', { title: 'B가 고침' }), updatedAt: 100 } } }
  ];
  const result = mergeVaultState(base, edits);
  const byId = Object.fromEntries(result.sounds.map((item) => [item.id, item]));
  assert.strictEqual(byId.a.title, 'A가 고침');
  assert.strictEqual(byId.b.title, 'B가 고침');
});

test('동률이면 machineId 사전순으로 결정적이다', () => {
  const base = { sounds: [sound('a')], folderOrder: [] };
  const edits = [
    { machineId: 'mac-z', sounds: { a: { ...sound('a', { title: 'Z' }), updatedAt: 500 } } },
    { machineId: 'mac-a', sounds: { a: { ...sound('a', { title: 'A' }), updatedAt: 500 } } }
  ];
  assert.strictEqual(mergeVaultState(base, edits).sounds[0].title, 'Z');
  assert.strictEqual(mergeVaultState(base, [...edits].reverse()).sounds[0].title, 'Z');
});

test('병합 순서를 바꿔도 같은 결과가 나온다', () => {
  const base = { sounds: [sound('a'), sound('b')], folderOrder: [] };
  const edits = [
    { machineId: 'mac-1', sounds: { a: { ...sound('a', { title: 'A1' }), updatedAt: 300 } } },
    { machineId: 'mac-2', sounds: { a: { ...sound('a', { title: 'A2' }), updatedAt: 400 } } }
  ];
  const forward = mergeVaultState(base, edits);
  const backward = mergeVaultState(base, [...edits].reverse());
  assert.deepStrictEqual(forward.sounds, backward.sounds);
});

test('삭제 표식이 이기면 결과에서 빠진다', () => {
  const base = { sounds: [sound('a'), sound('b')], folderOrder: [] };
  const edits = [{ machineId: 'mac-1', sounds: { a: { updatedAt: 500, deleted: true } } }];
  const result = mergeVaultState(base, edits);
  assert.deepStrictEqual(result.sounds.map((item) => item.id), ['b']);
});

test('삭제 표식보다 새로운 편집이 있으면 되살아난다', () => {
  const base = { sounds: [sound('a')], folderOrder: [] };
  const edits = [
    { machineId: 'mac-1', sounds: { a: { updatedAt: 500, deleted: true } } },
    { machineId: 'mac-2', sounds: { a: { ...sound('a', { title: '부활' }), updatedAt: 600 } } }
  ];
  const result = mergeVaultState(base, edits);
  assert.strictEqual(result.sounds.length, 1);
  assert.strictEqual(result.sounds[0].title, '부활');
});

test('베이스에 없는 사운드도 편집으로 추가된다', () => {
  const base = { sounds: [], folderOrder: [] };
  const edits = [{ machineId: 'mac-1', sounds: { z: { ...sound('z'), updatedAt: 100 } } }];
  assert.strictEqual(mergeVaultState(base, edits).sounds[0].id, 'z');
});

test('폴더 순서는 최신 것이 이긴다', () => {
  const base = { sounds: [], folderOrder: ['베이스'] };
  const edits = [
    { machineId: 'mac-1', sounds: {}, folderOrder: { updatedAt: 100, order: ['먼저'] } },
    { machineId: 'mac-2', sounds: {}, folderOrder: { updatedAt: 200, order: ['나중'] } }
  ];
  assert.deepStrictEqual(mergeVaultState(base, edits).folderOrder, ['나중']);
});

test('미리듣기 볼륨은 최신 것이 이긴다', () => {
  const base = { sounds: [], folderOrder: [] };
  const edits = [
    { machineId: 'mac-1', sounds: {}, settings: { updatedAt: 100, previewVolume: 0.2 } },
    { machineId: 'mac-2', sounds: {}, settings: { updatedAt: 200, previewVolume: 0.9 } }
  ];
  assert.strictEqual(mergeVaultState(base, edits).previewVolume, 0.9);
});

test('깨진 편집 소스는 무시하고 나머지를 병합한다', () => {
  const base = { sounds: [sound('a')], folderOrder: [] };
  const edits = [
    null,
    { machineId: 'broken' },
    { machineId: 'mac-1', sounds: { a: { ...sound('a', { title: '정상' }), updatedAt: 100 } } }
  ];
  assert.strictEqual(mergeVaultState(base, edits).sounds[0].title, '정상');
});

test('updatedAt이 없는 편집 레코드는 베이스를 이기지 못한다', () => {
  const base = { sounds: [sound('a', { title: '베이스' })], folderOrder: [] };
  const edits = [{ machineId: 'mac-1', sounds: { a: { ...sound('a', { title: '무효' }) } } }];
  assert.strictEqual(mergeVaultState(base, edits).sounds[0].title, '베이스');
});
```

`package.json`의 `scripts`에 추가 (기존 `check` 줄 다음):

```json
    "test": "node --test test/",
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/vault-sync'`

- [ ] **Step 3: 최소 구현 작성**

`src/vault-sync.js` 생성:

```js
const EDITS_SCHEMA_VERSION = 1;

// 베이스 레코드에는 updatedAt이 없다. 0으로 취급하면 어떤 편집도 베이스를 이긴다.
function stampOf(record) {
  const value = Number(record?.updatedAt || 0);
  return Number.isFinite(value) ? value : 0;
}

// 두 Mac이 각자 계산해도 같은 결론에 도달해야 한다. updatedAt이 같으면
// machineId 사전순으로 결정한다.
function beats(candidate, candidateMachine, current, currentMachine) {
  if (!current) return true;
  const candidateStamp = stampOf(candidate);
  const currentStamp = stampOf(current);
  if (candidateStamp !== currentStamp) return candidateStamp > currentStamp;
  return String(candidateMachine || '') > String(currentMachine || '');
}

function mergeVaultState(base, editSources) {
  const winners = new Map();
  const owners = new Map();

  for (const sound of base?.sounds || []) {
    if (!sound?.id) continue;
    winners.set(sound.id, { ...sound, updatedAt: 0 });
    owners.set(sound.id, '');
  }

  let folderOrder = { updatedAt: 0, order: base?.folderOrder || [] };
  let folderOwner = '';
  let volume = null;
  let volumeStamp = 0;
  let volumeOwner = '';

  for (const source of editSources || []) {
    if (!source || typeof source !== 'object') continue;
    const machineId = String(source.machineId || '');

    for (const [id, record] of Object.entries(source.sounds || {})) {
      if (!id || !record || typeof record !== 'object') continue;
      // updatedAt 이 없거나 잘못된 레코드는 무효로 본다. 이게 없으면 동률(0 대 0)
      // 판정에서 machineId 비교가 걸려 잘못된 레코드가 베이스를 이겨버린다.
      if (stampOf(record) <= 0) continue;
      if (!beats(record, machineId, winners.get(id), owners.get(id))) continue;
      winners.set(id, { ...record, id });
      owners.set(id, machineId);
    }

    const order = source.folderOrder;
    if (order && Array.isArray(order.order) && stampOf(order) > 0
      && beats(order, machineId, folderOrder, folderOwner)) {
      folderOrder = order;
      folderOwner = machineId;
    }

    const settings = source.settings;
    if (settings && Number.isFinite(Number(settings.previewVolume)) && stampOf(settings) > 0
      && beats(settings, machineId, { updatedAt: volumeStamp }, volumeOwner)) {
      volume = Number(settings.previewVolume);
      volumeStamp = stampOf(settings);
      volumeOwner = machineId;
    }
  }

  return {
    sounds: [...winners.values()].filter((record) => !record.deleted),
    folderOrder: [...new Set(folderOrder.order || [])],
    previewVolume: volume
  };
}

module.exports = { mergeVaultState, EDITS_SCHEMA_VERSION };
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run: `npm test`
Expected: PASS — 13개 테스트 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add src/vault-sync.js test/vault-sync.test.js package.json
git commit -m "[feat] 볼트 병합 순수 함수와 단위 테스트 추가

- mergeVaultState: 사운드 단위 last-writer-wins, 동률 시 machineId 사전순
- 삭제 표식(tombstone) 처리, 깨진 소스 무시
- node:test 기반 npm test 스크립트 추가 (의존성 없음)"
```

---

### Task 2: 편집 파일 입출력을 VaultStorage에 추가

**Files:**
- Modify: `src/vault-storage.js`
- Modify: `test/vault-sync.test.js` (추가 테스트 없음 — 이 작업은 입출력이라 Task 6 통합 테스트에서 검증)

**Interfaces:**
- Consumes: `EDITS_SCHEMA_VERSION` (Task 1)
- Produces (모두 `VaultStorage` 인스턴스 메서드):
  - `editsDirectory` (속성) → `<root>/.sound-shelf/edits` 절대 경로
  - `editFilePath(machineId)` → `string`
  - `async loadEditSources()` → `Array<{ machineId, sounds, folderOrder?, settings?, __fileName }>` — 깨진 파일은 건너뛴다
  - `async saveEdits(machineId, machineName, payload)` → `void`. `payload`는 `{ sounds, folderOrder, settings }`
  - `async editFileStamps(excludeMachineId)` → `Array<{ name, mtimeMs, size }>` — 내 파일 제외

- [ ] **Step 1: 편집 파일 경로와 상수 추가**

`src/vault-storage.js` 상단의 상수 옆에 추가:

```js
const EDITS_SCHEMA_VERSION = 1;
```

`constructor` 안, `this.folderOrderPath = ...` 줄 다음에 추가:

```js
    this.editsDirectory = path.join(this.controlDirectory, 'edits');
```

- [ ] **Step 2: 편집 파일 읽기 구현**

`src/vault-storage.js`의 `loadFolderOrder()` 메서드 다음에 추가:

```js
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
```

- [ ] **Step 3: 편집 파일 쓰기 구현**

같은 파일, `editFileStamps()` 다음에 추가:

```js
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
```

- [ ] **Step 4: `saveMetadata`의 공유 쓰기 제거**

현재 `saveMetadata()`는 `metadata.json`과 `vault.json`을 매번 쓴다. 둘 다 공유 파일이라 두 Mac이 동시에 쓰면 Drive 충돌 사본이 생긴다. 정상 경로에서 호출되지 않도록 이름을 바꿔 의도를 분명히 한다.

`src/vault-storage.js`의 `async saveMetadata(sounds) {` 줄을 다음으로 교체:

```js
  // 베이스 스냅샷을 통째로 덮어쓴다. 두 Mac이 동시에 호출하면 Drive 충돌 사본이
  // 생기므로 정상 편집 경로에서 호출하면 안 된다. 볼트 생성·가져오기처럼
  // 단독 실행이 보장된 경우에만 쓴다.
  async overwriteBaseMetadata(sounds) {
```

`module.exports`는 그대로 두고, 파일 끝의 exports에 상수를 추가:

```js
module.exports = {
  VaultStorage,
  EDITS_SCHEMA_VERSION,
  normalizedRelativePath,
  relativePathInside,
  readJson,
  writeJsonAtomic
};
```

- [ ] **Step 5: 문법 검사**

Run: `node --check src/vault-storage.js && npm test`
Expected: PASS — 문법 오류 없음, Task 1 테스트 13개 계속 통과

주의: 이 개명으로 `src/main.js`의 호출부 2곳(`saveDb`, `library:backup-import`)이 존재하지 않는 메서드를 부르게 된다. `npm run check`는 문법만 보므로 이를 잡지 못한다. Task 3이 `saveDb` 쪽을, Task 4가 `backup-import` 쪽을 고친다. **Task 4가 끝나기 전까지 앱은 저장·가져오기에서 깨진 상태다** — 중간에 앱을 띄워 확인하지 말 것.

- [ ] **Step 6: 커밋**

```bash
git add src/vault-storage.js
git commit -m "[feat] VaultStorage에 Mac별 편집 파일 입출력 추가

- loadEditSources: edits/*.json 전부 읽되 깨진 파일은 건너뜀
- saveEdits: 자기 machineId 파일만 원자적으로 씀
- editFileStamps: 폴링용 mtime/size 조회
- saveMetadata를 overwriteBaseMetadata로 개명해 공유 쓰기 의도를 명시"
```

---

### Task 3: machineId 생성과 diff 기반 편집 감지

**Files:**
- Modify: `src/main.js:90-108` (`cleanDb`)
- Modify: `src/main.js:34` (초기 `db`)
- Modify: `src/main.js:391-413` (`saveDb`)

**Interfaces:**
- Consumes: `VaultStorage#saveEdits`, `VaultStorage#loadEditSources` (Task 2), `mergeVaultState` (Task 1)
- Produces:
  - `db.settings.machineId` — 로컬 전용 Mac 고유 ID
  - `syncBaseline` (모듈 변수) → `Map<id, PortableSound & {updatedAt}>` — 마지막으로 알고 있는 공유 상태
  - `ownEdits` (모듈 변수) → `{ sounds: Object, folderOrder: Object|null, settings: Object|null }`
  - `collectLocalEdits()` → `void` — `db.sounds`를 `syncBaseline`과 비교해 `ownEdits`를 갱신

- [ ] **Step 1: machineId를 로컬 설정에 추가**

`src/main.js:34`의 초기 `db`를 교체:

```js
let db = { version: 1, sounds: [], categories: [], categoryOrder: [], settings: { watchedFolders: [], shortcuts: { ...DEFAULT_SHORTCUTS }, previewVolume: 0.8, machineId: '' } };
```

`cleanDb()`의 `settings` 객체(`src/main.js:96-106`)에서 `currentVaultId` 줄 다음에 추가:

```js
      currentVaultId: candidate?.settings?.currentVaultId || '',
      // 이 Mac만의 ID. 볼트에 저장하면 동기화되어 두 Mac이 같은 ID를 갖게 되므로
      // 반드시 로컬 userData에만 둔다.
      machineId: candidate?.settings?.machineId || crypto.randomUUID()
```

`activateVaultNow()`가 `db.settings`를 재구성할 때 잃지 않도록, `src/main.js`의 `db.settings = {` 블록(현재 257번째 줄 근처)에서 `currentVaultId: activeVault.id` 다음에 추가:

```js
    currentVaultId: activeVault.id,
    machineId: previousSettings.machineId || crypto.randomUUID()
```

- [ ] **Step 2: 동기화 상태 변수와 diff 함수 추가**

`src/main.js:53`의 `let startupLoading = true;` 다음에 추가:

```js
let syncBaseline = new Map();
let ownEdits = { sounds: {}, folderOrder: null, settings: null };
let lastEditStamps = '';
let syncPollTimer;
const SYNC_POLL_MS = 7000;
```

`src/main.js` 상단의 require 목록에 추가 (기존 `require('./vault-storage')` 줄 근처):

```js
const { mergeVaultState } = require('./vault-sync');
```

`saveDb()` 바로 앞에 diff 함수 추가:

```js
const EDITABLE_FIELDS = ['relativePath', 'fileName', 'title', 'tags', 'notes', 'favorite', 'rating', 'createdAt', 'modifiedAt', 'size', 'contentHash', 'keyAnalysis'];

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
    if (baseline && !baseline.deleted && sameSound(baseline, sound)) continue;
    ownEdits.sounds[id] = { ...sound, updatedAt: now };
  }

  for (const [id, baseline] of syncBaseline) {
    if (current.has(id) || baseline.deleted) continue;
    ownEdits.sounds[id] = { updatedAt: now, deleted: true };
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
  for (const [id, record] of Object.entries(ownEdits.sounds)) {
    if (record.deleted) syncBaseline.set(id, { id, deleted: true, updatedAt: record.updatedAt });
  }
}
```

- [ ] **Step 3: saveDb가 편집 파일만 쓰도록 교체**

`src/main.js:391-403`의 `saveDb()` 앞부분을 교체:

```js
async function saveDb() {
  if (vaultStorage && activeVault) {
    for (const sound of db.sounds) {
      const relativePath = soundRelativePath(sound.path);
      if (relativePath) sound.relativePath = relativePath;
    }
    collectLocalEdits();
    // 볼트에는 내 편집 파일 하나만 쓴다. metadata.json / folder-order.json /
    // vault.json 은 공유 파일이므로 정상 경로에서 건드리지 않는다.
    await vaultStorage.saveEdits(db.settings.machineId, os.hostname(), ownEdits);
    vaultStorage.replaceTechnicalCache(db.sounds.filter((sound) => sound.relativePath));
  }
```

(`saveDb()`의 나머지 — 로컬 `dbPath` 쓰기와 `performanceStats` 갱신 — 는 그대로 둔다.)

`src/main.js` 상단 require에 추가:

```js
const os = require('node:os');
```

- [ ] **Step 4: 문법 검사와 단위 테스트**

Run: `npm run check && npm test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/main.js
git commit -m "[feat] machineId 생성과 diff 기반 편집 감지 추가

- machineId를 로컬 db.settings에만 보관 (볼트에 넣으면 두 Mac이 같은 ID를 가짐)
- collectLocalEdits: 베이스라인과 비교해 변경/신규/삭제를 자동 추출
- saveDb가 볼트에는 자기 편집 파일만 쓰도록 변경"
```

---

### Task 4: 볼트 활성화 시 병합 상태 적용

**Files:**
- Modify: `src/main.js:263-330` (`activateVaultNow`)
- Modify: `src/main.js:1381-1400` 근처 (`library:backup-export`)

**Interfaces:**
- Consumes: `mergeVaultState` (Task 1), `loadEditSources` (Task 2), `syncBaseline`/`ownEdits` (Task 3)
- Produces: `applyMergedState(merged)` → `boolean` — 실제로 달라졌으면 `true`

- [ ] **Step 1: 병합 상태를 db에 반영하는 함수 추가**

`src/main.js`의 `activateVaultNow()` 바로 앞에 추가:

```js
// 변경 여부는 id 목록이 아니라 사용자 편집 필드까지 비교해야 한다. 태그만 바뀌고
// 목록 구성이 그대로인 경우가 이 기능의 주 사용 사례이기 때문이다.
function editSignature(sounds) {
  return JSON.stringify(sounds
    .map((sound) => [sound.id, sound.title, sound.tags, sound.notes, sound.favorite, sound.rating])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function applyMergedState(merged) {
  const before = editSignature(db.sounds.map(portableSound).filter(Boolean));
  const cacheById = new Map((vaultStorage?.cachedSounds() || []).map((item) => [item.id, item]));
  const hydrated = merged.sounds
    .filter((sound) => sound?.relativePath)
    .map((sound) => hydratePortableSound(sound, cacheById.get(sound.id), activeVault.root));
  db.sounds = deduplicateSoundsByPath(hydrated);
  if (merged.folderOrder.length) db.categoryOrder = merged.folderOrder;
  if (merged.previewVolume !== null) db.settings.previewVolume = merged.previewVolume;
  db.categories = [...new Set(db.sounds.map((sound) => sound.categoryPath).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  syncBaseline = new Map(merged.sounds.map((sound) => [sound.id, sound]));
  return before !== editSignature(db.sounds.map(portableSound).filter(Boolean));
}
```

- [ ] **Step 2: activateVaultNow가 편집 파일을 병합하도록 변경**

`src/main.js`의 `activateVaultNow()` 안에서 `const [portableMetadata, savedFolderOrder] = await Promise.all([` 블록을 교체:

```js
  const [portableMetadata, savedFolderOrder, editSources] = await Promise.all([
    vaultStorage.loadMetadata(),
    vaultStorage.loadFolderOrder(),
    vaultStorage.loadEditSources()
  ]);
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
```

이어서 `const cached = vaultStorage.cachedSounds();` 아래의 `const hydrated = portableMetadata.sounds` 블록에서 `portableMetadata.sounds`를 `merged.sounds`로 바꾼다:

```js
  const hydrated = merged.sounds
    .filter((sound) => sound?.relativePath)
    .map((sound) => hydratePortableSound(
      sound,
      cacheById.get(sound.id) || cacheByRelativePath.get(normalizedRelativePath(sound.relativePath)),
      root
    ));
```

그리고 `db.categoryOrder = savedFolderOrder.length ? savedFolderOrder : legacyCategoryOrder;` 를 교체:

```js
  db.categoryOrder = merged.folderOrder.length ? merged.folderOrder : legacyCategoryOrder;
  if (merged.previewVolume !== null) db.settings.previewVolume = merged.previewVolume;
  syncBaseline = new Map(merged.sounds.map((sound) => [sound.id, sound]));
```

- [ ] **Step 3: 백업이 병합 상태를 쓰도록 변경**

`src/main.js`에서 `metadata: await vaultStorage.loadMetadata(),` 를 찾아 교체:

```js
    metadata: {
      type: 'sound-shelf-metadata',
      schemaVersion: 1,
      vaultId: activeVault.id,
      updatedAt: new Date().toISOString(),
      // 편집 내용이 빠진 백업은 쓸모가 없다. 병합된 현재 상태를 쓴다.
      sounds: db.sounds.map(portableSound).filter(Boolean)
    },
```

`vaultStorage.saveMetadata(` 를 호출하는 남은 지점(`library:backup-import` 근처)을 `vaultStorage.overwriteBaseMetadata(` 로 바꾼다. 가져오기는 사용자가 명시적으로 실행하는 단독 작업이라 베이스를 덮어써도 안전하다.

- [ ] **Step 4: 남은 saveMetadata 호출이 없는지 확인**

Run: `grep -n "saveMetadata" src/main.js src/vault-storage.js`
Expected: 결과 없음 (전부 `overwriteBaseMetadata`로 바뀜)

Run: `npm run check && npm test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/main.js
git commit -m "[feat] 볼트 활성화 시 편집 파일을 병합해 적용

- activateVaultNow가 metadata.json 베이스에 edits/*.json을 얹어 병합
- 내 편집 파일 내용을 메모리로 복원해 다음 저장 시 유실 방지
- 백업 내보내기가 병합된 현재 상태를 쓰도록 변경"
```

---

### Task 5: 7초 폴링으로 원격 변경 반영

**Files:**
- Modify: `src/main.js` (폴링 함수 추가, `app.whenReady` 및 `before-quit` 수정)
- Modify: `src/renderer.js:1890-1895` (`onLibraryUpdated`)

**Interfaces:**
- Consumes: `applyMergedState` (Task 4), `editFileStamps`/`loadEditSources` (Task 2), `activateVault` 큐 (기존)
- Produces: `startSyncPolling()`, `stopSyncPolling()`, `pollRemoteEdits()`

- [ ] **Step 1: 폴링 함수 추가**

`src/main.js`의 `refreshFolderWatchers()` 앞에 추가:

```js
// fs.watch 를 쓰지 않는 이유: Google Drive 가상 파일시스템이 macOS FSEvents 를
// 제대로 발생시키는지 보장할 수 없다. mtime 폴링은 확실히 동작하고, Drive 자체의
// 내려받기 지연이 훨씬 크므로 7초면 충분하다.
async function pollRemoteEdits() {
  if (startupLoading || !vaultStorage || !activeVault) return;
  if (!fs.existsSync(activeVault.root)) return;
  const stamps = await vaultStorage.editFileStamps(db.settings.machineId).catch(() => null);
  if (!stamps) return;
  const fingerprint = JSON.stringify(stamps);
  if (fingerprint === lastEditStamps) return;
  lastEditStamps = fingerprint;

  const [portableMetadata, savedFolderOrder, editSources] = await Promise.all([
    vaultStorage.loadMetadata(),
    vaultStorage.loadFolderOrder(),
    vaultStorage.loadEditSources()
  ]);
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
```

- [ ] **Step 2: 시작 시 폴링 시작, 종료 시 정리**

`src/main.js`의 `app.whenReady()` 블록 `finally` 안에서 `refreshFolderWatchers();` 다음에 추가:

```js
    refreshFolderWatchers();
    startSyncPolling();
```

`app.on('before-quit', ...)` 안에 추가:

```js
  stopSyncPolling();
```

- [ ] **Step 3: 렌더러 토스트 추가**

`src/renderer.js`의 `onLibraryUpdated` 핸들러에 한 줄 추가:

```js
window.soundLibrary.onLibraryUpdated((snapshot) => {
  setLibrary(snapshot);
  if (snapshot.updateReason === 'folder-change') showToast('폴더 변경 사항을 자동으로 반영했습니다.', 1800);
  if (snapshot.updateReason === 'startup') showToast('사운드 라이브러리를 불러왔습니다.', 1800);
  if (snapshot.updateReason === 'vault-cached') showToast('저장된 목록을 표시했습니다. 폴더 동기화는 백그라운드에서 계속됩니다.', 2500);
  if (snapshot.updateReason === 'remote-sync') showToast('다른 Mac의 변경 사항을 반영했습니다.', 2000);
});
```

- [ ] **Step 4: 문법 검사**

Run: `npm run check && npm test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/main.js src/renderer.js
git commit -m "[feat] 7초 폴링으로 다른 Mac의 편집을 반영

- editFileStamps의 mtime/size 지문이 바뀔 때만 재병합
- 볼트 활성화 큐에 얹어 스캔과 직렬화
- 렌더러에 remote-sync 토스트 추가"
```

---

### Task 6: 두 인스턴스 통합 테스트

**Files:**
- Create: `test/manual/two-instance-sync.md`

**Interfaces:**
- Consumes: Task 1-5 전부
- Produces: 없음 (검증 절차 문서)

- [ ] **Step 1: 테스트 절차 문서 작성**

`test/manual/two-instance-sync.md` 생성:

```markdown
# 두 인스턴스 동기화 수동 검증

**실제 Google Drive 볼트로 하지 말 것.** 로컬 임시 폴더만 쓴다.

## 준비

	VAULT=$(mktemp -d)/vault
	mkdir -p "$VAULT/액션"
	cp <임의의 wav 3개> "$VAULT/액션/"
	A=$(mktemp -d)/userdata-a
	B=$(mktemp -d)/userdata-b

## 실행

인스턴스 A와 B를 각각 다른 userData로 띄운다. Electron `--user-data-dir` 대신
런처 스크립트에서 `app.setPath('userData', ...)` 를 쓴다 (시작 속도 수정 때 사용한 방식).

## 확인 항목

1. A와 B 모두에서 `$VAULT` 를 볼트로 연다.
2. `$VAULT/.sound-shelf/edits/` 에 서로 다른 이름의 json 파일 2개가 생기는지 확인한다.
   같은 파일을 공유하면 설계가 깨진 것이다.
3. A에서 사운드 하나에 태그를 단다. **10초 안에** B에 반영되고
   "다른 Mac의 변경 사항을 반영했습니다" 토스트가 뜨는지 확인한다.
4. B에서 **다른** 사운드에 태그를 단다. A의 태그가 살아있는지 확인한다.
   (이것이 기존 유실 버그의 회귀 테스트다.)
5. A에서 사운드를 삭제한다. B에서 사라지고, **양쪽을 재시작해도 되살아나지 않는지**
   확인한다.
6. 양쪽을 종료했다가 다시 켠다. 모든 태그가 남아있는지 확인한다.
7. `$VAULT/.sound-shelf/metadata.json` 의 mtime이 볼트를 연 이후로
   **바뀌지 않았는지** 확인한다. 바뀌었다면 공유 쓰기가 남아있는 것이다.
```

- [ ] **Step 2: 절차를 실제로 수행**

위 문서의 확인 항목 1-7을 실행한다. 실패하면 해당 Task로 돌아간다.

- [ ] **Step 3: 커밋**

```bash
git add test/manual/two-instance-sync.md
git commit -m "[test] 두 인스턴스 동기화 수동 검증 절차 추가"
```

---

## Self-Review

**1. 스펙 커버리지**

| 설계문 요구사항 | 담당 Task |
|---|---|
| `vault-sync.js` 순수 함수 분리 | Task 1 |
| 사운드 단위 last-writer-wins | Task 1 |
| 동률 시 machineId 사전순 | Task 1 |
| 삭제 표식 | Task 1 (병합), Task 3 (생성) |
| 베이스 updatedAt을 0으로 취급 | Task 1 |
| 편집 파일 형식 (전체 사운드 형태 + updatedAt) | Task 2, Task 3 |
| machineId를 로컬에만 보관 | Task 3 |
| diff 기반 변경 감지 | Task 3 |
| 공유 파일 쓰기 0번 | Task 2 (개명), Task 3 (saveDb), Task 6 (검증 7번) |
| 편집 파일만 원자적 쓰기 | Task 2 |
| 7초 폴링 | Task 5 |
| `remote-sync` 토스트 | Task 5 |
| 깨진 파일 건너뛰기 | Task 1, Task 2 |
| 충돌 사본도 병합 소스로 | Task 2 (`*.json` 전부 읽기) |
| 볼트 미연결 시 폴링 건너뛰기 | Task 5 |
| 시작 로딩 중 폴링 안 함 | Task 5 |
| 활성화 큐로 직렬화 | Task 5 |
| 백업이 병합 상태를 쓰기 | Task 4 |
| 단위 테스트 6종 | Task 1 (13개 작성) |
| 통합 테스트 | Task 6 |
| 마이그레이션 (기존 볼트 그대로 열림) | Task 4 (베이스가 곧 기존 metadata.json) |

누락 없음.

**2. 플레이스홀더 스캔**

TBD/TODO/"적절히 처리" 없음. 모든 코드 단계에 실제 코드가 있다.

**3. 타입 일관성**

- `mergeVaultState(base, editSources)` → `{ sounds, folderOrder, previewVolume }` — Task 1에서 정의, Task 4·5에서 동일하게 사용.
- `saveEdits(machineId, machineName, payload)` — Task 2에서 정의, Task 3에서 동일 시그니처로 호출.
- `editFileStamps(excludeMachineId)` — Task 2 정의, Task 5 사용.
- `ownEdits` 형태 `{ sounds, folderOrder, settings }` — Task 3 정의, Task 4에서 복원, Task 2 `saveEdits`의 payload와 일치.
- `overwriteBaseMetadata` — Task 2에서 개명, Task 4에서 호출부 갱신.

## 알려진 위험

- **Task 4 Step 2는 기존 코드 블록을 여러 군데 손대므로 가장 깨지기 쉽다.** 이 Task 후 반드시 `npm run check`와 앱 기동을 확인한다.
- **Task 3의 `collectLocalEdits`가 이 계획에서 가장 미묘하다.** 베이스라인 갱신을 틀리면 편집이 매번 새 `updatedAt`으로 다시 찍혀 폴링이 끝없이 돌거나, 반대로 편집이 누락된다. Task 6의 확인 항목 4·6이 이걸 잡는다.
- 두 Mac의 시계가 크게 어긋나면 "나중"의 판정이 틀어진다. 설계문에서 감수하기로 한 위험이다.
- 편집 파일은 접기(compaction)가 없어 계속 자란다. 설계문에서 최악 1 MB 미만으로 계산해 수용했다.
