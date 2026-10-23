// '여러 모델 합의' 자동 추천 — karpathy/llm-council 의 3단계를 claude -p 로 옮겼다.
// 1) 여러 모델이 각자 추천한다. 2) 누가 썼는지 가린 채(추천 A·B·C) 서로의 추천을 평가하고 순위를 매긴다.
// 3) 의장 모델이 추천·심사평·평균 순위를 보고 하나로 합친다.
// 실패한 모델은 빼고 계속한다. 의장이 실패하면 평가 1위 추천을 그대로 쓴다. 결과는 여전히 '제안'이고 저장은 사람이 한다.
const { SUGGESTION_SHAPE, buildPrompt, clueLines, extractJsonObject, guideLines, sanitizeSuggestion } = require('./claude-suggest');

const COUNCIL_MODELS = ['sonnet', 'opus', 'haiku'];
const CHAIRMAN_MODEL = 'sonnet';
const MODEL_NAMES = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };
const CONTENT_FIELDS = ['description', 'use_for', 'avoid_for', 'tags', 'aliases', 'role', 'intensity', 'character'];

function modelName(model) {
  return MODEL_NAMES[model] || String(model);
}

function shortError(error) {
  return String(error?.message || error || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function hasContent(suggestion) {
  return Boolean(suggestion.description || suggestion.use_for.length || suggestion.tags.length || suggestion.aliases.length);
}

// 심사·종합에는 내용만 보여 준다. 스스로 매긴 confidence 가 평가를 끌고 가지 않게.
function shownSuggestion(suggestion, { withDoubt = false } = {}) {
  const shown = Object.fromEntries(CONTENT_FIELDS.map((key) => [key, suggestion[key]]));
  if (withDoubt && suggestion.uncertain) shown.uncertain = suggestion.uncertain;
  return shown;
}

// 앞에 놓인 추천이 유리해지지 않게 순서를 섞은 뒤 A·B·C 를 붙인다.
function shuffled(items, random = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(random() * (index + 1));
    [copy[index], copy[pick]] = [copy[pick], copy[index]];
  }
  return copy;
}

function buildReviewPrompt(input, entries) {
  return [
    '너는 효과음 라이브러리 메타데이터 심사위원이다. 같은 소리에 대해 여러 명이 쓴 추천을, 누가 썼는지 모르는 채 비교한다. 소리를 직접 들을 수 없으니 아래 단서로 판단한다.',
    ...clueLines(input),
    '좋은 추천의 기준:',
    ...guideLines(),
    '',
    ...entries.flatMap(({ label, suggestion }) => [`추천 ${label}:`, JSON.stringify(shownSuggestion(suggestion))]),
    '',
    '할 일:',
    '1. 추천마다 그림·측정값·경로와 맞는 점, 틀리거나 흐릿한 점을 한 문장으로 적는다 (예: 측정 길이와 안 맞는 설명, 장면이 흐릿한 쓸 곳, 엉뚱한 역할·세기).',
    '2. 정확하고 편집자에게 쓸모 있는 순서로 모든 추천에 순위를 매긴다.',
    '다음 JSON 하나만 출력하라. 설명·코드 펜스 없이:',
    `{"notes":{${entries.map(({ label }) => `"${label}":"한 문장"`).join(',')}},"ranking":["가장 나은 추천의 글자","…","가장 못한 추천의 글자"]}`
  ].join('\n');
}

// 심사 결과에서 순위(추천 글자 목록)와 한 줄 평을 꺼낸다. "B", "추천 B", "Response B" 모두 받는다.
function parseReview(text, labels) {
  const raw = extractJsonObject(text);
  const labelIn = (value) => String(value ?? '').toUpperCase().match(/\b([A-Z])\b/g)?.map((match) => match.trim()) || [];
  const candidates = Array.isArray(raw?.ranking) ? raw.ranking.map((item) => labelIn(item)[0]) : labelIn(raw?.ranking);
  const ranking = [...new Set(candidates.filter((label) => labels.includes(label)))];
  if (!ranking.length) throw new Error('심사 결과에 순위가 없습니다.');
  const notes = {};
  for (const [key, note] of Object.entries(raw?.notes && typeof raw.notes === 'object' ? raw.notes : {})) {
    const label = labelIn(key)[0];
    const text = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (labels.includes(label) && text) notes[label] = text;
  }
  return { ranking, notes };
}

// 심사위원마다 매긴 자리를 평균한다(낮을수록 좋음). 아무도 순위에 넣지 않은 추천은 맨 뒤.
function aggregateRankings(reviews, entries) {
  return entries.map(({ label, model }) => {
    const positions = reviews.map((review) => review.ranking.indexOf(label) + 1).filter((position) => position > 0);
    const averageRank = positions.length ? Math.round((positions.reduce((sum, position) => sum + position, 0) / positions.length) * 100) / 100 : null;
    return { label, model, averageRank, votes: positions.length };
  }).sort((a, b) => (a.averageRank ?? Infinity) - (b.averageRank ?? Infinity) || b.votes - a.votes || a.label.localeCompare(b.label));
}

function buildChairmanPrompt(input, entries, reviews, ranking) {
  const standing = new Map(ranking.map((item) => [item.label, item]));
  return [
    '너는 효과음 라이브러리 메타데이터의 편집장이다. 같은 소리에 대해 여러 명이 낸 추천과, 누가 썼는지 가린 채 서로 평가한 결과가 있다. 이것을 하나의 최종 추천으로 합친다. 소리를 직접 들을 수 없으니 아래 단서로 판단하고, 의견이 갈린 부분은 그림·측정값을 다시 보고 정한다.',
    ...clueLines(input),
    ...guideLines(),
    '',
    '추천들 (평균 순위는 낮을수록 좋은 평가, uncertain 은 쓴 사람이 확신 없다고 한 부분):',
    ...entries.flatMap(({ label, suggestion }) => {
      const rank = standing.get(label);
      const note = rank?.averageRank != null ? `평균 ${rank.averageRank}위, ${rank.votes}표` : '평가 없음';
      return [`추천 ${label} (${note}):`, JSON.stringify(shownSuggestion(suggestion, { withDoubt: true }))];
    }),
    '',
    reviews.length ? '심사평:' : '심사평: 없음 (평가가 모두 실패했다. 추천끼리 비교해 정한다)',
    ...reviews.map((review, index) => [
      `심사위원 ${index + 1}: 순위 ${review.ranking.join(' > ')}.`,
      ...Object.entries(review.notes).map(([label, note]) => `${label}: ${note}`)
    ].join(' ')),
    '',
    '합치는 법:',
    '- 여러 추천이 함께 짚은 내용과 평가가 좋은 추천을 앞세우되, 평가가 낮은 추천이라도 단서와 맞는 좋은 표현은 가져온다.',
    '- 심사평에서 틀렸다고 지적된 내용은 버린다. 목록은 뜻이 겹치는 항목을 하나로 줄인다.',
    '- role·intensity 는 하나만 고른다. 의견이 갈렸으면 단서에 더 맞는 쪽.',
    '- confidence 는 추천들이 얼마나 일치했는지도 반영하고, uncertain 에는 의견이 갈린 부분을 적는다.',
    '다음 JSON 하나만 출력하라. 설명·코드 펜스 없이:',
    SUGGESTION_SHAPE
  ].join('\n');
}

// ask(model, prompt) 는 claude -p 의 출력 텍스트를 돌려주는 함수. 단계마다 onProgress(문구)를 부른다.
async function runCouncil({ ask, input, models = COUNCIL_MODELS, chairman = CHAIRMAN_MODEL, onProgress = () => {}, random = Math.random }) {
  onProgress(`여러 모델 합의 1/3 · 모델 ${models.length}개(${models.map(modelName).join('·')})가 각자 추천하는 중…`);
  const firstPrompt = buildPrompt(input);
  const first = await Promise.allSettled(models.map(async (model) => {
    const suggestion = sanitizeSuggestion(extractJsonObject(await ask(model, firstPrompt)));
    if (!hasContent(suggestion)) throw new Error('빈 추천을 냈습니다.');
    return suggestion;
  }));
  const members = models.map((model, index) => (first[index].status === 'fulfilled'
    ? { model, ok: true }
    : { model, ok: false, error: shortError(first[index].reason) }));
  const answered = models.map((model, index) => ({ model, suggestion: first[index].value })).filter((_, index) => first[index].status === 'fulfilled');
  if (!answered.length) {
    throw new Error(`모든 모델이 추천에 실패했습니다. ${members.map((member) => `${modelName(member.model)}: ${member.error}`).join(' / ')}`);
  }
  const entries = shuffled(answered, random).map((item, index) => ({ ...item, label: String.fromCharCode(65 + index) }));
  if (entries.length === 1) {
    return { suggestion: entries[0].suggestion, council: { members, ranking: [], reviews: 0, chairman, chosenBy: 'only-answer', chosenModel: entries[0].model } };
  }

  onProgress(`여러 모델 합의 2/3 · 추천 ${entries.length}개를 누가 썼는지 가리고 서로 평가하는 중…`);
  const labels = entries.map((item) => item.label);
  const reviewPrompt = buildReviewPrompt(input, entries);
  const reviewed = await Promise.allSettled(answered.map(async ({ model }) => parseReview(await ask(model, reviewPrompt), labels)));
  const reviews = reviewed.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  const ranking = aggregateRankings(reviews, entries);
  const summary = {
    members,
    ranking: ranking.map(({ model, averageRank, votes }) => ({ model, averageRank, votes })),
    reviews: reviews.length,
    chairman
  };

  onProgress(`여러 모델 합의 3/3 · 의장(${modelName(chairman)})이 심사평을 보고 하나로 합치는 중…`);
  try {
    const suggestion = sanitizeSuggestion(extractJsonObject(await ask(chairman, buildChairmanPrompt(input, entries, reviews, ranking))));
    if (!hasContent(suggestion)) throw new Error('빈 추천을 냈습니다.');
    return { suggestion, council: { ...summary, chosenBy: 'chairman', chosenModel: chairman } };
  } catch (error) {
    const top = entries.find((item) => item.label === ranking[0].label);
    return { suggestion: top.suggestion, council: { ...summary, chosenBy: 'top-ranked', chosenModel: top.model, chairmanError: shortError(error) } };
  }
}

// 폼 알림에 붙일 요약: 평가 순위, 누가 최종안을 냈는지, 답하지 못한 모델.
function describeCouncil(council) {
  const rankText = (rank) => (rank === null ? '평가 없음' : `${Number(rank.toFixed(1))}위`);
  const lines = [];
  if (council.reviews > 0) {
    lines.push(`평가 순위 (${council.reviews}명이 누가 썼는지 모른 채 평가): ${council.ranking.map((item) => `${modelName(item.model)} ${rankText(item.averageRank)}`).join(' · ')}`);
  }
  if (council.chosenBy === 'chairman') lines.push(`→ 의장(${modelName(council.chosenModel)})이 하나로 합쳤습니다.`);
  else if (council.chosenBy === 'only-answer') lines.push(`다른 모델이 답하지 않아 ${modelName(council.chosenModel)} 추천 하나만 썼습니다 (평가·종합 생략).`);
  else if (council.reviews > 0) lines.push(`의장(${modelName(council.chairman)}) 종합이 실패해 평가 1위(${modelName(council.chosenModel)}) 추천을 그대로 썼습니다: ${council.chairmanError}`);
  else lines.push(`평가와 종합이 모두 실패해 ${modelName(council.chosenModel)} 추천을 그대로 썼습니다: ${council.chairmanError}`);
  const failed = council.members.filter((member) => !member.ok);
  if (failed.length) lines.push(`답하지 못한 모델: ${failed.map((member) => `${modelName(member.model)} (${member.error})`).join(' / ')}`);
  return lines.join('\n');
}

module.exports = {
  CHAIRMAN_MODEL, COUNCIL_MODELS,
  aggregateRankings, buildChairmanPrompt, buildReviewPrompt, describeCouncil, modelName, parseReview, runCouncil, shuffled
};
