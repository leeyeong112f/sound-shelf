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
      const current = winners.get(id);
      if (record.deleted) {
        // 삭제는 일반 편집보다 항상 우선한다. 다른 Mac의 오래된 스캔이나 이동 기록이
        // 더 늦게 저장되더라도 사용자가 삭제한 항목을 되살리면 안 된다.
        // 단, 아래의 명시적 복원(restored)이 더 최신이면 그것이 이긴다.
        if (!current?.deleted && current?.restored && !beats(record, machineId, current, owners.get(id))) continue;
        if (!current?.deleted || beats(record, machineId, current, owners.get(id))) {
          winners.set(id, { ...(current || {}), ...record, id, deleted: true, restored: false });
          owners.set(id, machineId);
        }
        continue;
      }
      // 삭제한 파일이 같은 자리로 돌아온 것을 확인하고 되살린 기록만 삭제를 이긴다.
      // 일반 편집(태그·별점 등)은 여전히 삭제를 이기지 못한다 — 다른 Mac의 뒤늦은
      // 스캔 결과가 사용자의 삭제를 되돌리면 안 되기 때문이다.
      if (current?.deleted && record.restored && beats(record, machineId, current, owners.get(id))) {
        winners.set(id, { ...record, id, deleted: false, restored: true });
        owners.set(id, machineId);
        continue;
      }
      if (current?.deleted) continue;
      if (!beats(record, machineId, current, owners.get(id))) continue;
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

  const records = [...winners.values()];
  return {
    sounds: records.filter((record) => !record.deleted),
    deletedSounds: records.filter((record) => record.deleted),
    folderOrder: [...new Set(folderOrder.order || [])],
    previewVolume: volume
  };
}

// 베이스와 사용자 필드가 완전히 같은 자기 편집 레코드는 병합 결과에 기여하지
// 않으므로 제거해도 안전하다. 삭제 표식, 복원 표식, 베이스에 없는 신규 사운드는
// 편집 파일이 유일한 저장소이므로 반드시 유지한다.
function pruneRedundantEdits(ownSounds, baseSounds, fields) {
  const baseById = new Map((baseSounds || []).filter((sound) => sound?.id).map((sound) => [sound.id, sound]));
  const kept = {};
  for (const [id, record] of Object.entries(ownSounds || {})) {
    if (!record || typeof record !== 'object') continue;
    // 복원 표식을 지우면 베이스의 삭제 표식이 다시 이겨 사운드가 또 사라진다.
    if (record.deleted || record.restored) {
      kept[id] = record;
      continue;
    }
    const base = baseById.get(id);
    if (!base) {
      kept[id] = record;
      continue;
    }
    const same = (fields || []).every((field) => JSON.stringify(record[field] ?? null) === JSON.stringify(base[field] ?? null));
    if (!same) kept[id] = record;
  }
  return kept;
}

module.exports = { mergeVaultState, pruneRedundantEdits, EDITS_SCHEMA_VERSION };
