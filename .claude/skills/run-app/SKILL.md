---
name: run-app
description: Sound Shelf 데스크톱 앱(Electron)을 헤드리스 리눅스에서 실행하고 조작한다. 앱을 켜 달라거나, 화면을 캡처해 달라거나, 조성(Key) 분석·볼트 열기 같은 기능이 실제로 동작하는지 눈으로 확인해 달라는 요청에 사용한다.
---

Sound Shelf는 Electron 데스크톱 앱이라 헤드리스 환경에서는 창을 볼 수 없다.
`driver.mjs`(Playwright REPL)를 xvfb 아래에서 돌려 명령 한 줄씩 앱을 조작하고
스크린샷으로 결과를 확인한다. 모든 경로는 저장소 루트 기준이다.

## 준비

```bash
npm install
npm install --no-save playwright-core          # 드라이버 전용, 앱 의존성 아님

# Electron 바이너리(약 220MB)가 npm install에서 빠졌다면 직접 받는다.
# 에이전트 프록시 뒤에서는 NODE_USE_ENV_PROXY=1 없이 전송이 중간에 끊긴다.
NODE_USE_ENV_PROXY=1 node node_modules/electron/install.js

# 조성 분석에 필요 (ffprobe도 같이 설치된다)
apt-get update -qq && apt-get install -y --no-install-recommends ffmpeg
pip3 install --break-system-packages numpy
```

## 실행

명령을 파이프로 넣는 방식이 가장 확실하다.

```bash
printf 'samples /tmp/vault\nlaunch\nopen-vault /tmp/vault\nkey\nss 라이브러리\nquit\n' | \
  xvfb-run -a --server-args='-screen 0 1600x1000x24' node .claude/skills/run-app/driver.mjs
```

대화형으로 쓰려면 인자 없이 실행한 뒤 `help`를 친다.

```bash
xvfb-run -a --server-args='-screen 0 1600x1000x24' node .claude/skills/run-app/driver.mjs
```

스크린샷은 `/tmp/sound-shelf-shots`에 저장된다(`SCREENSHOT_DIR`로 변경).
**반드시 저장된 PNG를 직접 열어 확인한다.** 빈 화면이면 실행에 실패한 것이다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `launch` | 앱 실행 (약 7초) |
| `samples [폴더]` | 정답이 정해진 시험용 WAV 4개 생성 (기본 `/tmp/sound-shelf-samples`) |
| `open-vault <폴더>` | 폴더를 볼트로 열고 목록이 찰 때까지 기다린 뒤 사운드 목록 출력 |
| `sounds` | 등록된 사운드를 번호와 함께 출력 |
| `key [번호]` | 해당 사운드를 조성 분석 (번호 생략 시 전부). python3·numpy·ffmpeg를 모두 태운다 |
| `key-ui <번호>` | 우클릭 → 조성 분석 창을 열고 내용 출력 |
| `ss [이름]` | 스크린샷 저장 |
| `stub-dialog <경로>` | 네이티브 파일 선택 창이 항상 이 경로를 돌려주게 고정 |
| `click <선택자>` / `click-text <문구>` | 요소 클릭 |
| `eval <js>` / `text [선택자]` / `wait <선택자>` | 페이지 조회 |
| `press <키>` / `type <문자열>` | 키보드 입력 |
| `windows` | 창 목록 |
| `quit` | 앱 종료 후 REPL 종료 |

`samples`가 만드는 파일은 정답이 정해져 있어 채점할 수 있다.
`02_밝은_C장3화음`은 예전 알고리즘이 E Minor로 뒤집던 회귀 사례다.

```
01_C장조_코드진행 → C Major     02_밝은_C장3화음 → C Major
03_A단조_코드진행 → A Minor     04_잡음_효과음   → 미검출
```

## 유튜브 가져오기 시험

이 컨테이너는 유튜브에 접속할 수 없으므로 `SOUND_SHELF_YT_DLP` 환경 변수로 가짜 yt-dlp를
지정한다. 가짜 실행 파일은 `-o` 템플릿 폴더에 `source.<ext>`와 `source.info.json`을 쓰고
`[download]  45.0% …` 형식의 진행률 줄을 출력하면 된다. 붙여넣기는 렌더러에서 합성한다.

```bash
SOUND_SHELF_YT_DLP=/path/to/fake-yt-dlp printf '%s\n' launch 'open-vault /tmp/vault' \
  "eval (() => { const dt = new DataTransfer(); dt.setData('text/plain', 'https://youtu.be/dQw4w9WgXcQ'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 'ok'; })()" \
  'ss after-paste' sounds quit | xvfb-run -a --server-args='-screen 0 1600x1000x24' node .claude/skills/run-app/driver.mjs
```

완료 토스트(`… WAV 파일을 … 저장했습니다.`)가 뜰 때까지 `eval`로 `#scanToast` 문구를 폴링한다.

## 사람이 직접 실행할 때

```bash
npm start   # 창이 뜬다. 헤드리스 환경에서는 쓸모없다.
```

## 걸리는 지점

- **IPC를 직접 부르면 화면이 갱신되지 않는다.** `window.soundLibrary.openVault()`를
  호출하면 메인 프로세스는 볼트를 열지만 렌더러가 `setLibrary()`를 거치지 않아
  목록이 0개로 남는다. 반드시 실제 버튼(`#openVaultBtn` 등)을 클릭해야 한다.
- **네이티브 파일 선택 창은 자동 조작이 불가능하다.** `app.evaluate`로 메인
  프로세스의 `dialog.showOpenDialog`를 덮어써 경로를 고정한다(`stub-dialog`).
- **합성 `contextmenu` 이벤트는 무시된다.** `dispatchEvent(new MouseEvent(...))`로는
  우클릭 메뉴가 열리지 않는다. Playwright의 실제 우클릭(`click({button:'right'})`)을 쓴다.
- **Playwright가 들고 있는 ffmpeg는 WAV를 못 읽는다.** `image2pipe`와 `matroska,webm`
  디먹서만 있는 화면 녹화 전용 빌드다. 조성 분석을 시키려면 정식 ffmpeg가 필요하다.
- **`--no-sandbox`가 없으면 컨테이너에서 뜨지 않는다.** Electron 샌드박스는
  CAP_SYS_ADMIN이나 user namespace를 요구한다.
- **볼트 스캔 시간은 파일 수에 따라 다르다.** 고정 대기 대신 `.sound-row`가
  생길 때까지 폴링한다(`open-vault`가 이미 그렇게 한다).
- **`#vaultName`은 설정 화면을 열기 전까지 "열린 볼트 없음"으로 남는다.**
  볼트가 열렸는지는 `.sound-row` 개수로 판단한다.
- **파이프 입력은 readline이 모든 줄을 즉시 발행하고 곧바로 close를 띄운다.**
  드라이버가 명령을 큐로 직렬화하고 종료 전에 큐를 비운다.
- 이 환경에서 `tmux capture-pane`은 빈 출력을 돌려줬다. 파이프 방식이 확실하다.

## 문제 해결

- **실행이 30초 넘게 걸리다 실패** → `node_modules/electron/dist/electron`이 있는지
  확인한다. 없으면 위의 `NODE_USE_ENV_PROXY=1` 명령으로 다시 받는다.
- **"Missing X server"** → `xvfb-run`을 빠뜨렸다.
- **Xvfb 잠금 파일이 남음** → `pkill Xvfb; rm -f /tmp/.X*-lock`
- **조성 분석이 "Invalid data found when processing input"** → ffmpeg가 WAV를
  못 읽는 빌드다. `ffmpeg -demuxers | grep wav`로 확인한다.
- **조성 분석이 numpy 안내 문구를 낸다** → `pip3 install numpy`
- **앱 상태를 초기화하려면** → `rm -rf ~/.config/"Sound Shelf"`
