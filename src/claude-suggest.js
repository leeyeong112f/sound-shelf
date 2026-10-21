// '자동 추천': claude -p 에게 측정값과 파형·스펙트로그램 그림을 보여 주고 sounds.json 항목을 제안받는다.
// Claude 는 소리를 직접 듣지 못한다 — 그림·숫자·폴더/파일 이름으로 판단한 '제안'이고, 사람이 확인하고 저장한다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROLES, INTENSITIES } = require('./pack-metadata');

function findClaude(env = process.env) {
  const override = String(env.SOUND_SHELF_CLAUDE || '').trim();
  if (override && fs.existsSync(override)) return override;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.claude', 'local', 'claude')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function buildPrompt({ relativePath, entry, measurement, wavePng, spectrumPng }) {
  const known = {};
  for (const key of ['name', 'category', 'description', 'use_for', 'avoid_for', 'tags', 'aliases', 'role', 'intensity']) {
    const value = entry?.[key];
    if (Array.isArray(value) ? value.length : value) known[key] = value;
  }
  return [
    '너는 효과음 라이브러리의 메타데이터를 쓰는 사람이다. 소리를 직접 들을 수 없으니 아래 단서로 판단한다.',
    `- 그림 두 장을 Read 로 열어 볼 것: 파형 ${wavePng} , 스펙트로그램 ${spectrumPng}`,
    `- 파일 경로(폴더 이름도 단서): ${relativePath}`,
    `- 측정값: ${JSON.stringify(measurement)}`,
    `- 이미 적혀 있는 값(있으면 존중하고 보완): ${JSON.stringify(known)}`,
    '관점: 한국 요리·브이로그·예능 숏폼을 편집하는 사람이 "이 소리를 어디에 쓰나"를 찾을 때 도움이 되게.',
    '- use_for / avoid_for 는 "장면 + 순간" 한국어 짧은 구. 예: "자막이 톡 튀어나올 때", "진지한 인터뷰 중"',
    '- aliases 는 사람들이 이 소리를 부르는 한국어 의성어·별명 2~4개. 예: 뽁, 뿅, 띠용, 촤악',
    `- role 은 다음 중 하나: ${ROLES.map((role) => `${role.id}(${role.label})`).join(', ')}`,
    `- intensity 는 ${INTENSITIES.join(' / ')} 중 하나`,
    '- tags 는 한국어·영어 섞어 4~8개, 너무 일반적인 말(sound, effect) 금지',
    '다음 JSON 하나만 출력하라. 설명·코드 펜스 없이:',
    '{"description":"한 문장","use_for":[],"avoid_for":[],"tags":[],"aliases":[],"role":"","intensity":"","character":"음색 2~3단어","confidence":0.0,"uncertain":"확신 없는 부분 한 문장"}'
  ].join('\n');
}

// claude -p --output-format json 의 출력({ result: "..." })이나 맨 텍스트에서 제안 JSON 을 꺼낸다.
function extractJsonObject(text) {
  let body = String(text || '').trim();
  try {
    const wrapper = JSON.parse(body);
    if (wrapper && typeof wrapper.result === 'string') body = wrapper.result;
    else if (wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper) && 'description' in wrapper) return wrapper;
  } catch { /* 맨 텍스트 */ }
  body = body.replace(/```(?:json)?/gi, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('추천 결과에서 JSON 을 찾지 못했습니다.');
  return JSON.parse(body.slice(start, end + 1));
}

// 허용한 필드만, 정해진 모양으로 남긴다. 잘못된 role/intensity 는 버린다.
function sanitizeSuggestion(raw) {
  const text = (value, limit = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const list = (value, limit = 10) => [...new Set((Array.isArray(value) ? value : [])
    .map((item) => text(item, 80)).filter(Boolean))].slice(0, limit);
  const role = ROLES.some((item) => item.id === raw?.role) ? raw.role : '';
  const intensity = INTENSITIES.includes(raw?.intensity) ? raw.intensity : '';
  const confidence = Number(raw?.confidence);
  return {
    description: text(raw?.description),
    use_for: list(raw?.use_for),
    avoid_for: list(raw?.avoid_for),
    tags: list(raw?.tags),
    aliases: list(raw?.aliases, 6),
    role,
    intensity,
    character: text(raw?.character, 60),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    uncertain: text(raw?.uncertain)
  };
}

function suggestArgs(prompt, model) {
  const args = ['-p', prompt, '--allowedTools', 'Read', '--output-format', 'json'];
  if (model) args.push('--model', model);
  return args;
}

module.exports = { buildPrompt, extractJsonObject, findClaude, sanitizeSuggestion, suggestArgs };
