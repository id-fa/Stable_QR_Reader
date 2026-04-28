import {
  createDecoder,
  createJsqrDecoder,
  createZxingDecoder,
  type Decoder,
  type DetectedCode,
} from './decoder';

const SECONDARY_DECODER_THRESHOLD = 60;
const MIRROR_FALLBACK_THRESHOLD = 30;

export type StatusLevel = 'info' | 'ok' | 'warn' | 'error';

export interface ScannerStatus {
  level: StatusLevel;
  message: string;
  messageEn?: string;
  hint?: string;
  hintEn?: string;
}

export interface CameraInfo {
  deviceId: string;
  label: string;
}

export interface CapabilityFlags {
  focusModes: string[];
  exposureModes: string[];
  zoom: { min: number; max: number; step: number } | null;
  torch: boolean;
  focusDistance: { min: number; max: number; step: number } | null;
  facingMode: string | null;
}

interface ExtendedCapabilities extends MediaTrackCapabilities {
  focusMode?: string[];
  exposureMode?: string[];
  zoom?: { min: number; max: number; step: number };
  torch?: boolean;
  focusDistance?: { min: number; max: number; step: number };
  facingMode?: string[];
}

export class Scanner {
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly flipCanvas: HTMLCanvasElement;
  private stream: MediaStream | null = null;
  private decoder: Decoder | null = null;
  private secondaryDecoder: Decoder | null = null;
  private secondaryLoading = false;
  private currentZoom: number | null = null;
  private rafId = 0;
  private mirrored = false;
  private failureFrames = 0;
  private capabilities: ExtendedCapabilities | null = null;
  private trialIndex = 0;
  private lowSharpnessFrames = 0;
  private mirrorTrialActive = false;

  onResults: (codes: DetectedCode[]) => void = () => {};
  onStatus: (status: ScannerStatus) => void = () => {};
  onRuntimeChange: () => void = () => {};

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.flipCanvas = document.createElement('canvas');
  }

  static async listCameras(promptIfNeeded = true): Promise<CameraInfo[]> {
    if (promptIfNeeded) {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
        tmp.getTracks().forEach((t) => t.stop());
      } catch {
        // 拒否された場合はラベルなしで列挙される
      }
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label,
      }));
  }

  getActiveDeviceId(): string | null {
    if (!this.stream) return null;
    const track = this.stream.getVideoTracks()[0];
    if (!track) return null;
    return track.getSettings().deviceId ?? null;
  }

  async start(deviceId?: string): Promise<void> {
    this.stop();
    if (!this.decoder) this.decoder = await createDecoder();

    this.onStatus({
      level: 'info',
      message: 'カメラを起動しています...',
      messageEn: 'Starting camera…',
    });
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      this.handleStartError(e);
      throw e;
    }

    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', 'true');
    this.video.muted = true;
    await this.video.play().catch(() => {});

    const track = this.stream.getVideoTracks()[0];
    this.capabilities = (track.getCapabilities ? track.getCapabilities() : {}) as ExtendedCapabilities;
    const settings = track.getSettings();
    this.mirrored = settings.facingMode === 'user';

    this.failureFrames = 0;
    this.trialIndex = 0;
    this.lowSharpnessFrames = 0;
    this.secondaryDecoder = null;
    this.secondaryLoading = false;
    this.currentZoom = null;
    this.mirrorTrialActive = false;
    this.onStatus({
      level: 'ok',
      message: 'カメラ起動完了。QRコードをカメラにかざしてください。',
      messageEn: 'Camera ready. Hold a QR code up to the camera.',
    });
    this.scanLoop();
  }

  stop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video.srcObject) this.video.srcObject = null;
  }

  isActive(): boolean {
    return this.stream !== null;
  }

  isMirrored(): boolean {
    return this.mirrored;
  }

  getRuntimeInfo(): {
    primary: Decoder['kind'] | null;
    secondaryActive: boolean;
    currentZoom: number | null;
    mirrorTrial: boolean;
  } {
    return {
      primary: this.decoder?.kind ?? null,
      secondaryActive: this.secondaryDecoder !== null,
      currentZoom: this.currentZoom,
      mirrorTrial: this.mirrorTrialActive,
    };
  }

  getCapabilityFlags(): CapabilityFlags {
    const c = this.capabilities;
    return {
      focusModes: c?.focusMode ?? [],
      exposureModes: c?.exposureMode ?? [],
      zoom: c?.zoom ?? null,
      torch: c?.torch ?? false,
      focusDistance: c?.focusDistance ?? null,
      facingMode: c?.facingMode?.[0] ?? null,
    };
  }

  async setTorch(on: boolean): Promise<boolean> {
    if (!this.stream || !this.capabilities?.torch) return false;
    const track = this.stream.getVideoTracks()[0];
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      return true;
    } catch {
      return false;
    }
  }

  async detectFromFile(file: File): Promise<DetectedCode[]> {
    if (!this.decoder) this.decoder = await createDecoder();
    const bitmap = await createImageBitmap(file);
    try {
      let codes = await this.decoder.detect(bitmap);
      if (codes.length > 0) return codes;
      // native の次は jsqr、jsqr の次は ZXing と段階的に試す
      if (this.decoder.kind === 'native') {
        if (!this.secondaryDecoder || this.secondaryDecoder.kind !== 'jsqr') {
          this.secondaryDecoder = createJsqrDecoder();
        }
        codes = await this.secondaryDecoder.detect(bitmap);
        if (codes.length > 0) return codes;
      }
      let zxing: Decoder | null = null;
      try {
        zxing = await createZxingDecoder();
        codes = await zxing.detect(bitmap);
        if (codes.length > 0) return codes;
      } catch {
        // ZXing 読み込み失敗は諦める
      }
      // 鏡像フォールバック: 反転して保存された画像や鏡越し撮影にも対応する
      const flipped = flipImageHorizontally(bitmap);
      if (flipped) {
        let flippedCodes = await this.decoder.detect(flipped);
        if (flippedCodes.length === 0 && this.secondaryDecoder) {
          flippedCodes = await this.secondaryDecoder.detect(flipped);
        }
        if (flippedCodes.length === 0 && zxing) {
          flippedCodes = await zxing.detect(flipped);
        }
        if (flippedCodes.length > 0) {
          return unflipCodesHorizontally(flippedCodes, flipped.width);
        }
      }
      return codes;
    } finally {
      bitmap.close();
    }
  }

  private handleStartError(e: unknown): void {
    const err = e as { name?: string; message?: string };
    const name = err?.name ?? '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      this.onStatus({
        level: 'error',
        message: 'カメラへのアクセスが拒否されています。',
        messageEn: 'Camera access has been denied.',
        hint: 'アドレスバー左の鍵アイコン → サイトの設定 → カメラを「許可」にしてから「再試行」を押してください。',
        hintEn: 'Click the lock icon in the address bar → Site settings → set Camera to “Allow”, then press Start again.',
      });
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      this.onStatus({
        level: 'error',
        message: '指定したカメラが見つかりません。',
        messageEn: 'The selected camera was not found.',
        hint: '別のカメラを選択するか、デバイスを接続し直してください。',
        hintEn: 'Choose another camera or reconnect the device.',
      });
    } else if (name === 'NotReadableError') {
      this.onStatus({
        level: 'error',
        message: 'カメラを他のアプリが使用中の可能性があります。',
        messageEn: 'The camera may be in use by another app.',
        hint: 'カメラを使用している他のアプリ（Teams, Zoom等）を終了してから再試行してください。',
        hintEn: 'Close other apps using the camera (Teams, Zoom, etc.) and try again.',
      });
    } else {
      this.onStatus({
        level: 'error',
        message: 'カメラの起動に失敗しました。',
        messageEn: 'Failed to start the camera.',
        hint: err?.message,
      });
    }
  }

  private scanLoop = async (): Promise<void> => {
    if (!this.stream || !this.decoder) return;

    if (this.video.readyState >= 2) {
      const w = this.video.videoWidth;
      const h = this.video.videoHeight;
      if (w && h) {
        if (this.canvas.width !== w) this.canvas.width = w;
        if (this.canvas.height !== h) this.canvas.height = h;
        const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(this.video, 0, 0, w, h);
          let codes = await this.decoder.detect(this.canvas);
          if (codes.length === 0 && this.secondaryDecoder) {
            codes = await this.secondaryDecoder.detect(this.canvas);
          }
          // 鏡像読み取りフォールバック: facingMode が信頼できない環境（ミラー出力なのに
          // user 判定されない仮想カメラ等）では正しい向きでも未検出となるため、左右反転
          // した canvas でも検出を試みる。検出できた場合は座標を元の向きに戻して返す。
          if (codes.length === 0 && this.failureFrames >= MIRROR_FALLBACK_THRESHOLD) {
            if (!this.mirrorTrialActive) {
              this.mirrorTrialActive = true;
              this.onRuntimeChange();
            }
            const flipped = this.buildFlippedCanvas(w, h);
            if (flipped) {
              let flippedCodes = await this.decoder.detect(flipped);
              if (flippedCodes.length === 0 && this.secondaryDecoder) {
                flippedCodes = await this.secondaryDecoder.detect(flipped);
              }
              if (flippedCodes.length > 0) {
                codes = unflipCodesHorizontally(flippedCodes, w);
              }
            }
          }
          if (codes.length > 0) {
            this.failureFrames = 0;
            this.lowSharpnessFrames = 0;
            if (this.mirrorTrialActive) {
              this.mirrorTrialActive = false;
              this.onRuntimeChange();
            }
            this.onResults(codes);
            this.onStatus({
              level: 'ok',
              message:
                codes.length === 1
                  ? 'QRコードを検出しました。'
                  : `${codes.length}件のQRコードを検出中。`,
              messageEn:
                codes.length === 1
                  ? 'QR code detected.'
                  : `Detecting ${codes.length} QR codes.`,
            });
          } else {
            this.failureFrames++;
            this.onResults([]);
            this.maybeActivateSecondaryDecoder();
            await this.maybeAdjust(ctx, w, h);
          }
        }
      }
    }

    this.rafId = requestAnimationFrame(this.scanLoop);
  };

  private buildFlippedCanvas(w: number, h: number): HTMLCanvasElement | null {
    if (this.flipCanvas.width !== w) this.flipCanvas.width = w;
    if (this.flipCanvas.height !== h) this.flipCanvas.height = h;
    const ctx = this.flipCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.setTransform(-1, 0, 0, 1, w, 0);
    ctx.drawImage(this.canvas, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return this.flipCanvas;
  }

  private maybeActivateSecondaryDecoder(): void {
    if (this.secondaryDecoder || this.secondaryLoading) return;
    if (this.failureFrames < SECONDARY_DECODER_THRESHOLD) return;
    if (this.decoder?.kind === 'native') {
      this.secondaryDecoder = createJsqrDecoder();
      this.onRuntimeChange();
    } else if (this.decoder?.kind === 'jsqr') {
      this.secondaryLoading = true;
      void createZxingDecoder()
        .then((d) => {
          this.secondaryDecoder = d;
          this.onRuntimeChange();
        })
        .catch(() => {
          // 読み込み失敗は黙って諦める
        })
        .finally(() => {
          this.secondaryLoading = false;
        });
    }
  }

  private async maybeAdjust(ctx: CanvasRenderingContext2D, w: number, h: number): Promise<void> {
    if (this.failureFrames < 20) return;

    const sw = Math.min(120, w);
    const sh = Math.min(120, h);
    const sample = ctx.getImageData(
      Math.floor((w - sw) / 2),
      Math.floor((h - sh) / 2),
      sw,
      sh,
    );
    const brightness = averageBrightness(sample.data);

    if (brightness < 45) {
      this.lowSharpnessFrames = 0;
      this.onStatus({
        level: 'warn',
        message: '画面が暗いようです。',
        messageEn: 'The image looks too dark.',
        hint: '部屋を明るくするか、対象にライトを当ててください。',
        hintEn: 'Brighten the room or shine a light on the target.',
      });
    } else if (brightness > 235) {
      this.lowSharpnessFrames = 0;
      this.onStatus({
        level: 'warn',
        message: '画面が明るすぎて白飛びしています。',
        messageEn: 'The image is overexposed.',
        hint: '光源の反射を避けるよう角度を変えてください。',
        hintEn: 'Change the angle to avoid light reflections.',
      });
    } else {
      const { stdDev, gradient } = imageSharpness(sample.data, sw, sh);
      // シーンに何か写っているのに勾配が低い → 全体的にボケている
      if (stdDev > 22 && gradient < 3) {
        this.lowSharpnessFrames++;
      } else {
        this.lowSharpnessFrames = 0;
      }

      const hasManualFocus = !!(
        this.capabilities?.focusDistance && this.capabilities?.focusMode?.includes('manual')
      );
      // フォーカス試行を一巡したか（manual: 5距離、それ以外: 待ち時間のみ）
      const focusCycleDone = hasManualFocus ? this.trialIndex >= 5 : this.trialIndex >= 2;

      if (focusCycleDone && this.lowSharpnessFrames >= 30) {
        this.onStatus({
          level: 'warn',
          message: 'ピントが合わないようです。',
          messageEn: 'Unable to focus.',
          hint: 'レンズが汚れている可能性があります。柔らかい布で軽く拭いてみてください。',
          hintEn: 'The lens may be smudged. Try wiping it gently with a soft cloth.',
        });
      } else {
        const altActive = this.secondaryDecoder !== null;
        this.onStatus({
          level: 'warn',
          message: 'QRコードを検出できません。',
          messageEn: 'No QR code detected.',
          hint: altActive
            ? 'カメラからの距離を変えてみてください。別の読み取り方式も試行中です。'
            : 'カメラからの距離を変えてみてください。',
          hintEn: altActive
            ? 'Try changing the distance from the camera. Also trying an alternative decoder.'
            : 'Try changing the distance from the camera.',
        });
      }
    }

    if (this.failureFrames % 45 === 0) {
      await this.tryAdjustOptics();
    }
  }

  private async tryAdjustOptics(): Promise<void> {
    if (!this.stream || !this.capabilities) return;
    const track = this.stream.getVideoTracks()[0];
    const caps = this.capabilities;

    try {
      if (caps.focusMode?.includes('continuous') && this.trialIndex === 0) {
        await track.applyConstraints({
          advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
        });
      } else if (caps.focusDistance && caps.focusMode?.includes('manual')) {
        const { min, max } = caps.focusDistance;
        const ratio = (this.trialIndex % 5) / 4;
        const distance = min + (max - min) * ratio;
        await track.applyConstraints({
          advanced: [
            { focusMode: 'manual', focusDistance: distance } as MediaTrackConstraintSet,
          ],
        });
      }
    } catch {
      // 制約適用失敗は無視
    }

    // ハードウェアズームが利用可能なら能力に応じて広角/標準/望遠をオシレーション
    if (caps.zoom) {
      const targets: number[] = [];
      if (caps.zoom.min <= 0.6) targets.push(clamp(0.5, caps.zoom.min, caps.zoom.max));
      targets.push(clamp(1, caps.zoom.min, caps.zoom.max));
      if (caps.zoom.max >= 1.5) targets.push(clamp(2, caps.zoom.min, caps.zoom.max));
      const unique = [...new Set(targets.map((v) => Math.round(v * 100) / 100))];
      if (unique.length >= 2) {
        const target = unique[this.trialIndex % unique.length];
        try {
          await track.applyConstraints({
            advanced: [{ zoom: target } as MediaTrackConstraintSet],
          });
          if (this.currentZoom !== target) {
            this.currentZoom = target;
            this.onRuntimeChange();
          }
        } catch {
          // 制約適用失敗は無視
        }
      }
    }

    this.trialIndex++;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function flipImageHorizontally(src: ImageBitmap): HTMLCanvasElement | null {
  const w = src.width;
  const h = src.height;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.setTransform(-1, 0, 0, 1, w, 0);
  ctx.drawImage(src, 0, 0, w, h);
  return canvas;
}

// 左右反転 canvas で検出した DetectedCode の x 座標を元の向きに戻す。
function unflipCodesHorizontally(codes: DetectedCode[], width: number): DetectedCode[] {
  return codes.map((c) => ({
    ...c,
    cornerPoints: c.cornerPoints?.map((p) => ({ x: width - p.x, y: p.y })),
    boundingBox: c.boundingBox
      ? {
          x: width - c.boundingBox.x - c.boundingBox.width,
          y: c.boundingBox.y,
          width: c.boundingBox.width,
          height: c.boundingBox.height,
        }
      : undefined,
  }));
}

function averageBrightness(data: Uint8ClampedArray): number {
  let sum = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return sum / n;
}

// 中央サンプルの「シーン情報量」と「鮮鋭度」を返す。
// stdDev: 輝度のばらつき（無地の壁なら低い、コントラストのある被写体なら高い）
// gradient: 隣接ピクセル差分の平均（ボケると全体的に低くなる）
function imageSharpness(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { stdDev: number; gradient: number } {
  const lum = new Float32Array(width * height);
  let sum = 0;
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    lum[j] = y;
    sum += y;
  }
  const mean = sum / lum.length;

  let varSum = 0;
  let gradSum = 0;
  let gradCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const v = lum[idx];
      varSum += (v - mean) * (v - mean);
      if (x < width - 1 && y < height - 1) {
        const dx = lum[idx + 1] - v;
        const dy = lum[idx + width] - v;
        gradSum += Math.abs(dx) + Math.abs(dy);
        gradCount++;
      }
    }
  }

  return {
    stdDev: Math.sqrt(varSum / lum.length),
    gradient: gradCount > 0 ? gradSum / gradCount : 0,
  };
}

export type { DetectedCode };
