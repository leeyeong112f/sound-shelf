const state = {
  sounds: [],
  categories: [],
  watchedFolders: [],
  filter: 'all',
  query: '',
  selectedId: null,
  inspectorOpen: false,
  playingId: null,
  playRangeEnd: null,
  waveforms: new Map(),
  waveformLoading: new Set(),
  selections: new Map()
};

const $ = (selector) => document.querySelector(selector);
const list = $('#soundList');
const player = $('#audioPlayer');
const detailWrap = $('#detailWaveformWrap');
const detailCanvas = $('#detailWaveformCanvas');
const detailSelection = $('#detailSelection');
let saveDebounce;
let selectionGesture = null;
let transportAnimationFrame = null;
const miniWaveObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    const id = entry.target.dataset.waveformId;
    const sound = state.sounds.find((item) => item.id === id);
    if (!sound) return;
    if (state.waveforms.has(id)) drawMiniWaveform(id);
    else ensureWaveform(sound);
  });
}, { root: list, rootMargin: '120px' });

function formatDuration(seconds) {
  if (!seconds) return '—';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${rest}`;
}

function formatDetailedDuration(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = (safe % 60).toFixed(2).padStart(5, '0');
  return `${minutes}:${rest}`;
}

function formatSize(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function fileUrl(filePath) {
  return encodeURI(`file://${filePath}`);
}

function selectedSound() {
  return state.sounds.find((sound) => sound.id === state.selectedId);
}

function showToast(message, duration = 3000) {
  const toast = $('#scanToast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toast.hideTimer);
  toast.hideTimer = setTimeout(() => toast.classList.add('hidden'), duration);
}

function filteredSounds() {
  const query = state.query.trim().toLocaleLowerCase('ko');
  return state.sounds.filter((sound) => {
    if (state.filter === 'favorites' && !sound.favorite) return false;
    if (state.filter.startsWith('category:') && sound.category !== state.filter.slice(9)) return false;
    if (!query) return true;
    const haystack = [sound.title, sound.fileName, sound.category, sound.notes, ...(sound.tags || [])]
      .join(' ').toLocaleLowerCase('ko');
    return query.split(/\s+/).every((word) => haystack.includes(word));
  }).sort((a, b) => a.title.localeCompare(b.title, 'ko', { numeric: true }));
}

function setLibrary(snapshot) {
  if (!snapshot) return;
  state.sounds = snapshot.sounds || [];
  state.categories = snapshot.categories || [];
  state.watchedFolders = snapshot.watchedFolders || [];
  render();
}

function renderSidebar() {
  $('#allCount').textContent = state.sounds.length;
  $('#favoriteCount').textContent = state.sounds.filter((sound) => sound.favorite).length;
  $('#categoryList').innerHTML = state.categories.map((category) => {
    const count = state.sounds.filter((sound) => sound.category === category).length;
    const active = state.filter === `category:${category}` ? 'active' : '';
    return `<button class="nav-item ${active}" data-category="${escapeHtml(category)}"><span>●</span>${escapeHtml(category)}<b>${count}</b></button>`;
  }).join('');
  document.querySelectorAll('.nav-item[data-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === state.filter);
  });
  $('#categoryOptions').innerHTML = state.categories.map((category) => `<option value="${escapeHtml(category)}"></option>`).join('');
}

function renderList() {
  const sounds = filteredSounds();
  const filterName = state.filter === 'all' ? '모든 사운드' : state.filter === 'favorites' ? '즐겨찾기' : state.filter.slice(9);
  $('#viewTitle').textContent = filterName;
  $('#resultSummary').textContent = `${sounds.length.toLocaleString()}개의 사운드`;
  $('#emptyState').classList.toggle('hidden', state.sounds.length > 0);
  list.classList.toggle('hidden', state.sounds.length === 0);

  list.innerHTML = sounds.map((sound) => {
    const tags = (sound.tags || []).slice(0, 3).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
    const isPlaying = state.playingId === sound.id && !player.paused;
    return `<div class="sound-row ${state.selectedId === sound.id ? 'selected' : ''}" data-id="${sound.id}" draggable="true">
      <button class="play-button" data-action="play" title="미리 듣기">${isPlaying ? '❚❚' : '▶'}</button>
      <div class="sound-name"><strong>${escapeHtml(sound.title)}</strong><small>${escapeHtml(sound.fileName)}${sound.missing ? ' · 파일 없음' : ''}</small></div>
      <div class="mini-waveform-wrap"><canvas class="mini-waveform" data-waveform-id="${sound.id}"></canvas><div class="mini-playhead"></div></div>
      <span class="category-pill">${escapeHtml(sound.category || '미분류')}</span>
      <span class="dim">${formatDuration(sound.duration)}</span>
      <span class="dim">${escapeHtml((sound.codec || sound.fileName.split('.').pop()).toUpperCase())}</span>
      <span class="dim">${sound.channels || '—'}</span>
      <div class="tags">${tags || '<span class="dim">—</span>'}</div>
      <div class="row-actions"><button class="favorite ${sound.favorite ? 'on' : ''}" data-action="favorite" title="즐겨찾기">★</button><button class="more-button" data-action="inspect" title="사운드 정보 수정">⋯</button></div>
    </div>`;
  }).join('');
  requestAnimationFrame(() => {
    miniWaveObserver.disconnect();
    list.querySelectorAll('.mini-waveform').forEach((canvas) => {
      miniWaveObserver.observe(canvas);
      if (state.waveforms.has(canvas.dataset.waveformId)) drawMiniWaveform(canvas.dataset.waveformId);
    });
  });
}

function renderInspector() {
  const sound = selectedSound();
  const visible = Boolean(sound && state.inspectorOpen);
  $('#inspector').classList.toggle('hidden', !visible);
  $('.app-shell').classList.toggle('inspector-closed', !visible);
  if (!visible) return;
  $('#editTitle').value = sound.title || '';
  $('#editCategory').value = sound.category || '';
  $('#editTags').value = (sound.tags || []).join(', ');
  $('#editNotes').value = sound.notes || '';
  $('#largePlay').textContent = state.playingId === sound.id && !player.paused ? '❚❚' : '▶';
  $('#soundFacts').innerHTML = [
    ['길이', formatDuration(sound.duration)],
    ['샘플레이트', sound.sampleRate ? `${(sound.sampleRate / 1000).toFixed(1)} kHz` : '—'],
    ['채널', sound.channels || '—'],
    ['코덱', (sound.codec || '—').toUpperCase()],
    ['크기', formatSize(sound.size)]
  ].map(([key, value]) => `<div class="fact"><span>${key}</span><b>${value}</b></div>`).join('');
  const seed = [...sound.id.slice(0, 36)].map((character) => parseInt(character, 16));
  $('#waveBars').innerHTML = seed.map((number) => `<i style="height:${15 + number * 4}%"></i>`).join('');
}

function renderDetailPanel() {
  const sound = selectedSound();
  $('#auditionPanel').classList.remove('hidden');
  if (!sound) {
    $('#detailSoundName').textContent = '목록에서 사운드 이름을 선택하세요';
    $('#detailCurrentTime').textContent = '0:00.00';
    $('#detailTotalTime').textContent = '0:00.00';
    $('#detailPlayButton').textContent = '▶';
    $('#detailWaveformLoading').classList.add('hidden');
    $('#detailSelection').classList.add('hidden');
    $('#clearRangeButton').classList.add('hidden');
    $('#detailPlayhead').style.left = '0%';
    const context = detailCanvas.getContext('2d');
    context.clearRect(0, 0, detailCanvas.width, detailCanvas.height);
    return;
  }
  $('#detailSoundName').textContent = sound.title;
  $('#detailTotalTime').textContent = formatDetailedDuration(sound.duration);
  ensureWaveform(sound);
  updateDetailSelection();
  updateTransportDisplay();
  requestAnimationFrame(drawDetailWaveform);
}

function render() {
  renderSidebar();
  renderList();
  renderInspector();
  renderDetailPanel();
}

async function ensureWaveform(sound) {
  if (!sound || sound.missing || state.waveforms.has(sound.id) || state.waveformLoading.has(sound.id)) return;
  state.waveformLoading.add(sound.id);
  if (state.selectedId === sound.id) $('#detailWaveformLoading').classList.remove('hidden');
  const waveform = await window.soundLibrary.getWaveform(sound.id);
  state.waveformLoading.delete(sound.id);
  state.waveforms.set(sound.id, waveform || { left: [], right: [] });
  drawMiniWaveform(sound.id);
  if (state.selectedId === sound.id) {
    drawDetailWaveform();
    $('#detailWaveformLoading').classList.toggle('hidden', !waveform?.left?.length);
  }
}

function drawMiniWaveform(id) {
  const canvas = list.querySelector(`.mini-waveform[data-waveform-id="${id}"]`);
  const waveform = state.waveforms.get(id);
  if (!canvas || !waveform?.left?.length) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  context.clearRect(0, 0, rect.width, rect.height);
  const normalized = normalizeWaveform(waveform);
  const combined = normalized.left.map((left, index) => Math.max(left, normalized.right?.[index] || 0));
  const peaks = resamplePeaks(combined, Math.max(44, Math.floor(rect.width / 1.45)));
  const step = rect.width / peaks.length;
  context.strokeStyle = '#6ce0d5';
  context.lineWidth = Math.max(0.4, Math.min(0.75, step * 0.22));
  context.lineCap = 'round';
  const center = rect.height / 2;
  peaks.forEach((peak, index) => {
    const height = Math.max(1, peak * rect.height * 0.47);
    const x = index * step + step / 2;
    context.beginPath();
    context.moveTo(x, center - height);
    context.lineTo(x, center + height);
    context.stroke();
  });
}

function resamplePeaks(peaks, targetCount) {
  if (!peaks?.length || peaks.length <= targetCount) return peaks || [];
  const bucketSize = peaks.length / targetCount;
  const result = [];
  for (let bucket = 0; bucket < targetCount; bucket += 1) {
    const start = Math.floor(bucket * bucketSize);
    const end = Math.max(start + 1, Math.floor((bucket + 1) * bucketSize));
    let peak = 0;
    for (let index = start; index < Math.min(peaks.length, end); index += 1) peak = Math.max(peak, peaks[index]);
    result.push(peak);
  }
  return result;
}

function normalizeWaveform(waveform) {
  const left = waveform?.left || [];
  const right = waveform?.right || [];
  let maximum = 0;
  left.forEach((peak, index) => { maximum = Math.max(maximum, peak, right[index] || 0); });
  if (maximum <= 0) return { left, right };
  const gain = 1 / maximum;
  const displayFloorDb = -54;
  const shapeForDisplay = (peak) => {
    const normalized = Math.max(0, peak * gain);
    if (normalized <= 0) return 0;
    const decibels = 20 * Math.log10(normalized);
    if (decibels <= displayFloorDb) return 0;
    return Math.min(0.97, ((decibels - displayFloorDb) / -displayFloorDb) * 0.97);
  };
  return {
    left: left.map(shapeForDisplay),
    right: right.map(shapeForDisplay)
  };
}

function drawChannel(context, peaks, width, center, amplitude) {
  if (!peaks?.length) return;
  const step = width / peaks.length;
  context.strokeStyle = '#4fb7ae';
  context.lineWidth = Math.max(0.45, Math.min(0.85, step * 0.24));
  context.lineCap = 'round';
  peaks.forEach((peak, index) => {
    const height = Math.max(1, peak * amplitude);
    const x = index * step + step / 2;
    context.beginPath();
    context.moveTo(x, center - height);
    context.lineTo(x, center + height);
    context.stroke();
  });
}

function drawDetailWaveform() {
  const sound = selectedSound();
  if (!sound || !detailCanvas) return;
  const rect = detailCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  detailCanvas.width = Math.round(rect.width * ratio);
  detailCanvas.height = Math.round(rect.height * ratio);
  const context = detailCanvas.getContext('2d');
  context.scale(ratio, ratio);
  context.clearRect(0, 0, rect.width, rect.height);
  context.strokeStyle = '#292e31';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, rect.height / 2);
  context.lineTo(rect.width, rect.height / 2);
  context.stroke();
  const waveform = state.waveforms.get(sound.id);
  const hasWaveform = Boolean(waveform?.left?.length);
  $('#detailWaveformLoading').classList.toggle('hidden', hasWaveform);
  if (!hasWaveform) return;
  const normalized = normalizeWaveform(waveform);
  const targetCount = Math.max(80, Math.floor(rect.width / 2));
  const left = resamplePeaks(normalized.left, targetCount);
  const right = resamplePeaks(normalized.right, targetCount);
  if (sound.channels > 1) {
    drawChannel(context, left, rect.width, rect.height * 0.26, rect.height * 0.235);
    drawChannel(context, right, rect.width, rect.height * 0.74, rect.height * 0.235);
  } else {
    drawChannel(context, left, rect.width, rect.height * 0.5, rect.height * 0.47);
  }
}

function updateDetailSelection() {
  const sound = selectedSound();
  const selection = sound ? state.selections.get(sound.id) : null;
  detailSelection.classList.toggle('hidden', !selection);
  $('#clearRangeButton').classList.toggle('hidden', !selection);
  if (!sound || !selection) return;
  detailSelection.style.left = `${(selection.start / sound.duration) * 100}%`;
  detailSelection.style.width = `${((selection.end - selection.start) / sound.duration) * 100}%`;
  detailSelection.classList.toggle('preparing', Boolean(selection.preparing));
  detailSelection.classList.toggle('ready', Boolean(selection.path));
  detailSelection.draggable = Boolean(selection.path);
  detailSelection.dataset.clipPath = selection.path || '';
  detailSelection.querySelector('span').textContent = `${formatDetailedDuration(selection.start)} – ${formatDetailedDuration(selection.end)}${selection.preparing ? ' · 준비 중' : ''}`;
}

function waveformRatio(event) {
  const rect = detailWrap.getBoundingClientRect();
  return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
}

async function prepareSelection(sound, selection) {
  const token = `${selection.start.toFixed(6)}:${selection.end.toFixed(6)}`;
  selection.token = token;
  selection.preparing = true;
  selection.path = '';
  updateDetailSelection();
  const result = await window.soundLibrary.prepareClip({ id: sound.id, start: selection.start, end: selection.end });
  const current = state.selections.get(sound.id);
  if (!current || current.token !== token) return;
  current.preparing = false;
  if (result.ok) current.path = result.path;
  updateDetailSelection();
  showToast(result.ok ? `${result.duration.toFixed(2)}초 구간 준비 완료 · 선택 영역을 드래그하세요` : result.message, result.ok ? 2600 : 5000);
}

async function toggleFullPlayback(sound) {
  if (!sound || sound.missing) return;
  state.playRangeEnd = null;
  if (state.playingId === sound.id && !player.paused) {
    player.pause();
    return;
  }
  if (state.playingId !== sound.id) {
    player.src = fileUrl(sound.path);
    state.playingId = sound.id;
  }
  await player.play().catch(() => {});
}

async function playSelection(sound, selection, resume = false) {
  if (!sound || !selection || sound.missing) return;
  if (state.playingId !== sound.id) {
    player.src = fileUrl(sound.path);
    state.playingId = sound.id;
  }
  if (!resume || player.currentTime < selection.start || player.currentTime >= selection.end) player.currentTime = selection.start;
  state.playRangeEnd = selection.end;
  await player.play().catch(() => {});
}

async function toggleSelectedPlayback() {
  const sound = selectedSound();
  if (!sound) return;
  if (state.playingId === sound.id && !player.paused) {
    player.pause();
    return;
  }
  const selection = state.selections.get(sound.id);
  if (selection) return playSelection(sound, selection, true);
  return toggleFullPlayback(sound);
}

function updateTransportPosition() {
  const sound = selectedSound();
  if (!sound) return;
  const isCurrent = state.playingId === sound.id;
  const current = isCurrent ? player.currentTime || 0 : 0;
  $('#detailCurrentTime').textContent = formatDetailedDuration(current);
  $('#detailPlayhead').style.left = `${sound.duration ? Math.min(100, (current / sound.duration) * 100) : 0}%`;
  const playingSound = state.sounds.find((item) => item.id === state.playingId);
  const miniPosition = playingSound?.duration ? Math.min(100, ((player.currentTime || 0) / playingSound.duration) * 100) : 0;
  const previousHead = list.querySelector('.mini-playhead.active');
  const currentRow = state.playingId ? list.querySelector(`.sound-row[data-id="${state.playingId}"]`) : null;
  const currentHead = currentRow?.querySelector('.mini-playhead');
  if (previousHead && previousHead !== currentHead) previousHead.classList.remove('active');
  if (currentHead) {
    currentHead.classList.add('active');
    currentHead.style.left = `${miniPosition}%`;
  }
}

function updateTransportDisplay() {
  const sound = selectedSound();
  updateTransportPosition();
  const isCurrent = Boolean(sound && state.playingId === sound.id);
  $('#detailPlayButton').textContent = isCurrent && !player.paused ? '❚❚' : '▶';
  $('#largePlay').textContent = isCurrent && !player.paused ? '❚❚' : '▶';
  list.querySelectorAll('.sound-row').forEach((row) => {
    const playing = row.dataset.id === state.playingId && !player.paused;
    const button = row.querySelector('.play-button');
    if (button) button.textContent = playing ? '❚❚' : '▶';
  });
}

function stopTransportAnimation() {
  if (transportAnimationFrame !== null) cancelAnimationFrame(transportAnimationFrame);
  transportAnimationFrame = null;
}

function animateTransport() {
  updateTransportPosition();
  if (state.playRangeEnd !== null && player.currentTime >= state.playRangeEnd) {
    player.pause();
    state.playRangeEnd = null;
    return;
  }
  if (!player.paused) transportAnimationFrame = requestAnimationFrame(animateTransport);
}

async function updateSelected(changes) {
  const sound = selectedSound();
  if (!sound) return;
  Object.assign(sound, changes);
  renderList();
  $('#detailSoundName').textContent = sound.title;
  clearTimeout(saveDebounce);
  saveDebounce = setTimeout(async () => setLibrary(await window.soundLibrary.updateSound({ id: sound.id, ...changes })), 250);
}

list.addEventListener('click', async (event) => {
  const row = event.target.closest('.sound-row');
  if (!row) return;
  const sound = state.sounds.find((item) => item.id === row.dataset.id);
  const action = event.target.closest('[data-action]')?.dataset.action;
  state.selectedId = sound.id;
  if (action === 'play') {
    renderDetailPanel();
    return toggleSelectedPlayback();
  }
  if (action === 'favorite') {
    sound.favorite = !sound.favorite;
    setLibrary(await window.soundLibrary.updateSound({ id: sound.id, favorite: sound.favorite }));
    return;
  }
  if (action === 'inspect') {
    state.inspectorOpen = true;
    render();
    return;
  }
  state.inspectorOpen = false;
  list.querySelectorAll('.sound-row').forEach((item) => item.classList.toggle('selected', item.dataset.id === sound.id));
  renderInspector();
  renderDetailPanel();
});

list.addEventListener('dragstart', (event) => {
  const row = event.target.closest('.sound-row');
  if (!row) return event.preventDefault();
  const sound = state.sounds.find((item) => item.id === row.dataset.id);
  event.preventDefault();
  if (!sound?.missing) window.soundLibrary.startDrag(sound.path);
});

list.addEventListener('dblclick', async (event) => {
  const name = event.target.closest('.sound-name');
  const row = event.target.closest('.sound-row');
  if (!name || !row) return;
  event.preventDefault();
  const sound = state.sounds.find((item) => item.id === row.dataset.id);
  if (!sound || sound.missing) return;
  showToast('DaVinci Resolve 타임헤드에 삽입 중…', 15000);
  const result = await window.soundLibrary.insertIntoResolve({ path: sound.path, duration: sound.duration, sampleRate: sound.sampleRate });
  showToast(result.message, result.ok ? 2200 : 6000);
});

detailWrap.addEventListener('pointerdown', (event) => {
  if (event.target.closest('.detail-selection')) return;
  const sound = selectedSound();
  if (!sound?.duration) return;
  event.preventDefault();
  const ratio = waveformRatio(event);
  selectionGesture = { id: sound.id, pointerId: event.pointerId, startRatio: ratio };
  detailWrap.setPointerCapture(event.pointerId);
  state.selections.set(sound.id, { start: ratio * sound.duration, end: ratio * sound.duration, path: '', preparing: false });
  updateDetailSelection();
});

detailWrap.addEventListener('pointermove', (event) => {
  if (!selectionGesture || event.pointerId !== selectionGesture.pointerId) return;
  const sound = selectedSound();
  if (!sound || sound.id !== selectionGesture.id) return;
  const ratio = waveformRatio(event);
  const start = Math.min(selectionGesture.startRatio, ratio) * sound.duration;
  const end = Math.max(selectionGesture.startRatio, ratio) * sound.duration;
  state.selections.set(sound.id, { start, end, path: '', preparing: false });
  updateDetailSelection();
});

detailWrap.addEventListener('pointerup', (event) => {
  if (!selectionGesture || event.pointerId !== selectionGesture.pointerId) return;
  const sound = selectedSound();
  const selection = sound ? state.selections.get(sound.id) : null;
  if (detailWrap.hasPointerCapture(event.pointerId)) detailWrap.releasePointerCapture(event.pointerId);
  selectionGesture = null;
  if (!sound || !selection) return;
  if (selection.end - selection.start < 0.05) {
    state.selections.delete(sound.id);
    updateDetailSelection();
    return;
  }
  prepareSelection(sound, selection);
});

detailWrap.addEventListener('pointercancel', () => { selectionGesture = null; });
detailSelection.addEventListener('click', () => {
  const sound = selectedSound();
  if (sound) playSelection(sound, state.selections.get(sound.id));
});
detailSelection.addEventListener('dragstart', (event) => {
  event.preventDefault();
  const clipPath = detailSelection.dataset.clipPath;
  if (clipPath) window.soundLibrary.startDrag(clipPath);
});

document.addEventListener('click', (event) => {
  const filterButton = event.target.closest('[data-filter]');
  const categoryButton = event.target.closest('[data-category]');
  if (filterButton) { state.filter = filterButton.dataset.filter; render(); }
  if (categoryButton) { state.filter = `category:${categoryButton.dataset.category}`; render(); }
});

$('#searchInput').addEventListener('input', (event) => { state.query = event.target.value; renderList(); });
$('#addFolderBtn').addEventListener('click', async () => setLibrary(await window.soundLibrary.addFolder()));
$('#emptyAddBtn').addEventListener('click', async () => setLibrary(await window.soundLibrary.addFolder()));
$('#addFilesBtn').addEventListener('click', async () => setLibrary(await window.soundLibrary.addFiles()));
$('#rescanBtn').addEventListener('click', async () => setLibrary(await window.soundLibrary.rescan()));
$('#closeInspector').addEventListener('click', () => { state.inspectorOpen = false; render(); });
$('#largePlay').addEventListener('click', toggleSelectedPlayback);
$('#detailPlayButton').addEventListener('click', toggleSelectedPlayback);
$('#clearRangeButton').addEventListener('click', () => {
  const sound = selectedSound();
  if (!sound) return;
  state.selections.delete(sound.id);
  state.playRangeEnd = null;
  updateDetailSelection();
});
$('#editTitle').addEventListener('input', (event) => updateSelected({ title: event.target.value }));
$('#editCategory').addEventListener('input', (event) => updateSelected({ category: event.target.value }));
$('#editTags').addEventListener('input', (event) => updateSelected({ tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) }));
$('#editNotes').addEventListener('input', (event) => updateSelected({ notes: event.target.value }));
$('#revealBtn').addEventListener('click', () => { const sound = selectedSound(); if (sound) window.soundLibrary.reveal(sound.path); });
$('#removeBtn').addEventListener('click', async (event) => {
  const sound = selectedSound();
  if (!sound) return;
  const trashFile = event.altKey;
  const message = trashFile
    ? `“${sound.title}”의 원본 파일도 휴지통으로 이동할까요?`
    : `“${sound.title}”을 라이브러리에서만 삭제할까요? 원본 파일은 유지됩니다.\n\n원본도 휴지통으로 보내려면 Option 키를 누른 채 삭제 버튼을 클릭하세요.`;
  if (!confirm(message)) return;
  state.selectedId = null;
  state.inspectorOpen = false;
  setLibrary(await window.soundLibrary.removeSound({ id: sound.id, trashFile }));
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    $('#searchInput').focus();
  }
  if (event.code === 'Space' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    toggleSelectedPlayback();
  }
});

player.addEventListener('play', () => {
  stopTransportAnimation();
  updateTransportDisplay();
  transportAnimationFrame = requestAnimationFrame(animateTransport);
});
player.addEventListener('pause', () => {
  stopTransportAnimation();
  updateTransportDisplay();
});
player.addEventListener('ended', () => {
  stopTransportAnimation();
  state.playingId = null;
  state.playRangeEnd = null;
  updateTransportDisplay();
});
player.addEventListener('timeupdate', () => {
  if (state.playRangeEnd !== null && player.currentTime >= state.playRangeEnd) {
    player.pause();
    state.playRangeEnd = null;
  }
});
window.soundLibrary.onScanProgress(({ current, total, fileName }) => showToast(`사운드 분석 중 ${current}/${total} · ${fileName}`, 1200));
window.soundLibrary.onDragError((message) => showToast(`드래그를 시작하지 못했습니다: ${message}`, 4000));
new ResizeObserver(drawDetailWaveform).observe(detailWrap);

window.soundLibrary.getLibrary().then(setLibrary);
