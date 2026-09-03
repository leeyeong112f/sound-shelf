// Sound Shelf Electron 앱을 헤드리스 리눅스에서 띄우고 조작하는 REPL 드라이버.
// stdin으로 명령 한 줄을 보내면 실행하고 결과를 출력한다. 사용법은 SKILL.md 참고.
import { createRequire } from 'node:module';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const APP_DIR = path.resolve(import.meta.dirname, '../../..');
const require = createRequire(path.join(APP_DIR, 'package.json'));
const { _electron: electron } = require('playwright-core');

const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/sound-shelf-shots';
const SAMPLE_DIR = process.env.SAMPLE_DIR || '/tmp/sound-shelf-samples';
fs.mkdirSync(SHOT_DIR, { recursive: true });

let app = null;
let page = null;

const need = () => {
  if (!page) throw new Error('먼저 launch를 실행하세요.');
};

const COMMANDS = {
  async launch() {
    if (app) return console.log('이미 실행 중입니다.');
    app = await electron.launch({
      executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
      // --no-sandbox 없이는 컨테이너에서 뜨지 않는다 (CAP_SYS_ADMIN 부재).
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', APP_DIR],
      timeout: 90_000,
    });
    page = await app.firstWindow();
    await new Promise((r) => setTimeout(r, 7000));
    console.log('실행됨. 창', app.windows().length, '개');
  },

  // 네이티브 파일 선택 창은 자동 조작이 불가능하므로 메인 프로세스에서 결과를 고정한다.
  async 'stub-dialog'(target) {
    if (!app) throw new Error('먼저 launch를 실행하세요.');
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: chosen });
    }, target);
    console.log('파일 선택 창 고정:', target);
  },

  // IPC를 직접 부르면 렌더러가 다시 그리지 않는다. 반드시 실제 버튼을 눌러야 한다.
  async 'open-vault'(vaultPath) {
    need();
    await COMMANDS['stub-dialog'](vaultPath || SAMPLE_DIR);
    await page.evaluate(() => document.querySelector('#openVaultBtn').click());
    // 스캔 시간은 파일 수에 따라 달라지므로 고정 대기 대신 목록이 찰 때까지 기다린다.
    for (let i = 0; i < 40; i += 1) {
      if (await page.evaluate(() => document.querySelectorAll('.sound-row').length > 0)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await COMMANDS.sounds();
  },

  async sounds() {
    need();
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.sound-row')].map((r, i) => ({
        번호: i,
        id: r.dataset.id,
        이름: r.querySelector('strong, .sound-title')?.textContent?.trim() ?? r.innerText.split('\n')[1] ?? '',
      })));
    if (!rows.length) console.log('사운드 없음 (볼트를 먼저 여세요)');
    for (const r of rows) console.log(` [${r.번호}] ${r.이름}`);
    return rows;
  },

  // 조성 검출은 python3 + numpy + ffmpeg를 모두 태우는 경로다.
  async key(index) {
    need();
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.sound-row')].map((r) => r.dataset.id));
    const targets = index === '' ? rows : [rows[Number(index)]];
    for (const id of targets.filter(Boolean)) {
      const out = await page.evaluate(async (soundId) => {
        const name = document.querySelector(`.sound-row[data-id="${soundId}"]`)?.innerText.split('\n')[1] ?? soundId;
        try {
          const snap = await window.soundLibrary.analyzeKey({ id: soundId, force: true });
          const a = snap.keyAnalysisResult?.analysis;
          return a?.detected
            ? `${name}: ${a.display} (${a.korean}, ${a.camelot}) 신뢰도 ${Math.round(a.confidence * 100)}% 튜닝 ${a.tuningCents}cent v${a.analysisVersion}`
            : `${name}: 미검출 — ${a?.reason ?? ''} 신뢰도 ${Math.round((a?.confidence ?? 0) * 100)}%`;
        } catch (e) { return `${name}: 오류 ${e.message.slice(0, 160)}`; }
      }, id);
      console.log(' ', out);
    }
  },

  // 합성 contextmenu 이벤트는 무시된다. Playwright의 실제 우클릭을 써야 메뉴가 열린다.
  async 'key-ui'(index) {
    need();
    const row = page.locator('.sound-row').nth(Number(index || 0));
    await row.click();
    await new Promise((r) => setTimeout(r, 600));
    await row.click({ button: 'right' });
    await new Promise((r) => setTimeout(r, 1200));
    await page.evaluate(() => {
      const menu = document.querySelector('#contextMenu');
      (menu?.querySelector('[data-context-action="view-key"]')
        ?? menu?.querySelector('[data-context-action="analyze-key"]'))?.click();
    });
    await new Promise((r) => setTimeout(r, 15_000));
    console.log(await page.evaluate(() =>
      document.querySelector('#resultsContent')?.innerText?.slice(0, 500) ?? '(창이 열리지 않음)'));
  },

  // 조성 검출을 시험할 합성 오디오를 만든다 (numpy 필요).
  async samples(dir) {
    const out = dir || SAMPLE_DIR;
    const script = path.join(import.meta.dirname, 'make-samples.py');
    console.log(execFileSync(process.env.PYTHON || 'python3', [script, out], { encoding: 'utf8' }).trim());
  },

  async ss(name) {
    need();
    const file = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png');
    await page.screenshot({ path: file });
    console.log('저장:', file);
  },

  async click(sel) {
    need();
    console.log('click', sel, '->', await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK';
    }, sel));
  },

  async 'click-text'(text) {
    need();
    console.log('click-text', text, '->', await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"], [data-context-action]')];
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t));
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK: ' + el.textContent.trim().slice(0, 40);
    }, text));
  },

  async eval(expr) { need(); console.log(JSON.stringify(await page.evaluate(expr))); },
  async text(sel) {
    need();
    console.log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null));
  },
  async wait(sel) {
    need();
    try { await page.waitForSelector(sel, { timeout: 15_000 }); console.log('찾음:', sel); }
    catch { console.log('시간 초과:', sel); }
  },
  async press(key) { need(); await page.keyboard.press(key); },
  async type(t) { need(); await page.keyboard.type(t, { delay: 20 }); },
  async windows() {
    if (!app) throw new Error('먼저 launch를 실행하세요.');
    for (const w of app.windows()) console.log(' ', w.url());
  },
  async quit() { if (app) await app.close().catch(() => {}); app = null; page = null; },
  help() { console.log('명령:', Object.keys(COMMANDS).join(', ')); },
};

// Electron이 stdin을 가로채므로 raw fd로 직접 읽는다.
const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' });

// 파이프로 여러 줄을 한꺼번에 넣으면 readline이 즉시 모두 발행한다.
// 앞 명령이 끝나기 전에 다음 명령이 시작되지 않도록 한 줄씩 차례로 처리한다.
let queue = Promise.resolve();
rl.on('line', (line) => {
  queue = queue.then(async () => {
    const trimmed = line.trim();
    if (!trimmed) return rl.prompt();
    const [cmd, ...rest] = trimmed.split(/\s+/);
    const fn = COMMANDS[cmd];
    if (!fn) { console.log('알 수 없는 명령:', cmd, '(help 참고)'); return rl.prompt(); }
    try { await fn(rest.join(' ')); } catch (e) { console.log('오류:', e.message); }
    if (cmd === 'quit') { rl.close(); process.exit(0); }
    rl.prompt();
  });
});
// 파이프 입력은 마지막 줄을 읽자마자 close가 뜬다. 큐가 다 끝난 뒤에 종료한다.
rl.on('close', async () => {
  await queue.catch(() => {});
  await COMMANDS.quit();
  process.exit(0);
});
console.log('Sound Shelf 드라이버 — help로 명령 목록, launch로 시작');
rl.prompt();
