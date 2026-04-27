const STORAGE_KEY = 'stable-qr-reader.history.v1';
const MAX_ITEMS = 200;

export interface HistoryItem {
  text: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
}

export class History {
  private items = new Map<string, HistoryItem>();

  constructor() {
    this.load();
  }

  /** 追加。既存ならカウントと lastSeen を更新。新規エントリなら true を返す。 */
  add(text: string): boolean {
    const existing = this.items.get(text);
    const now = Date.now();
    if (existing) {
      existing.lastSeen = now;
      existing.count += 1;
      this.persist();
      return false;
    }
    this.items.set(text, { text, firstSeen: now, lastSeen: now, count: 1 });
    this.trim();
    this.persist();
    return true;
  }

  list(): HistoryItem[] {
    return [...this.items.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  remove(text: string): void {
    this.items.delete(text);
    this.persist();
  }

  clear(): void {
    this.items.clear();
    this.persist();
  }

  private trim(): void {
    if (this.items.size <= MAX_ITEMS) return;
    const sorted = [...this.items.values()].sort((a, b) => a.lastSeen - b.lastSeen);
    while (sorted.length > MAX_ITEMS) {
      const old = sorted.shift();
      if (old) this.items.delete(old.text);
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as HistoryItem[];
      for (const it of parsed) {
        if (typeof it.text === 'string') this.items.set(it.text, it);
      }
    } catch {
      // 破損していれば無視
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.items.values()]));
    } catch {
      // QuotaExceeded 等は無視
    }
  }
}
