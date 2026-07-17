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
- Finder에서 파일·폴더를 앱으로 드래그하여 등록
- 등록 폴더 재스캔 및 새 파일 감지
- 등록 폴더의 추가·복원·이동을 실시간 감시하고 자동 갱신
- 이름·카테고리·태그·메모 통합 검색
- 실제 파일을 다른 폴더 또는 카테고리 폴더로 이동
- 라이브러리 항목만 삭제하거나 원본 파일을 macOS 휴지통으로 이동
- 카테고리 폴더와 태그를 각각 탐색·필터링
- Soundly 형태의 중첩 카테고리 폴더 트리와 펼치기·접기
- 상위 카테고리 선택 시 모든 하위 폴더 사운드 함께 표시
- 즐겨찾기와 메타데이터 편집
- 검색·이동·태그·추가·삭제·재생 단축키 사용자 설정
- 오디오 미리 듣기
- 하단에 좌·우 채널을 합친 한 줄 파형 표시
- 미리듣기 음량 조절과 음소거 (설정값 자동 저장)
- 사운드 이름 오른쪽에 실제 오디오 파형 표시
- 파형 드래그로 구간 선택 및 선택 구간 미리 듣기
- 선택 구간만 임시 WAV로 만들어 Resolve에 드래그
- Finder에서 원본 위치 열기
- 기본 단축키: `⌘S` 검색, `⌘M` 카테고리 이동, `⌘T` 태그 편집, `⌘⌫` 원본 삭제
- 사운드 행 어디서든 드래그하여 DaVinci Resolve에 실제 파일 전달
- 사운드 이름을 더블클릭하여 Resolve의 현재 타임헤드·선택 오디오 트랙에 삽입

## DaVinci Resolve 자동 삽입 설정

`DaVinci Resolve > Preferences > System > General > External scripting using`을 `Local`로 설정하고 Resolve를 재시작합니다. 프로젝트와 타임라인을 연 뒤 Fairlight에서 삽입할 오디오 트랙을 선택하면 Sound Shelf의 사운드 이름 더블클릭으로 현재 타임헤드에 삽입됩니다. 이 기능은 Resolve Studio 스크립팅 API를 사용합니다.

라이브러리 정보는 Electron 사용자 데이터 폴더의 `sound-library.json`에 저장되며 원본 오디오 파일은 이동하거나 수정하지 않습니다.
