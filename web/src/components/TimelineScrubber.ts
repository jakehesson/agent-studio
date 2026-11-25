import type { NormalizedEvent } from "../types.js";
import { colorForEventKind, escHtml, fmtTimecode, trunc } from "../utils.js";

export interface ScrubberCallbacks {
  onCursorChange: (index: number, liveTail: boolean) => void;
}

const SPEEDS = [1, 2, 4] as const;

export class TimelineScrubber {
  private root: HTMLElement;
  private cb: ScrubberCallbacks;

  private events: NormalizedEvent[] = [];
  private cursor = -1;
  private liveTail = true;
  private playing = false;
  private speedIdx = 0;
  private playTimer: number | null = null;
  private dragging = false;
  private onKeyDown: (e: KeyboardEvent) => void;

  constructor(root: HTMLElement, cb: ScrubberCallbacks) {
    this.root = root;
    this.cb = cb;

    this.root.innerHTML = `
      <div class="tl-transport" role="group" aria-label="Timeline playback controls">
        <button type="button" class="tl-btn" data-tl="home" title="Jump to start (Home)" aria-label="Jump to start">⏮</button>
        <button type="button" class="tl-btn" data-tl="prev" title="Previous event (←)" aria-label="Previous event">◀</button>
        <button type="button" class="tl-btn play" data-tl="play" title="Play / Pause (Space)" aria-label="Play or pause">▶</button>
        <button type="button" class="tl-btn" data-tl="next" title="Next event (→)" aria-label="Next event">▶|</button>
        <button type="button" class="tl-btn tl-speed" data-tl="speed" title="Playback speed">1×</button>
      </div>

      <div class="tl-center">
        <div class="tl-meta-row">
          <span class="tl-now-label" data-tl-label>Waiting for events…</span>
          <span class="tl-hint">Space · ←/→ · Home · L</span>
        </div>
        <div
          class="tl-track-wrap"
          data-tl-track-wrap
          role="slider"
          tabindex="0"
          aria-label="Session timeline scrubber"
          aria-valuemin="0"
          aria-valuemax="0"
          aria-valuenow="0"
        >
          <div class="tl-track">
            <div class="tl-fill" data-tl-fill></div>
            <div class="tl-ticks" data-tl-ticks></div>
            <div class="tl-tail-glow" aria-hidden="true"></div>
            <div class="tl-thumb" data-tl-thumb></div>
          </div>
          <div class="tl-hover" data-tl-hover role="tooltip"></div>
        </div>
      </div>

      <div class="tl-right">
        <div class="tl-timecode">
          <strong data-tl-tc>00:00 / 00:00</strong>
          <span data-tl-idx>0 / 0 events</span>
        </div>
        <button type="button" class="live-pill" data-tl="live" title="Snap to live tail (L)">
          <span class="dot" aria-hidden="true"></span>
          <span data-tl-live-text>● LIVE</span>
        </button>
      </div>
    `;

    this.bindEvents();

    this.onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (document.querySelector("dialog[open]")) return;
      if (this.root.closest("[hidden]")) return;

      if (e.code === "Space") {
        e.preventDefault();
        this.togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        this.step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        this.step(1);
      } else if (e.key === "Home") {
        e.preventDefault();
        this.seek(0, false);
      } else if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        this.snapLive();
      }
    };
    window.addEventListener("keydown", this.onKeyDown);
  }

  public dispose(): void {
    this.stopPlay();
    window.removeEventListener("keydown", this.onKeyDown);
  }

  public getState(): { cursor: number; liveTail: boolean } {
    return { cursor: this.cursor, liveTail: this.liveTail };
  }

  public updateEvents(events: NormalizedEvent[]): void {
    this.events = events;
    if (events.length === 0) {
      this.cursor = -1;
      this.liveTail = true;
      this.stopPlay();
    } else if (this.liveTail) {
      this.cursor = events.length - 1;
    } else {
      this.cursor = Math.max(0, Math.min(this.cursor, events.length - 1));
    }
    this.render();
  }

  public seek(index: number, pinLive: boolean): void {
    if (this.events.length === 0) return;
    const clamped = Math.max(0, Math.min(index, this.events.length - 1));
    const isTail = clamped >= this.events.length - 1;
    this.cursor = clamped;
    this.liveTail = pinLive || isTail;
    if (this.liveTail) this.stopPlay();
    this.render();
    this.cb.onCursorChange(this.cursor, this.liveTail);
  }

  public snapLive(): void {
    this.stopPlay();
    this.liveTail = true;
    this.cursor = this.events.length - 1;
    this.render();
    this.cb.onCursorChange(this.cursor, true);
  }

  private step(delta: number): void {
    if (this.events.length === 0) return;
    this.stopPlay();
    const base = this.cursor < 0 ? this.events.length - 1 : this.cursor;
    const next = Math.max(0, Math.min(this.events.length - 1, base + delta));
    this.seek(next, next >= this.events.length - 1);
  }

  private togglePlay(): void {
    if (this.events.length === 0) return;
    if (this.playing) {
      this.stopPlay();
      return;
    }
    if (this.cursor >= this.events.length - 1) {
      this.cursor = 0;
      this.liveTail = false;
      this.cb.onCursorChange(0, false);
    }
    this.playing = true;
    this.scheduleNextTick();
    this.render();
  }

  private stopPlay(): void {
    this.playing = false;
    if (this.playTimer != null) {
      window.clearTimeout(this.playTimer);
      this.playTimer = null;
    }
    this.render();
  }

  private scheduleNextTick(): void {
    if (!this.playing) return;
    const speed = SPEEDS[this.speedIdx] ?? 1;
    const delayMs = Math.max(120, Math.round(700 / speed));
    this.playTimer = window.setTimeout(() => {
      if (!this.playing) return;
      if (this.cursor + 1 >= this.events.length) {
        this.snapLive();
        return;
      }
      this.cursor += 1;
      this.liveTail = this.cursor >= this.events.length - 1;
      this.render();
      this.cb.onCursorChange(this.cursor, this.liveTail);
      if (this.liveTail) {
        this.stopPlay();
      } else {
        this.scheduleNextTick();
      }
    }, delayMs);
  }

  private indexFromPointer(clientX: number): number {
    const track = this.root.querySelector("[data-tl-track-wrap]") as HTMLElement | null;
    if (!track || this.events.length <= 1) return 0;
    const rect = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return Math.round(frac * (this.events.length - 1));
  }

  private bindEvents(): void {
    this.root.querySelectorAll<HTMLButtonElement>("[data-tl]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = btn.dataset.tl;
        if (act === "home") this.seek(0, false);
        else if (act === "prev") this.step(-1);
        else if (act === "next") this.step(1);
        else if (act === "play") this.togglePlay();
        else if (act === "live") this.snapLive();
        else if (act === "speed") {
          this.speedIdx = (this.speedIdx + 1) % SPEEDS.length;
          btn.textContent = `${SPEEDS[this.speedIdx]}×`;
        }
      });
    });

    const trackWrap = this.root.querySelector("[data-tl-track-wrap]") as HTMLElement | null;
    const hoverEl = this.root.querySelector("[data-tl-hover]") as HTMLElement | null;
    if (!trackWrap) return;

    const showHoverAt = (clientX: number) => {
      if (!hoverEl || this.events.length === 0) return;
      const idx = this.indexFromPointer(clientX);
      const ev = this.events[idx];
      const firstEpoch = this.events[0]?.epoch ?? 0;
      if (!ev) return;
      const rect = trackWrap.getBoundingClientRect();
      const pct = Math.max(6, Math.min(94, ((clientX - rect.left) / Math.max(1, rect.width)) * 100));
      hoverEl.style.left = `${pct}%`;
      hoverEl.style.display = "block";
      hoverEl.innerHTML = `<b>${fmtTimecode(ev.epoch - firstEpoch)}</b> · ${escHtml(
        ev.agentLabel || ev.agentId
      )} · ${escHtml(trunc(ev.summary, 44))}`;
    };

    trackWrap.addEventListener("pointerdown", (e) => {
      if (this.events.length === 0) return;
      this.dragging = true;
      this.stopPlay();
      trackWrap.classList.add("dragging");
      trackWrap.setPointerCapture(e.pointerId);
      const idx = this.indexFromPointer(e.clientX);
      this.seek(idx, idx >= this.events.length - 1);
      showHoverAt(e.clientX);
    });

    trackWrap.addEventListener("pointermove", (e) => {
      if (this.events.length === 0) return;
      showHoverAt(e.clientX);
      if (this.dragging) {
        const idx = this.indexFromPointer(e.clientX);
        this.seek(idx, idx >= this.events.length - 1);
      }
    });

    const endDrag = () => {
      this.dragging = false;
      trackWrap.classList.remove("dragging");
    };
    trackWrap.addEventListener("pointerup", endDrag);
    trackWrap.addEventListener("pointercancel", endDrag);
    trackWrap.addEventListener("pointerleave", () => {
      if (hoverEl) hoverEl.style.display = "none";
    });
  }

  private render(): void {
    const total = this.events.length;
    const idx = total > 0 ? Math.max(0, Math.min(this.cursor, total - 1)) : -1;
    const pct = total > 1 && idx >= 0 ? (idx / (total - 1)) * 100 : total === 1 ? 100 : 0;
    const behind = total > 0 && !this.liveTail ? total - 1 - idx : 0;
    const isHistory = behind > 0;

    const firstEpoch = this.events[0]?.epoch ?? 0;
    const lastEpoch = this.events[total - 1]?.epoch ?? firstEpoch;
    const curEpoch = idx >= 0 ? (this.events[idx]?.epoch ?? firstEpoch) : firstEpoch;

    const fill = this.root.querySelector("[data-tl-fill]") as HTMLElement | null;
    const thumb = this.root.querySelector("[data-tl-thumb]") as HTMLElement | null;
    const ticks = this.root.querySelector("[data-tl-ticks]") as HTMLElement | null;
    const label = this.root.querySelector("[data-tl-label]") as HTMLElement | null;
    const tc = this.root.querySelector("[data-tl-tc]") as HTMLElement | null;
    const idxEl = this.root.querySelector("[data-tl-idx]") as HTMLElement | null;
    const playBtn = this.root.querySelector('[data-tl="play"]') as HTMLButtonElement | null;
    const liveBtn = this.root.querySelector('[data-tl="live"]') as HTMLButtonElement | null;
    const liveTxt = this.root.querySelector("[data-tl-live-text]") as HTMLElement | null;
    const trackWrap = this.root.querySelector("[data-tl-track-wrap]");

    if (fill) {
      fill.style.width = `${pct}%`;
      fill.classList.toggle("history", isHistory);
    }
    if (thumb) {
      thumb.style.left = `${pct}%`;
      thumb.classList.toggle("history", isHistory);
    }
    if (trackWrap) {
      trackWrap.setAttribute("aria-valuemax", String(Math.max(0, total - 1)));
      trackWrap.setAttribute("aria-valuenow", String(Math.max(0, idx)));
    }

    if (ticks) {
      // Sample up to 160 ticks to stay crisp and fast on long sessions
      const stride = total > 160 ? Math.ceil(total / 160) : 1;
      const parts: string[] = [];
      for (let i = 0; i < total; i += stride) {
        const ev = this.events[i];
        if (!ev) continue;
        const left = total > 1 ? (i / (total - 1)) * 100 : 100;
        const col = colorForEventKind(ev.kind, ev.payload);
        const isTool = ev.kind === "tool_start" || ev.kind === "tool_end";
        parts.push(
          `<span class="tl-tick ${isTool ? "tool" : ""}" style="left:${left.toFixed(2)}%;background:${col}"></span>`
        );
      }
      ticks.innerHTML = parts.join("");
    }

    if (label) {
      const curEv = idx >= 0 ? this.events[idx] : null;
      label.textContent = curEv
        ? `${curEv.agentLabel || curEv.agentId} · ${curEv.summary}`
        : "Waiting for session telemetry…";
    }
    if (tc) {
      tc.textContent = `${fmtTimecode(curEpoch - firstEpoch)} / ${fmtTimecode(lastEpoch - firstEpoch)}`;
    }
    if (idxEl) {
      idxEl.textContent = total > 0 ? `${idx + 1} / ${total} events` : "0 / 0 events";
    }
    if (playBtn) {
      playBtn.textContent = this.playing ? "⏸" : "▶";
      playBtn.classList.toggle("playing", this.playing);
    }
    if (liveBtn && liveTxt) {
      liveBtn.classList.toggle("behind", isHistory);
      liveTxt.textContent = isHistory ? `↺ LIVE (-${behind})` : "● LIVE";
    }
  }
}
