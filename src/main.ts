import './styles.css';
import { Scanner, type ScannerStatus } from './scanner';
import type { DetectedCode } from './decoder';
import { History } from './history';

const app = document.getElementById('app');
if (!app) throw new Error('#app not found');

app.innerHTML = `
  <header><h1>Stable QR Reader</h1></header>
  <main>
    <section class="viewer">
      <div class="video-wrap">
        <video id="video" playsinline muted></video>
        <canvas id="overlay"></canvas>
      </div>
      <div class="controls">
        <select id="camera-select" aria-label="カメラ選択 / Select camera"></select>
        <button id="start-btn" class="primary">開始 / Start</button>
        <button id="stop-btn" disabled>停止 / Stop</button>
        <label class="toggle">
          <input type="checkbox" id="torch-toggle" disabled />
          ライト / Light
        </label>
        <label class="toggle">
          <input type="checkbox" id="zoom-toggle" />
          2倍ズーム / 2× Zoom
        </label>
        <label class="file-btn">
          画像ファイルから読み取り / Read from image file
          <input type="file" id="file-input" accept="image/*" hidden />
        </label>
      </div>
      <div id="status" class="status status-info">
        <strong>「開始」を押してカメラを起動してください。<span class="en">Press “Start” to launch the camera.</span></strong>
      </div>
      <div id="capability" class="capability"></div>
    </section>
    <section>
      <div class="history-header">
        <h2>読み取り履歴 / Scan history</h2>
        <button id="clear-history">履歴をクリア / Clear</button>
      </div>
      <ul id="history-list"></ul>
    </section>
  </main>
`;

const video = document.getElementById('video') as HTMLVideoElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement;
const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const torchToggle = document.getElementById('torch-toggle') as HTMLInputElement;
const zoomToggle = document.getElementById('zoom-toggle') as HTMLInputElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const capabilityEl = document.getElementById('capability') as HTMLDivElement;
const historyList = document.getElementById('history-list') as HTMLUListElement;
const clearHistoryBtn = document.getElementById('clear-history') as HTMLButtonElement;

const scanner = new Scanner(video);
const history = new History();

function showStatus(s: ScannerStatus): void {
  statusEl.className = `status status-${s.level}`;
  const msgEn = s.messageEn ? `<span class="en">${escapeHtml(s.messageEn)}</span>` : '';
  const strong = `<strong>${escapeHtml(s.message)}${msgEn}</strong>`;
  let small = '';
  if (s.hint || s.hintEn) {
    const hintJa = s.hint ? escapeHtml(s.hint) : '';
    const hintEn = s.hintEn ? `<span class="en">${escapeHtml(s.hintEn)}</span>` : '';
    small = `<small>${hintJa}${hintEn}</small>`;
  }
  statusEl.innerHTML = `${strong}${small}`;
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
    time.textContent = `${new Date(it.lastSeen).toLocaleString()}${it.count > 1 ? ` ・ ${it.count}回検出 / ${it.count}× detected` : ''}`;
    meta.appendChild(time);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'コピー / Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(it.text).then(() => {
        copyBtn.textContent = 'コピー済 / Copied';
        setTimeout(() => (copyBtn.textContent = 'コピー / Copy'), 1200);
      });
    });
    actions.appendChild(copyBtn);

    if (isUrl(it.text)) {
      const openBtn = document.createElement('button');
      openBtn.textContent = '開く / Open';
      openBtn.addEventListener('click', () => window.open(it.text, '_blank', 'noopener'));
      actions.appendChild(openBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.textContent = '削除 / Delete';
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
    cameraSelect.innerHTML = '';

    // 先頭は常に「デフォルト」エントリ（empty value → facingMode: environment）
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'デフォルト / Default';
    cameraSelect.appendChild(defaultOpt);

    // 権限取得済み（label が入っている）デバイスのみ列挙
    for (const c of cams) {
      if (!c.label) continue;
      const opt = document.createElement('option');
      opt.value = c.deviceId;
      opt.textContent = c.label;
      cameraSelect.appendChild(opt);
    }

    // 動作中のストリームがあれば、その実 deviceId に選択を合わせる
    const activeId = scanner.getActiveDeviceId();
    if (activeId && cams.some((c) => c.deviceId === activeId && c.label)) {
      cameraSelect.value = activeId;
    } else {
      cameraSelect.value = '';
    }
  } catch (e) {
    console.warn('カメラ列挙失敗', e);
  }
}

function updateCapabilityDisplay(): void {
  const caps = scanner.getCapabilityFlags();
  const rt = scanner.getRuntimeInfo();
  const items: string[] = [];
  if (rt.primary) {
    const labelOf = (k: 'native' | 'jsqr' | 'zxing'): string =>
      k === 'native' ? 'BarcodeDetector' : k === 'jsqr' ? 'jsQR' : 'ZXing';
    const primaryLabel = labelOf(rt.primary);
    const secondaryLabel: string = rt.secondaryActive
      ? rt.primary === 'native'
        ? ' + jsQR'
        : ' + ZXing'
      : '';
    items.push(`検出方式 / Decoder: ${primaryLabel}${secondaryLabel}`);
  }
  if (rt.mirrorTrial) {
    items.push('左右反転で試行中 / Trying mirrored read');
  }
  if (caps.focusModes.length) items.push(`フォーカス / Focus: ${caps.focusModes.join('/')}`);
  else items.push('フォーカス / Focus: 制御不可（パンフォーカス想定） / not controllable (assumes pan-focus)');
  if (caps.focusDistance) {
    items.push(`合焦距離 / Focus distance: ${caps.focusDistance.min}〜${caps.focusDistance.max}`);
  }
  if (caps.exposureModes.length) items.push(`露出 / Exposure: ${caps.exposureModes.join('/')}`);
  if (caps.zoom) items.push(`ズーム / Zoom: ×${caps.zoom.min}〜×${caps.zoom.max}`);
  if (rt.currentZoom !== null) {
    items.push(`現在のズーム / Current zoom: ×${rt.currentZoom.toFixed(1)}`);
  }
  if (caps.torch) items.push('ライト / Light: 利用可 / available');
  if (caps.facingMode) items.push(`向き / Facing: ${caps.facingMode}`);
  capabilityEl.textContent = items.join(' ・ ');
  torchToggle.disabled = !caps.torch;
}

function setRunningUI(running: boolean): void {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  startBtn.textContent = running ? '実行中 / Running' : '開始 / Start';
}

let zoomed = false;

function applyVideoTransforms(): void {
  const parts: string[] = [];
  if (scanner.isMirrored()) parts.push('scaleX(-1)');
  if (zoomed) parts.push('scale(2)');
  const t = parts.join(' ') || 'none';
  video.style.transform = t;
  overlay.style.transform = t;
}

function syncOverlay(): void {
  if (video.videoWidth && video.videoHeight) {
    if (overlay.width !== video.videoWidth) overlay.width = video.videoWidth;
    if (overlay.height !== video.videoHeight) overlay.height = video.videoHeight;
  }
  applyVideoTransforms();
}

function drawOverlay(codes: DetectedCode[]): void {
  syncOverlay();
  const ctx = overlay.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (codes.length === 0) return;

  const lineWidth = Math.max(3, overlay.width / 250);
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#2bb673';
  ctx.fillStyle = 'rgba(43, 182, 115, 0.18)';

  for (const c of codes) {
    const cp = c.cornerPoints;
    if (cp && cp.length >= 4) {
      ctx.beginPath();
      ctx.moveTo(cp[0].x, cp[0].y);
      for (let i = 1; i < cp.length; i++) ctx.lineTo(cp[i].x, cp[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (c.boundingBox) {
      const bb = c.boundingBox;
      ctx.fillRect(bb.x, bb.y, bb.width, bb.height);
      ctx.strokeRect(bb.x, bb.y, bb.width, bb.height);
    }
  }
}

video.addEventListener('loadedmetadata', syncOverlay);

scanner.onStatus = showStatus;
scanner.onRuntimeChange = updateCapabilityDisplay;
scanner.onResults = (codes) => {
  drawOverlay(codes);
  if (codes.length === 0) return;
  for (const c of codes) history.add(c.rawValue);
  renderHistory();
};

startBtn.addEventListener('click', async () => {
  try {
    await scanner.start(cameraSelect.value || undefined);
    await refreshCameraList(false);
    updateCapabilityDisplay();
    applyVideoTransforms();
    setRunningUI(true);
  } catch {
    setRunningUI(false);
  }
});

stopBtn.addEventListener('click', () => {
  scanner.stop();
  setRunningUI(false);
  drawOverlay([]);
  showStatus({ level: 'info', message: '停止しました。', messageEn: 'Stopped.' });
});

cameraSelect.addEventListener('change', async () => {
  if (!scanner.isActive()) return;
  try {
    await scanner.start(cameraSelect.value);
    await refreshCameraList(false);
    updateCapabilityDisplay();
    applyVideoTransforms();
  } catch {
    setRunningUI(false);
  }
});

zoomToggle.addEventListener('change', () => {
  zoomed = zoomToggle.checked;
  applyVideoTransforms();
});

torchToggle.addEventListener('change', async () => {
  const ok = await scanner.setTorch(torchToggle.checked);
  if (!ok) {
    torchToggle.checked = false;
    showStatus({
      level: 'warn',
      message: 'ライトを制御できませんでした。',
      messageEn: 'Could not control the light.',
      hint: 'このカメラはライト制御に対応していません。',
      hintEn: 'This camera does not support light control.',
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
        messageEn: 'No QR code could be detected in this image.',
        hint: '画像が不鮮明、またはQRコード以外のコードの可能性があります。',
        hintEn: 'The image may be unclear or contain a non-QR code.',
      });
    } else {
      for (const c of codes) history.add(c.rawValue);
      renderHistory();
      showStatus({
        level: 'ok',
        message: `画像から ${codes.length} 件のQRコードを検出しました。履歴をご確認ください。`,
        messageEn: `Detected ${codes.length} QR code(s) from the image. See history.`,
      });
    }
  } catch (e) {
    const err = e as { message?: string };
    showStatus({
      level: 'error',
      message: '画像の読み取りに失敗しました。',
      messageEn: 'Failed to read the image.',
      hint: err?.message,
    });
  } finally {
    fileInput.value = '';
  }
});

clearHistoryBtn.addEventListener('click', () => {
  if (confirm('履歴をすべて削除しますか？\nClear all history?')) {
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
