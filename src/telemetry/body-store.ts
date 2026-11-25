export const MAX_BODY_BYTES = 512 * 1024;
export const MAX_ENTRIES = 500;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface EventBodyEntry {
  body: string;
  truncated: boolean;
  byteLength: number;
}

export interface EventBodyStoreOptions {
  maxBodyBytes?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
}

function truncateUtf8Clean(raw: string, maxBytes: number): EventBodyEntry {
  const rawBuf = Buffer.from(raw, "utf8");
  if (rawBuf.byteLength <= maxBytes) {
    return {
      body: raw,
      truncated: false,
      byteLength: rawBuf.byteLength,
    };
  }

  let end = Math.max(0, maxBytes);
  // Walk back past any split multi-byte UTF-8 sequence (continuation bytes 10xxxxxx).
  while (end > 0 && end < rawBuf.byteLength && (rawBuf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  const sliced = rawBuf.subarray(0, end);
  return {
    body: sliced.toString("utf8"),
    truncated: true,
    byteLength: sliced.byteLength,
  };
}

export class EventBodyStore {
  private readonly entries = new Map<string, EventBodyEntry>();
  private _totalBytes = 0;
  readonly maxBodyBytes: number;
  readonly maxEntries: number;
  readonly maxTotalBytes: number;

  constructor(options?: EventBodyStoreOptions) {
    this.maxBodyBytes = options?.maxBodyBytes ?? MAX_BODY_BYTES;
    this.maxEntries = options?.maxEntries ?? MAX_ENTRIES;
    this.maxTotalBytes = options?.maxTotalBytes ?? MAX_TOTAL_BYTES;
  }

  private static makeKey(sessionId: string, eventId: string): string {
    return `${sessionId}\u0000${eventId}`;
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this._totalBytes;
  }

  has(sessionId: string, eventId: string): boolean {
    return this.entries.has(EventBodyStore.makeKey(sessionId, eventId));
  }

  get(sessionId: string, eventId: string): EventBodyEntry | undefined {
    const key = EventBodyStore.makeKey(sessionId, eventId);
    const existing = this.entries.get(key);
    if (!existing) return undefined;
    // Refresh LRU order: delete and re-insert at MRU tail.
    this.entries.delete(key);
    this.entries.set(key, existing);
    return existing;
  }

  set(sessionId: string, eventId: string, rawBody: string): EventBodyEntry {
    const key = EventBodyStore.makeKey(sessionId, eventId);
    const prev = this.entries.get(key);
    if (prev) {
      this._totalBytes -= prev.byteLength;
      this.entries.delete(key);
    }

    const entry = truncateUtf8Clean(rawBody, this.maxBodyBytes);
    this.entries.set(key, entry);
    this._totalBytes += entry.byteLength;

    while (
      this.entries.size > this.maxEntries ||
      (this.entries.size > 0 && this._totalBytes > this.maxTotalBytes)
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) {
        this._totalBytes -= oldest.byteLength;
      }
    }

    return entry;
  }

  clear(): void {
    this.entries.clear();
    this._totalBytes = 0;
  }
}

export const defaultEventBodyStore = new EventBodyStore();
export const eventBodyStore = defaultEventBodyStore;
