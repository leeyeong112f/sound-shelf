const DEFAULT_SHORTCUTS = {
  search: 'Meta+S', moveCategory: 'Meta+M', editTags: 'Meta+T', addFiles: 'Meta+O',
  addFolder: 'Meta+Shift+O', trash: 'Meta+Backspace', reveal: 'Meta+Shift+R',
  favorite: 'Meta+Shift+F', settings: 'Meta+Comma', playPause: 'Space',
  renameSound: 'Enter',
  insertResolve: 'Meta+F', newSubfolder: 'Meta+Shift+N'
};
const SHORTCUT_LABELS = {
  search: ['사운드 검색', '검색창으로 이동'],
  moveCategory: ['카테고리 폴더로 이동', '선택 파일을 실제 카테고리 폴더로 이동'],
  editTags: ['태그 편집', '선택 사운드의 기존 태그 선택·추가·제거'],
  addFiles: ['파일 추가', '오디오 파일 선택'],
  addFolder: ['볼트 열기', '다른 Sound Shelf 볼트 선택'],
  trash: ['원본 파일 삭제', '선택 파일을 macOS 휴지통으로 이동'],
  reveal: ['Finder에서 보기', '선택 파일 위치 열기'],
  favorite: ['즐겨찾기 전환', '선택 사운드 별표 켜기/끄기'],
  settings: ['단축키 설정', '이 설정 화면 열기'],
  playPause: ['재생/일시정지', '선택 사운드 미리 듣기'],
  renameSound: ['사운드 이름 변경', '실제 오디오 파일명을 함께 변경'],
  insertResolve: ['Fairlight로 보내기', '선택 사운드(구간 선택 시 그 구간만)를 Resolve 타임헤드에 삽입'],
  newSubfolder: ['새 하위 폴더', '현재 보고 있는 카테고리 안에 새 폴더 생성']
};

const state = {
  sounds: [],
  loading: true,
  categories: [],
  categoryPaths: [],
  categoryOrder: [],
  watchedFolders: [],
  filter: 'all',
  query: '',
  selectedId: null,
  selectedIds: new Set(),
  selectionAnchorId: null,
  inspectorOpen: false,
  playingId: null,
  followSelectionPlayback: false,
  playRangeEnd: null,
  waveforms: new Map(),
  waveformLoading: new Set(),
  selections: new Map(),
  shortcuts: { ...DEFAULT_SHORTCUTS },
  view: 'library',
  previewVolume: 0.8,
  collapsedCategories: new Set(),
  categoryKeyboardMode: false,
  categoryKeyboardPath: null,
  selectedCategories: new Set(),
  categoryAnchor: null,
  sortBy: 'title',
  sortDirection: 1,
  frozenTitleOrder: null,
  frozenRatingOrder: null,
  minimumRating: 0,
  fileFilter: 'all',
  tagFilters: new Set(),
  tagPanelQuery: '',
  tagPanelCollapsed: localStorage.getItem('sound-shelf-tag-panel-collapsed') === 'true',
  tagPanelHeight: Math.max(140, Number(localStorage.getItem('sound-shelf-tag-panel-height')) || 220),
  tagManagerQuery: '',
  tagManagerSort: 'usage',
  performance: null,
  vault: null,
  updateStatus: null,
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
let searchKeyboardNavigation = false;
let duplicateGroups = [];
let tagPanelResizeGesture = null;
let tagUndoSnapshot = null;
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

function captureListPosition(movingIds = [], { keepFocusOnReorder = false } = {}) {
  const moving = new Set(movingIds || []);
  const selectedIndex = state.visibleSounds.findIndex((sound) => sound.id === state.selectedId);
  const movingIndex = state.visibleSounds.findIndex((sound) => moving.has(sound.id));
  return {
    scrollTop: list.scrollTop,
    keepFocusOnReorder,
    focusIndex: selectedIndex >= 0
      ? selectedIndex
      : movingIndex >= 0 ? movingIndex : Math.floor(list.scrollTop / VIRTUAL_ROW_HEIGHT)
  };
}

function moveSoundSelectionWithArrow(direction) {
  if (!state.visibleSounds.length) return;
  const previousSelectedId = state.selectedId;
  const continueAudition = Boolean(previousSelectedId
    && state.playingId === previousSelectedId
    && state.followSelectionPlayback);
  const currentIndex = state.visibleSounds.findIndex((sound) => sound.id === state.selectedId);
  const fallbackIndex = direction > 0 ? 0 : state.visibleSounds.length - 1;
  const nextIndex = currentIndex < 0
    ? fallbackIndex
    : Math.max(0, Math.min(state.visibleSounds.length - 1, currentIndex + direction));
  const nextSound = state.visibleSounds[nextIndex];
  if (!nextSound) return;
  state.selectedId = nextSound.id;
  state.selectedIds = new Set([nextSound.id]);
  state.selectionAnchorId = nextSound.id;

  const rowTop = nextIndex * VIRTUAL_ROW_HEIGHT;
  const rowBottom = rowTop + VIRTUAL_ROW_HEIGHT;
  if (rowTop < list.scrollTop) list.scrollTop = rowTop;
  else if (rowBottom > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, rowBottom - list.clientHeight);

  renderVirtualRows();
  updateBatchToolbar();
  renderInspector();
  renderDetailPanel();
  if (continueAudition && nextSound.id !== previousSelectedId) toggleFullPlayback(nextSound);
}

function showToast(message, duration = 3000) {
  const toast = $('#scanToast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toast.hideTimer);
  toast.hideTimer = setTimeout(() => toast.classList.add('hidden'), duration);
}

function parseSearchQuery(value) {
  const tagTerms = [];
  const lowered = String(value || '').trim().toLocaleLowerCase('ko');
  const textOnly = lowered.replace(/#([^#\s]+)/g, (_match, tag) => {
    const cleaned = normalizedTagKey(tag.replace(/[,;]+$/g, ''));
    if (cleaned) tagTerms.push(cleaned);
    return ' ';
  });
  return {
    textTerms: textOnly.split(/\s+/).map((term) => term.trim()).filter((term) => term && term !== '#'),
    tagTerms: [...new Set(tagTerms)]
  };
}

function compareSoundsForCurrentSort(a, b) {
  let comparison = 0;
  if (state.sortBy === 'title') comparison = a.title.localeCompare(b.title, 'ko', { numeric: true });
  else comparison = Number(a[state.sortBy] || 0) - Number(b[state.sortBy] || 0);
  return comparison * state.sortDirection;
}

function freezeRatingSortOrder() {
  if (state.sortBy !== 'rating' || state.frozenRatingOrder) return;
  state.frozenRatingOrder = [...state.sounds]
    .sort(compareSoundsForCurrentSort)
    .map((sound) => sound.id);
}

function freezeTitleSortOrder() {
  if (state.sortBy !== 'title' || state.frozenTitleOrder) return;
  state.frozenTitleOrder = [...state.sounds]
    .sort(compareSoundsForCurrentSort)
    .map((sound) => sound.id);
}

function filteredSounds() {
  const { textTerms, tagTerms } = parseSearchQuery(state.query);
  const sounds = state.sounds.filter((sound) => {
    if (state.filter === 'favorites' && !sound.favorite) return false;
    if (state.filter.startsWith('category:')) {
      const selectedPath = state.filter.slice(9);
      const soundPath = sound.categoryPath || sound.category || '미분류';
      if (soundPath !== selectedPath) return false;
    }
    if (state.tagFilters.size) {
      const soundTagKeys = new Set((sound.tags || []).map(normalizedTagKey));
      if (![...state.tagFilters].every((tag) => soundTagKeys.has(normalizedTagKey(tag)))) return false;
    }
    if (Number(sound.rating || 0) < state.minimumRating) return false;
    if (state.fileFilter === 'missing' && !sound.missing) return false;
    if (state.fileFilter === 'available' && sound.missing) return false;
    if (state.fileFilter === 'untagged' && (sound.tags || []).length > 0) return false;
    if (!textTerms.length && !tagTerms.length) return true;
    const haystack = [sound.title, sound.fileName, sound.category, sound.categoryPath, sound.notes,
      ...(sound.embeddedTags || []), ...Object.values(sound.embeddedMetadata || {})]
      .join(' ').toLocaleLowerCase('ko');
    const tags = (sound.tags || []).map(normalizedTagKey);
    const matchesText = textTerms.every((term) => haystack.includes(term));
    const matchesAnyTag = !tagTerms.length
      || tagTerms.some((term) => tags.some((tag) => tag.includes(term)));
    return matchesText && matchesAnyTag;
  });
  const frozenOrder = state.sortBy === 'title'
    ? state.frozenTitleOrder
    : state.sortBy === 'rating' ? state.frozenRatingOrder : null;
  if (frozenOrder) {
    const positions = new Map(frozenOrder.map((id, index) => [id, index]));
    return sounds.sort((a, b) => {
      const aPosition = positions.get(a.id);
      const bPosition = positions.get(b.id);
      if (aPosition !== undefined && bPosition !== undefined) return aPosition - bPosition;
      if (aPosition !== undefined) return -1;
      if (bPosition !== undefined) return 1;
      return compareSoundsForCurrentSort(a, b);
    });
  }
  return sounds.sort(compareSoundsForCurrentSort);
}

function setLibrary(snapshot, { preserveListPosition = null } = {}) {
  if (!snapshot) return;
  state.sounds = snapshot.sounds || [];
  state.loading = Boolean(snapshot.loading);
  const availableTags = new Map(tagUsageEntries().map((entry) => [entry.key, entry.label]));
  state.tagFilters = new Set([...state.tagFilters]
    .map((tag) => availableTags.get(normalizedTagKey(tag)))
    .filter(Boolean));
  state.categories = snapshot.categories || [];
  state.categoryPaths = snapshot.categoryPaths || snapshot.categories || [];
  state.categoryOrder = snapshot.categoryOrder || [];
  state.watchedFolders = snapshot.watchedFolders || [];
  state.shortcuts = { ...DEFAULT_SHORTCUTS, ...(snapshot.shortcuts || {}) };
  state.previewVolume = Number.isFinite(Number(snapshot.previewVolume)) ? Number(snapshot.previewVolume) : 0.8;
  state.performance = snapshot.performance || state.performance;
  state.vault = snapshot.vault || null;
  player.volume = state.previewVolume;
  if (state.previewVolume > 0) lastAudibleVolume = state.previewVolume;
  if (snapshot.moved?.oldId && state.selectedId === snapshot.moved.oldId) state.selectedId = snapshot.moved.id;
  if (snapshot.idChanges?.[state.selectedId]) state.selectedId = snapshot.idChanges[state.selectedId];
  if (snapshot.idChanges) state.selectedIds = new Set([...state.selectedIds].map((id) => snapshot.idChanges[id] || id));
  if (snapshot.idChanges?.[state.selectionAnchorId]) state.selectionAnchorId = snapshot.idChanges[state.selectionAnchorId];
  const validIds = new Set(state.sounds.map((sound) => sound.id));
  state.selectedIds = new Set([...state.selectedIds].filter((id) => validIds.has(id)));
  if (snapshot.categoryMove && state.filter.startsWith('category:')) {
    const current = state.filter.slice(9);
    if (current === snapshot.categoryMove.from || current.startsWith(`${snapshot.categoryMove.from}/`)) {
      state.filter = `category:${snapshot.categoryMove.to}${current.slice(snapshot.categoryMove.from.length)}`;
    }
  }
  if (snapshot.categoryMove) {
    state.selectedCategories = new Set([...state.selectedCategories].map((category) => {
      if (category === snapshot.categoryMove.from) return snapshot.categoryMove.to;
      if (category.startsWith(`${snapshot.categoryMove.from}/`)) return `${snapshot.categoryMove.to}${category.slice(snapshot.categoryMove.from.length)}`;
      return category;
    }));
  }
  const validCategories = new Set(state.categoryPaths);
  state.selectedCategories = new Set([...state.selectedCategories].filter((category) => validCategories.has(category)));
  if (state.categoryAnchor && !validCategories.has(state.categoryAnchor)) state.categoryAnchor = null;
  if (preserveListPosition) {
    const nextVisibleSounds = filteredSounds();
    const selectedIndex = nextVisibleSounds.findIndex((sound) => sound.id === state.selectedId);
    const focusIndex = Math.max(0, Math.min(nextVisibleSounds.length - 1, Number(preserveListPosition.focusIndex) || 0));
    const selectionLeftItsRow = preserveListPosition.keepFocusOnReorder
      && selectedIndex >= 0
      && selectedIndex !== focusIndex;
    if (selectedIndex < 0 || selectionLeftItsRow) {
      const nextIndex = focusIndex;
      const nextSound = nextVisibleSounds[nextIndex] || null;
      state.selectedId = nextSound?.id || null;
      state.selectedIds = nextSound ? new Set([nextSound.id]) : new Set();
      state.selectionAnchorId = nextSound?.id || null;
    }
  }
  render();
  if (preserveListPosition) {
    const maximum = Math.max(0, state.visibleSounds.length * VIRTUAL_ROW_HEIGHT - list.clientHeight);
    list.scrollTop = Math.max(0, Math.min(maximum, Number(preserveListPosition.scrollTop) || 0));
    renderVirtualRows();
  }
  if (!$('#tagManagerDialog').classList.contains('hidden')) renderTagManager();
}

function updateVolumeControl() {
  const percent = Math.round(state.previewVolume * 100);
  $('#volumeSlider').value = String(percent);
  $('#volumeValue').textContent = `${percent}%`;
  $('#muteButton').textContent = percent === 0 ? '🔇' : percent < 50 ? '🔉' : '🔊';
  $('#muteButton').setAttribute('aria-label', percent === 0 ? '음소거 해제' : '음소거');
}

function normalizedTagKey(value) {
  return String(value || '').normalize('NFKC').replace(/^#+/, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ko');
}

function cleanTagLabel(value) {
  return String(value || '').normalize('NFKC').replace(/^#+/, '').replace(/\s+/g, ' ').trim();
}

function tagUsageEntries() {
  const entries = new Map();
  state.sounds.forEach((sound) => {
    const soundKeys = new Set();
    (sound.tags || []).forEach((rawTag) => {
      const label = cleanTagLabel(rawTag);
      const key = normalizedTagKey(label);
      if (!key || soundKeys.has(key)) return;
      soundKeys.add(key);
      const current = entries.get(key) || { key, label, count: 0 };
      current.count += 1;
      entries.set(key, current);
    });
  });
  return [...entries.values()].sort((a, b) => a.label.localeCompare(b.label, 'ko'));
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
  const orderIndex = new Map(state.categoryOrder.map((category, index) => [category, index]));
  return [...nodes.values()]
    .sort((a, b) => {
      const ai = orderIndex.has(a.path) ? orderIndex.get(a.path) : Number.MAX_SAFE_INTEGER;
      const bi = orderIndex.has(b.path) ? orderIndex.get(b.path) : Number.MAX_SAFE_INTEGER;
      return ai - bi || a.name.localeCompare(b.name, 'ko', { numeric: true });
    })
    .map((node) => {
      const hasChildren = node.children.size > 0;
      const collapsed = state.collapsedCategories.has(node.path);
      const active = state.filter === `category:${node.path}` ? 'active' : '';
      const count = state.sounds.filter((sound) => {
        const soundPath = sound.categoryPath || sound.category || '미분류';
        return soundPath === node.path;
      }).length;
      const children = hasChildren && !collapsed ? renderCategoryNodes(node.children, depth + 1) : '';
      return `<div class="category-tree-node">
        <div class="category-tree-row ${active} ${state.selectedCategories.has(node.path) ? 'multi-selected' : ''} ${state.categoryKeyboardMode && state.categoryKeyboardPath === node.path ? 'keyboard-focused' : ''}" data-category-row="${escapeHtml(node.path)}" draggable="true">
          <button class="tree-toggle ${hasChildren ? '' : 'empty'}" data-category-toggle="${escapeHtml(node.path)}" ${hasChildren ? `aria-expanded="${!collapsed}" title="하위 폴더 ${collapsed ? '펼치기' : '접기'}"` : 'disabled'}>${hasChildren ? (collapsed ? '▶' : '▼') : ''}</button>
          <button class="tree-label" data-category="${escapeHtml(node.path)}" title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</button>
          <b>${count}</b>
        </div>${children ? `<div class="category-tree-children">${children}</div>` : ''}
      </div>`;
    }).join('');
}

function renderTagPanel() {
  const tagEntries = tagUsageEntries();
  const tagQuery = normalizedTagKey(state.tagPanelQuery);
  const visibleTagEntries = tagEntries.filter((entry) => !tagQuery || normalizedTagKey(entry.label).includes(tagQuery));
  $('#tagCount').textContent = String(tagEntries.length);
  $('#tagDock').classList.toggle('collapsed', state.tagPanelCollapsed);
  $('#tagDock').style.setProperty('--tag-panel-height', `${state.tagPanelHeight}px`);
  $('#tagPanelToggle').setAttribute('aria-expanded', String(!state.tagPanelCollapsed));
  $('#tagPanelArrow').textContent = state.tagPanelCollapsed ? '▲' : '▼';
  $('#tagFilterInput').value = state.tagPanelQuery;
  $('#tagList').innerHTML = visibleTagEntries.map(({ label, count }) => {
    const active = [...state.tagFilters].some((tag) => normalizedTagKey(tag) === normalizedTagKey(label)) ? 'active' : '';
    return `<button class="nav-item ${active}" data-tag="${escapeHtml(label)}" title="#${escapeHtml(label)}"><span>#</span>${escapeHtml(label)}<b>${count}</b></button>`;
  }).join('') || '<div class="dim category-list-empty">태그 없음</div>';
}

function renderSidebar() {
  $('#allCount').textContent = state.sounds.length;
  $('#favoriteCount').textContent = state.sounds.filter((sound) => sound.favorite).length;
  $('#categoryList').innerHTML = renderCategoryNodes(buildCategoryTree(state.categoryPaths).children)
    || '<div class="dim category-list-empty">카테고리 없음</div>';
  renderTagPanel();
  document.querySelectorAll('.nav-item[data-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === state.filter);
  });
  $('#categoryOptions').innerHTML = state.categoryPaths.map((category) => `<option value="${escapeHtml(category)}"></option>`).join('');
  $('#searchShortcutHint').textContent = displayShortcut(state.shortcuts.search);
  if (state.categoryKeyboardMode) requestAnimationFrame(() => {
    const row = [...document.querySelectorAll('#categoryList [data-category-row]')]
      .find((item) => item.dataset.categoryRow === state.categoryKeyboardPath);
    row?.scrollIntoView({ block: 'nearest' });
  });
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
  const filterName = state.tagFilters.size ? [...state.tagFilters].map((tag) => `#${tag}`).join(' + ')
    : state.filter === 'all' ? '모든 사운드'
    : state.filter === 'favorites' ? '즐겨찾기'
      : state.filter.slice(9);
  $('#viewTitle').textContent = filterName;
  $('#resultSummary').textContent = `${sounds.length.toLocaleString()}개의 사운드`;
  const showLoading = state.loading && state.sounds.length === 0;
  const showOnboarding = !state.loading && state.sounds.length === 0;
  const showNoResults = state.sounds.length > 0 && sounds.length === 0;
  $('#loadingState').classList.toggle('hidden', !showLoading);
  $('#emptyState').classList.toggle('hidden', !showOnboarding);
  $('#filterEmptyState').classList.toggle('hidden', !showNoResults);
  list.classList.toggle('hidden', state.sounds.length === 0 || showNoResults);

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
    ['파일 상태', sound.missing ? '원본 파일 없음 · 재연결 필요' : (sound.technicalError || '정상')],
    ['길이', formatDuration(sound.duration)],
    ['샘플레이트', sound.sampleRate ? `${(sound.sampleRate / 1000).toFixed(1)} kHz` : '—'],
    ['채널', sound.channels || '—'],
    ['코덱', (sound.codec || '—').toUpperCase()],
    ['크기', formatSize(sound.size)],
    ['조성(Key)', currentKeyAnalysis(sound)?.detected ? `${currentKeyAnalysis(sound).display} · ${Math.round(currentKeyAnalysis(sound).confidence * 100)}%` : (currentKeyAnalysis(sound) ? '조성 불명확' : '우클릭하여 분석')],
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
    hideDetailWaveformStatus();
    $('#detailSelection').classList.add('hidden');
    $('#createRangeFileButton').classList.add('hidden');
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

function renderUpdateSettings() {
  const status = state.updateStatus || {
    phase: 'idle', currentVersion: '', latestVersion: '', message: '업데이트 정보를 불러오는 중입니다.', progress: 0
  };
  const currentLabel = status.currentVersion ? `v${status.currentVersion}` : '확인 중';
  const latestLabel = status.latestVersion && status.latestVersion !== status.currentVersion
    ? ` · 최신 v${status.latestVersion}`
    : '';
  $('#updateVersionBadge').textContent = `현재 ${currentLabel}${latestLabel}`;
  $('#updateStatusText').textContent = status.message || '업데이트 확인 버튼을 눌러 최신 버전을 확인하세요.';

  const busy = ['checking', 'downloading', 'installing'].includes(status.phase);
  const checkButton = $('#checkUpdateBtn');
  checkButton.disabled = busy || status.phase === 'downloaded';
  checkButton.textContent = status.phase === 'checking'
    ? '확인 중…'
    : status.phase === 'downloading'
      ? `다운로드 ${Math.round(status.progress || 0)}%`
      : '업데이트 확인';
  $('#installUpdateBtn').classList.toggle('hidden', status.phase !== 'downloaded');
  $('#openReleaseBtn').classList.toggle('hidden', !['manual-available', 'error'].includes(status.phase));
  const showProgress = ['downloading', 'downloaded', 'installing'].includes(status.phase);
  $('#updateProgress').classList.toggle('hidden', !showProgress);
  $('#updateProgressBar').style.width = `${Math.max(0, Math.min(100, Number(status.progress) || 0))}%`;
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
  if (stats) $('#performanceInfo').textContent = `저장 방식: ${stats.storage} · ${Number(stats.soundCount).toLocaleString()}개 · 로컬 복구 정보 ${formatSize(stats.fileSize)} · 시작 로드 ${stats.loadMs}ms · 가상 목록 ${stats.virtualRenderMs || '—'}ms`;
  $('#vaultName').textContent = state.vault?.name || '열린 볼트 없음';
  $('#vaultPath').textContent = state.vault
    ? `${state.vault.connected === false ? '연결 끊김 · ' : ''}${state.vault.root}`
    : '볼트 폴더를 선택해 주세요.';
  $('#revealVaultBtn').disabled = !state.vault?.connected;
  $('#compactVaultBtn').disabled = !state.vault?.connected;
  $('#moveVaultBtn').disabled = !state.vault?.connected;
  $('#locateVaultBtn').disabled = !state.vault;
  $('#checkVaultBtn').disabled = !state.vault?.connected;
  renderUpdateSettings();
}

function render() {
  renderSidebar();
  renderList();
  renderInspector();
  renderDetailPanel();
  renderSettings();
}

function showDetailWaveformStatus(message, { retry = false } = {}) {
  $('#detailWaveformStatus').textContent = message;
  $('#detailWaveformRetryBtn').classList.toggle('hidden', !retry);
  $('#detailWaveformLoading').classList.remove('hidden');
}

function hideDetailWaveformStatus() {
  $('#detailWaveformLoading').classList.add('hidden');
  $('#detailWaveformRetryBtn').classList.add('hidden');
}

async function ensureWaveform(sound) {
  if (!sound) return;
  if (sound.missing) {
    if (state.selectedId === sound.id) showDetailWaveformStatus('원본 파일이 없어 파형을 만들 수 없습니다. 우클릭하여 재연결해 주세요.');
    return;
  }
  if (state.waveforms.has(sound.id)) {
    const cached = state.waveforms.get(sound.id);
    if (state.selectedId === sound.id && cached?.error) showDetailWaveformStatus(cached.error, { retry: true });
    return;
  }
  if (state.waveformLoading.has(sound.id)) return;
  state.waveformLoading.add(sound.id);
  if (state.selectedId === sound.id) showDetailWaveformStatus('파형 생성 중… Google Drive 파일은 잠시 걸릴 수 있습니다.');
  try {
    const waveform = await window.soundLibrary.getWaveform(sound.id);
    const result = waveform || { left: [], right: [], status: 'error', error: '파형 데이터를 받지 못했습니다.' };
    state.waveforms.set(sound.id, result);
    drawMiniWaveform(sound.id);
    if (state.selectedId === sound.id) {
      drawDetailWaveform();
      if (result?.left?.length) hideDetailWaveformStatus();
      else showDetailWaveformStatus(result.error || '파형을 만들 수 없습니다.', { retry: result.status !== 'missing' });
    }
  } catch (error) {
    const result = { left: [], right: [], status: 'error', error: `파형 생성 요청에 실패했습니다: ${error.message}` };
    state.waveforms.set(sound.id, result);
    if (state.selectedId === sound.id) showDetailWaveformStatus(result.error, { retry: true });
  } finally {
    state.waveformLoading.delete(sound.id);
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
  if (!hasWaveform) {
    if (sound.missing) {
      showDetailWaveformStatus('원본 파일이 없어 파형을 만들 수 없습니다. 우클릭하여 재연결해 주세요.');
    } else if (waveform?.error) {
      showDetailWaveformStatus(waveform.error, { retry: waveform.status !== 'missing' });
    } else if (state.waveformLoading.has(sound.id)) {
      showDetailWaveformStatus('파형 생성 중… Google Drive 파일은 잠시 걸릴 수 있습니다.');
    }
    return;
  }
  hideDetailWaveformStatus();
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
  $('#createRangeFileButton').classList.toggle('hidden', !selection);
  $('#createRangeFileButton').disabled = Boolean(selection?.path || selection?.preparing);
  $('#createRangeFileButton').textContent = selection?.path
    ? '구간 파일 생성 완료'
    : (selection?.preparing ? 'Resolve용 구간 준비 중…' : '선택 구간 파일 만들기');
  if (!sound || !selection) return;
  detailSelection.style.left = `${(selection.start / sound.duration) * 100}%`;
  detailSelection.style.width = `${((selection.end - selection.start) / sound.duration) * 100}%`;
  detailSelection.classList.toggle('preparing', Boolean(selection.preparing));
  detailSelection.classList.toggle('ready', Boolean(selection.path || selection.dragPath));
  detailSelection.draggable = Boolean(selection.path || selection.dragPath);
  detailSelection.dataset.clipPath = selection.path || selection.dragPath || '';
  const dragStatus = selection.preparing
    ? ' · Resolve용 준비 중'
    : (selection.path || selection.dragPath ? ' · Resolve로 드래그' : ' · 선택됨');
  detailSelection.querySelector('span').textContent = `${formatDetailedDuration(selection.start)} – ${formatDetailedDuration(selection.end)}${dragStatus}`;
}

async function prepareSelectionForDrag(sound, selection) {
  const token = `${selection.start.toFixed(6)}:${selection.end.toFixed(6)}`;
  if (selection.dragPath && selection.dragToken === token) {
    return { ok: true, path: selection.dragPath, duration: selection.end - selection.start };
  }
  if (selection.dragPromise && selection.dragToken === token) return selection.dragPromise;

  selection.dragToken = token;
  selection.dragPath = '';
  selection.preparing = true;
  updateDetailSelection();
  const promise = window.soundLibrary.prepareClip({ id: sound.id, start: selection.start, end: selection.end });
  selection.dragPromise = promise;
  const result = await promise;
  const current = state.selections.get(sound.id);
  if (!current || current.dragToken !== token) {
    return { ok: false, message: '선택 구간이 변경되었습니다. 다시 드래그해 주세요.' };
  }
  current.dragPromise = null;
  current.preparing = false;
  if (result.ok) current.dragPath = result.path;
  updateDetailSelection();
  return result;
}

function waveformRatio(event) {
  const rect = detailWrap.getBoundingClientRect();
  return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
}

let previewPlaybackRequest = 0;

function pausePreviewPlayback() {
  previewPlaybackRequest += 1;
  state.followSelectionPlayback = false;
  player.pause();
}

async function startPreviewPlayback(sound) {
  const request = ++previewPlaybackRequest;
  try {
    await player.play();
    return request === previewPlaybackRequest;
  } catch (error) {
    if (request !== previewPlaybackRequest || error?.name === 'AbortError') return false;
    if (state.playingId === sound?.id) state.followSelectionPlayback = false;
    const message = sound?.missing
      ? '원본 파일이 없어 재생할 수 없습니다.'
      : '사운드를 재생할 수 없습니다. Google Drive 다운로드 상태나 파일 형식을 확인해 주세요.';
    showToast(message, 5000);
    return false;
  }
}

async function toggleFullPlayback(sound) {
  if (!sound) return;
  if (sound.missing) return showToast('원본 파일이 없어 재생할 수 없습니다.', 5000);
  state.playRangeEnd = null;
  if (state.playingId === sound.id && !player.paused) {
    pausePreviewPlayback();
    return;
  }
  if (state.playingId !== sound.id) {
    player.src = fileUrl(sound.path);
    state.playingId = sound.id;
  }
  await startPreviewPlayback(sound);
}

async function playSelection(sound, selection, resume = false) {
  if (!sound || !selection) return;
  if (sound.missing) return showToast('원본 파일이 없어 재생할 수 없습니다.', 5000);
  if (state.playingId !== sound.id) {
    player.src = fileUrl(sound.path);
    state.playingId = sound.id;
  }
  if (!resume || player.currentTime < selection.start || player.currentTime >= selection.end) player.currentTime = selection.start;
  state.playRangeEnd = selection.end;
  state.followSelectionPlayback = true;
  await startPreviewPlayback(sound);
}

async function seekAndPlay(sound, requestedTime) {
  if (!sound) return;
  if (sound.missing) return showToast('원본 파일이 없어 재생할 수 없습니다.', 5000);
  if (!sound.duration) return showToast('길이 정보를 읽지 못해 해당 위치에서 재생할 수 없습니다.', 5000);
  const targetTime = Math.max(0, Math.min(sound.duration - 0.001, Number(requestedTime) || 0));
  state.playRangeEnd = null;
  if (state.playingId !== sound.id) {
    player.src = fileUrl(sound.path);
    state.playingId = sound.id;
  }
  if (player.readyState < 1) {
    await Promise.race([
      new Promise((resolve) => player.addEventListener('loadedmetadata', resolve, { once: true })),
      new Promise((resolve) => setTimeout(resolve, 800))
    ]);
  }
  try { player.currentTime = targetTime; } catch {}
  updateTransportDisplay();
  state.followSelectionPlayback = true;
  await startPreviewPlayback(sound);
}

async function toggleSelectedPlayback() {
  const sound = selectedSound();
  if (!sound) return;
  if (state.playingId === sound.id && !player.paused) {
    pausePreviewPlayback();
    return;
  }
  state.followSelectionPlayback = true;
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
    pausePreviewPlayback();
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
  saveDebounce = setTimeout(async () => {
    try {
      setLibrary(await window.soundLibrary.updateSound({ id: sound.id, ...changes }));
    } catch (error) {
      showToast(`저장하지 못했습니다: ${error.message}`, 4000);
      try { setLibrary(await window.soundLibrary.getLibrary()); } catch {}
    }
  }, 250);
}

function openInputDialog({
  title,
  description,
  value = '',
  placeholder = '',
  options = [],
  suggestions = [],
  confirmWithShiftSpace = false,
  navigateOptions = false,
  confirmWithSpace = false
}) {
  return new Promise((resolve) => {
    const backdrop = $('#inputDialog');
    const form = $('#inputDialogForm');
    const field = $('#inputDialogField');
    const suggestionsPanel = $('#inputDialogSuggestions');
    $('#inputDialogTitle').textContent = title;
    $('#inputDialogDescription').textContent = description;
    field.value = value;
    field.placeholder = placeholder;
    $('#inputDialogOptions').innerHTML = options.map((option) => `<option value="${escapeHtml(option)}"></option>`).join('');
    if (options.length && !navigateOptions) field.setAttribute('list', 'inputDialogOptions');
    else field.removeAttribute('list');
    form.classList.toggle('has-suggestions', suggestions.length > 0 || navigateOptions);
    const normalizeSuggestion = (text) => String(text || '').normalize('NFKC')
      .replace(/\s+/g, ' ').trim().toLocaleLowerCase('ko');
    const searchableOptions = options.map((option) => ({
      value: option,
      normalizedValue: normalizeSuggestion(option)
    }));
    const searchableSuggestions = suggestions.map((item) => ({
      ...item,
      normalizedName: normalizeSuggestion(item.name)
    }));
    let optionSearchActive = false;
    let visibleOptions = searchableOptions;
    let highlightedOption = searchableOptions.find((item) => item.normalizedValue === normalizeSuggestion(value))?.value
      || searchableOptions[0]?.value || '';
    let settled = false;
    let lastWheelSelectionAt = -Infinity;
    let suggestionPlayingId = null;

    const renderOptionSuggestions = () => {
      const query = optionSearchActive ? normalizeSuggestion(field.value) : '';
      visibleOptions = searchableOptions.filter((item) => !query || item.normalizedValue.includes(query));
      if (!visibleOptions.some((item) => item.value === highlightedOption)) {
        highlightedOption = visibleOptions.find((item) => item.normalizedValue === query)?.value
          || visibleOptions[0]?.value || '';
      }
      suggestionsPanel.classList.remove('hidden');
      if (!visibleOptions.length) {
        suggestionsPanel.innerHTML = '<div class="input-dialog-suggestion-empty">일치하는 기존 카테고리가 없습니다.</div>';
        return;
      }
      suggestionsPanel.innerHTML = `
        <div class="input-dialog-suggestion-summary">카테고리 ${visibleOptions.length}개 · 휠/↑↓ 선택 · Space/Enter 이동</div>
        ${visibleOptions.map((item, index) => `<button type="button" class="input-dialog-option${item.value === highlightedOption ? ' active' : ''}" data-input-option-index="${index}" aria-selected="${item.value === highlightedOption}"><strong>${escapeHtml(item.value)}</strong></button>`).join('')}`;
      requestAnimationFrame(() => suggestionsPanel.querySelector('.input-dialog-option.active')?.scrollIntoView({ block: 'nearest' }));
    };

    const renderNameSuggestions = () => {
      const query = normalizeSuggestion(field.value);
      if (!suggestions.length || !query) {
        suggestionsPanel.innerHTML = '';
        suggestionsPanel.classList.add('hidden');
        return;
      }
      const matches = searchableSuggestions
        .filter((item) => item.normalizedName.includes(query))
        .sort((left, right) => {
          const prefixDifference = Number(!left.normalizedName.startsWith(query)) - Number(!right.normalizedName.startsWith(query));
          return prefixDifference || left.name.localeCompare(right.name, 'ko');
        });
      suggestionsPanel.classList.remove('hidden');
      if (!matches.length) {
        suggestionsPanel.innerHTML = '<div class="input-dialog-suggestion-empty">이 키워드가 포함된 기존 사운드가 없습니다.</div>';
        return;
      }
      const visible = matches.slice(0, 8);
      suggestionsPanel.innerHTML = `
        <div class="input-dialog-suggestion-summary">기존 이름 ${matches.length}개 · 클릭하여 중복 사운드 미리듣기${matches.length > visible.length ? ` · 상위 ${visible.length}개 표시` : ''}</div>
        ${visible.map((item) => {
          const playing = item.id && state.playingId === item.id && !player.paused;
          return `<button type="button" class="input-dialog-suggestion${playing ? ' playing' : ''}${item.missing ? ' missing' : ''}" data-name-suggestion-id="${escapeHtml(item.id || '')}"><i>${playing ? '❚❚' : '▶'}</i><span class="input-dialog-suggestion-name"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.category || '미분류')}</small></span></button>`;
        }).join('')}`;
    };
    const renderSuggestions = () => {
      if (navigateOptions) renderOptionSuggestions();
      else renderNameSuggestions();
    };
    const handleFieldInput = () => {
      if (navigateOptions) {
        optionSearchActive = true;
        highlightedOption = '';
      }
      renderSuggestions();
    };
    const selectedDialogValue = () => navigateOptions
      ? (highlightedOption || field.value.trim())
      : field.value.trim();
    const selectAdjacentOption = (direction) => {
      if (!navigateOptions || !visibleOptions.length || !direction) return;
      const current = visibleOptions.findIndex((item) => item.value === highlightedOption);
      const next = current < 0
        ? (direction > 0 ? 0 : visibleOptions.length - 1)
        : Math.max(0, Math.min(visibleOptions.length - 1, current + direction));
      highlightedOption = visibleOptions[next].value;
      renderOptionSuggestions();
    };
    const handleOptionClick = async (event) => {
      if (!navigateOptions) {
        const button = event.target.closest('[data-name-suggestion-id]');
        if (!button) return;
        const sound = state.sounds.find((item) => item.id === button.dataset.nameSuggestionId);
        if (!sound) return;
        if (sound.missing) {
          showToast('원본 파일이 없어 이 후보를 재생할 수 없습니다.', 5000);
          return;
        }
        suggestionPlayingId = sound.id;
        await toggleFullPlayback(sound);
        renderNameSuggestions();
        field.focus();
        return;
      }
      const button = event.target.closest('[data-input-option-index]');
      if (!button) return;
      const selected = visibleOptions[Number(button.dataset.inputOptionIndex)];
      if (!selected) return;
      highlightedOption = selected.value;
      finish(highlightedOption);
    };
    const handleOptionWheel = (event) => {
      if (!navigateOptions || !visibleOptions.length) return;
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (!delta) return;
      event.preventDefault();
      event.stopPropagation();
      const now = performance.now();
      if (now - lastWheelSelectionAt < 90) return;
      lastWheelSelectionAt = now;
      selectAdjacentOption(delta > 0 ? 1 : -1);
    };
    const refreshSuggestionPlayback = () => {
      if (!settled && !navigateOptions) renderNameSuggestions();
    };
    backdrop.classList.remove('hidden');
    const finish = (result) => {
      if (settled) return;
      settled = true;
      backdrop.classList.add('hidden');
      suggestionsPanel.classList.add('hidden');
      suggestionsPanel.innerHTML = '';
      form.classList.remove('has-suggestions');
      field.removeEventListener('input', handleFieldInput);
      suggestionsPanel.removeEventListener('click', handleOptionClick);
      form.removeEventListener('submit', submit);
      $('#inputDialogCancel').removeEventListener('click', cancel);
      backdrop.removeEventListener('click', outside);
      form.removeEventListener('wheel', handleOptionWheel);
      document.removeEventListener('keydown', handleDialogKeydown, true);
      player.removeEventListener('play', refreshSuggestionPlayback);
      player.removeEventListener('pause', refreshSuggestionPlayback);
      player.removeEventListener('ended', refreshSuggestionPlayback);
      if (suggestionPlayingId && state.playingId === suggestionPlayingId) pausePreviewPlayback();
      suggestionPlayingId = null;
      resolve(result);
    };
    const submit = (event) => { event.preventDefault(); finish(selectedDialogValue()); };
    const cancel = () => finish(null);
    const outside = (event) => { if (event.target === backdrop) finish(null); };
    const handleDialogKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
        return;
      }
      if (navigateOptions && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        event.stopPropagation();
        selectAdjacentOption(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      const noCommandModifier = !event.metaKey && !event.ctrlKey && !event.altKey;
      if (confirmWithSpace && event.key === ' ' && !event.shiftKey && noCommandModifier) {
        event.preventDefault();
        event.stopPropagation();
        finish(selectedDialogValue());
        return;
      }
      if (!confirmWithShiftSpace || event.key !== ' ' || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      finish(selectedDialogValue());
    };
    field.addEventListener('input', handleFieldInput);
    suggestionsPanel.addEventListener('click', handleOptionClick);
    form.addEventListener('submit', submit);
    $('#inputDialogCancel').addEventListener('click', cancel);
    backdrop.addEventListener('click', outside);
    form.addEventListener('wheel', handleOptionWheel, { passive: false });
    document.addEventListener('keydown', handleDialogKeydown, true);
    player.addEventListener('play', refreshSuggestionPlayback);
    player.addEventListener('pause', refreshSuggestionPlayback);
    player.addEventListener('ended', refreshSuggestionPlayback);
    requestAnimationFrame(() => { field.focus(); field.select(); renderSuggestions(); });
  });
}

function openTagEditor(ids) {
  return new Promise((resolve) => {
    const selectedSounds = state.sounds.filter((sound) => ids.includes(sound.id));
    if (!selectedSounds.length) return resolve(null);
    const backdrop = $('#tagDialog');
    const form = $('#tagDialogForm');
    const searchField = $('#tagDialogSearch');
    const addButton = $('#tagDialogAdd');
    const choices = $('#tagDialogChoices');
    const selectedPanel = $('#tagDialogSelected');
    const usageByKey = new Map(tagUsageEntries().map((entry) => [entry.key, entry]));
    const labels = new Map([...usageByKey].map(([key, entry]) => [key, entry.label]));
    const selectedCounts = new Map();
    selectedSounds.forEach((sound) => {
      const soundKeys = new Set();
      (sound.tags || []).forEach((rawTag) => {
        const label = cleanTagLabel(rawTag);
        const key = normalizedTagKey(label);
        if (!key || soundKeys.has(key)) return;
        soundKeys.add(key);
        labels.set(key, labels.get(key) || label);
        selectedCounts.set(key, (selectedCounts.get(key) || 0) + 1);
      });
    });
    const initialStates = new Map();
    labels.forEach((_label, key) => {
      const count = selectedCounts.get(key) || 0;
      initialStates.set(key, count === selectedSounds.length ? 'all' : (count > 0 ? 'some' : 'none'));
    });
    const currentStates = new Map(initialStates);
    let settled = false;
    let tagInputComposing = false;
    let addAfterCompositionSpace = false;

    const stateIcon = (tagState) => tagState === 'all' ? '✓' : (tagState === 'some' ? '−' : '＋');
    const tagButtonMarkup = (key) => {
      const label = labels.get(key) || key;
      const tagState = currentStates.get(key) || 'none';
      const usage = usageByKey.get(key)?.count || 0;
      return `<button type="button" class="tag-choice state-${tagState}" data-tag-choice="${escapeHtml(key)}"><i>${stateIcon(tagState)}</i><span>${escapeHtml(label)}</span><b>${usage}</b></button>`;
    };
    const orderedKeys = () => [...labels.keys()].sort((left, right) => {
      const stateOrder = { all: 0, some: 1, none: 2 };
      const stateDifference = stateOrder[currentStates.get(left) || 'none'] - stateOrder[currentStates.get(right) || 'none'];
      const usageDifference = (usageByKey.get(right)?.count || 0) - (usageByKey.get(left)?.count || 0);
      return stateDifference || usageDifference || (labels.get(left) || '').localeCompare(labels.get(right) || '', 'ko');
    });
    const renderTagEditor = () => {
      const query = normalizedTagKey(searchField.value);
      const keys = orderedKeys();
      const selectedKeys = keys.filter((key) => currentStates.get(key) === 'all' || currentStates.get(key) === 'some');
      selectedPanel.innerHTML = selectedKeys.map(tagButtonMarkup).join('');
      const visibleKeys = keys.filter((key) => !query || key.includes(query));
      choices.innerHTML = visibleKeys.map(tagButtonMarkup).join('')
        || '<div class="tag-choice-empty">일치하는 기존 태그가 없습니다. 위의 새 태그 추가를 사용하세요.</div>';
      $('#tagDialogResultCount').textContent = `${visibleKeys.length} / ${keys.length}개`;
      const inputLabel = cleanTagLabel(searchField.value.split(',')[0]);
      const exactKey = normalizedTagKey(inputLabel);
      addButton.disabled = !inputLabel;
      addButton.textContent = exactKey && labels.has(exactKey) ? '이 태그 모두 적용' : '새 태그 추가';
    };
    const toggleTag = (key) => {
      const initial = initialStates.get(key) || 'none';
      const current = currentStates.get(key) || 'none';
      let next;
      if (initial === 'some') next = current === 'some' ? 'all' : (current === 'all' ? 'none' : 'some');
      else next = current === 'all' ? 'none' : 'all';
      currentStates.set(key, next);
      renderTagEditor();
    };
    const addInputTags = () => {
      const rawTags = searchField.value.split(',').map(cleanTagLabel).filter(Boolean);
      if (!rawTags.length) return;
      rawTags.forEach((label) => {
        const key = normalizedTagKey(label);
        if (!key) return;
        labels.set(key, labels.get(key) || label);
        if (!initialStates.has(key)) initialStates.set(key, 'none');
        currentStates.set(key, 'all');
      });
      searchField.value = '';
      renderTagEditor();
      searchField.focus();
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      backdrop.classList.add('hidden');
      form.removeEventListener('submit', submit);
      searchField.removeEventListener('input', renderTagEditor);
      searchField.removeEventListener('keydown', searchKeydown);
      searchField.removeEventListener('compositionstart', compositionStart);
      searchField.removeEventListener('compositionend', compositionEnd);
      addButton.removeEventListener('click', addInputTags);
      choices.removeEventListener('click', choiceClick);
      selectedPanel.removeEventListener('click', choiceClick);
      $('#tagDialogCancel').removeEventListener('click', cancel);
      $('#tagDialogClose').removeEventListener('click', cancel);
      backdrop.removeEventListener('click', outside);
      document.removeEventListener('keydown', dialogKeydown, true);
      resolve(result);
    };
    const submit = (event) => {
      event.preventDefault();
      const addTags = [];
      const removeTags = [];
      labels.forEach((label, key) => {
        const initial = initialStates.get(key) || 'none';
        const current = currentStates.get(key) || 'none';
        if (current === 'all' && initial !== 'all') addTags.push(label);
        if (current === 'none' && initial !== 'none') removeTags.push(label);
      });
      finish({ addTags, removeTags });
    };
    const cancel = () => finish(null);
    const outside = (event) => { if (event.target === backdrop) finish(null); };
    const choiceClick = (event) => {
      const button = event.target.closest('[data-tag-choice]');
      if (button) toggleTag(button.dataset.tagChoice);
    };
    const searchKeydown = (event) => {
      if (event.key === 'Enter' && event.metaKey) return;
      const spaceKey = event.key === ' ' || event.code === 'Space';
      const enterKey = event.key === 'Enter';
      if ((!enterKey && !spaceKey) || event.metaKey || event.ctrlKey || event.altKey) return;
      // 한글 IME 조합을 확정하는 키 입력은 태그 추가나 다이얼로그 적용으로 처리하지 않는다.
      if (tagInputComposing || event.isComposing || event.keyCode === 229) {
        // 한글 조합 중 누른 Space는 조합이 끝난 뒤 완성된 단어 전체를 추가한다.
        if (spaceKey) addAfterCompositionSpace = true;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (enterKey) {
        form.requestSubmit();
        return;
      }
      addInputTags();
    };
    const compositionStart = () => { tagInputComposing = true; };
    const compositionEnd = () => {
      tagInputComposing = false;
      renderTagEditor();
      if (!addAfterCompositionSpace) return;
      addAfterCompositionSpace = false;
      setTimeout(() => {
        if (!settled) addInputTags();
      }, 0);
    };
    const dialogKeydown = (event) => {
      if (event.key === 'Enter' && event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        form.requestSubmit();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase('ko') === 't') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const button = event.target.closest?.('[data-tag-choice]');
      if (button && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        event.stopPropagation();
        toggleTag(button.dataset.tagChoice);
      }
    };

    $('#tagDialogDescription').textContent = selectedSounds.length === 1
      ? `“${selectedSounds[0].title}”의 태그를 선택하세요. Space 또는 Enter로 연속 추가할 수 있습니다.`
      : `${selectedSounds.length}개 사운드의 태그를 함께 편집합니다. Space 또는 Enter로 연속 추가할 수 있습니다.`;
    searchField.value = '';
    backdrop.classList.remove('hidden');
    form.addEventListener('submit', submit);
    searchField.addEventListener('input', renderTagEditor);
    searchField.addEventListener('keydown', searchKeydown);
    searchField.addEventListener('compositionstart', compositionStart);
    searchField.addEventListener('compositionend', compositionEnd);
    addButton.addEventListener('click', addInputTags);
    choices.addEventListener('click', choiceClick);
    selectedPanel.addEventListener('click', choiceClick);
    $('#tagDialogCancel').addEventListener('click', cancel);
    $('#tagDialogClose').addEventListener('click', cancel);
    backdrop.addEventListener('click', outside);
    document.addEventListener('keydown', dialogKeydown, true);
    renderTagEditor();
    requestAnimationFrame(() => searchField.focus());
  });
}

async function moveSelectedToCategory() {
  const sound = selectedSound();
  if (!sound) return showToast('먼저 이동할 사운드를 선택해 주세요.');
  const category = await openInputDialog({
    title: '카테고리 폴더로 이동',
    description: `“${sound.title}” 파일을 이동할 기존 카테고리를 선택하세요. 마우스 휠·↑↓로 고르고 Space 또는 Enter를 누르세요.`,
    value: sound.categoryPath || sound.category || '', placeholder: '예: Trains/Horn', options: state.categoryPaths,
    navigateOptions: true,
    confirmWithSpace: true
  });
  if (!category) return;
  const existingCategory = state.categoryPaths.find((item) => item.normalize('NFC') === category.normalize('NFC'));
  if (!existingCategory) return showToast('목록에 있는 기존 카테고리 폴더만 선택할 수 있습니다.', 5000);
  showToast(`${existingCategory} 폴더로 파일 이동 중…`, 10000);
  const listPosition = captureListPosition([sound.id]);
  try {
    const snapshot = await window.soundLibrary.moveSoundToCategory({ id: sound.id, category: existingCategory });
    if (!snapshot) return;
    setLibrary(snapshot, { preserveListPosition: listPosition });
    showToast(`파일을 “${existingCategory}” 카테고리 폴더로 이동했습니다.`);
  } catch (error) {
    showToast(`이동 실패: ${error.message}`, 5000);
  }
}

async function editSelectedTags() {
  const ids = selectedIdList();
  if (!ids.length) return showToast('먼저 태그를 편집할 사운드를 선택해 주세요.');
  const changes = await openTagEditor(ids);
  if (!changes) return;
  if (!changes.addTags.length && !changes.removeTags.length) return showToast('변경된 태그가 없습니다.');
  setLibrary(await window.soundLibrary.updateSoundsBatch({ ids, ...changes }));
  showToast(`${ids.length}개 사운드의 태그를 저장했습니다.`);
}

function selectedIdList() {
  if (state.selectedIds.size) return [...state.selectedIds];
  return state.selectedId ? [state.selectedId] : [];
}

function soundIdsWithTag(tag, candidateIds = null) {
  const key = normalizedTagKey(tag);
  const candidates = candidateIds ? new Set(candidateIds) : null;
  return state.sounds
    .filter((sound) => (!candidates || candidates.has(sound.id))
      && (sound.tags || []).some((item) => normalizedTagKey(item) === key))
    .map((sound) => sound.id);
}

function tagRecordsForUndo(ids) {
  const selected = new Set(ids);
  return state.sounds
    .filter((sound) => selected.has(sound.id))
    .map((sound) => ({ id: sound.id, tags: [...(sound.tags || [])] }));
}

function renderTagManager() {
  const entries = tagUsageEntries();
  const query = normalizedTagKey(state.tagManagerQuery);
  const visible = entries.filter((entry) => !query || entry.key.includes(query));
  visible.sort((left, right) => state.tagManagerSort === 'name'
    ? left.label.localeCompare(right.label, 'ko')
    : right.count - left.count || left.label.localeCompare(right.label, 'ko'));
  $('#tagManagerSearch').value = state.tagManagerQuery;
  $('#tagManagerSort').value = state.tagManagerSort;
  $('#tagManagerSummary').textContent = `전체 ${entries.length}개 · 표시 ${visible.length}개 · 총 ${entries.reduce((sum, entry) => sum + entry.count, 0).toLocaleString()}회 사용`;
  $('#tagManagerUndo').disabled = !tagUndoSnapshot;
  $('#tagManagerUndo').textContent = tagUndoSnapshot ? `변경 취소 · ${tagUndoSnapshot.description}` : '마지막 변경 취소';
  $('#tagManagerList').innerHTML = visible.map((entry) => `<div class="tag-manager-row" data-tag-manager-tag="${escapeHtml(entry.label)}">
    <strong>#${escapeHtml(entry.label)}</strong><span class="tag-manager-count">${entry.count}개</span>
    <div class="tag-manager-actions"><button data-tag-manager-action="rename">변경</button></div>
  </div>`).join('') || '<div class="tag-choice-empty">일치하는 태그가 없습니다.</div>';
}

function openTagManager() {
  state.tagManagerQuery = '';
  $('#tagManagerDialog').classList.remove('hidden');
  renderTagManager();
  requestAnimationFrame(() => $('#tagManagerSearch').focus());
}

function closeTagManager() {
  $('#tagManagerDialog').classList.add('hidden');
}

async function commitTagChange(ids, changes, description) {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return showToast('변경할 사운드가 없습니다.');
  const before = tagRecordsForUndo(uniqueIds);
  try {
    const snapshot = await window.soundLibrary.updateSoundsBatch({ ids: uniqueIds, ...changes });
    tagUndoSnapshot = { items: before, description };
    setLibrary(snapshot);
    showToast(`${description} · ${uniqueIds.length}개 사운드에 반영했습니다.`);
  } catch (error) {
    showToast(`태그 변경 실패: ${error.message}`, 5000);
  }
}

async function renameManagedTag(tag) {
  const next = await openInputDialog({
    title: '태그 이름 변경',
    description: `#${tag} 태그가 붙은 모든 사운드에서 이름을 변경합니다. 이미 사용 중인 태그 이름은 선택할 수 없습니다.`,
    value: tag,
    placeholder: '새 태그 이름',
    options: tagUsageEntries().map((entry) => entry.label)
  });
  const cleaned = cleanTagLabel(next);
  if (!cleaned || cleaned === tag) return;
  const existing = tagUsageEntries().find((entry) => entry.key === normalizedTagKey(cleaned));
  if (existing && existing.key !== normalizedTagKey(tag)) {
    return showToast(`#${existing.label} 태그가 이미 있습니다. 다른 이름을 입력해 주세요.`, 5000);
  }
  await commitTagChange(soundIdsWithTag(tag), { addTags: [cleaned], removeTags: [tag] }, `#${tag} → #${cleaned}`);
}

async function undoLastTagChange() {
  if (!tagUndoSnapshot) return;
  const undo = tagUndoSnapshot;
  tagUndoSnapshot = null;
  try {
    setLibrary(await window.soundLibrary.setTagsBatch({ items: undo.items }));
    showToast(`${undo.description} 변경을 취소했습니다.`);
  } catch (error) {
    tagUndoSnapshot = undo;
    renderTagManager();
    showToast(`실행 취소 실패: ${error.message}`, 5000);
  }
}

async function addTagsToSelection() {
  return editSelectedTags();
}

async function moveSelectionToCategory() {
  const ids = selectedIdList();
  if (!ids.length) return showToast('먼저 사운드를 선택해 주세요.');
  const category = await openInputDialog({
    title: '선택 항목 카테고리 이동',
    description: `${ids.length}개 원본 파일을 이동할 기존 카테고리를 마우스 휠·↑↓로 고르고 Space 또는 Enter를 누르세요.`,
    placeholder: '목록에서 기존 폴더 선택',
    options: state.categoryPaths,
    navigateOptions: true,
    confirmWithSpace: true
  });
  if (!category) return;
  const existingCategory = state.categoryPaths.find((item) => item.normalize('NFC') === category.normalize('NFC'));
  if (!existingCategory) return showToast('목록에 있는 기존 카테고리 폴더만 선택할 수 있습니다.', 5000);
  showToast(`${ids.length}개 파일 이동 중…`, 20000);
  const listPosition = captureListPosition(ids);
  try {
    const snapshot = await window.soundLibrary.moveSoundsToCategory({ ids, category: existingCategory });
    setLibrary(snapshot, { preserveListPosition: listPosition });
    const movedCount = Number(snapshot.moveResult?.moved ?? ids.length);
    showToast(`${movedCount}개 파일을 이동했습니다.`);
  } catch (error) {
    showToast(`이동 실패: ${error.message}`, 5000);
  }
}

async function trashSelection() {
  const ids = selectedIdList();
  if (!ids.length) return;
  if (state.playingId && ids.includes(state.playingId)) pausePreviewPlayback();
  const listPosition = captureListPosition(ids);
  showToast(`${ids.length}개 파일을 휴지통으로 이동하는 중…`, 15000);
  try {
    const snapshot = await window.soundLibrary.removeSoundsBatch({ ids });
    state.inspectorOpen = false;
    setLibrary(snapshot, { preserveListPosition: listPosition });
    showToast(`${ids.length}개 파일을 휴지통으로 이동했습니다.`);
  } catch (error) {
    showToast(`삭제 실패: ${error.message}`, 5000);
  }
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

async function createCategoryFolder(parentCategory = '') {
  const rootLevel = !parentCategory || parentCategory === '미분류';
  const vaultName = state.vault?.name || '현재 볼트';
  const name = await openInputDialog({
    title: rootLevel ? '새 최상위 카테고리' : '새 하위 폴더',
    description: rootLevel
      ? `“${vaultName}” 바로 아래에 만들 최상위 폴더 이름을 입력하세요.`
      : `“${parentCategory}” 안에 만들 하위 폴더 이름을 입력하세요.`,
    placeholder: rootLevel ? '새 최상위 폴더' : '새 하위 폴더'
  });
  if (!name) return;
  try {
    setLibrary(await window.soundLibrary.createCategoryFolder({ parentCategory: rootLevel ? '' : parentCategory, name }));
    if (!rootLevel) state.collapsedCategories.delete(parentCategory);
    renderSidebar();
    showToast(rootLevel ? '새 최상위 카테고리 폴더를 만들었습니다.' : '새 하위 폴더를 만들었습니다.');
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

async function trashSelectedCategories() {
  const categories = pruneNestedCategories([...state.selectedCategories]);
  if (!categories.length) return;
  try {
    if (state.filter.startsWith('category:')) {
      const current = state.filter.slice(9);
      if (categories.some((category) => current === category || current.startsWith(`${category}/`))) state.filter = 'all';
    }
    state.selectedCategories.clear();
    state.categoryAnchor = null;
    setLibrary(await window.soundLibrary.trashCategoryFolders(categories));
    showToast(`${categories.length}개 폴더를 휴지통으로 이동했습니다.`);
  } catch (error) {
    showToast(`폴더 삭제 실패: ${error.message}`, 5000);
  }
}

async function trashCategory(category) {
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
      showToast('파일을 폴더로 이동했습니다.');
    }
  } catch (error) {
    showToast(`파일 추가 실패: ${error.message}`, 5000);
  }
}

let contextTarget = null;

function currentKeyAnalysis(sound) {
  const analysis = sound?.keyAnalysis;
  if (!analysis || Number(analysis.sourceModifiedAt) !== Number(sound.modifiedAt)) return null;
  return analysis;
}

function keyConfidenceLabel(confidence) {
  const value = Number(confidence || 0);
  if (value >= 0.75) return '높음';
  if (value >= 0.52) return '보통';
  return '낮음';
}

function signedPitchValue(value, digits = 0) {
  const number = Number(value || 0);
  const normalized = Math.abs(number) < (0.5 * (10 ** -digits)) ? 0 : number;
  return `${normalized > 0 ? '+' : ''}${normalized.toFixed(digits)}`;
}

function renderPitchTargetGuide(analysis) {
  const select = $('#pitchTargetKey');
  const output = $('#pitchGuideOutput');
  if (!select || !output || !window.PitchGuide) return;
  const sourceIndex = window.PitchGuide.sourceIndexForKey(analysis.key);
  if (sourceIndex < 0) {
    output.textContent = '분석된 기준음을 피치 계산에 사용할 수 없습니다.';
    return;
  }
  const update = () => {
    const [targetIndex, targetMode] = select.value.split(':');
    const guide = window.PitchGuide.calculatePitchGuide({
      sourceIndex,
      sourceMode: analysis.mode,
      tuningCents: analysis.tuningCents,
      targetIndex: Number(targetIndex),
      targetMode
    });
    const direction = guide.totalCents > 0 ? '올리기' : guide.totalCents < 0 ? '내리기' : '조절 없음';
    output.innerHTML = `
      <div class="pitch-guide-summary"><strong>${direction}</strong><span>가장 가까운 음정으로 이동</span></div>
      <div class="pitch-guide-values">
        <div><span>Pitch</span><b>${signedPitchValue(guide.pitchSemitones)} semitone</b></div>
        <div><span>Cents</span><b>${signedPitchValue(guide.fineCents, 1)} cent</b></div>
        <div><span>총 이동량</span><b>${signedPitchValue(guide.totalSemitones, 3)} semitone</b></div>
      </div>
      ${guide.modeMismatch ? '<p class="pitch-guide-warning">목표의 장·단조가 다릅니다. 피치 조절은 기준음만 맞추며 Major와 Minor의 성격 자체는 바꾸지 못합니다.</p>' : ''}
      ${Number(analysis.confidence || 0) < 0.52 ? '<p class="pitch-guide-warning">분석 신뢰도가 낮습니다. BGM과 함께 들어보고 ±1 semitone 주변도 비교해 보세요.</p>' : ''}`;
  };
  select.addEventListener('change', update);
  update();
}

function showKeyAnalysisResult(sound, analysis) {
  const confidence = Math.round(Number(analysis?.confidence || 0) * 100);
  $('#resultsTitle').textContent = '사운드 조성(Key) 분석';
  if (analysis?.detected) {
    $('#resultsContent').innerHTML = `
      <div class="key-result">
        <div class="key-result-name">${escapeHtml(analysis.display)}</div>
        <div class="key-result-korean">${escapeHtml(analysis.korean)} · Camelot ${escapeHtml(analysis.camelot)}</div>
        <div class="key-metrics">
          <div><span>신뢰도</span><b>${confidence}% · ${keyConfidenceLabel(analysis.confidence)}</b></div>
          <div><span>튜닝 편차</span><b>${Number(analysis.tuningCents || 0) >= 0 ? '+' : ''}${Number(analysis.tuningCents || 0).toFixed(1)} cent</b></div>
          <div><span>분석 대상</span><b>${escapeHtml(sound.title)}</b></div>
        </div>
        <p class="key-explanation">장·단조 프로파일, 코드 구성음, 시간대별 음정 안정성과 잡음 비율을 함께 분석한 결과입니다.</p>
        <div class="key-alternatives"><strong>가까운 후보</strong>${(analysis.alternatives || []).map((candidate) => `<span>${escapeHtml(candidate.display)} · ${escapeHtml(candidate.camelot)}</span>`).join('')}</div>
        <section class="pitch-target-guide">
          <div class="pitch-target-heading"><div><strong>BGM 목표 조성에 맞추기</strong><small>목표 Key를 선택하면 Pitch와 Cents 조절값을 계산합니다.</small></div>
            <select id="pitchTargetKey">${window.PitchGuide.targetKeys().map((target) => `<option value="${target.index}:${target.mode}" ${target.index === window.PitchGuide.sourceIndexForKey(analysis.key) && target.mode === analysis.mode ? 'selected' : ''}>${escapeHtml(target.display)} · ${escapeHtml(target.korean)} · ${target.camelot}</option>`).join('')}</select>
          </div>
          <div id="pitchGuideOutput"></div>
        </section>
      </div>`;
    renderPitchTargetGuide(analysis);
  } else {
    $('#resultsContent').innerHTML = `
      <div class="key-result uncertain">
        <div class="key-result-name">조성 불명확</div>
        <div class="key-result-korean">${escapeHtml(analysis?.reason || '이 사운드에서 안정적인 조성을 찾지 못했습니다.')}</div>
        <div class="key-metrics"><div><span>추정 신뢰도</span><b>${confidence}% · 낮음</b></div><div><span>분석 대상</span><b>${escapeHtml(sound.title)}</b></div></div>
        <p class="key-explanation">충격음·노이즈·짧은 효과음에는 음악적인 Key가 없을 수 있으므로 임의의 조성을 표시하지 않습니다.</p>
        ${(analysis?.alternatives || []).length ? `<div class="key-alternatives"><strong>참고 후보(미확정)</strong>${analysis.alternatives.map((candidate) => `<span>${escapeHtml(candidate.display)} · ${escapeHtml(candidate.camelot)}</span>`).join('')}</div>` : ''}
      </div>`;
  }
  $('#resultsDialog').classList.remove('hidden');
}

async function analyzeSelectedKey(force = true) {
  const sound = selectedSound();
  if (!sound) return showToast('먼저 조성을 분석할 사운드를 선택해 주세요.');
  if (sound.missing) return showToast('원본 파일을 찾을 수 없습니다.');
  showToast('조성(Key)을 분석하는 중… 긴 BGM은 시간이 조금 걸릴 수 있습니다.', 240000);
  try {
    const snapshot = await window.soundLibrary.analyzeKey({ id: sound.id, force });
    const analysis = snapshot.keyAnalysisResult?.analysis;
    setLibrary(snapshot);
    const updated = state.sounds.find((item) => item.id === sound.id) || sound;
    showKeyAnalysisResult(updated, analysis);
    showToast(analysis.detected ? `${analysis.display} · 신뢰도 ${Math.round(analysis.confidence * 100)}%` : '안정적인 조성을 찾지 못했습니다.', 6000);
  } catch (error) {
    showToast(error.message, 7000);
  }
}

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
      <button data-context-action="new-folder">${protectedRoot ? '새 최상위 폴더' : '새 하위 폴더'}</button>
      <button data-context-action="add-files">이 폴더에 파일 추가…</button>
      <button data-context-action="reveal-category">Finder에서 보기</button>
      ${!protectedRoot && target.category.includes('/') ? '<button data-context-action="move-category-up">상위 폴더로 한 단계 이동</button>' : ''}
      ${protectedRoot ? '' : '<div class="separator"></div><button data-context-action="rename-category">이름 변경…</button><button class="danger" data-context-action="trash-category">폴더를 휴지통으로</button>'}
      ${state.selectedCategories.size > 1 && state.selectedCategories.has(target.category)
        ? `<div class="separator"></div><button class="danger" data-context-action="trash-selected-categories">선택한 ${state.selectedCategories.size}개 폴더를 휴지통으로</button>`
        : ''}`;
  } else if (target.type === 'tag') {
    const count = soundIdsWithTag(target.tag).length;
    menu.innerHTML = `
      <div class="context-menu-label">#${escapeHtml(target.tag)} · ${count}개 사운드</div>
      <button data-context-action="rename-tag">태그 이름 전체 변경…</button>
      <button data-context-action="manage-tags">태그 이름 관리…</button>`;
  } else {
    const targetSound = state.sounds.find((sound) => sound.id === target.id);
    const keyAnalysis = currentKeyAnalysis(targetSound);
    const selectedSoundCount = state.selectedIds.has(target.id) ? state.selectedIds.size : 1;
    menu.innerHTML = `
      ${targetSound?.missing ? '<button data-context-action="relink-sound">누락 파일 재연결…</button><div class="separator"></div>' : ''}
      ${keyAnalysis ? `<button data-context-action="view-key">조성(Key): ${escapeHtml(keyAnalysis.detected ? `${keyAnalysis.display} · ${Math.round(keyAnalysis.confidence * 100)}%` : '불명확')}</button><button data-context-action="analyze-key">조성 다시 분석…</button><div class="separator"></div>` : '<button data-context-action="analyze-key">조성(Key) 분석…</button><div class="separator"></div>'}
      <button data-context-action="rename-sound">이름 변경…</button>
      <button data-context-action="move-category">카테고리 폴더로 이동…</button>
      <button data-context-action="move-folder">다른 폴더로 이동…</button>
      <button data-context-action="reveal-sound">Finder에서 보기</button>
      <div class="separator"></div><button class="danger" data-context-action="trash-sound">${selectedSoundCount > 1 ? `선택한 ${selectedSoundCount}개 파일을 휴지통으로` : '원본 파일을 휴지통으로'}</button>`;
  }
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - rect.height - 8)}px`;
}

async function trashSelected() {
  return trashSelection();
}

async function toggleFavoriteSelected() {
  const ids = selectedIdList();
  if (!ids.length) return showToast('먼저 사운드를 선택해 주세요.');
  const selected = state.sounds.filter((sound) => ids.includes(sound.id));
  const favorite = !selected.every((sound) => sound.favorite);
  try {
    setLibrary(await window.soundLibrary.updateSoundsBatch({ ids, updates: { favorite } }));
  } catch (error) {
    showToast(`즐겨찾기 변경 실패: ${error.message}`, 4000);
  }
}

async function updateRatingsWithoutReordering(ids, rating) {
  const soundIds = [...new Set(ids || [])].filter((id) => state.sounds.some((sound) => sound.id === id));
  if (!soundIds.length) return null;
  const listPosition = captureListPosition(soundIds);
  const previousFrozenOrder = state.frozenRatingOrder;
  freezeRatingSortOrder();
  try {
    const snapshot = await window.soundLibrary.updateSoundsBatch({ ids: soundIds, updates: { rating } });
    setLibrary(snapshot, { preserveListPosition: listPosition });
    return snapshot;
  } catch (error) {
    state.frozenRatingOrder = previousFrozenOrder;
    throw error;
  }
}

async function setSelectedRating(rating) {
  const ids = selectedIdList();
  if (!ids.length) return showToast('별점을 지정할 사운드를 먼저 선택해 주세요.');
  const value = Math.max(1, Math.min(5, Number(rating) || 1));
  try {
    await updateRatingsWithoutReordering(ids, value);
    showToast(ids.length === 1
      ? `별점 ${value}점을 지정했습니다.`
      : `${ids.length}개 사운드에 별점 ${value}점을 지정했습니다.`);
  } catch (error) {
    showToast(`별점 지정 실패: ${error.message}`, 5000);
  }
}

function openSettings() {
  state.view = 'settings';
  state.inspectorOpen = false;
  render();
}

async function insertSelectedIntoResolve() {
  const sound = selectedSound();
  if (!sound) return showToast('먼저 Fairlight로 보낼 사운드를 선택해 주세요.');
  if (sound.missing) return showToast('원본 파일을 찾을 수 없습니다.');
  const selection = state.selections.get(sound.id);
  const hasRange = selection && selection.end - selection.start >= 0.05;
  showToast(hasRange ? '선택 구간을 Fairlight 타임헤드에 삽입 중…' : 'Fairlight 타임헤드에 삽입 중…', 15000);
  let payload = { path: sound.path, duration: sound.duration, sampleRate: sound.sampleRate };
  if (hasRange) {
    const clip = await window.soundLibrary.prepareClip({ id: sound.id, start: selection.start, end: selection.end });
    if (!clip.ok) return showToast(clip.message, 5000);
    payload = { path: clip.path, duration: clip.duration, sampleRate: sound.sampleRate };
  }
  const result = await window.soundLibrary.insertIntoResolve(payload);
  showToast(result.message, result.ok ? 2200 : 6000);
}

function fileNameWithoutExtension(fileName) {
  return String(fileName || '').replace(/\.[^.]+$/, '');
}

async function renameSelectedSound() {
  const sound = selectedSound();
  if (!sound) return showToast('먼저 이름을 바꿀 사운드를 선택해 주세요.');
  if (sound.missing) return showToast('원본 파일을 찾을 수 없습니다.');
  const currentName = fileNameWithoutExtension(sound.fileName);
  const name = await openInputDialog({
    title: '사운드 이름 변경',
    description: '기존 이름 후보를 클릭하면 중복 여부를 미리 들을 수 있습니다. 실제 파일명도 함께 변경됩니다.',
    value: currentName,
    placeholder: '새 사운드 이름',
    suggestions: state.sounds.filter((item) => item.id !== sound.id).map((item) => ({
      id: item.id,
      name: fileNameWithoutExtension(item.fileName || item.title),
      category: item.categoryPath || item.category || '미분류',
      missing: Boolean(item.missing)
    })),
    confirmWithShiftSpace: true
  });
  if (!name || name === currentName) return;
  const previousFrozenOrder = state.frozenTitleOrder;
  freezeTitleSortOrder();
  const listPosition = captureListPosition([sound.id]);
  try {
    const snapshot = await window.soundLibrary.renameSound({ id: sound.id, name });
    setLibrary(snapshot, { preserveListPosition: listPosition });
    showToast('이름을 변경했습니다. 정렬 버튼을 누르기 전까지 현재 위치를 유지합니다.');
  } catch (error) {
    state.frozenTitleOrder = previousFrozenOrder;
    showToast(`이름 변경 실패: ${error.message}`, 5000);
  }
}

async function runShortcut(action) {
  if (action === 'search') {
    clearTimeout(searchDebounce);
    searchKeyboardNavigation = false;
    state.categoryKeyboardMode = false;
    state.categoryKeyboardPath = null;
    state.view = 'library';
    state.query = '';
    $('#searchInput').value = '';
    list.scrollTop = 0;
    render();
    $('#searchInput').focus();
  } else if (action === 'moveCategory') await moveSelectionToCategory();
  else if (action === 'editTags') await editSelectedTags();
  else if (action === 'addFiles') setLibrary(await window.soundLibrary.addFiles());
  else if (action === 'addFolder') setLibrary(await window.soundLibrary.addFolder());
  else if (action === 'trash') await trashSelected();
  else if (action === 'reveal') { const sound = selectedSound(); if (sound) window.soundLibrary.reveal(sound.path); }
  else if (action === 'favorite') await toggleFavoriteSelected();
  else if (action === 'settings') openSettings();
  else if (action === 'playPause') toggleSelectedPlayback();
  else if (action === 'renameSound') await renameSelectedSound();
  else if (action === 'insertResolve') await insertSelectedIntoResolve();
  else if (action === 'newSubfolder') {
    const parent = state.filter.startsWith('category:') ? state.filter.slice(9) : '';
    await createCategoryFolder(parent);
  }
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
    try {
      await updateRatingsWithoutReordering([sound.id], nextRating);
    } catch (error) {
      showToast(`별점 지정 실패: ${error.message}`, 5000);
    }
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

let internalNativeDrag = false;
let internalDragResetTimer = null;
let internalDraggedCategories = [];
let internalDraggedSoundIds = [];
const CATEGORY_DRAG_TYPE = 'application/x-sound-shelf-categories';

function markInternalNativeDrag(kind = 'sound') {
  internalNativeDrag = kind;
  clearTimeout(internalDragResetTimer);
  internalDragResetTimer = setTimeout(() => { internalNativeDrag = false; }, 30000);
}

function clearInternalNativeDrag() {
  internalNativeDrag = false;
  internalDraggedCategories = [];
  internalDraggedSoundIds = [];
  clearTimeout(internalDragResetTimer);
  internalDragResetTimer = null;
}

list.addEventListener('dragstart', (event) => {
  const row = event.target.closest('.sound-row');
  if (!row) return event.preventDefault();
  const sound = state.sounds.find((item) => item.id === row.dataset.id);
  event.preventDefault();
  if (!sound?.missing) {
    const draggedSounds = state.selectedIds.size > 1 && state.selectedIds.has(sound.id)
      ? state.sounds.filter((item) => state.selectedIds.has(item.id) && !item.missing)
      : [sound];
    internalDraggedSoundIds = draggedSounds.map((item) => item.id);
    markInternalNativeDrag();
    window.soundLibrary.startDrag(draggedSounds.map((item) => item.path));
  }
});

$('#categoryList').addEventListener('dragstart', (event) => {
  const row = event.target.closest('[data-category-row]');
  if (!row) return event.preventDefault();
  const dragged = row.dataset.categoryRow;
  const categories = state.selectedCategories.size > 1 && state.selectedCategories.has(dragged)
    ? pruneNestedCategories([...state.selectedCategories])
    : [dragged];
  internalDraggedCategories = categories;
  markInternalNativeDrag('category');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(CATEGORY_DRAG_TYPE, JSON.stringify(categories));
  event.dataTransfer.setData('text/plain', categories.join('\n'));
  if (event.dataTransfer.setDragImage) event.dataTransfer.setDragImage(row, 18, Math.min(18, row.clientHeight / 2));
  row.classList.add('dragging');
});

document.addEventListener('contextmenu', (event) => {
  const tagButton = event.target.closest('#tagList [data-tag]');
  if (tagButton) return showContextMenu(event, { type: 'tag', tag: tagButton.dataset.tag });
  const categoryRow = event.target.closest('[data-category-row]');
  if (categoryRow) {
    if (state.selectedCategories.size && !state.selectedCategories.has(categoryRow.dataset.categoryRow)) {
      state.selectedCategories.clear();
      renderSidebar();
    }
    return showContextMenu(event, { type: 'category', category: categoryRow.dataset.categoryRow });
  }
  if (event.target.closest('[data-root-drop]')) return showContextMenu(event, { type: 'category', category: '미분류' });
  if (event.target.closest('#categoryList')) return showContextMenu(event, { type: 'category', category: '미분류' });
  const soundRow = event.target.closest('.sound-row');
  if (soundRow) {
    state.selectedId = soundRow.dataset.id;
    if (!state.selectedIds.has(soundRow.dataset.id)) {
      state.selectedIds = new Set([soundRow.dataset.id]);
      state.selectionAnchorId = soundRow.dataset.id;
      renderVirtualRows();
      updateBatchToolbar();
    }
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
  const scrubbing = Boolean(event.target.closest('#detailPlayhead'));
  selectionGesture = {
    id: sound.id,
    pointerId: event.pointerId,
    startRatio: ratio,
    startX: event.clientX,
    mode: scrubbing ? 'scrub' : 'pending',
    ratio
  };
  if (scrubbing) {
    pausePreviewPlayback();
    $('#detailPlayhead').classList.add('scrubbing');
  }
  detailWrap.setPointerCapture(event.pointerId);
});

detailWrap.addEventListener('pointermove', (event) => {
  if (!selectionGesture || event.pointerId !== selectionGesture.pointerId) return;
  const sound = selectedSound();
  if (!sound || sound.id !== selectionGesture.id) return;
  const ratio = waveformRatio(event);
  selectionGesture.ratio = ratio;
  if (selectionGesture.mode === 'scrub') {
    $('#detailCurrentTime').textContent = formatDetailedDuration(ratio * sound.duration);
    $('#detailPlayhead').style.left = `${ratio * 100}%`;
    return;
  }
  if (selectionGesture.mode === 'pending' && Math.abs(event.clientX - selectionGesture.startX) < 5) return;
  selectionGesture.mode = 'selection';
  const start = Math.min(selectionGesture.startRatio, ratio) * sound.duration;
  const end = Math.max(selectionGesture.startRatio, ratio) * sound.duration;
  state.selections.set(sound.id, { start, end, path: '', dragPath: '', preparing: false });
  updateDetailSelection();
});

detailWrap.addEventListener('pointerup', async (event) => {
  if (!selectionGesture || event.pointerId !== selectionGesture.pointerId) return;
  const sound = selectedSound();
  const gesture = selectionGesture;
  if (detailWrap.hasPointerCapture(event.pointerId)) detailWrap.releasePointerCapture(event.pointerId);
  selectionGesture = null;
  $('#detailPlayhead').classList.remove('scrubbing');
  if (!sound) return;
  if (gesture.mode === 'scrub' || gesture.mode === 'pending') {
    state.selections.delete(sound.id);
    updateDetailSelection();
    await seekAndPlay(sound, gesture.ratio * sound.duration);
    return;
  }
  const selection = state.selections.get(sound.id);
  if (!selection) return;
  if (selection.end - selection.start < 0.05) {
    state.selections.delete(sound.id);
    updateDetailSelection();
    return;
  }
  await playSelection(sound, selection);
  const result = await prepareSelectionForDrag(sound, selection);
  if (result.ok) showToast('선택 구간 준비 완료 · 표시된 영역을 DaVinci Resolve로 드래그하세요.', 2600);
  else showToast(result.message, 5000);
});

detailWrap.addEventListener('pointercancel', () => {
  selectionGesture = null;
  $('#detailPlayhead').classList.remove('scrubbing');
  updateTransportDisplay();
});
detailSelection.addEventListener('click', () => {
  const sound = selectedSound();
  if (sound) playSelection(sound, state.selections.get(sound.id));
});
detailSelection.addEventListener('dragstart', (event) => {
  event.preventDefault();
  const sound = selectedSound();
  const selection = sound ? state.selections.get(sound.id) : null;
  if (!sound || !selection || selection.end - selection.start < 0.05) return;
  const clipPath = selection.path || selection.dragPath;
  if (!clipPath) return showToast('선택 구간을 준비하는 중입니다. 잠시 후 다시 드래그해 주세요.', 2600);
  markInternalNativeDrag('range');
  window.soundLibrary.startDrag(clipPath);
  showToast('선택 구간을 DaVinci Resolve에 놓으세요.', 3000);
});

function visibleCategoryOrder() {
  return [...document.querySelectorAll('#categoryList [data-category-row]')].map((row) => row.dataset.categoryRow);
}

function revealCategoryAncestors(categoryPath) {
  const parts = String(categoryPath || '').split('/').filter(Boolean);
  for (let index = 1; index < parts.length; index += 1) {
    state.collapsedCategories.delete(parts.slice(0, index).join('/'));
  }
}

function enterCategoryKeyboardNavigation() {
  let categoryPath = state.filter.startsWith('category:') ? state.filter.slice(9) : '';
  if (!state.categoryPaths.includes(categoryPath)) {
    const sound = selectedSound();
    categoryPath = sound?.categoryPath || sound?.category || '';
  }
  if (!state.categoryPaths.includes(categoryPath)) categoryPath = state.categoryPaths[0] || null;
  if (!categoryPath) return false;
  revealCategoryAncestors(categoryPath);
  state.categoryKeyboardMode = true;
  state.categoryKeyboardPath = categoryPath;
  searchKeyboardNavigation = false;
  renderSidebar();
  return true;
}

function selectKeyboardCategory(categoryPath) {
  if (!state.categoryPaths.includes(categoryPath)) return;
  state.categoryKeyboardPath = categoryPath;
  state.view = 'library';
  state.filter = `category:${categoryPath}`;
  state.tagFilters.clear();
  state.selectedCategories.clear();
  state.categoryAnchor = categoryPath;
  list.scrollTop = 0;
  render();
}

function leaveCategoryKeyboardNavigation() {
  state.categoryKeyboardMode = false;
  state.categoryKeyboardPath = null;
  if (!state.visibleSounds.some((sound) => sound.id === state.selectedId)) {
    const sound = state.visibleSounds[0] || null;
    state.selectedId = sound?.id || null;
    state.selectedIds = sound ? new Set([sound.id]) : new Set();
    state.selectionAnchorId = sound?.id || null;
  }
  render();
}

function moveCategorySelectionWithArrow(direction) {
  const order = visibleCategoryOrder();
  if (!order.length) return;
  const current = order.indexOf(state.categoryKeyboardPath);
  const nextIndex = current < 0
    ? (direction > 0 ? 0 : order.length - 1)
    : Math.max(0, Math.min(order.length - 1, current + direction));
  selectKeyboardCategory(order[nextIndex]);
}

function navigateCategoryHorizontally(direction) {
  const categoryPath = state.categoryKeyboardPath;
  if (!categoryPath) return;
  const hasChildren = state.categoryPaths.some((category) => category.startsWith(`${categoryPath}/`));
  if (direction < 0) {
    if (hasChildren && !state.collapsedCategories.has(categoryPath)) {
      state.collapsedCategories.add(categoryPath);
      renderSidebar();
      return;
    }
    const separator = categoryPath.lastIndexOf('/');
    if (separator >= 0) selectKeyboardCategory(categoryPath.slice(0, separator));
    return;
  }
  if (hasChildren) {
    if (state.collapsedCategories.has(categoryPath)) {
      state.collapsedCategories.delete(categoryPath);
      renderSidebar();
      return;
    }
    const next = visibleCategoryOrder().find((category) => category.startsWith(`${categoryPath}/`));
    if (next) selectKeyboardCategory(next);
    return;
  }
  leaveCategoryKeyboardNavigation();
}

function pruneNestedCategories(paths) {
  return paths.filter((candidate) => !paths.some((other) => other !== candidate && candidate.startsWith(`${other}/`)));
}

function clearCategorySelection() {
  if (!state.selectedCategories.size) return;
  state.selectedCategories.clear();
  renderSidebar();
}

function toggleCategorySelection(categoryPath, { range = false } = {}) {
  if (categoryPath === '미분류') return;
  if (range) {
    const order = visibleCategoryOrder();
    const anchor = state.categoryAnchor && order.includes(state.categoryAnchor) ? state.categoryAnchor : categoryPath;
    const start = order.indexOf(anchor);
    const end = order.indexOf(categoryPath);
    if (start < 0 || end < 0) return;
    const [from, to] = start <= end ? [start, end] : [end, start];
    state.selectedCategories = new Set(order.slice(from, to + 1).filter((item) => item !== '미분류'));
    if (!order.includes(state.categoryAnchor)) state.categoryAnchor = anchor;
  } else {
    if (state.selectedCategories.has(categoryPath)) state.selectedCategories.delete(categoryPath);
    else state.selectedCategories.add(categoryPath);
    state.categoryAnchor = categoryPath;
  }
  renderSidebar();
}

function toggleCategoryCollapse(categoryPath) {
  const hasChildren = state.categoryPaths.some((category) => category.startsWith(`${categoryPath}/`));
  if (!hasChildren) return;
  if (state.collapsedCategories.has(categoryPath)) state.collapsedCategories.delete(categoryPath);
  else state.collapsedCategories.add(categoryPath);
  renderSidebar();
}

document.addEventListener('click', (event) => {
  if (state.categoryKeyboardMode) {
    state.categoryKeyboardMode = false;
    state.categoryKeyboardPath = null;
    requestAnimationFrame(renderSidebar);
  }
  const filterButton = event.target.closest('[data-filter]');
  const categoryButton = event.target.closest('[data-category]');
  const categoryToggle = event.target.closest('[data-category-toggle]');
  const tagButton = event.target.closest('[data-tag]');
  const categoryRowEl = event.target.closest('[data-category-row]');
  const multiSelectClick = categoryRowEl && !categoryToggle && (event.shiftKey || event.metaKey);
  if (multiSelectClick) {
    event.preventDefault();
    toggleCategorySelection(categoryRowEl.dataset.categoryRow, { range: event.shiftKey });
    if (!event.target.closest('#contextMenu')) hideContextMenu();
    return;
  }
  if (state.selectedCategories.size && !event.target.closest('#categoryList') && !event.target.closest('#contextMenu')) {
    clearCategorySelection();
  }
  if (filterButton) {
    state.view = 'library';
    state.filter = filterButton.dataset.filter;
    state.tagFilters.clear();
    list.scrollTop = 0;
    render();
  }
  if (categoryToggle) {
    toggleCategoryCollapse(categoryToggle.dataset.categoryToggle);
  }
  if (categoryButton) {
    state.view = 'library';
    state.filter = `category:${categoryButton.dataset.category}`;
    state.tagFilters.clear();
    state.selectedCategories.clear();
    state.categoryAnchor = categoryButton.dataset.category;
    list.scrollTop = 0;
    render();
  }
  if (tagButton) {
    const tag = tagButton.dataset.tag;
    const existing = [...state.tagFilters].find((item) => normalizedTagKey(item) === normalizedTagKey(tag));
    if (event.metaKey || event.ctrlKey) {
      if (existing) state.tagFilters.delete(existing);
      else state.tagFilters.add(tag);
    } else if (existing && state.tagFilters.size === 1) state.tagFilters.clear();
    else state.tagFilters = new Set([tag]);
    state.view = 'library';
    state.filter = 'all';
    list.scrollTop = 0;
    render();
  }
  if (!event.target.closest('#contextMenu')) hideContextMenu();
});

$('#tagPanelToggle').addEventListener('click', () => {
  state.tagPanelCollapsed = !state.tagPanelCollapsed;
  localStorage.setItem('sound-shelf-tag-panel-collapsed', String(state.tagPanelCollapsed));
  renderTagPanel();
});

$('#manageTagsBtn').addEventListener('click', (event) => {
  event.stopPropagation();
  openTagManager();
});
$('#tagManagerUndo').addEventListener('click', undoLastTagChange);
$('#tagManagerSearch').addEventListener('input', (event) => {
  state.tagManagerQuery = event.target.value;
  renderTagManager();
  $('#tagManagerSearch').focus();
});
$('#tagManagerSort').addEventListener('change', (event) => {
  state.tagManagerSort = event.target.value;
  renderTagManager();
});
$('#tagManagerList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tag-manager-action]');
  const row = event.target.closest('[data-tag-manager-tag]');
  if (!button || !row) return;
  const tag = row.dataset.tagManagerTag;
  const action = button.dataset.tagManagerAction;
  if (action === 'rename') renameManagedTag(tag);
});
$('#tagManagerClose').addEventListener('click', closeTagManager);
$('#tagManagerDialog').addEventListener('click', (event) => {
  if (event.target === $('#tagManagerDialog')) closeTagManager();
});
$('#tagManagerDialog').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeTagManager();
  }
});

$('#tagFilterInput').addEventListener('input', (event) => {
  state.tagPanelQuery = event.target.value;
  renderTagPanel();
  $('#tagFilterInput').focus();
});

$('#tagPanelResizer').addEventListener('pointerdown', (event) => {
  if (state.tagPanelCollapsed) return;
  event.preventDefault();
  tagPanelResizeGesture = { pointerId: event.pointerId, startY: event.clientY, startHeight: state.tagPanelHeight };
  event.currentTarget.classList.add('resizing');
  event.currentTarget.setPointerCapture(event.pointerId);
});

$('#tagPanelResizer').addEventListener('pointermove', (event) => {
  if (!tagPanelResizeGesture || event.pointerId !== tagPanelResizeGesture.pointerId) return;
  const maximum = Math.max(180, Math.floor($('.sidebar').clientHeight * 0.55));
  state.tagPanelHeight = Math.max(140, Math.min(maximum, tagPanelResizeGesture.startHeight + tagPanelResizeGesture.startY - event.clientY));
  $('#tagDock').style.setProperty('--tag-panel-height', `${state.tagPanelHeight}px`);
});

const finishTagPanelResize = (event) => {
  if (!tagPanelResizeGesture || event.pointerId !== tagPanelResizeGesture.pointerId) return;
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  event.currentTarget.classList.remove('resizing');
  tagPanelResizeGesture = null;
  localStorage.setItem('sound-shelf-tag-panel-height', String(Math.round(state.tagPanelHeight)));
};
$('#tagPanelResizer').addEventListener('pointerup', finishTagPanelResize);
$('#tagPanelResizer').addEventListener('pointercancel', finishTagPanelResize);

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
    if (action === 'new-folder') return createCategoryFolder(target.category);
    if (action === 'add-files') return addFilesToCategory(target.category);
    if (action === 'rename-category') return renameCategory(target.category);
    if (action === 'move-category-up') {
      try {
        setLibrary(await window.soundLibrary.moveCategoryUp(target.category));
        showToast('폴더를 상위 단계로 이동했습니다.');
      } catch (error) {
        showToast(`폴더 이동 실패: ${error.message}`, 5000);
      }
      return;
    }
    if (action === 'trash-category') return trashCategory(target.category);
    if (action === 'trash-selected-categories') return trashSelectedCategories();
    if (action === 'reveal-category') {
      try { await window.soundLibrary.revealCategoryFolder(target.category); } catch (error) { showToast(error.message, 4000); }
    }
    return;
  }
  if (target.type === 'tag') {
    if (action === 'rename-tag') return renameManagedTag(target.tag);
    if (action === 'manage-tags') return openTagManager();
    return;
  }
  const keepMultipleSelection = action === 'trash-sound'
    && state.selectedIds.size > 1
    && state.selectedIds.has(target.id);
  state.selectedId = target.id;
  if (!keepMultipleSelection) state.selectedIds = new Set([target.id]);
  if (action === 'relink-sound') {
    const snapshot = await window.soundLibrary.relinkOne(target.id);
    if (snapshot) { setLibrary(snapshot); showToast('원본 파일을 재연결했습니다.'); }
    return;
  }
  if (action === 'view-key') {
    const sound = selectedSound();
    const analysis = currentKeyAnalysis(sound);
    if (analysis) showKeyAnalysisResult(sound, analysis);
    return;
  }
  if (action === 'analyze-key') return analyzeSelectedKey(true);
  if (action === 'rename-sound') return renameSelectedSound();
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
  searchKeyboardNavigation = false;
  state.categoryKeyboardMode = false;
  state.categoryKeyboardPath = null;
  const value = event.target.value;
  searchDebounce = setTimeout(() => { state.query = value; list.scrollTop = 0; renderList(); }, 130);
});
function applyCurrentSort({ resetScroll = false } = {}) {
  state.frozenTitleOrder = null;
  state.frozenRatingOrder = null;
  if (resetScroll) list.scrollTop = 0;
  renderList();
}

$('#sortSelect').addEventListener('change', (event) => {
  state.sortBy = event.target.value;
  applyCurrentSort({ resetScroll: true });
});
$('#sortDirectionBtn').addEventListener('click', (event) => {
  state.sortDirection *= -1;
  event.currentTarget.textContent = state.sortDirection > 0 ? '↑' : '↓';
  applyCurrentSort();
});
$('#sortApplyBtn').addEventListener('click', () => applyCurrentSort());
$('#ratingFilter').addEventListener('change', (event) => { state.minimumRating = Number(event.target.value || 0); list.scrollTop = 0; renderList(); });
$('#fileFilter').addEventListener('change', (event) => { state.fileFilter = event.target.value; list.scrollTop = 0; renderList(); });
$('#resetFiltersBtn').addEventListener('click', () => {
  clearTimeout(searchDebounce);
  state.query = '';
  state.tagFilters.clear();
  state.fileFilter = 'all';
  state.minimumRating = 0;
  $('#searchInput').value = '';
  $('#fileFilter').value = 'all';
  $('#ratingFilter').value = '0';
  list.scrollTop = 0;
  render();
});
$('#batchTagsBtn').addEventListener('click', addTagsToSelection);
$('#batchMoveBtn').addEventListener('click', moveSelectionToCategory);
$('#batchFavoriteBtn').addEventListener('click', toggleFavoriteSelected);
$('#batchTrashBtn').addEventListener('click', trashSelection);
$('#clearSelectionBtn').addEventListener('click', () => { state.selectedIds.clear(); state.selectedId = null; render(); });
async function addFolderWithFeedback() {
  try {
    setLibrary(await window.soundLibrary.addFolder());
  } catch (error) {
    showToast(`폴더를 열지 못했습니다: ${error.message}`, 5000);
  }
}

async function addFilesWithFeedback() {
  try {
    setLibrary(await window.soundLibrary.addFiles());
  } catch (error) {
    showToast(`파일을 추가하지 못했습니다: ${error.message}`, 5000);
  }
}

$('#addFolderBtn').addEventListener('click', addFolderWithFeedback);
$('#newRootCategoryBtn').addEventListener('click', (event) => {
  event.stopPropagation();
  createCategoryFolder('');
});
$('#emptyAddBtn').addEventListener('click', addFolderWithFeedback);
$('#addFilesBtn').addEventListener('click', addFilesWithFeedback);
$('#rescanBtn').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  showToast('사운드 폴더를 다시 스캔하는 중…', 60000);
  try {
    const snapshot = await window.soundLibrary.rescan();
    setLibrary(snapshot);
    const result = snapshot?.scanResult || {};
    showToast(`스캔 완료 · 추가 ${result.added || 0}개 · 갱신 ${result.updated || 0}개`);
  } catch (error) {
    showToast(`재스캔 실패: ${error.message}`, 5000);
  } finally {
    button.disabled = false;
  }
});
$('#settingsBtn').addEventListener('click', openSettings);
$('#openVaultBtn').addEventListener('click', async () => {
  try {
    const snapshot = await window.soundLibrary.openVault();
    if (!snapshot) return;
    state.selectedIds.clear(); state.selectedId = null;
    setLibrary(snapshot);
    showToast(`“${snapshot.vault?.name || '볼트'}”를 열었습니다.`);
  } catch (error) { alert(error.message); }
});
$('#createVaultBtn').addEventListener('click', async () => {
  try {
    const snapshot = await window.soundLibrary.createVault();
    if (!snapshot) return;
    state.selectedIds.clear(); state.selectedId = null;
    setLibrary(snapshot);
    showToast('새 Sound Shelf 볼트를 만들었습니다.');
  } catch (error) { alert(error.message); }
});
$('#locateVaultBtn').addEventListener('click', async () => {
  try {
    const snapshot = await window.soundLibrary.locateVault();
    if (!snapshot) return;
    setLibrary(snapshot);
    showToast('이동된 볼트의 새 위치를 연결했습니다.');
  } catch (error) { alert(error.message); }
});
$('#moveVaultBtn').addEventListener('click', async () => {
  if (!confirm('현재 볼트의 모든 사운드와 정리 정보를 선택한 위치로 실제 이동합니다. 계속할까요?')) return;
  try {
    const snapshot = await window.soundLibrary.moveVault();
    if (!snapshot) return;
    setLibrary(snapshot);
    showToast('볼트 위치를 변경했습니다.', 5000);
  } catch (error) { alert(error.message); }
});
$('#checkVaultBtn').addEventListener('click', async () => {
  try {
    const result = await window.soundLibrary.checkVault();
    const message = `메타데이터 ${result.total.toLocaleString()}개 · 누락 ${result.missingFiles}개 · 중복 경로 ${result.duplicatePaths}개 · 로컬 캐시 ${result.cacheEntries.toLocaleString()}개`;
    $('#vaultHealth').textContent = `${result.ok ? '✓ 볼트 구조 정상' : '⚠ 확인 필요'} · ${message}`;
    showToast(result.ok ? '볼트 연결 상태가 정상입니다.' : '볼트에서 확인할 항목이 발견되었습니다.', 5000);
  } catch (error) { alert(error.message); }
});
$('#compactVaultBtn').addEventListener('click', async () => {
  const ok = confirm(
    '볼트를 압축합니다.\n\n'
    + '모든 편집 기록을 베이스에 접어 넣고 편집 파일을 정리합니다.\n'
    + '실행 전에 다른 Mac의 Sound Shelf가 종료되어 있는지 확인해 주세요.\n\n'
    + '계속할까요?'
  );
  if (!ok) return;
  try {
    const result = await window.soundLibrary.compactVault();
    showToast(`볼트 압축 완료 — 사운드 ${result.sounds}개를 베이스로 접었습니다 (삭제 기록 ${result.tombstones}건 유지).`, 3500);
  } catch (error) {
    showToast(`볼트 압축 실패: ${error.message}`, 4000);
  }
});
$('#revealVaultBtn').addEventListener('click', async () => {
  try { await window.soundLibrary.revealVault(); } catch (error) { alert(error.message); }
});
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
  $('#resultsTitle').textContent = '중복 파일 검사';
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
  if (!button) return;
  const snapshot = await window.soundLibrary.removeSound({ id: button.dataset.duplicateTrash, trashFile: true });
  setLibrary(snapshot);
  button.closest('.duplicate-file').remove();
});
$('#closeSettingsBtn').addEventListener('click', () => { window.soundLibrary.setShortcutCapture(false); state.view = 'library'; render(); });
$('#checkUpdateBtn').addEventListener('click', async () => {
  try {
    state.updateStatus = await window.soundLibrary.checkForUpdates();
    renderUpdateSettings();
  } catch (error) {
    showToast(`업데이트 확인 실패: ${error.message}`, 5000);
  }
});
$('#installUpdateBtn').addEventListener('click', async () => {
  try {
    state.updateStatus = await window.soundLibrary.installUpdate();
    renderUpdateSettings();
  } catch (error) {
    showToast(`업데이트 설치 실패: ${error.message}`, 5000);
  }
});
$('#openReleaseBtn').addEventListener('click', async () => {
  try { await window.soundLibrary.openUpdatePage(); }
  catch (error) { showToast(`GitHub를 열지 못했습니다: ${error.message}`, 5000); }
});
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
$('#detailWaveformRetryBtn').addEventListener('click', async () => {
  const sound = selectedSound();
  if (!sound || sound.missing) return;
  state.waveforms.delete(sound.id);
  state.waveformLoading.delete(sound.id);
  showDetailWaveformStatus('파형을 다시 생성하는 중…');
  await ensureWaveform(sound);
});
$('#createRangeFileButton').addEventListener('click', async () => {
  const sound = selectedSound();
  const selection = sound ? state.selections.get(sound.id) : null;
  if (!sound || !selection || selection.end - selection.start < 0.05 || selection.path) return;
  const button = $('#createRangeFileButton');
  button.disabled = true;
  button.textContent = '파일 만드는 중…';
  showToast('선택 구간을 같은 카테고리에 새 사운드 파일로 만드는 중…', 15000);
  try {
    const snapshot = await window.soundLibrary.createClip({ id: sound.id, start: selection.start, end: selection.end });
    const current = state.selections.get(sound.id);
    if (current && snapshot.createdClip) {
      current.path = snapshot.createdClip.path;
      current.createdId = snapshot.createdClip.id;
    }
    setLibrary(snapshot);
    updateDetailSelection();
    showToast(`“${snapshot.createdClip.title}” 파일을 만들었습니다.`);
  } catch (error) {
    button.disabled = false;
    button.textContent = '선택 구간 파일 만들기';
    showToast(`구간 파일 생성 실패: ${error.message}`, 5000);
  }
});
$('#editTitle').addEventListener('input', (event) => updateSelected({ title: event.target.value }));
$('#editCategory').addEventListener('input', (event) => updateSelected({ category: event.target.value }));
$('#editTags').addEventListener('input', (event) => updateSelected({ tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) }));
$('#editNotes').addEventListener('input', (event) => updateSelected({ notes: event.target.value }));
$('#inspectorRating').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-rating]');
  const sound = selectedSound();
  if (!button || !sound) return;
  const rating = Number(button.dataset.rating);
  try {
    await updateRatingsWithoutReordering([sound.id], Number(sound.rating || 0) === rating ? 0 : rating);
  } catch (error) {
    showToast(`별점 지정 실패: ${error.message}`, 5000);
  }
});
$('#revealBtn').addEventListener('click', () => { const sound = selectedSound(); if (sound) window.soundLibrary.reveal(sound.path); });
$('#moveBtn').addEventListener('click', moveSelectedToFolder);
$('#trashBtn').addEventListener('click', trashSelected);

document.addEventListener('keydown', (event) => {
  if (event.target.closest('.shortcut-capture.recording')) return;
  const isSearchField = document.activeElement === $('#searchInput');
  const isTextEntry = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
    || document.activeElement.isContentEditable;
  const isEditing = !isSearchField && isTextEntry;
  const noCommandModifier = !event.metaKey && !event.ctrlKey && !event.altKey;
  if (state.categoryKeyboardMode && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)
    && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      moveCategorySelectionWithArrow(event.key === 'ArrowDown' ? 1 : -1);
    } else {
      navigateCategoryHorizontally(event.key === 'ArrowRight' ? 1 : -1);
    }
    return;
  }
  if (event.key === 'ArrowLeft' && !isEditing && !event.metaKey && !event.ctrlKey && !event.altKey
    && (!isSearchField || searchKeyboardNavigation)) {
    event.preventDefault();
    enterCategoryKeyboardNavigation();
    return;
  }
  if (/^[1-5]$/.test(event.key) && !isTextEntry && noCommandModifier
    && !document.querySelector('.dialog-backdrop:not(.hidden)')) {
    event.preventDefault();
    if (!event.repeat) setSelectedRating(Number(event.key));
    return;
  }
  if (['ArrowUp', 'ArrowDown'].includes(event.key) && !isEditing && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    if (isSearchField) searchKeyboardNavigation = true;
    moveSoundSelectionWithArrow(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (isSearchField && event.key === ' ' && (event.shiftKey || searchKeyboardNavigation)
    && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    if (!event.repeat) toggleSelectedPlayback();
    return;
  }
  if (event.key === 'Escape' && state.categoryKeyboardMode) {
    event.preventDefault();
    leaveCategoryKeyboardNavigation();
    return;
  }
  if (event.key === 'Escape' && state.selectedCategories.size) {
    state.categoryAnchor = null;
    clearCategorySelection();
    return;
  }
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
  if (shortcut === 'Enter' && ['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (shortcut === 'Space' && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  event.preventDefault();
  runShortcut(action);
});

function clearCategoryDropIndicators() {
  document.querySelectorAll('.category-tree-row.drag-over, .category-tree-row.drag-between-before, .category-tree-row.drag-between-after')
    .forEach((row) => {
      row.classList.remove('drag-over', 'drag-between-before', 'drag-between-after');
      delete row.dataset.dropHint;
    });
  document.querySelectorAll('.root-drop-over').forEach((element) => element.classList.remove('root-drop-over'));
  document.querySelectorAll('#tagList [data-tag].drag-over').forEach((element) => element.classList.remove('drag-over'));
}

function categoryDropIntent(event) {
  const row = event.target.closest('[data-category-row]');
  if (!row) {
    const root = event.target.closest('[data-root-drop], #categoryList');
    return root ? { category: '미분류', mode: 'root', row: null, reference: '' } : null;
  }
  const category = row.dataset.categoryRow;
  if (internalNativeDrag !== 'category') return { category, mode: 'child', row, reference: category };
  const rect = row.getBoundingClientRect();
  const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
  if (internalDraggedCategories.includes('미분류')) {
    const parent = category.includes('/') ? category.slice(0, category.lastIndexOf('/')) : '미분류';
    return { category: parent, mode: ratio < 0.5 ? 'before' : 'after', row, reference: category };
  }
  if (ratio > 0.27 && ratio < 0.73) return { category, mode: 'child', row, reference: category };
  const parent = category.includes('/') ? category.slice(0, category.lastIndexOf('/')) : '미분류';
  return { category: parent, mode: ratio <= 0.27 ? 'before' : 'after', row, reference: category };
}

// A Finder/native audio drop must always be handled by Sound Shelf. Without
// this capture-phase guard, Chromium can navigate to the dropped audio file
// and show its black, standalone media-player window.
for (const eventName of ['dragenter', 'dragover', 'drop']) {
  window.addEventListener(eventName, (event) => {
    if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
  }, { capture: true });
}

document.addEventListener('dragenter', (event) => {
  const internalCategory = internalNativeDrag === 'category' || event.dataTransfer?.types.includes(CATEGORY_DRAG_TYPE);
  if (!internalCategory && !event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
});
document.addEventListener('dragover', (event) => {
  const internalCategory = internalNativeDrag === 'category' || event.dataTransfer?.types.includes(CATEGORY_DRAG_TYPE);
  if (!internalCategory && !event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  clearCategoryDropIndicators();
  if (internalNativeDrag === 'range') {
    event.dataTransfer.dropEffect = 'none';
    return;
  }
  const tagTarget = event.target.closest('#tagList [data-tag]');
  if (internalNativeDrag === 'sound' && internalDraggedSoundIds.length && tagTarget) {
    tagTarget.classList.add('drag-over');
    event.dataTransfer.dropEffect = 'link';
    return;
  }
  const intent = categoryDropIntent(event);
  if (intent?.row) {
    if (intent.mode === 'child') {
      intent.row.classList.add('drag-over');
      intent.row.dataset.dropHint = '하위 폴더로 이동';
    } else {
      intent.row.classList.add(intent.mode === 'before' ? 'drag-between-before' : 'drag-between-after');
      intent.row.dataset.dropHint = intent.category === '미분류' ? '최상위로 이동' : '같은 상위 폴더로 이동';
    }
  } else if (intent?.mode === 'root') {
    $('[data-root-drop]')?.classList.add('root-drop-over');
  }
  if (intent || state.filter.startsWith('category:')) event.dataTransfer.dropEffect = 'move';
});
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) clearCategoryDropIndicators();
});
document.addEventListener('drop', async (event) => {
  event.preventDefault();
  const droppedTag = event.target.closest('#tagList [data-tag]')?.dataset.tag || '';
  const intent = categoryDropIntent(event);
  const dragKind = internalNativeDrag;
  const draggedCategories = [...internalDraggedCategories];
  const draggedSoundIds = [...internalDraggedSoundIds];
  const categoryMove = internalNativeDrag === 'category' && intent;
  clearInternalNativeDrag();
  clearCategoryDropIndicators();
  // Native range drag needs a disposable WAV path. If the drag returns to
  // Sound Shelf, never route that transport file through normal file import.
  if (dragKind === 'range') return;
  if (dragKind === 'sound' && draggedSoundIds.length && droppedTag) {
    await commitTagChange(draggedSoundIds, { addTags: [droppedTag] }, `#${droppedTag} 추가`);
    return;
  }
  if (categoryMove) {
    showToast('폴더 순서를 변경하는 중…', 10000);
    try {
      setLibrary(await window.soundLibrary.reorderCategories({
        categories: draggedCategories,
        referenceCategory: intent.reference,
        position: intent.mode === 'child' ? 'inside' : intent.mode
      }));
      showToast(intent.mode === 'child' ? '폴더를 하위 폴더로 이동했습니다.' : '폴더 위치와 순서를 변경했습니다.');
    } catch (error) {
      showToast(`순서 변경 실패: ${error.message}`, 5000);
    }
    return;
  }
  const selectedCategory = state.filter.startsWith('category:') ? state.filter.slice('category:'.length) : '';
  const dropCategory = intent?.category || selectedCategory;
  if (dragKind === 'sound' && draggedSoundIds.length && dropCategory) {
    showToast(`“${dropCategory}” 폴더로 파일을 이동하는 중…`, 10000);
    try {
      setLibrary(await window.soundLibrary.moveSoundsToCategory({ ids: draggedSoundIds, category: dropCategory }));
      showToast(`${draggedSoundIds.length}개 파일을 이동했습니다.`);
    } catch (error) {
      showToast(`이동 실패: ${error.message}`, 5000);
    }
    return;
  }
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  if (dropCategory) {
    showToast(dropCategory === '미분류' ? '최상위 폴더로 이동하는 중…' : `“${dropCategory}” 폴더로 이동하는 중…`, 10000);
    try {
      const snapshot = await window.soundLibrary.dropFilesToCategory(dropCategory, files);
      if (dropCategory !== '미분류') state.collapsedCategories.delete(dropCategory);
      setLibrary(snapshot);
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

document.addEventListener('dragend', () => {
  document.querySelectorAll('.category-tree-row.dragging').forEach((row) => row.classList.remove('dragging'));
  clearCategoryDropIndicators();
  clearInternalNativeDrag();
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
  state.followSelectionPlayback = false;
  state.playRangeEnd = null;
  updateTransportDisplay();
});
player.addEventListener('timeupdate', () => {
  if (state.playRangeEnd !== null && player.currentTime >= state.playRangeEnd) {
    pausePreviewPlayback();
    state.playRangeEnd = null;
  }
});
window.soundLibrary.onScanProgress(({ current, total, fileName }) => showToast(`사운드 분석 중 ${current}/${total} · ${fileName}`, 1200));
window.soundLibrary.onLibraryUpdated((snapshot) => {
  setLibrary(snapshot);
  if (snapshot.updateReason === 'folder-change') showToast('폴더 변경 사항을 자동으로 반영했습니다.', 1800);
  if (snapshot.updateReason === 'startup') showToast('사운드 라이브러리를 불러왔습니다.', 1800);
  if (snapshot.updateReason === 'vault-cached') showToast('저장된 목록을 표시했습니다. 폴더 동기화는 백그라운드에서 계속됩니다.', 2500);
  if (snapshot.updateReason === 'remote-sync') showToast('다른 Mac의 변경 사항을 반영했습니다.', 2000);
});
window.soundLibrary.onUpdateStatus((status) => {
  state.updateStatus = status;
  renderUpdateSettings();
});
window.soundLibrary.onDragError((message) => showToast(`드래그를 시작하지 못했습니다: ${message}`, 4000));
window.soundLibrary.onShortcut((shortcut) => {
  const action = actionForShortcut(shortcut);
  if (action) runShortcut(action);
});
new ResizeObserver(drawDetailWaveform).observe(detailWrap);

window.soundLibrary.getLibrary().then((snapshot) => {
  setLibrary(snapshot);
  if (snapshot.loading) showToast('사운드 라이브러리를 불러오는 중입니다…', 4000);
});
window.soundLibrary.getUpdateStatus().then((status) => {
  state.updateStatus = status;
  renderUpdateSettings();
});
