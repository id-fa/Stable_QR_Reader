import { createDecoder, type Decoder, type DetectedCode } from './decoder';

export type StatusLevel = 'info' | 'ok' | 'warn' | 'error';

export interface ScannerStatus {
  level: StatusLevel;
  message: string;
  hint?: string;
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
  private stream: MediaStream | null = null;
  private decoder: Decoder | null = null;
  private rafId = 0;
  private mirrored = false;
  private failureFrames = 0;
  private capabilities: ExtendedCapabilities | null = null;
  private trialIndex = 0;

  onResults: (codes: DetectedCode[]) => void = () => {};
  onStatus: (status: ScannerStatus) => void = () => {};

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.canvas = document.createElement('canvas');
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
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `カメラ ${i + 1}`,
      }));
  }

  async start(deviceId?: string): Promise<void> {
    this.stop();
    if (!this.decoder) this.decoder = await createDecoder();

    this.onStatus({ level: 'info', message: 'カメラを起動しています...' });
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
    this.video.style.transform = this.mirrored ? 'scaleX(-1)' : 'none';

    this.failureFrames = 0;
    this.trialIndex = 0;
    this.onStatus({
      level: 'ok',
      message: 'カメラ起動完了。QRコードをカメラにかざしてください。',
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
      return await this.decoder.detect(bitmap);
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
        hint: 'アドレスバー左の鍵アイコン → サイトの設定 → カメラを「許可」にしてから「再試行」を押してください。',
      });
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      this.onStatus({
        level: 'error',
        message: '指定したカメラが見つかりません。',
        hint: '別のカメラを選択するか、デバイスを接続し直してください。',
      });
    } else if (name === 'NotReadableError') {
      this.onStatus({
        level: 'error',
        message: 'カメラを他のアプリが使用中の可能性があります。',
        hint: 'カメラを使用している他のアプリ（Teams, Zoom等）を終了してから再試行してください。',
      });
    } else {
      this.onStatus({
        level: 'error',
        message: 'カメラの起動に失敗しました。',
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
          const codes = await this.decoder.detect(this.canvas);
          if (codes.length > 0) {
            this.failureFrames = 0;
            this.onResults(codes);
            this.onStatus({
              level: 'ok',
              message:
                codes.length === 1
                  ? 'QRコードを検出しました。'
                  : `${codes.length}件のQRコードを検出中。`,
            });
          } else {
            this.failureFrames++;
            this.onResults([]);
            await this.maybeAdjust(ctx, w, h);
          }
        }
      }
    }

    this.rafId = requestAnimationFrame(this.scanLoop);
  };

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
      this.onStatus({
        level: 'warn',
        message: '画面が暗いようです。',
        hint: '部屋を明るくするか、対象にライトを当ててください。',
      });
    } else if (brightness > 235) {
      this.onStatus({
        level: 'warn',
        message: '画面が明るすぎて白飛びしています。',
        hint: '光源の反射を避けるよう角度を変えてください。',
      });
    } else {
      const hints = [
        'コードを少し近づけてください。',
        'コードを少し遠ざけてください。',
        'コードがフレーム中央に来るようにしてください。',
        '手ブレを抑え、しっかりかざしてください。',
      ];
      const hint = hints[Math.floor(this.failureFrames / 30) % hints.length];
      this.onStatus({
        level: 'warn',
        message: 'QRコードを検出できません。',
        hint,
      });
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

    this.trialIndex++;
  }
}

function averageBrightness(data: Uint8ClampedArray): number {
  let sum = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return sum / n;
}

export type { DetectedCode };
