# 두 인스턴스 동기화 수동 검증

**실제 Google Drive 볼트로 하지 말 것.** 로컬 임시 폴더만 쓴다.

## 준비

	VAULT=$(mktemp -d)/vault
	mkdir -p "$VAULT/액션"
	# 임의의 wav 3개 (ffmpeg로 무음 생성 가능)
	for n in s1 s2 s3; do ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 1 "$VAULT/액션/$n.wav"; done
	A=$(mktemp -d)/userdata-a
	B=$(mktemp -d)/userdata-b

## 실행

인스턴스 A와 B를 각각 다른 userData로 띄운다. Electron `--user-data-dir`는 userData에
적용되지 않으므로, 런처 스크립트에서 `require('electron').app.setPath('userData', ...)`를
`require('./src/main.js')` **앞에** 호출한다. single-instance lock이 userData 기준이라
이렇게 하면 두 인스턴스가 동시에 뜬다.

userData에 아래 내용의 `sound-library.json`을 미리 넣어두면 다이얼로그 없이 시작 시
볼트가 활성화된다:

	{"version":3,"sounds":[],"categories":[],"categoryOrder":[],
	 "settings":{"watchedFolders":["<VAULT>"],"currentVaultRoot":"<VAULT>","previewVolume":0.8}}

**A를 먼저 띄우고 스캔이 끝난 뒤(≈10초) B를 띄운다.** 빈 볼트를 두 인스턴스가 동시에
처음 스캔하면 같은 파일에 서로 다른 id를 배정해 dedupe 수렴 전 편집이 유실될 수 있다
(기존 볼트는 베이스 metadata.json에 id가 공유되어 있어 해당 없음 — 알려진 한계).

## 확인 항목

1. A와 B 모두에서 볼트가 열리고 사운드 3개가 보인다.
2. `$VAULT/.sound-shelf/edits/`에 **서로 다른 이름의 json 파일 2개**가 생긴다.
   같은 파일을 공유하면 설계가 깨진 것이다.
3. A에서 s1에 태그를 단다. **10초 안에** B에 반영되고
   "다른 Mac의 변경 사항을 반영했습니다" 토스트가 뜬다.
4. B에서 s2에 태그를 단다. **A의 s1 태그가 살아있는 채로** A에 s2 태그가 반영된다.
   (통째 덮어쓰기 유실 버그의 회귀 테스트 — 가장 중요한 항목.)
5. A에서 s3을 **파일까지 삭제**한다 (일괄 삭제 또는 Alt+삭제 — `trashFile: true` 경로).
   B에서 사라지고, **양쪽을 재시작해도 되살아나지 않는다.**
   주의: 레코드만 삭제(파일 유지)하면 다음 전체 스캔이 디스크의 파일을 재발견해
   **새 id로 다시 등록**한다. 이는 동기화 이전부터 있던 폴더 우선 설계의 의도된
   동작이며 동기화 회귀가 아니다. 삭제 표식(tombstone)이 막는 것은 메타데이터
   경로의 부활이다.
6. 양쪽을 종료했다가 다시 켠다. 모든 태그가 남아있다.
7. `$VAULT/.sound-shelf/`에 `metadata.json`과 `folder-order.json`이 **생기지 않는다**
   (신규 볼트 기준). 기존 볼트라면 mtime이 볼트를 연 이후로 바뀌지 않아야 한다.
   바뀌었다면 공유 쓰기가 남아있는 것이다. (`vault.json`은 최초 생성 시 1회,
   `backups/`는 활성화마다 고유 이름으로 추가되는 것이 정상.)

## 자동화

위 항목 1~7을 스크립트로 수행하는 런처가 있다. 렌더러의 실제 preload IPC
(`updateSound`/`removeSound`)를 `webContents.executeJavaScript`로 호출하므로
`library:update → queueSave → saveDb → saveEdits` 전체 경로를 그대로 지난다.

역할: `SYNC_ROLE=a`(태그+삭제) → 12초 뒤 `SYNC_ROLE=b`(태그+수신 검증) →
둘 다 종료 후 `SYNC_ROLE=b2`(재시작 지속성 검증). 각 역할이 `result-<role>.log`에
`CHECK <이름> PASS/FAIL`을 남긴다. 2026-07-18 실행 결과는 커밋 메시지 참조.
