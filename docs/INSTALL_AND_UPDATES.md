# Sound Shelf 설치와 자동 업데이트 배포

## 다른 Mac에서 최초 설치

1. [Sound Shelf Releases](https://github.com/leeyeong112f/sound-shelf/releases/latest)를 엽니다.
2. `Sound-Shelf-버전-universal.dmg`를 다운로드합니다.
3. DMG를 열고 `Sound Shelf`를 `응용 프로그램` 폴더로 드래그합니다.
4. `응용 프로그램`에서 Sound Shelf를 **우클릭 → 열기 → 열기** 로 실행합니다. 서명 없는 빌드는 더블클릭하면 macOS가 막습니다. 한 번만 이렇게 열면 다음부터는 그냥 열립니다.
5. 설정의 `기존 볼트 열기`를 누르고 Google Drive의 공유 `효과음_통합` 폴더를 선택합니다.
6. Google Drive를 스트리밍 방식으로 사용한다면 공유 볼트를 Finder에서 우클릭하고 `오프라인 사용 가능`을 선택합니다.

`universal` 설치 파일은 Apple Silicon과 Intel Mac을 모두 지원합니다.

## 설치 후 자동 업데이트

Sound Shelf는 실행 12초 후 새 GitHub Release를 확인하고 이후 4시간마다 다시 확인합니다. 새 버전이 있으면 백그라운드로 다운로드하고 `재시작하고 업데이트` 버튼을 표시합니다. `나중에`를 선택하면 앱을 종료할 때 업데이트가 적용됩니다.

**이 자동 업데이트는 서명된 빌드에서만 동작합니다.** Apple 인증서를 등록하지 않았다면 릴리스는 서명 없이 만들어지고, macOS가 서명을 검증할 수 없어 앱 안에서 업데이트가 적용되지 않습니다. 새 버전은 [Releases](https://github.com/leeyeong112f/sound-shelf/releases/latest)에서 DMG를 받아 다시 설치해 주세요.

## 배포자 설정 (선택)

**아무 설정을 하지 않아도 `main`에 푸시하면 자동으로 배포됩니다.** 다만 Apple 인증서가 없으면 서명 없는 빌드가 만들어져, 받는 사람이 첫 실행 때 우클릭으로 열어야 하고 앱 내 자동 업데이트가 동작하지 않습니다.

아래 설정은 그 두 가지를 없애고 싶을 때만 필요하며, 연 99달러 Apple Developer Program 가입이 전제입니다.

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

Secrets를 등록하면 다음 푸시부터 워크플로가 자동으로 서명·공증 빌드로 전환합니다. 별도로 켜야 하는 스위치는 없습니다.

## 이후 바이브코딩 배포 흐름

수정 작업을 `main` 브랜치에 푸시하는 것만으로 배포됩니다.

1. 기능을 수정하고 검사합니다.
2. 변경 내용을 Git 커밋합니다.
3. GitHub `main`에 푸시합니다.
4. GitHub Actions가 `npm run check`와 `npm test`를 돌립니다. 하나라도 실패하면 배포가 중단됩니다.
5. 자동 버전을 만들고 Universal DMG와 업데이트 ZIP을 빌드해 GitHub Release에 게시합니다.
6. Apple 인증서가 등록되어 있으면 서명·공증한 뒤 게시하고, 설치된 앱이 자동으로 새 버전을 받습니다. 인증서가 없으면 서명 없이 게시하고, 받는 사람이 Releases에서 DMG를 내려받아 다시 설치합니다.

버전은 `0.1.GitHub실행번호` 형식으로 자동 증가합니다. 같은 사용자에게 배포하는 동안 Developer ID 인증서를 임의로 바꾸지 않아야 기존 설치본이 업데이트를 신뢰할 수 있습니다.

## 공식 참고 문서

- [Electron 자동 업데이트](https://www.electronjs.org/docs/latest/tutorial/updates)
- [electron-builder 자동 업데이트](https://www.electron.build/docs/features/auto-update/)
- [electron-builder GitHub Actions 배포](https://www.electron.build/docs/features/github-actions/)
- [Apple macOS 앱 공증](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
