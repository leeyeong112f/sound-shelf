# Sound Shelf 설치와 자동 업데이트 배포

## 다른 Mac에서 최초 설치

1. [Sound Shelf Releases](https://github.com/leeyeong112f/sound-shelf/releases/latest)를 엽니다.
2. `Sound-Shelf-버전-universal.dmg`를 다운로드합니다.
3. DMG를 열고 `Sound Shelf`를 `응용 프로그램` 폴더로 드래그합니다.
4. `응용 프로그램`에서 Sound Shelf를 실행합니다.
5. 설정의 `기존 볼트 열기`를 누르고 Google Drive의 공유 `효과음_통합` 폴더를 선택합니다.
6. Google Drive를 스트리밍 방식으로 사용한다면 공유 볼트를 Finder에서 우클릭하고 `오프라인 사용 가능`을 선택합니다.

`universal` 설치 파일은 Apple Silicon과 Intel Mac을 모두 지원합니다.

## 설치 후 자동 업데이트

Sound Shelf는 실행 12초 후 새 GitHub Release를 확인하고 이후 4시간마다 다시 확인합니다. 새 버전이 있으면 백그라운드로 다운로드하고 `재시작하고 업데이트` 버튼을 표시합니다. `나중에`를 선택하면 앱을 종료할 때 업데이트가 적용됩니다.

## 배포자 최초 1회 설정

macOS 자동 업데이트는 모든 버전을 같은 Developer ID로 서명해야 합니다. Apple Developer Program에서 `Developer ID Application` 인증서를 만든 뒤 Keychain Access에서 암호가 설정된 `.p12` 파일로 내보냅니다.

GitHub 저장소의 `Settings > Secrets and variables > Actions`에서 다음 Repository secret을 등록합니다.

- `CSC_LINK`: `.p12` 파일을 Base64로 인코딩한 전체 문자열
- `CSC_KEY_PASSWORD`: `.p12` 내보내기 암호
- `APPLE_ID`: Apple Developer 계정 이메일
- `APPLE_APP_SPECIFIC_PASSWORD`: Apple ID에서 발급한 앱 전용 암호
- `APPLE_TEAM_ID`: Apple Developer Team ID

`CSC_LINK` 값은 인증서 파일이 있는 Mac에서 다음 명령으로 복사할 수 있습니다.

```bash
base64 -i DeveloperID.p12 | pbcopy
```

인증 정보는 코드나 채팅에 넣지 말고 GitHub Secrets에만 저장합니다.

Secrets 등록을 마친 뒤 같은 화면의 `Variables`에서 Repository variable을 추가합니다.

- 이름: `AUTO_RELEASE_ENABLED`
- 값: `true`

마지막으로 `Actions > Release Sound Shelf for macOS > Run workflow`를 한 번 실행해 최초 Release를 만듭니다.

## 이후 바이브코딩 배포 흐름

최초 설정 이후에는 수정 작업을 `main` 브랜치에 푸시하는 것만으로 배포됩니다.

1. Codex로 기능을 수정하고 검사합니다.
2. 변경 내용을 Git 커밋합니다.
3. GitHub `main`에 푸시합니다.
4. GitHub Actions가 자동 버전을 만들고 Universal DMG와 업데이트 ZIP을 빌드합니다.
5. 앱을 서명·공증한 뒤 GitHub Release에 게시합니다.
6. 이미 설치된 Sound Shelf가 새 버전을 자동으로 다운로드합니다.

버전은 `0.1.GitHub실행번호` 형식으로 자동 증가합니다. 같은 사용자에게 배포하는 동안 Developer ID 인증서를 임의로 바꾸지 않아야 기존 설치본이 업데이트를 신뢰할 수 있습니다.

## 공식 참고 문서

- [Electron 자동 업데이트](https://www.electronjs.org/docs/latest/tutorial/updates)
- [electron-builder 자동 업데이트](https://www.electron.build/docs/features/auto-update/)
- [electron-builder GitHub Actions 배포](https://www.electron.build/docs/features/github-actions/)
- [Apple macOS 앱 공증](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
