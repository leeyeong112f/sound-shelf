# suno-batch

영화 cue별 BGM 후보를 Suno로 대량 생성하고, 내려받아 Sound Shelf 볼트의 cue 폴더에 넣는다.

```
cues.yaml ──(Codex)──► prompts.json ──(generate)──► Suno 라이브러리
                                                        │
                                            (download) ─┴─► 볼트/Cue 01 오프닝/CUE01-T01.wav
```

---

## 먼저 알아야 할 것

### 다운로드에 개수 한도가 있다 (2026-09-03부터)

**생성과 다운로드는 별개 한도다.** 크레딧이 남아 있어도 내려받기는 따로 막힌다.

| 플랜 | 크레딧 | 다운로드 |
|---|---|---|
| Free | 일 50 | 평생 7회 |
| Pro $10 | 2,500/월 (약 500곡 생성) | **월 20회** |
| Premier $30 | 10,000/월 | 월 60회 |

한도는 소급 적용이라 기존 라이브러리 전체에 걸리고, 추가 다운로드는 곡당 $2.99(벌크 할인 없음)다.
500곡을 다 받으려면 Pro로 약 25개월이다.

**이 도구는 한도를 우회하지 않는다.** 벽을 만나면 그 자리에서 멈추고, 받은 것까지는 볼트에 남긴다.
다음 결제일 이후 같은 명령을 다시 돌리면 이어서 받는다.

그래서 이렇게 쓰는 것을 전제로 만들었다.

1. `generate`로 500곡을 다 만든다 (크레딧만 씀)
2. **Suno에서 들어보고** cue마다 쓸 만한 1~2곡을 고른다
3. `download --only`로 고른 것만 받는다 (50~100회면 충분)

### 약관

Suno 약관은 자동화된 접근을 제한할 가능성이 높고, 계정 정지 위험이 있다. 쓸지 말지는 사용자 판단이다.
도구는 사람이 쓰는 속도로만 움직이고(생성 사이 8~15초), 로그인은 사람이 직접 하며,
CAPTCHA나 모르는 화면을 만나면 추측해서 누르지 않고 멈춘다.

---

## 설치

```bash
cd tools/suno-batch
pip install -r requirements.txt
playwright install chromium
```

ffmpeg도 필요하다 (WAV 변환).

```bash
brew install ffmpeg
```

---

## 쓰는 순서

### 1. cue를 정의한다

```bash
cp cues.example.yaml cues.yaml
```

cue마다 번호·이름·분위기만 적는다. 실제 프롬프트는 다음 단계에서 만든다.

### 2. Codex로 프롬프트를 만든다

`CODEX_BRIEF.md`의 지시문과 `cues.yaml`을 Codex에 주면 `prompts.json`이 나온다. 바로 검사한다.

```bash
python3 suno_batch.py validate prompts.json
```

제목 형식(`CUE01-T03`)이 하나라도 어긋나면 여기서 걸린다. 이 제목이 나중에 곡을 찾는 유일한 열쇠라 그렇다.

### 3. 첫 로그인

```bash
python3 suno_batch.py probe
```

브라우저가 열린다. Suno에 **직접 로그인**하면 이후 실행은 그 프로필(`.profile/`)을 재사용한다.
스크립트는 비밀번호를 저장하지도 입력하지도 않는다.

`probe`는 각 셀렉터가 현재 화면에서 잡히는지도 보여준다. Suno UI가 바뀌어 도구가 멈추면 여기서부터 본다.

### 4. 소량으로 확인한다

```bash
python3 suno_batch.py generate --dry-run --limit 3     # 실제로 만들지 않고 목록만
python3 suno_batch.py generate --limit 2               # 진짜로 2곡
```

### 5. 전체를 만든다

```bash
python3 suno_batch.py generate
python3 suno_batch.py status
```

중간에 끊겨도 다시 돌리면 이어서 한다. 한 곡 끝날 때마다 `work/manifest.json`에 기록하기 때문이다.

### 6. Suno에서 골라서 받는다

들어보고 쓸 것을 정한 뒤:

```bash
python3 suno_batch.py download --vault ~/SoundVault --only CUE01-T03,CUE02-T07,CUE03-T01
```

한도만큼 나눠 받으려면:

```bash
python3 suno_batch.py download --vault ~/SoundVault --limit 20
```

받은 파일은 WAV(24bit PCM)로 변환되어 `볼트/Cue 01 오프닝/CUE01-T03.wav`에 들어간다.
Sound Shelf가 폴더 감시로 잡는다. 안 보이면 앱에서 `↻`(폴더 다시 스캔).

---

## 명령

| 명령 | 하는 일 |
|---|---|
| `validate [prompts.json]` | 프롬프트 파일 검사. 브라우저를 열기 전에 먼저 |
| `generate` | 프롬프트를 Suno에 넣어 곡을 만든다. **크레딧 사용** |
| `status` | 진행 상황과 실패 목록 |
| `download` | 만든 곡을 받아 볼트에 넣는다. **다운로드 한도 사용** |
| `probe` | 셀렉터가 현재 화면에서 잡히는지 확인 |

자주 쓰는 옵션: `--limit N`, `--only 제목,제목`, `--dry-run`, `--retry-failed`, `--vault 경로`

---

## 고장났을 때

**`'…'을(를) 찾지 못했습니다`** — Suno 화면이 바뀌었다. `probe`를 돌려 어느 항목이 안 잡히는지 보고,
`sunobatch/selectors.py`에서 그 항목의 후보를 고친다. 후보는 여러 개 둘 수 있고 위에서부터 시도한다.

**`켜짐/꺼짐을 읽을 수 없습니다`** — 토글 상태를 확신할 수 없어 멈춘 것이다. 잘못 눌러 인스트루멘털이
꺼진 채 수백 곡이 나오는 것보다 낫다. `work/diagnostics/`의 스크린샷을 보고 `selectors.py`를 고친다.

**`연달아 3번 실패했습니다`** — 한 건씩의 문제가 아니라 화면이 바뀐 것으로 보고 전체를 멈춘다.

**`한도에 걸려 멈췄습니다`** — 정상이다. 받은 것까지는 볼트에 있고, 나머지는 `generated` 상태로 남는다.
다음 결제일 이후 같은 명령을 다시 돌린다.

`work/diagnostics/`에 멈춘 시점의 스크린샷과 HTML이 남는다.

---

## 시험

```bash
python3 -m unittest discover -s tests
```

의존성 없이 돈다(순수 모듈). 통합 시험은 `tests/mock_suno/`의 가짜 Suno 페이지를 로컬 HTTP로 띄워
생성→다운로드→볼트 배치 전 과정을 돌린다. **진짜 Suno에는 접속하지 않는다.**
