const DEFAULT_SHORTCUTS = {
  search: 'Meta+S', moveCategory: 'Meta+M', editTags: 'Meta+T', addFiles: 'Meta+O',
  addFolder: 'Meta+Shift+O', trash: 'Meta+Backspace', reveal: 'Meta+Shift+R',
  favorite: 'Meta+Shift+F', settings: 'Meta+Comma', playPause: 'Space'
};
const SHORTCUT_LABELS = {
  search: ['사운드 검색', '검색창으로 이동'],
  moveCategory: ['카테고리 폴더로 이동', '선택 파일을 실제 카테고리 폴더로 이동'],
  editTags: ['태그 편집', '선택 사운드의 태그 입력'],
  addFiles: ['파일 추가', '오디오 파일 선택'],
  addFolder: ['폴더 추가', '오디오 폴더 등록'],
  trash: ['원본 파일 삭제', '선택 파일을 macOS 휴지통으로 이동'],
  reveal: ['Finder에서 보기', '선택 파일 위치 열기'],
  favorite: ['즐겨찾기 전환', '선택 사운드 별표 켜기/끄기'],
  settings: ['단축키 설정', '이 설정 화면 열기'],
  playPause: ['재생/일시정지', '선택 사운드 미리 듣기']
};

const state = {
  sounds: [],
  categories: [],
  categoryPaths: [],
  watchedFolders: [],
  filter: 'all',
  query: '',
  selectedId: null,
  selectedIds: new Set(),
  selectionAnchorId: null,
  inspectorOpen: false,
  playingId: null,
  playRangeEnd: null,
  waveforms: new Map(),
  waveformLoading: new Set(),
  selections: new Map(),
  shortcuts: { ...DEFAULT_SHORTCUTS },
  view: 'library',
  previewVolume: 0.8,
  collapsedCategories: new Set(),
  sortBy: 'title',
  sortDirection: 1,
  minimumRating: 0,
  fileFilter: 'all',
  performance: null,
  visibleSounds: []
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
let volumeSaveDebounce;
let lastAudibleVolume = 0.8;
const VIRTUAL_ROW_HEIGHT = 64;
const VIRTUAL_BUFFER = 8;
let virtualRenderFrame;
let searchDebounce;
let duplicateGroups = [];
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
    if (state.filter.startsWith('category:')) {
      const selectedPath = state.filter.slice(9);
      const soundPath = sound.categoryPath || sound.category || '미분류';
      if (soundPath !== selectedPath && !soundPath.startsWith(`${selectedPath}/`)) return false;
    }
    if (state.filter.startsWith('tag:') && !(sound.tags || []).includes(state.filter.slice(4))) return false;
    if (Number(sound.rating || 0) < state.minimumRating) return false;
    if (state.fileFilter === 'missing' && !sound.missing) return false;
    if (state.fileFilter === 'available' && sound.missing) return false;
    if (!query) return true;
    const haystack = [sound.title, sound.fileName, sound.category, sound.categoryPath, sound.notes,
      ...(sound.embeddedTags || []), ...Object.values(sound.embeddedMetadata || {})]
      .join(' ').toLocaleLowerCase('ko');
    const tags = (sound.tags || []).map((tag) => tag.toLocaleLowerCase('ko'));
    return query.split(/\s+/).every((word) => {
      if (!word.startsWith('#')) return haystack.includes(word);
      const tagQuery = word.slice(1);
      return tagQuery ? tags.some((tag) => tag.includes(tagQuery)) : tags.length > 0;
    });
  }).sort((a, b) => {
    let comparison = 0;
    if (state.sortBy === 'title') comparison = a.title.localeCompare(b.title, 'ko', { numeric: true });
    else comparison = Number(a[state.sortBy] || 0) - Number(b[state.sortBy] || 0);
    return comparison * state.sortDirection;
  });
}

function setLibrary(snapshot) {
  if (!snapshot) return;
  state.sounds = snapshot.sounds || [];
  state.categories = snapshot.categories || [];
  state.categoryPaths = snapshot.categoryPaths || snapshot.categories || [];
  state.watchedFolders = snapshot.watchedFolders || [];
  state.shortcuts = { ...DEFAULT_SHORTCUTS, ...(snapshot.shortcuts || {}) };
  state.previewVolume = Number.isFinite(Number(snapshot.previewVolume)) ? Number(snapshot.previewVolume) : 0.8;
  state.performance = snapshot.performance || state.performance;
  player.volume = state.previewVolume;
  if (state.previewVolume > 0) lastAudibleVolume = state.previewVolume;
  if (snapshot.moved?.oldId && state.selectedId === snapshot.moved.oldId) state.selectedId = snapshot.moved.id;
  if (snapshot.idChanges?.[state.selectedId]) state.selectedId = snapshot.idChanges[state.selectedId];
  if (snapshot.idChanges) state.selectedIds = new Set([...state.selectedIds].map((id) => snapshot.idChanges[id] || id));
  const validIds = new Set(state.sounds.map((sound) => sound.id));
  state.selectedIds = new Set([...state.selectedIds].filter((id) => validIds.has(id)));
  if (snapshot.categoryMove && state.filter.startsWith('category:')) {
    const current = state.filter.slice(9);
    if (current === snapshot.categoryMove.from || current.startsWith(`${snapshot.categoryMove.from}/`)) {
      state.filter = `category:${snapshot.categoryMove.to}${current.slice(snapshot.categoryMove.from.length)}`;
    }
  }
  render();
}

function updateVolumeControl() {
  const percent = Math.round(state.previewVolume * 100);
  $('#volumeSlider').value = String(percent);
  $('#volumeValue').textContent = `${percent}%`;
  $('#muteButton').textContent = percent === 0 ? '🔇' : percent < 50 ? '🔉' : '🔊';
  $('#muteButton').setAttribute('aria-label', percent === 0 ? '음소거 해제' : '음소거');
}

function allTags() {
  return [...new Set(state.sounds.flatMap((sound) => sound.tags || []).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
}

function displayShortcut(value) {
  return String(value || '')
    .replace('Meta', '⌘').replace('Control', '⌃').replace('Alt', '⌥').replace('Shift', '⇧')
    .replace('Backspace', '⌫').replace('Comma', ',').replace('Space', 'Space').replaceAll('+', '');
}

function buildCategoryTree(paths) {
  const root = { children: new Map() };
  paths.forEach((categoryPath) => {
    let parent = root;
    let currentPath = '';
    String(categoryPath).split('/').filter(Boolean).forEach((name) => {
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      if (!parent.children.has(name)) parent.children.set(name, { name, path: currentPath, children: new Map() });
      parent = parent.children.get(name);
    });
  });
  return root;
}

function renderCategoryNodes(nodes, depth = 0) {
  return [...nodes.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }))
    .map((node) => {
      const hasChildren = node.children.size > 0;
      const collapsed = state.collapsedCategories.has(node.path);
      const active = state.filter === `category:${node.path}` ? 'active' : '';
      const count = state.sounds.filter((sound) => {
        const soundPath = sound.categoryPath || sound.category || '미분류';
        return soundPath === node.path || soundPath.startsWith(`${node.path}/`);
      }).length;
      const children = hasChildren && !collapsed ? renderCategoryNodes(node.children, depth + 1) : '';
      return `<div class="category-tree-node">
        <div class="category-tree-row ${active}" data-category-row="${escapeHtml(node.path)}" draggable="${node.path !== '미분류'}">
          <button class="tree-toggle ${hasChildren ? '' : 'empty'}" data-category-toggle="${escapeHtml(node.path)}" ${hasChildren ? `aria-expanded="${!collapsed}" title="하위 폴더 ${collapsed ? '펼치기' : '접기'}"` : 'disabled'}>${hasChildren ? (collapsed ? '▶' : '▼') : ''}</button>
          <button class="tree-label" data-category="${escapeHtml(node.path)}" title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</button>
          <b>${count}</b>
        </div>${children ? `<div class="category-tree-children">${children}</div>` : ''}
      </div>`;
    }).join('');
}

function renderSidebar() {
  $('#allCount').textContent = state.sounds.length;
  $('#favoriteCount').textContent = state.sounds.filter((sound) => sound.favorite).length;
  $('#categoryList').innerHTML = renderCategoryNodes(buildCategoryTree(state.categoryPaths).children)
    || '<div class="dim category-list-empty">카테고리 없음</div>';
  $('#tagList').innerHTML = allTags().map((tag) => {
    const count = state.sounds.filter((sound) => (sound.tags || []).includes(tag)).length;
    const active = state.filter === `tag:${tag}` ? 'active' : '';
    return `<button class="nav-item ${active}" data-tag="${escapeHtml(tag)}"><span>#</span>${escapeHtml(tag)}<b>${count}</b></button>`;
  }).join('') || '<div class="dim category-list-empty">태그 없음</div>';
  document.querySelectorAll('.nav-item[data-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === state.filter);
  });
  $('#categoryOptions').innerHTML = state.categoryPaths.map((category) => `<option value="${escapeHtml(category)}"></option>`).join('');
  $('#searchShortcutHint').textContent = displayShortcut(state.shortcuts.search);
}

function ratingMarkup(sound, context = 'row') {
  return Array.from({ length: 5 }, (_, index) => {
    const value = index + 1;
    return `<button class="rating-star ${Number(sound.rating || 0) >= value ? 'on' : ''}" data-action="rating" data-rating="${value}" title="${value}점">★</button>`;
  }).join('');
}

function updateBatchToolbar() {
  $('#batchToolbar').classList.toggle('hidden', state.selectedIds.size < 2);
  $('#selectionCount').textContent = `${state.selectedIds.size}개 선택`;
}

function renderVirtualRows() {
  const renderStarted = performance.now();
  const sounds = state.visibleSounds;
  if (!sounds.length) {
    list.innerHTML = '';
    return;
  }
  const viewportHeight = Math.max(list.clientHeight, VIRTUAL_ROW_HEIGHT * 8);
  const start = Math.max(0, Math.floor(list.scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_BUFFER);
  const end = Math.min(sounds.length, Math.ceil((list.scrollTop + viewportHeight) / VIRTUAL_ROW_HEIGHT) + VIRTUAL_BUFFER);
  const visible = sounds.slice(start, end);
  const rows = visible.map((sound) => {
    const tags = (sound.tags || []).slice(0, 3).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
    const isPlaying = state.playingId === sound.id && !player.paused;
    return `<div class="sound-row ${state.selectedIds.has(sound.id) ? 'selected' : ''}" data-id="${sound.id}" draggable="true">
      <button class="play-button" data-action="play" title="미리 듣기">${isPlaying ? '❚❚' : '▶'}</button>
      <div class="sound-name"><strong>${escapeHtml(sound.title)}</strong><small>${escapeHtml(sound.fileName)}${sound.missing ? ' · 파일 없음' : ''}</small></div>
      <div class="mini-waveform-wrap"><canvas class="mini-waveform" data-waveform-id="${sound.id}"></canvas><div class="mini-playhead"></div></div>
      <span class="category-pill" title="${escapeHtml(sound.categoryPath || sound.category || '미분류')}">${escapeHtml(sound.category || '미분류')}</span>
      <span class="dim">${formatDuration(sound.duration)}</span><span class="dim">${escapeHtml((sound.codec || sound.fileName.split('.').pop()).toUpperCase())}</span><span class="dim">${sound.channels || '—'}</span>
      <div class="rating-stars">${ratingMarkup(sound)}</div><div class="tags">${tags || '<span class="dim">—</span>'}</div>
      <div class="row-actions"><button class="favorite ${sound.favorite ? 'on' : ''}" data-action="favorite" title="즐겨찾기">★</button><button class="more-button" data-action="inspect" title="사운드 정보 수정">⋯</button></div>
    </div>`;
  }).join('');
  list.innerHTML = `<div class="virtual-spacer"><div class="virtual-window">${rows}</div></div>`;
  list.querySelector('.virtual-spacer').style.height = `${sounds.length * VIRTUAL_ROW_HEIGHT}px`;
  list.querySelector('.virtual-window').style.transform = `translateY(${start * VIRTUAL_ROW_HEIGHT}px)`;
  if (state.performance) state.performance.virtualRenderMs = Number((performance.now() - renderStarted).toFixed(2));
  requestAnimationFrame(() => {
    miniWaveObserver.disconnect();
    list.querySelectorAll('.mini-waveform').forEach((canvas) => {
      miniWaveObserver.observe(canvas);
      if (state.waveforms.has(canvas.dataset.waveformId)) drawMiniWaveform(canvas.dataset.waveformId);
    });
    updateTransportPosition();
  });
}

function renderList() {
  const sounds = filteredSounds();
  state.visibleSounds = sounds;
  const filterName = state.filter === 'all' ? '모든 사운드'
    : state.filter === 'favorites' ? '즐겨찾기'
      : state.filter.startsWith('tag:') ? `#${state.filter.slice(4)}` : state.filter.slice(9);
  $('#viewTitle').textContent = filterName;
  $('#resultSummary').textContent = `${sounds.length.toLocaleString()}개의 사운드`;
  $('#emptyState').classList.toggle('hidden', state.sounds.length > 0);
  list.classList.toggle('hidden', state.sounds.length === 0);

  updateBatchToolbar();
  renderVirtualRows();
}

function renderInspector() {
  const sound = selectedSound();
  const visible = Boolean(sound && state.inspectorOpen);
  $('#inspector').classList.toggle('hidden', !visible);
  $('.app-shell').classList.toggle('inspector-closed', !visible);
  if (!visible) return;
  $('#editTitle').value = sound.title || '';
  $('#editCategory').value = sound.categoryPath || sound.category || '';
  $('#editTags').value = (sound.tags || []).join(', ');
  $('#editNotes').value = sound.notes || '';
  $('#inspectorRating').innerHTML = ratingMarkup(sound, 'inspector');
  $('#largePlay').textContent = state.playingId === sound.id && !player.paused ? '❚❚' : '▶';
  $('#soundFacts').innerHTML = [
    ['길이', formatDuration(sound.duration)],
    ['샘플레이트', sound.sampleRate ? `${(sound.sampleRate / 1000).toFixed(1)} kHz` : '—'],
    ['채널', sound.channels || '—'],
    ['코덱', (sound.codec || '—').toUpperCase()],
    ['크기', formatSize(sound.size)],
    ['내장 설명', sound.embeddedMetadata?.description || sound.embeddedMetadata?.comment || '—'],
    ['내장 키워드', (sound.embeddedTags || []).join(', ') || '—']
  ].map(([key, value]) => `<div class="fact"><span>${key}</span><b>${value}</b></div>`).join('');
  const seed = [...sound.id.slice(0, 36)].map((character) => parseInt(character, 16));
  $('#waveBars').innerHTML = seed.map(() => '<i></i>').join('');
  [...$('#waveBars').children].forEach((bar, index) => { bar.style.height = `${15 + seed[index] * 4}%`; });
}

function renderDetailPanel() {
  const sound = selectedSound();
  $('#auditionPanel').classList.remove('hidden');
  updateVolumeControl();
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

function renderSettings() {
  const open = state.view === 'settings';
  document.querySelectorAll('.library-only').forEach((element) => element.classList.toggle('hidden', open));
  $('#settingsPanel').classList.toggle('hidden', !open);
  $('#settingsBtn').classList.toggle('active', open);
  if (!open) return;
  $('#shortcutList').innerHTML = Object.entries(SHORTCUT_LABELS).map(([action, [title, description]]) => `
    <div class="shortcut-row">
      <div><strong>${title}</strong><small>${description}</small></div>
      <button class="shortcut-capture" data-shortcut-action="${action}">${displayShortcut(state.shortcuts[action])}</button>
    </div>`).join('');
  const stats = state.performance;
  if (stats) $('#performanceInfo').textContent = `저장 방식: ${stats.storage} · ${Number(stats.soundCount).toLocaleString()}개 · ${formatSize(stats.fileSize)} · 시작 로드 ${stats.loadMs}ms · 가상 목록 ${stats.virtualRenderMs || '—'}ms · ${stats.sqliteRecommended ? 'SQLite 전환 권장 규모' : '현재는 JSON이 더 가볍고 충분히 빠름'}`;
}

function render() {
  renderSidebar();
  renderList();
  renderInspector();
  renderDetailPanel();
  renderSettings();
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
  const combined = normalized.left.map((left, index) => Math.max(left, normalized.right?.[index] || 0));
  const mono = resamplePeaks(combined, targetCount);
  drawChannel(context, mono, rect.width, rect.height * 0.5, rect.height * 0.47);
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

function openInputDialog({ title, description, value = '', placeholder = '', options = [] }) {
  return new Promise((resolve) => {
    const backdrop = $('#inputDialog');
    const field = $('#inputDialogField');
    $('#inputDialogTitle').textContent = title;
    $('#inputDialogDescription').textContent = description;
    field.value = value;
    field.placeholder = placeholder;
    $('#inputDialogOptions').innerHTML = options.map((option) => `<option value="${escapeHtml(option)}"></option>`).join('');
    field.setAttribute('list', options.length ? 'inputDialogOptions' : '');
    backdrop.classList.remove('hidden');
    requestAnimationFrame(() => { field.focus(); field.select(); });
    const finish = (result) => {
      backdrop.classList.add('hidden');
      $('#inputDialogForm').removeEventListener('submit', submit);
      $('#inputDialogCancel').removeEventListener('click', cancel);
      backdrop.removeEventListener('click', outside);
      resolve(result);
    };
    const submit = (event) => { event.preventDefault(); finish(field.value.trim()); };
    const cancel = () => finish(null);
    const outside = (event) => { if (event.target === backdrop) finish(null); };
    $('#inputDialogForm').addEventListener('submit', submit);
    $('#inputDialogCancel').addEventListener('click', cancel);
    backdrop.addEventListener('click', outside);
  });
}

async function moveSelectedToCategory() {
  const sound = selectedSound();
  if (!sound) return showToast('먼저 이동할 사운드를 선택해 주세요.');
  const category = await openInputDialog({
    title: '카테고리 폴더로 이동',
    description: `“${sound.title}” 파일을 이동할 카테고리를 입력하세요.`,
    value: sound.categoryPath || sound.category || '', placeholder: '예: Trains/Horn', options: state.categoryPaths
  });
  if (!category) return;
  showToast(`${category} 폴더로 파일 이동 중…`, 10000);
  try {
    const snapshot = await window.soundLibrary.moveSoundToCategory({ id: sound.id, category });
    if (!snapshot) return;
    setLibrary(snapshot);
    showToast(`파일을 “${category}” 카테고리 폴더로 이동했습니다.`);
  } catch (error) {
    showToast(`이동 실패: ${error.message}`, 5000);
  }
}

async function editSelectedTags() {
  const sound = selectedSound();
  if (!sound) return showToast('먼저 태그를 편집할 사운드를 선택해 주세요.');
  const value = await openInputDialog({
    title: '태그 편집', description: '쉼표로 여러 태그를 구분하세요.',
    value: (sound.tags || []).join(', '), placeholder: '예: 알림, 트위치, 밝음', options: allTags()
  });
  if (value === null) return;
  const tags = [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))];
  setLibrary(await window.soundLibrary.updateSound({ id: sound.id, tags }));
  showToast('태그를 저장했습니다.');
}

function selectedIdList() {
  if (state.selectedIds.size) return [...state.selectedIds];
  return state.selectedId ? [state.selectedId] : [];
}

async function addTagsToSelection() {
  const ids = selectedIdList();
  if (!ids.length) return showToast('먼저 사운드를 선택해 주세요.');
  const value = await openInputDialog({ title: '선택 항목에 태그 추가', description: `${ids.length}개 사운드에 추가할 태그를 입력하세요.`, placeholder: '예: 긴장, 전환', options: allTags() });
  if (value === null) return;
  const addTags = [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))];
  setLibrary(await window.soundLibrary.updateSoundsBatch({ ids, addTags }));
  showToast(`${ids.length}개 사운드에 태그를 추가했습니다.`);
}

async function moveSelectionToCategory() {
  const ids = selectedIdList();
  if (!ids.length) return showToast('먼저 사운드를 선택해 주세요.');
  const category = await openInputDialog({ title: '선택 항목 카테고리 이동', description: `${ids.length}개 원본 파일을 실제 카테고리 폴더로 이동합니다.`, placeholder: '예: 예능 효과음/황당', options: state.categoryPaths });
  if (!category) return;
  showToast(`${ids.length}개 파일 이동 중…`, 20000);
  setLibrary(await window.soundLibrary.moveSoundsToCategory({ ids, category }));
  showToast(`${ids.length}개 파일을 이동했습니다.`);
}

async function trashSelection() {
  const ids = selectedIdList();
  if (!ids.length || !confirm(`선택한 ${ids.length}개 원본 파일을 휴지통으로 이동할까요?`)) return;
  setLibrary(await window.soundLibrary.removeSoundsBatch({ ids, trashFiles: true }));
  state.selectedIds.clear();
  state.selectedId = null;
  render();
  showToast(`${ids.length}개 파일을 휴지통으로 이동했습니다.`);
}

async function moveSelectedToFolder() {
  const sound = selectedSound();
  if (!sound) return showToast('먼저 이동할 사운드를 선택해 주세요.');
  try {
    const snapshot = await window.soundLibrary.moveSoundToFolder(sound.id);
    if (!snapshot) return;
    setLibrary(snapshot);
    showToast('파일을 선택한 폴더로 이동했습니다.');
  } catch (error) {
    showToast(`이동 실패: ${error.message}`, 5000);
  }
}

async function createSubfolder(category) {
  const name = await openInputDialog({
    title: '새 하위 폴더', description: `“${category}” 안에 만들 폴더 이름을 입력하세요.`, placeholder: '새 폴더'
  });
  if (!name) return;
  try {
    setLibrary(await window.soundLibrary.createCategoryFolder({ parentCategory: category, name }));
    state.collapsedCategories.delete(category);
    renderSidebar();
    showToast('새 폴더를 만들었습니다.');
  } catch (error) {
    showToast(`폴더 생성 실패: ${error.message}`, 5000);
  }
}

async function renameCategory(category) {
  const oldName = category.split('/').pop();
  const name = await openInputDialog({
    title: '폴더 이름 변경', description: `“${category}” 폴더의 새 이름을 입력하세요.`, value: oldName
  });
  if (!name || name === oldName) return;
  try {
    setLibrary(await window.soundLibrary.renameCategoryFolder({ category, name }));
    showToast('폴더 이름을 변경했습니다.');
  } catch (error) {
    showToast(`이름 변경 실패: ${error.message}`, 5000);
  }
}

async function trashCategory(category) {
  if (!confirm(`“${category}” 폴더와 안의 모든 파일을 macOS 휴지통으로 이동할까요?`)) return;
  try {
    if (state.filter === `category:${category}` || state.filter.startsWith(`category:${category}/`)) state.filter = 'all';
    setLibrary(await window.soundLibrary.trashCategoryFolder(category));
    showToast('폴더를 휴지통으로 이동했습니다.');
  } catch (error) {
    showToast(`폴더 삭제 실패: ${error.message}`, 5000);
  }
}

async function addFilesToCategory(category) {
  try {
    const snapshot = await window.soundLibrary.addFilesToCategory(category);
    if (snapshot) {
      setLibrary(snapshot);
      showToast('파일을 폴더에 복사해 추가했습니다.');
    }
  } catch (error) {
    showToast(`파일 추가 실패: ${error.message}`, 5000);
  }
}

let contextTarget = null;
function hideContextMenu() {
  $('#contextMenu').classList.add('hidden');
  contextTarget = null;
}

function showContextMenu(event, target) {
  event.preventDefault();
  contextTarget = target;
  const menu = $('#contextMenu');
  if (target.type === 'category') {
    const protectedRoot = target.category === '미분류';
    const hasChildren = state.categoryPaths.some((category) => category.startsWith(`${target.category}/`));
    const collapsed = state.collapsedCategories.has(target.category);
    menu.innerHTML = `
      ${hasChildren ? `<button data-context-action="toggle-category">하위 폴더 ${collapsed ? '펼치기' : '접기'}</button><div class="separator"></div>` : ''}
      <button data-context-action="new-folder">새 하위 폴더</button>
      <button data-context-action="add-files">이 폴더에 파일 추가…</button>
      <button data-context-action="reveal-category">Finder에서 보기</button>
      ${protectedRoot ? '' : '<div class="separator"></div><button data-context-action="rename-category">이름 변경…</button><button class="danger" data-context-action="trash-category">폴더를 휴지통으로</button>'}`;
  } else {
    const targetSound = state.sounds.find((sound) => sound.id === target.id);
    menu.innerHTML = `
      ${targetSound?.missing ? '<button data-context-action="relink-sound">누락 파일 재연결…</button><div class="separator"></div>' : ''}
      <button data-context-action="move-category">카테고리 폴더로 이동…</button>
      <button data-context-action="move-folder">다른 폴더로 이동…</button>
      <button data-context-action="reveal-sound">Finder에서 보기</button>
      <div class="separator"></div><button class="danger" data-context-action="trash-sound">원본 파일을 휴지통으로</button>`;
  }
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - rect.height - 8)}px`;
}

async function trashSelected() {
  const sound = selectedSound();
  if (!sound) return showToast('먼저 삭제할 사운드를 선택해 주세요.');
  if (!confirm(`“${sound.title}” 원본 파일을 macOS 휴지통으로 이동할까요?\n이 항목은 라이브러리에서도 삭제됩니다.`)) return;
  if (state.playingId === sound.id) player.pause();
  state.selectedId = null;
  state.selectedIds.delete(sound.id);
  state.inspectorOpen = false;
  setLibrary(await window.soundLibrary.removeSound({ id: sound.id, trashFile: true }));
  showToast('원본 파일을 휴지통으로 이동했습니다.');
}

async function toggleFavoriteSelected() {
  const sound = selectedSound();
  if (!sound) return showToast('먼저 사운드를 선택해 주세요.');
  setLibrary(await window.soundLibrary.updateSound({ id: sound.id, favorite: !sound.favorite }));
}

function openSettings() {
  state.view = 'settings';
  state.inspectorOpen = false;
  render();
}

async function runShortcut(action) {
  if (action === 'search') {
    state.view = 'library'; render(); $('#searchInput').focus(); $('#searchInput').select();
  } else if (action === 'moveCategory') await moveSelectedToCategory();
  else if (action === 'editTags') await editSelectedTags();
  else if (action === 'addFiles') setLibrary(await window.soundLibrary.addFiles());
  else if (action === 'addFolder') setLibrary(await window.soundLibrary.addFolder());
  else if (action === 'trash') await trashSelected();
  else if (action === 'reveal') { const sound = selectedSound(); if (sound) window.soundLibrary.reveal(sound.path); }
  else if (action === 'favorite') await toggleFavoriteSelected();
  else if (action === 'settings') openSettings();
  else if (action === 'playPause') toggleSelectedPlayback();
}

function actionForShortcut(shortcut) {
  return Object.keys(state.shortcuts).find((action) => state.shortcuts[action] === shortcut);
}

function shortcutFromKeyboardEvent(event) {
  const parts = [];
  if (event.metaKey) parts.push('Meta');
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  let key = event.key;
  if (key === ',') key = 'Comma';
  if (key === ' ') key = 'Space';
  if (key === 'Delete') key = 'Backspace';
  if (key.length === 1) key = key.toUpperCase();
  if (!['Meta', 'Control', 'Alt', 'Shift'].includes(key)) parts.push(key);
  return parts.join('+');
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
  if (action === 'rating') {
    const rating = Number(event.target.closest('[data-rating]')?.dataset.rating || 0);
    const nextRating = Number(sound.rating || 0) === rating ? 0 : rating;
    setLibrary(await window.soundLibrary.updateSound({ id: sound.id, rating: nextRating }));
    return;
  }
  if (action === 'inspect') {
    state.inspectorOpen = true;
    render();
    return;
  }
  if (event.shiftKey && state.selectionAnchorId) {
    const start = state.visibleSounds.findIndex((item) => item.id === state.selectionAnchorId);
    const end = state.visibleSounds.findIndex((item) => item.id === sound.id);
    if (start >= 0 && end >= 0) {
      if (!event.metaKey) state.selectedIds.clear();
      for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) state.selectedIds.add(state.visibleSounds[index].id);
    }
  } else if (event.metaKey || event.ctrlKey) {
    if (state.selectedIds.has(sound.id)) state.selectedIds.delete(sound.id);
    else state.selectedIds.add(sound.id);
    state.selectionAnchorId = sound.id;
  } else {
    state.selectedIds = new Set([sound.id]);
    state.selectionAnchorId = sound.id;
  }
  state.inspectorOpen = false;
  renderVirtualRows();
  updateBatchToolbar();
  renderInspector();
  renderDetailPanel();
});

list.addEventListener('scroll', () => {
  cancelAnimationFrame(virtualRenderFrame);
  virtualRenderFrame = requestAnimationFrame(renderVirtualRows);
});

list.addEventListener('dragstart', (event) => {
  const row = event.target.closest('.sound-row');
  if (!row) return event.preventDefault();
  const sound = state.sounds.find((item) => item.id === row.dataset.id);
  event.preventDefault();
  if (!sound?.missing) window.soundLibrary.startDrag(sound.path);
});

$('#categoryList').addEventListener('dragstart', (event) => {
  const row = event.target.closest('[data-category-row]');
  if (!row || row.dataset.categoryRow === '미분류') return event.preventDefault();
  event.preventDefault();
  window.soundLibrary.startCategoryDrag(row.dataset.categoryRow);
});

document.addEventListener('contextmenu', (event) => {
  const categoryRow = event.target.closest('[data-category-row]');
  if (categoryRow) return showContextMenu(event, { type: 'category', category: categoryRow.dataset.categoryRow });
  if (event.target.closest('#categoryList')) return showContextMenu(event, { type: 'category', category: '미분류' });
  const soundRow = event.target.closest('.sound-row');
  if (soundRow) {
    state.selectedId = soundRow.dataset.id;
    state.inspectorOpen = false;
    renderDetailPanel();
    return showContextMenu(event, { type: 'sound', id: soundRow.dataset.id });
  }
  hideContextMenu();
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

function toggleCategoryCollapse(categoryPath) {
  const hasChildren = state.categoryPaths.some((category) => category.startsWith(`${categoryPath}/`));
  if (!hasChildren) return;
  if (state.collapsedCategories.has(categoryPath)) state.collapsedCategories.delete(categoryPath);
  else state.collapsedCategories.add(categoryPath);
  renderSidebar();
}

document.addEventListener('click', (event) => {
  const filterButton = event.target.closest('[data-filter]');
  const categoryButton = event.target.closest('[data-category]');
  const categoryToggle = event.target.closest('[data-category-toggle]');
  const tagButton = event.target.closest('[data-tag]');
  if (filterButton) { state.view = 'library'; state.filter = filterButton.dataset.filter; render(); }
  if (categoryToggle) {
    toggleCategoryCollapse(categoryToggle.dataset.categoryToggle);
  }
  if (categoryButton) { state.view = 'library'; state.filter = `category:${categoryButton.dataset.category}`; render(); }
  if (tagButton) { state.view = 'library'; state.filter = `tag:${tagButton.dataset.tag}`; render(); }
  if (!event.target.closest('#contextMenu')) hideContextMenu();
});

$('#categoryList').addEventListener('dblclick', (event) => {
  const label = event.target.closest('[data-category]');
  if (!label) return;
  event.preventDefault();
  toggleCategoryCollapse(label.dataset.category);
});

$('#contextMenu').addEventListener('click', async (event) => {
  const action = event.target.closest('[data-context-action]')?.dataset.contextAction;
  if (!action || !contextTarget) return;
  const target = contextTarget;
  hideContextMenu();
  if (target.type === 'category') {
    if (action === 'toggle-category') return toggleCategoryCollapse(target.category);
    if (action === 'new-folder') return createSubfolder(target.category);
    if (action === 'add-files') return addFilesToCategory(target.category);
    if (action === 'rename-category') return renameCategory(target.category);
    if (action === 'trash-category') return trashCategory(target.category);
    if (action === 'reveal-category') {
      try { await window.soundLibrary.revealCategoryFolder(target.category); } catch (error) { showToast(error.message, 4000); }
    }
    return;
  }
  state.selectedId = target.id;
  state.selectedIds = new Set([target.id]);
  if (action === 'relink-sound') {
    const snapshot = await window.soundLibrary.relinkOne(target.id);
    if (snapshot) { setLibrary(snapshot); showToast('원본 파일을 재연결했습니다.'); }
    return;
  }
  if (action === 'move-category') return moveSelectedToCategory();
  if (action === 'move-folder') return moveSelectedToFolder();
  if (action === 'trash-sound') return trashSelected();
  if (action === 'reveal-sound') {
    const sound = selectedSound();
    if (sound) window.soundLibrary.reveal(sound.path);
  }
});

$('#searchInput').addEventListener('input', (event) => {
  clearTimeout(searchDebounce);
  const value = event.target.value;
  searchDebounce = setTimeout(() => { state.query = value; list.scrollTop = 0; renderList(); }, 130);
});
$('#sortSelect').addEventListener('change', (event) => { state.sortBy = event.target.value; list.scrollTop = 0; renderList(); });
$('#sortDirectionBtn').addEventListener('click', (event) => { state.sortDirection *= -1; event.currentTarget.textContent = state.sortDirection > 0 ? '↑' : '↓'; renderList(); });
$('#ratingFilter').addEventListener('change', (event) => { state.minimumRating = Number(event.target.value || 0); list.scrollTop = 0; renderList(); });
$('#fileFilter').addEventListener('change', (event) => { state.fileFilter = event.target.value; list.scrollTop = 0; renderList(); });
$('#batchTagsBtn').addEventListener('click', addTagsToSelection);
$('#batchMoveBtn').addEventListener('click', moveSelectionToCategory);
$('#batchFavoriteBtn').addEventListener('click', async () => setLibrary(await window.soundLibrary.updateSoundsBatch({ ids: selectedIdList(), updates: { favorite: true } })));
$('#batchTrashBtn').addEventListener('click', trashSelection);
$('#clearSelectionBtn').addEventListener('click', () => { state.selectedIds.clear(); state.selectedId = null; render(); });
$('#addFolderBtn').addEventListener('click', async () => setLibrary(await window.soundLibrary.addFolder()));
$('#emptyAddBtn').addEventListener('click', async () => setLibrary(await window.soundLibrary.addFolder()));
$('#addFilesBtn').addEventListener('click', async () => setLibrary(await window.soundLibrary.addFiles()));
$('#rescanBtn').addEventListener('click', async () => setLibrary(await window.soundLibrary.rescan()));
$('#settingsBtn').addEventListener('click', openSettings);
$('#exportBackupBtn').addEventListener('click', async () => {
  const result = await window.soundLibrary.exportBackup();
  if (result?.ok) showToast(`백업을 저장했습니다: ${result.path}`, 5000);
});
$('#importBackupBtn').addEventListener('click', async () => {
  if (!confirm('현재 라이브러리 정보는 자동 백업한 뒤 선택한 백업으로 교체됩니다. 계속할까요?')) return;
  const snapshot = await window.soundLibrary.importBackup();
  if (snapshot) { state.selectedIds.clear(); state.selectedId = null; setLibrary(snapshot); showToast('백업을 복원했습니다.'); }
});
$('#collectMetadataBtn').addEventListener('click', async () => {
  showToast('내장 메타데이터를 수집하는 중…', 60000);
  const snapshot = await window.soundLibrary.collectMetadata();
  setLibrary(snapshot);
  showToast(`${snapshot.metadataResult?.updated || 0}개 파일의 메타데이터를 수집했습니다.`);
});
$('#relinkMissingBtn').addEventListener('click', async () => {
  showToast('누락 파일을 찾는 중…', 30000);
  const snapshot = await window.soundLibrary.relinkMissing();
  setLibrary(snapshot);
  const result = snapshot.relinkResult;
  showToast(`누락 ${result.missing}개 중 ${result.relinked}개 재연결 · ${result.unresolved}개 미해결`, 6000);
});
$('#findDuplicatesBtn').addEventListener('click', async () => {
  showToast('같은 크기의 파일을 해시로 검사하는 중…', 60000);
  const result = await window.soundLibrary.findDuplicates();
  duplicateGroups = result.groups || [];
  $('#resultsContent').innerHTML = duplicateGroups.length ? duplicateGroups.map((group, groupIndex) => `
    <div class="duplicate-group"><strong>동일 콘텐츠 ${group.length}개 · ${formatSize(group[0].size)}</strong>${group.map((sound, index) => `
      <div class="duplicate-file"><div><b>${escapeHtml(sound.title)}</b><br><small>${escapeHtml(sound.path)}</small></div>${index ? `<button data-duplicate-trash="${sound.id}" data-group="${groupIndex}">휴지통</button>` : '<span class="dim">유지</span>'}</div>`).join('')}</div>`).join('') : '<p>콘텐츠가 완전히 같은 중복 파일이 없습니다.</p>';
  $('#resultsDialog').classList.remove('hidden');
  showToast(`${result.checked}개 후보 검사 · 중복 그룹 ${duplicateGroups.length}개`);
});
$('#closeResultsBtn').addEventListener('click', () => $('#resultsDialog').classList.add('hidden'));
$('#resultsDialog').addEventListener('click', async (event) => {
  if (event.target === $('#resultsDialog')) $('#resultsDialog').classList.add('hidden');
  const button = event.target.closest('[data-duplicate-trash]');
  if (!button || !confirm('이 중복 원본 파일을 휴지통으로 이동할까요?')) return;
  const snapshot = await window.soundLibrary.removeSound({ id: button.dataset.duplicateTrash, trashFile: true });
  setLibrary(snapshot);
  button.closest('.duplicate-file').remove();
});
$('#closeSettingsBtn').addEventListener('click', () => { window.soundLibrary.setShortcutCapture(false); state.view = 'library'; render(); });
$('#resetShortcutsBtn').addEventListener('click', async () => {
  window.soundLibrary.setShortcutCapture(false);
  setLibrary(await window.soundLibrary.setShortcuts(DEFAULT_SHORTCUTS));
  showToast('기본 단축키로 복원했습니다.');
});
$('#shortcutList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-shortcut-action]');
  if (!button) return;
  button.classList.add('recording');
  button.textContent = '새 단축키를 누르세요…';
  button.focus();
  window.soundLibrary.setShortcutCapture(true);
});
$('#shortcutList').addEventListener('keydown', async (event) => {
  const button = event.target.closest('[data-shortcut-action].recording');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') { window.soundLibrary.setShortcutCapture(false); renderSettings(); return; }
  const shortcut = shortcutFromKeyboardEvent(event);
  if (!shortcut || ['Meta', 'Control', 'Alt', 'Shift'].includes(shortcut)) return;
  const duplicate = Object.entries(state.shortcuts).find(([action, value]) => action !== button.dataset.shortcutAction && value === shortcut);
  if (duplicate) {
    window.soundLibrary.setShortcutCapture(false);
    showToast(`이미 “${SHORTCUT_LABELS[duplicate[0]][0]}”에 사용 중인 단축키입니다.`);
    return renderSettings();
  }
  state.shortcuts[button.dataset.shortcutAction] = shortcut;
  window.soundLibrary.setShortcutCapture(false);
  setLibrary(await window.soundLibrary.setShortcuts(state.shortcuts));
  showToast('단축키를 저장했습니다.');
});
$('#closeInspector').addEventListener('click', () => { state.inspectorOpen = false; render(); });
$('#largePlay').addEventListener('click', toggleSelectedPlayback);
$('#detailPlayButton').addEventListener('click', toggleSelectedPlayback);
$('#volumeSlider').addEventListener('input', (event) => {
  state.previewVolume = Math.max(0, Math.min(1, Number(event.target.value) / 100));
  player.volume = state.previewVolume;
  if (state.previewVolume > 0) lastAudibleVolume = state.previewVolume;
  updateVolumeControl();
  clearTimeout(volumeSaveDebounce);
  volumeSaveDebounce = setTimeout(() => window.soundLibrary.setPreviewVolume(state.previewVolume), 180);
});
$('#muteButton').addEventListener('click', () => {
  state.previewVolume = state.previewVolume > 0 ? 0 : Math.max(0.05, lastAudibleVolume || 0.8);
  player.volume = state.previewVolume;
  updateVolumeControl();
  window.soundLibrary.setPreviewVolume(state.previewVolume);
});
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
$('#inspectorRating').addEventListener('click', (event) => {
  const button = event.target.closest('[data-rating]');
  const sound = selectedSound();
  if (!button || !sound) return;
  const rating = Number(button.dataset.rating);
  updateSelected({ rating: Number(sound.rating || 0) === rating ? 0 : rating });
  renderInspector();
});
$('#revealBtn').addEventListener('click', () => { const sound = selectedSound(); if (sound) window.soundLibrary.reveal(sound.path); });
$('#moveBtn').addEventListener('click', moveSelectedToFolder);
$('#trashBtn').addEventListener('click', trashSelected);
$('#removeBtn').addEventListener('click', async (event) => {
  const sound = selectedSound();
  if (!sound) return;
  const trashFile = event.altKey;
  const message = trashFile
    ? `“${sound.title}”의 원본 파일도 휴지통으로 이동할까요?`
    : `“${sound.title}”을 라이브러리에서만 삭제할까요? 원본 파일은 유지됩니다.\n\n원본도 휴지통으로 보내려면 Option 키를 누른 채 삭제 버튼을 클릭하세요.`;
  if (!confirm(message)) return;
  state.selectedId = null;
  state.selectedIds.delete(sound.id);
  state.inspectorOpen = false;
  setLibrary(await window.soundLibrary.removeSound({ id: sound.id, trashFile }));
});

document.addEventListener('keydown', (event) => {
  if (event.target.closest('.shortcut-capture.recording')) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    state.selectedIds = new Set(state.visibleSounds.map((sound) => sound.id));
    if (!state.selectedId && state.visibleSounds[0]) state.selectedId = state.visibleSounds[0].id;
    renderList();
    return;
  }
  const shortcut = shortcutFromKeyboardEvent(event);
  const action = actionForShortcut(shortcut);
  if (!action) return;
  if (shortcut === 'Space' && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  event.preventDefault();
  runShortcut(action);
});

let dragDepth = 0;
document.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  $('#dropOverlay').classList.remove('hidden');
});
document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  document.querySelectorAll('.category-tree-row.drag-over').forEach((row) => row.classList.remove('drag-over'));
  const categoryRow = event.target.closest('[data-category-row]');
  categoryRow?.classList.add('drag-over');
  if (categoryRow || state.filter.startsWith('category:')) event.dataTransfer.dropEffect = 'move';
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#dropOverlay').classList.add('hidden');
});
document.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').classList.add('hidden');
  document.querySelectorAll('.category-tree-row.drag-over').forEach((row) => row.classList.remove('drag-over'));
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  const categoryRow = event.target.closest('[data-category-row]');
  const selectedCategory = state.filter.startsWith('category:') ? state.filter.slice('category:'.length) : '';
  const dropCategory = categoryRow?.dataset.categoryRow || selectedCategory;
  if (dropCategory) {
    showToast(`“${dropCategory}” 폴더로 이동하는 중…`, 10000);
    try {
      setLibrary(await window.soundLibrary.dropFilesToCategory(dropCategory, files));
      showToast('파일 또는 폴더를 이동했습니다.');
    } catch (error) {
      showToast(`이동 실패: ${error.message}`, 5000);
    }
    return;
  }
  showToast('드롭한 사운드를 추가하는 중…', 10000);
  try {
    setLibrary(await window.soundLibrary.addDroppedFiles(files));
    showToast('사운드를 라이브러리에 추가했습니다.');
  } catch (error) {
    showToast(`추가 실패: ${error.message}`, 5000);
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
window.soundLibrary.onLibraryUpdated((snapshot) => {
  setLibrary(snapshot);
  if (snapshot.updateReason === 'folder-change') showToast('폴더 변경 사항을 자동으로 반영했습니다.', 1800);
});
window.soundLibrary.onDragError((message) => showToast(`드래그를 시작하지 못했습니다: ${message}`, 4000));
window.soundLibrary.onShortcut((shortcut) => {
  const action = actionForShortcut(shortcut);
  if (action) runShortcut(action);
});
new ResizeObserver(drawDetailWaveform).observe(detailWrap);

window.soundLibrary.getLibrary().then(setLibrary);
