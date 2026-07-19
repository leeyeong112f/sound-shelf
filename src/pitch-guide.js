(function exposePitchGuide(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PitchGuide = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  const NOTES = [
    { key: 'C', korean: '도' },
    { key: 'C♯/D♭', korean: '도♯/레♭' },
    { key: 'D', korean: '레' },
    { key: 'E♭', korean: '미♭' },
    { key: 'E', korean: '미' },
    { key: 'F', korean: '파' },
    { key: 'F♯/G♭', korean: '파♯/솔♭' },
    { key: 'G', korean: '솔' },
    { key: 'A♭', korean: '라♭' },
    { key: 'A', korean: '라' },
    { key: 'B♭', korean: '시♭' },
    { key: 'B', korean: '시' }
  ];
  const MAJOR_CAMELOT = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
  const MINOR_CAMELOT = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

  function closestSemitones(value) {
    let wrapped = ((Number(value) + 6) % 12 + 12) % 12 - 6;
    if (Math.abs(wrapped + 6) < 1e-9 && Number(value) > 0) wrapped = 6;
    return wrapped;
  }

  function calculatePitchGuide({ sourceIndex, sourceMode, tuningCents = 0, targetIndex, targetMode }) {
    const source = Number(sourceIndex);
    const target = Number(targetIndex);
    if (!Number.isInteger(source) || source < 0 || source > 11) throw new Error('출발 조성을 확인할 수 없습니다.');
    if (!Number.isInteger(target) || target < 0 || target > 11) throw new Error('목표 조성을 확인할 수 없습니다.');
    const tuning = Math.max(-50, Math.min(50, Number(tuningCents) || 0));
    const totalSemitones = closestSemitones(target - source - tuning / 100);
    const totalCents = totalSemitones * 100;
    const pitchSemitones = Math.round(totalSemitones);
    const fineCents = totalCents - pitchSemitones * 100;
    return {
      pitchSemitones,
      fineCents: Math.abs(fineCents) < 0.05 ? 0 : Number(fineCents.toFixed(1)),
      totalSemitones: Number(totalSemitones.toFixed(3)),
      totalCents: Number(totalCents.toFixed(1)),
      modeMismatch: Boolean(sourceMode && targetMode && sourceMode !== targetMode)
    };
  }

  function targetKeys() {
    return ['major', 'minor'].flatMap((mode) => NOTES.map((note, index) => ({
      index,
      mode,
      key: note.key,
      korean: `${note.korean} ${mode === 'major' ? '장조' : '단조'}`,
      display: `${note.key} ${mode === 'major' ? 'Major' : 'Minor'}`,
      camelot: mode === 'major' ? MAJOR_CAMELOT[index] : MINOR_CAMELOT[index]
    })));
  }

  function sourceIndexForKey(key) {
    return NOTES.findIndex((note) => note.key === key);
  }

  return { NOTES, calculatePitchGuide, sourceIndexForKey, targetKeys };
}));
