import jsQR from 'jsqr';

export interface DetectedCode {
  rawValue: string;
  format: string;
  cornerPoints?: { x: number; y: number }[];
  boundingBox?: { x: number; y: number; width: number; height: number };
}

export interface Decoder {
  readonly kind: 'native' | 'jsqr' | 'zxing';
  detect(source: CanvasImageSource & { width?: number; height?: number }): Promise<DetectedCode[]>;
}

interface NativeBarcodeDetectorCtor {
  new (options?: { formats?: string[] }): {
    detect(source: CanvasImageSource): Promise<
      Array<{
        rawValue: string;
        format: string;
        cornerPoints?: { x: number; y: number }[];
        boundingBox?: DOMRectReadOnly;
      }>
    >;
  };
  getSupportedFormats(): Promise<string[]>;
}

export async function createDecoder(): Promise<Decoder> {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: NativeBarcodeDetectorCtor })
    .BarcodeDetector;

  if (Ctor) {
    try {
      const formats = await Ctor.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new Ctor({ formats: ['qr_code'] });
        return {
          kind: 'native',
          async detect(source) {
            try {
              const codes = await detector.detect(source);
              return codes
                .filter((c) => typeof c.rawValue === 'string' && c.rawValue.length > 0)
                .map((c) => ({
                  rawValue: c.rawValue,
                  format: c.format,
                  cornerPoints: c.cornerPoints,
                  boundingBox: c.boundingBox
                    ? {
                        x: c.boundingBox.x,
                        y: c.boundingBox.y,
                        width: c.boundingBox.width,
                        height: c.boundingBox.height,
                      }
                    : undefined,
                }));
            } catch {
              return [];
            }
          },
        };
      }
    } catch {
      // BarcodeDetector がエラーを投げた場合はフォールバック
    }
  }

  return createJsqrDecoder();
}

export function createJsqrDecoder(): Decoder {
  return {
    kind: 'jsqr',
    async detect(source) {
      const { canvas, ctx, width, height } = toCanvas(source);
      if (!ctx || !width || !height) return [];
      const imageData = ctx.getImageData(0, 0, width, height);
      const code = jsQR(imageData.data, width, height, { inversionAttempts: 'attemptBoth' });
      if (!code || typeof code.data !== 'string' || code.data.length === 0) return [];
      const cp = [code.location.topLeftCorner, code.location.topRightCorner, code.location.bottomRightCorner, code.location.bottomLeftCorner];
      const xs = cp.map((p) => p.x);
      const ys = cp.map((p) => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      void canvas;
      return [
        {
          rawValue: code.data,
          format: 'qr_code',
          cornerPoints: cp,
          boundingBox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        },
      ];
    },
  };
}

// ZXing は重いので動的 import で別チャンクに切り出す。
// QR 以外（1次元バーコード等）を読み取らないよう、MultiFormatReader ではなく
// QRCodeReader を直接使う。将来的にバーコード対応を加える際は MultiFormatReader に戻し、
// POSSIBLE_FORMATS で許可するフォーマットを明示する方針。
export async function createZxingDecoder(): Promise<Decoder> {
  const mod = await import('@zxing/library');
  const {
    BinaryBitmap,
    HybridBinarizer,
    HTMLCanvasElementLuminanceSource,
    QRCodeReader,
    DecodeHintType,
  } = mod;

  const reader = new QRCodeReader();
  const hints = new Map<unknown, unknown>();
  hints.set(DecodeHintType.TRY_HARDER, true);

  return {
    kind: 'zxing',
    async detect(source) {
      const { canvas, width, height } = toCanvas(source);
      if (!width || !height) return [];
      try {
        const lum = new HTMLCanvasElementLuminanceSource(canvas);
        const bitmap = new BinaryBitmap(new HybridBinarizer(lum));
        const result = reader.decode(bitmap, hints as never);
        const text = result.getText();
        if (!text) return [];
        const points = result.getResultPoints();
        const cornerPoints =
          points && points.length > 0
            ? points.map((p) => ({ x: p.getX(), y: p.getY() }))
            : undefined;
        let boundingBox: { x: number; y: number; width: number; height: number } | undefined;
        if (cornerPoints && cornerPoints.length > 0) {
          const xs = cornerPoints.map((p) => p.x);
          const ys = cornerPoints.map((p) => p.y);
          const minX = Math.min(...xs);
          const minY = Math.min(...ys);
          boundingBox = { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
        }
        return [{ rawValue: text, format: 'qr_code', cornerPoints, boundingBox }];
      } catch {
        // NotFoundException 等は検出なし扱い
        return [];
      } finally {
        reader.reset();
      }
    },
  };
}

function toCanvas(source: CanvasImageSource & { width?: number; height?: number }): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  width: number;
  height: number;
} {
  let width = 0;
  let height = 0;
  if (source instanceof HTMLVideoElement) {
    width = source.videoWidth;
    height = source.videoHeight;
  } else if (source instanceof HTMLCanvasElement) {
    return {
      canvas: source,
      ctx: source.getContext('2d', { willReadFrequently: true }),
      width: source.width,
      height: source.height,
    };
  } else if (source instanceof ImageBitmap) {
    width = source.width;
    height = source.height;
  } else if (typeof (source as { width?: number }).width === 'number') {
    width = (source as { width: number }).width;
    height = (source as { height: number }).height;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx && width && height) {
    ctx.drawImage(source, 0, 0, width, height);
  }
  return { canvas, ctx, width, height };
}
