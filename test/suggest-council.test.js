const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateRankings, buildChairmanPrompt, buildReviewPrompt, describeCouncil, parseReview, runCouncil, shuffled
} = require('../src/suggest-council');

const input = { relativePath: '예능/또잇.wav', entry: { tags: ['pop'] }, measurement: { duration: 1.1 }, wavePng: '/tmp/w.png', spectrumPng: '/tmp/s.png' };
const wrap = (value) => JSON.stringify({ result: JSON.stringify(value) });
const answer = (description, extra = {}) => wrap({ description, use_for: ['자막 등장'], tags: ['pop'], role: 'accent', intensity: 'soft', confidence: 0.9, uncertain: '길이', ...extra });

// 단계마다 프롬프트 첫 줄로 구분해 정해진 답을 돌려주는 가짜 claude -p.
function fakeAsk({ first = {}, review = {}, chairman, fail = [] } = {}) {
  const calls = [];
  const ask = async (model, prompt) => {
    const stage = prompt.includes('심사위원이다') ? 'review' : prompt.includes('편집장이다') ? 'chairman' : 'first';
    calls.push({ model, stage, prompt });
    if (fail.includes(`${stage}:${model}`)) throw new Error(`${model} 사용 불가`);
    if (stage === 'first') return first[model] ?? answer(`${model} 설명`);
    if (stage === 'review') return review[model] ?? wrap({ notes: { A: '좋음' }, ranking: ['A', 'B', 'C'] });
    return chairman ?? answer('종합 설명', { use_for: ['자막 등장', '반전'] });
  };
  return { ask, calls };
}

test('심사 결과: 래퍼·여러 글자 표기에서 순위와 한 줄 평을 꺼내고 모르는 글자는 버린다', () => {
  const parsed = parseReview(wrap({ notes: { '추천 A': '  길이와 맞음 ', Z: '없는 추천' }, ranking: ['Response B', '추천 A', 'B', 'Z'] }), ['A', 'B', 'C']);
  assert.deepEqual(parsed.ranking, ['B', 'A']);
  assert.deepEqual(parsed.notes, { A: '길이와 맞음' });
  assert.deepEqual(parseReview('{"ranking":"C > A > B"}', ['A', 'B', 'C']).ranking, ['C', 'A', 'B']);
  assert.deepEqual(parseReview('{"ranking":["B (A보다 정확)","A"]}', ['A', 'B']).ranking, ['B', 'A']);
  assert.throws(() => parseReview('{"ranking":[]}', ['A', 'B']), /순위/);
});

test('평균 순위: 낮을수록 앞, 표 없는 추천은 맨 뒤', () => {
  const entries = [{ label: 'A', model: 'sonnet' }, { label: 'B', model: 'opus' }, { label: 'C', model: 'haiku' }];
  const ranking = aggregateRankings([{ ranking: ['B', 'A'] }, { ranking: ['B', 'A'] }, { ranking: ['A', 'B'] }], entries);
  assert.deepEqual(ranking.map((item) => [item.model, item.averageRank, item.votes]), [['opus', 1.33, 3], ['sonnet', 1.67, 3], ['haiku', null, 0]]);
});

test('심사·종합 프롬프트는 모델 이름을 숨기고 스스로 매긴 확신은 빼며, 종합에는 평균 순위와 심사평을 준다', () => {
  const entries = [{ label: 'A', model: 'opus', suggestion: { description: '뽁', use_for: [], avoid_for: [], tags: [], aliases: [], role: 'accent', intensity: 'soft', character: '', confidence: 0.95, uncertain: '세기' } }];
  const review = buildReviewPrompt(input, entries);
  assert.match(review, /추천 A:/);
  assert.match(review, /\/tmp\/w\.png/);
  assert.doesNotMatch(review, /opus|confidence|uncertain/i);
  const chairman = buildChairmanPrompt(input, entries, [{ ranking: ['A'], notes: { A: '길이와 맞음' } }], [{ label: 'A', model: 'opus', averageRank: 1, votes: 1 }]);
  assert.match(chairman, /추천 A \(평균 1위, 1표\)/);
  assert.match(chairman, /심사위원 1: 순위 A\. A: 길이와 맞음/);
  assert.match(chairman, /"uncertain":"세기"/);
  assert.doesNotMatch(chairman, /opus|0\.95/i, '종합 출력 형식의 confidence 칸은 있어도, 추천들이 스스로 매긴 값은 넘기지 않는다');
});

test('세 단계를 거쳐 의장의 종합안을 돌려주고, 단계마다 진행 문구를 낸다', async () => {
  const { ask, calls } = fakeAsk();
  const progress = [];
  const { suggestion, council } = await runCouncil({ ask, input, onProgress: (message) => progress.push(message), random: () => 0.99 });
  assert.equal(suggestion.description, '종합 설명');
  assert.deepEqual(suggestion.use_for, ['자막 등장', '반전']);
  assert.deepEqual(calls.map((call) => `${call.stage}:${call.model}`), [
    'first:sonnet', 'first:opus', 'first:haiku', 'review:sonnet', 'review:opus', 'review:haiku', 'chairman:sonnet'
  ]);
  assert.equal(new Set(calls.filter((call) => call.stage === 'first').map((call) => call.prompt)).size, 1, '모두 같은 질문을 받는다');
  // random 이 0.99 면 섞어도 순서가 그대로: A=sonnet, B=opus, C=haiku. 모든 심사위원이 A>B>C.
  assert.deepEqual(council.ranking, [
    { model: 'sonnet', averageRank: 1, votes: 3 }, { model: 'opus', averageRank: 2, votes: 3 }, { model: 'haiku', averageRank: 3, votes: 3 }
  ]);
  assert.equal(council.chosenBy, 'chairman');
  assert.equal(progress.length, 3);
  assert.match(progress[0], /1\/3.*Sonnet·Opus·Haiku/);
  assert.match(describeCouncil(council), /평가 순위 \(3명이.*\): Sonnet 1위 · Opus 2위 · Haiku 3위\n→ 의장\(Sonnet\)이 하나로 합쳤습니다/);
});

test('추천에 실패하거나 빈 추천을 낸 모델은 빼고 계속하며 그 모델은 심사도 하지 않는다', async () => {
  const { ask, calls } = fakeAsk({ fail: ['first:opus'], first: { haiku: wrap({ description: '', tags: [] }) } });
  const { council } = await runCouncil({ ask, input });
  assert.deepEqual(council.members.map((member) => member.ok), [true, false, false]);
  assert.equal(council.chosenBy, 'only-answer');
  assert.equal(council.chosenModel, 'sonnet');
  assert.equal(calls.some((call) => call.stage !== 'first'), false, '하나만 남으면 평가·종합을 건너뛴다');
  const message = describeCouncil(council);
  assert.match(message, /Sonnet 추천 하나만/);
  assert.match(message, /답하지 못한 모델: Opus \(opus 사용 불가\) \/ Haiku \(빈 추천을 냈습니다\.\)/);
});

test('모든 모델이 실패하면 이유를 모아 오류를 낸다', async () => {
  const { ask } = fakeAsk({ fail: ['first:sonnet', 'first:opus', 'first:haiku'] });
  await assert.rejects(runCouncil({ ask, input }), /모든 모델이 추천에 실패했습니다\. Sonnet: sonnet 사용 불가 \/ Opus/);
});

test('의장이 실패하면 평가 1위 추천을 그대로 쓴다', async () => {
  const { ask } = fakeAsk({ chairman: '모르겠습니다', review: { sonnet: wrap({ ranking: ['C', 'A', 'B'] }), opus: wrap({ ranking: ['C', 'B', 'A'] }), haiku: '순위 없음' } });
  const { suggestion, council } = await runCouncil({ ask, input, random: () => 0.99 });
  assert.equal(council.reviews, 2, '형식이 틀린 심사는 빼고 센다');
  assert.equal(council.chosenBy, 'top-ranked');
  assert.equal(council.chosenModel, 'haiku');
  assert.equal(suggestion.description, 'haiku 설명');
  assert.match(describeCouncil(council), /의장\(Sonnet\) 종합이 실패해 평가 1위\(Haiku\) 추천을 그대로 썼습니다: 추천 결과에서 JSON/);
});

test('섞기는 원본을 바꾸지 않고 모든 항목을 한 번씩 담는다', () => {
  const items = ['a', 'b', 'c', 'd'];
  const mixed = shuffled(items, () => 0);
  assert.deepEqual(items, ['a', 'b', 'c', 'd']);
  assert.deepEqual([...mixed].sort(), items);
  assert.notDeepEqual(mixed, items);
});
