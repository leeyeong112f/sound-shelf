// macOS 휴지통 이동의 폴백.
//
// Google Drive 같은 File Provider 영역의 파일은 NSFileManager 의 휴지통 이동(shell.trashItem)이
// "접근 권한이 없다"(NSCocoaErrorDomain 513)며 거부된다. 반면 같은 파일을 ~/.Trash 로
// rename 하거나 복사 후 삭제하는 것은 된다(2026-09-29 LaunchServices 로 띄운 앱에서 확인).
// Drive 에 이미 동기화된 파일만 이렇게 되고, 막 넣은 파일은 trashItem 이 그대로 성공한다.
//
// Finder 의 "되돌려 놓기" 정보는 남지 않지만, 앱은 같은 자리로 돌아온 파일을 스스로 알아본다.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// 사용자 휴지통 폴더. Electron 의 app.getPath 에는 'trash' 가 없어(예외를 던진다) 홈에서 직접 만든다.
// 다른 볼륨의 파일은 rename 이 실패하고 복사로 넘어가므로 부팅 볼륨 휴지통 하나면 된다.
function userTrashDirectory(homeDirectory) {
  const home = String(homeDirectory || '').trim();
  if (!home) throw new Error('홈 폴더를 알 수 없어 휴지통 위치를 정할 수 없습니다.');
  return path.join(home, '.Trash');
}

// 휴지통 안에서 겹치지 않는 이름. Finder 처럼 "이름 2.wav", "이름 3.wav" 로 번호를 붙인다.
function trashDestination(trashDir, sourceName, exists = fs.existsSync) {
  const extension = path.extname(sourceName);
  const stem = path.basename(sourceName, extension);
  let candidate = path.join(trashDir, sourceName);
  for (let counter = 2; exists(candidate); counter += 1) {
    if (counter > 1000) throw new Error(`휴지통에 같은 이름이 너무 많습니다: ${sourceName}`);
    candidate = path.join(trashDir, `${stem} ${counter}${extension}`);
  }
  return candidate;
}

// trashItem 이 실패하면 rename 으로, 그것도 안 되면 복사 후 삭제로 휴지통에 넣는다.
// 폴백까지 실패하면 원래 오류를 던진다. 사용자가 본 문구가 진짜 원인이어야 한다.
async function moveToTrash(target, { trashItem, trashDir }) {
  let original;
  try {
    await trashItem(target);
    return { method: 'system' };
  } catch (error) {
    original = error;
  }
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat) throw original;
  let destination;
  try {
    destination = trashDestination(trashDir, path.basename(target));
  } catch {
    throw original;
  }
  try {
    await fsp.rename(target, destination);
    return { method: 'rename', destination };
  } catch {
    // 볼륨이나 File Provider 경계를 넘지 못하는 경우다.
  }
  try {
    if (stat.isDirectory()) {
      await fsp.cp(target, destination, { recursive: true, errorOnExist: true, force: false });
      await fsp.rm(target, { recursive: true });
    } else {
      await fsp.copyFile(target, destination, fs.constants.COPYFILE_EXCL);
      await fsp.unlink(target);
    }
    return { method: 'copy', destination };
  } catch {
    // 복사본만 남기고 원본은 못 지운 경우 복사본을 치운다.
    await fsp.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw original;
  }
}

module.exports = { moveToTrash, trashDestination, userTrashDirectory };
