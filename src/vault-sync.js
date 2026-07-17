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
