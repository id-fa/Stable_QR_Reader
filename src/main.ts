import './styles.css';
import { Scanner, type ScannerStatus } from './scanner';
import { History } from './history';

const app = document.getElementById('app');
if (!app) throw new Error('#app not found');

app.innerHTML = `
  <header><h1>Stable QR Reader</h1></header>
  <main>
    <section class="viewer">
      <div class="video-wrap">
        <video id="video" playsinline muted></video>
      </div>
      <div class="controls">
        <select id="camera-select" aria-label="カメラ選択"></select>
        <button id="start-btn" class="primary">開始</button>
        <button id="stop-btn" disabled>停止</button>
        <label class="toggle">
          <input type="checkbox" id="torch-toggle" disabled />
          ライト
        </label>
        <label class="file-btn">
          画像ファイルから読み取り
          <input type="file" id="file-input" accept="image/*" hidden />
        </label>
      </div>
      <div id="status" class="status status-info">
        <strong>「開始」を押してカメラを起動してください。</strong>
      </div>
      <div id="capability" class="capability"></div>
    </section>
    <section>
      <div class="history-header">
        <h2>読み取り履歴</h2>
        <button id="clear-history">履歴をクリア</button>
      </div>
      <ul id="history-list"></ul>
    </section>
  </main>
`;

const video = document.getElementById('video') as HTMLVideoElement;
const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement;
const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const torchToggle = document.getElementById('torch-toggle') as HTMLInputElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const capabilityEl = document.getElementById('capability') as HTMLDivElement;
const historyList = document.getElementById('history-list') as HTMLUListElement;
const clearHistoryBtn = document.getElementById('clear-history') as HTMLButtonElement;

const scanner = new Scanner(video);
const history = new History();

function showStatus(s: ScannerStatus): void {
  statusEl.className = `status status-${s.level}`;
  const safeMsg = escapeHtml(s.message);
  const safeHint = s.hint ? `<small>${escapeHtml(s.hint)}</small>` : '';
  statusEl.innerHTML = `<strong>${safeMsg}</strong>${safeHint}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function isUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

function renderHistory(): void {
  historyList.innerHTML = '';
  for (const it of history.list()) {
    const li = document.createElement('li');

    const main = document.createElement('div');
    if (isUrl(it.text)) {
      const a = document.createElement('a');
      a.href = it.text;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = it.text;
      main.appendChild(a);
    } else {
      main.textContent = it.text;
    }
    li.appendChild(main);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const time = document.createElement('span');
    time.textContent = `${new Date(it.lastSeen).toLocaleString()}${it.count > 1 ? ` ・ ${it.count}回検出` : ''}`;
    meta.appendChild(time);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'コピー';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(it.text).then(() => {
        copyBtn.textContent = 'コピー済';
        setTimeout(() => (copyBtn.textContent = 'コピー'), 1200);
      });
    });
    actions.appendChild(copyBtn);

    if (isUrl(it.text)) {
      const openBtn = document.createElement('button');
      openBtn.textContent = '開く';
      openBtn.addEventListener('click', () => window.open(it.text, '_blank', 'noopener'));
      actions.appendChild(openBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', () => {
      history.remove(it.text);
      renderHistory();
    });
    actions.appendChild(delBtn);

    meta.appendChild(actions);
    li.appendChild(meta);
    historyList.appendChild(li);
  }
}

async function refreshCameraList(promptIfNeeded = false): Promise<void> {
  try {
    const cams = await Scanner.listCameras(promptIfNeeded);
    const current = cameraSelect.value;
    cameraSelect.innerHTML = '';
    for (const c of cams) {
      const opt = document.createElement('option');
      opt.value = c.deviceId;
      opt.textContent = c.label;
      cameraSelect.appendChild(opt);
    }
    if (current && cams.some((c) => c.deviceId === current)) {
      cameraSelect.value = current;
    }
  } catch (e) {
    console.warn('カメラ列挙失敗', e);
  }
}

function updateCapabilityDisplay(): void {
  const caps = scanner.getCapabilityFlags();
  const items: string[] = [];
  if (caps.focusModes.length) items.push(`フォーカス: ${caps.focusModes.join('/')}`);
  else items.push('フォーカス: 制御不可（パンフォーカス想定）');
  if (caps.exposureModes.length) items.push(`露出: ${caps.exposureModes.join('/')}`);
  if (caps.zoom) items.push(`ズーム: ×${caps.zoom.min}〜×${caps.zoom.max}`);
  if (caps.torch) items.push('ライト: 利用可');
  if (caps.facingMode) items.push(`向き: ${caps.facingMode}`);
  capabilityEl.textContent = items.join(' ・ ');
  torchToggle.disabled = !caps.torch;
}

function setRunningUI(running: boolean): void {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  startBtn.textContent = running ? '実行中' : '開始';
}

scanner.onStatus = showStatus;
scanner.onResults = (codes) => {
  for (const c of codes) history.add(c.rawValue);
  renderHistory();
};

startBtn.addEventListener('click', async () => {
  try {
    await scanner.start(cameraSelect.value || undefined);
    await refreshCameraList(false);
    updateCapabilityDisplay();
    setRunningUI(true);
  } catch {
    setRunningUI(false);
  }
});

stopBtn.addEventListener('click', () => {
  scanner.stop();
  setRunningUI(false);
  showStatus({ level: 'info', message: '停止しました。' });
});

cameraSelect.addEventListener('change', async () => {
  if (!scanner.isActive()) return;
  try {
    await scanner.start(cameraSelect.value);
    updateCapabilityDisplay();
  } catch {
    setRunningUI(false);
  }
});

torchToggle.addEventListener('change', async () => {
  const ok = await scanner.setTorch(torchToggle.checked);
  if (!ok) {
    torchToggle.checked = false;
    showStatus({
      level: 'warn',
      message: 'ライトを制御できませんでした。',
      hint: 'このカメラはライト制御に対応していません。',
    });
  }
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const codes = await scanner.detectFromFile(file);
    if (codes.length === 0) {
      showStatus({
        level: 'warn',
        message: 'この画像からQRコードを検出できませんでした。',
        hint: '画像が不鮮明、またはQRコード以外のコードの可能性があります。',
      });
    } else {
      for (const c of codes) history.add(c.rawValue);
      renderHistory();
      showStatus({
        level: 'ok',
        message: `画像から ${codes.length} 件のQRコードを検出しました。履歴をご確認ください。`,
      });
    }
  } catch (e) {
    const err = e as { message?: string };
    showStatus({
      level: 'error',
      message: '画像の読み取りに失敗しました。',
      hint: err?.message,
    });
  } finally {
    fileInput.value = '';
  }
});

clearHistoryBtn.addEventListener('click', () => {
  if (confirm('履歴をすべて削除しますか？')) {
    history.clear();
    renderHistory();
  }
});

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  refreshCameraList(false);
});

// 初期化
renderHistory();
refreshCameraList(false);
