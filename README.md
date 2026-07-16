# Sound Shelf

로컬 사운드 파일을 검색·분류·미리 듣고 DaVinci Resolve 타임라인으로 드래그하는 macOS 데스크톱 앱입니다.

## 실행

```bash
npm install
npm start
```

파형 분석과 선택 구간 WAV 생성에는 `ffmpeg`가 필요합니다.

```bash
brew install ffmpeg
```

## macOS 앱 빌드

```bash
npm run build:mac
```

완성된 앱은 `outputs` 폴더에 생성됩니다. 이 폴더와 개인 사운드 파일은 GitHub 저장소에 포함되지 않습니다.

## 현재 기능

- 오디오 파일 또는 폴더 등록
- 등록 폴더 재스캔 및 새 파일 감지
- 이름·카테고리·태그·메모 통합 검색
- 카테고리 자동 생성, 즐겨찾기, 메타데이터 편집
- 오디오 미리 듣기
- 사운드 이름 오른쪽에 실제 오디오 파형 표시
- 파형 드래그로 구간 선택 및 선택 구간 미리 듣기
- 선택 구간만 임시 WAV로 만들어 Resolve에 드래그
- Finder에서 원본 위치 열기
- 라이브러리 항목 삭제 (원본 유지)
- 사운드 행 어디서든 드래그하여 DaVinci Resolve에 실제 파일 전달
- 사운드 이름을 더블클릭하여 Resolve의 현재 타임헤드·선택 오디오 트랙에 삽입

## DaVinci Resolve 자동 삽입 설정

`DaVinci Resolve > Preferences > System > General > External scripting using`을 `Local`로 설정하고 Resolve를 재시작합니다. 프로젝트와 타임라인을 연 뒤 Fairlight에서 삽입할 오디오 트랙을 선택하면 Sound Shelf의 사운드 이름 더블클릭으로 현재 타임헤드에 삽입됩니다. 이 기능은 Resolve Studio 스크립팅 API를 사용합니다.

라이브러리 정보는 Electron 사용자 데이터 폴더의 `sound-library.json`에 저장되며 원본 오디오 파일은 이동하거나 수정하지 않습니다.
