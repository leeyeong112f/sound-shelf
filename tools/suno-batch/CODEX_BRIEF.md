# Codex에 줄 지시문

`cues.yaml`을 입력으로 주고 아래를 그대로 붙여넣으면 `prompts.json`이 나온다.
결과는 `python3 suno_batch.py validate prompts.json`으로 반드시 검사한다.

---

첨부한 `cues.yaml`을 읽고 `prompts.json`을 만들어 주세요.

## 출력 형식

```json
{
  "project": "<cues.yaml의 project>",
  "cues": [
    {
      "id": 1,
      "name": "오프닝",
      "takes": [
        {
          "take": 1,
          "title": "CUE01-T01",
          "style": "<Suno에 넣을 영어 프롬프트>",
          "instrumental": true
        }
      ]
    }
  ]
}
```

## 반드시 지킬 것

- `title`은 **`CUE{cue번호 두 자리}-T{take번호 두 자리}`** 형식이어야 한다. 예: `CUE01-T01`, `CUE50-T10`.
  이 제목이 나중에 Suno 라이브러리에서 곡을 찾는 유일한 열쇠다. 하나라도 어긋나면 그 곡은 영영 못 찾는다.
- cue마다 `takes_per_cue`개(기본 10개)를 만든다. `take` 번호는 1부터 연속.
- `style`은 **영어**로 쓴다. Suno가 영어 프롬프트를 훨씬 잘 알아듣는다.
- `style`은 1000자를 넘기지 않는다. 실제로는 200자 안쪽이 낫다.
- `instrumental`은 전부 `true`. 가사를 넣지 않는다. 프롬프트에 가사·보컬을 암시하는 말(vocal, singer, lyrics, choir 등)도 쓰지 않는다.
- 같은 cue의 10곡은 **서로 뚜렷이 달라야 한다.** 같은 문장을 조금씩 바꾼 것은 쓸모가 없다.

## 10곡을 어떻게 다르게 할 것인가

cue의 분위기는 유지하되, 아래 축을 조합해 실제로 다른 곡이 나오게 한다.

| 축 | 예 |
|---|---|
| 템포·박자 | 60bpm ↔ 140bpm, 4/4 ↔ 3/4 ↔ 5/4 |
| 편성 | 현악 / 신스 / 타악 중심 / 솔로 악기(첼로·클라리넷·기타) / 실내악 |
| 강도 | 거의 들리지 않는 배경 ↔ 꽉 찬 총주 |
| 질감 | 어쿠스틱 ↔ 전자음 ↔ 둘을 섞음, 깨끗함 ↔ 거칠게 녹음된 느낌 |
| 접근 | 또렷한 주제 선율 ↔ 선율 없는 앰비언트·드론 |

한 곡 안에서 이 축들을 여러 개 동시에 바꾸면 cue에서 너무 멀어진다. **한두 축만 바꾸고 나머지는 붙들어 둔다.**

## 프롬프트 쓰는 법

- 장르·악기·템포·분위기·질감을 짧은 구로 나열한다. 문장으로 길게 쓰지 않는다.
- 좋음: `sparse solo cello, 60bpm, wide hall reverb, aching and restrained, film score`
- 나쁨: `A beautiful and emotional piece of music that makes the listener feel sad about the past`
- 영화 음악임을 알리는 말(`film score`, `cinematic underscore`)을 넣으면 결과가 안정적이다.
- 실제 아티스트·곡 이름은 쓰지 않는다.

`prompts.json` 하나만 출력한다. 설명은 붙이지 않는다.
