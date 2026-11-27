import { fetchEventBody } from "../api.js";
import type { NormalizedEvent } from "../types.js";
import {
  classifyEventReadable,
  cleanSummaryText,
  copyTextSafe,
  escHtml,
  fmtClock,
  formatActorName,
  getIdeMeta,
} from "../utils.js";
import { renderMarkdown, type MarkdownHeading } from "../utils/markdown.js";
import { attachPanelResizer, type PanelResizerHandle } from "../utils/panelResizer.js";

export interface ReaderSessionContext {
  sessionId?: string;
  ide?: string;
  project?: string;
  workspace?: string;
}

export interface CommReaderModalOptions {
  embedMode?: boolean;
  getSessionContext?: () => ReaderSessionContext;
}

export interface CommReaderOpenOptions {
  labelMap?: Map<string, string>;
}

type ReaderViewMode = "formatted" | "raw";
type BodyLoadState = "ready" | "loading" | "error";

function extractInitialBody(ev: NormalizedEvent): string {
  const p = ev.payload;
  const candidate =
    (typeof p?.body === "string" && p.body.trim()) ||
    (typeof p?.message === "string" && p.message.trim()) ||
    (typeof p?.Message === "string" && p.Message.trim()) ||
    (typeof p?.prompt === "string" && p.prompt.trim()) ||
    "";
  const cleanedSummary = cleanSummaryText(ev.summary);
  if (candidate && candidate.length >= cleanedSummary.length) {
    return candidate;
  }
  return (typeof ev.summary === "string" && ev.summary.trim()) || cleanedSummary || "No message body recorded.";
}

function decodeFileUriToPath(uri: string): string {
  const raw = uri.trim();
  if (!/^file:/i.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    let pathname = decodeURIComponent(parsed.pathname);
    // Windows drive path e.g. /D:/Work/... -> D:/Work/...
    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    if (parsed.host && parsed.host !== "localhost") {
      return `//${parsed.host}${pathname}`;
    }
    return pathname || raw;
  } catch {
    return raw.replace(/^file:\/\//i, "");
  }
}

export class CommReaderModal {
  private dialog: HTMLDialogElement;
  private embedMode: boolean;
  private getSessionContext: () => ReaderSessionContext;

  private currentEvent: NormalizedEvent | null = null;
  private labelMap: Map<string, string> | undefined = undefined;
  private currentBody = "";
  private mode: ReaderViewMode = "formatted";
  private loadState: BodyLoadState = "ready";
  private loadError = "";
  private isFullscreen = false;
  private openGeneration = 0;
  private tocObserver: IntersectionObserver | null = null;
  private headings: MarkdownHeading[] = [];

  private titleEl: HTMLElement;
  private metaEl: HTMLElement;
  private statusEl: HTMLElement;
  private bodyGridEl: HTMLElement;
  private tocDesktopEl: HTMLElement;
  private tocResizerEl: HTMLElement;
  private tocResizer: PanelResizerHandle | null = null;
  private tocDrawerEl: HTMLDetailsElement;
  private tocDrawerSummaryEl: HTMLElement;
  private tocMobileEl: HTMLElement;
  private scrollEl: HTMLElement;
  private contentEl: HTMLElement;
  private jsonCodeEl: HTMLElement;
  private rawDrawerEl: HTMLDetailsElement;
  private liveEl: HTMLElement;
  private copyMdBtn: HTMLButtonElement;
  private copyJsonBtn: HTMLButtonElement;
  private fullscreenBtn: HTMLButtonElement;

  constructor(opts: CommReaderModalOptions = {}) {
    this.embedMode = Boolean(opts.embedMode);
    this.getSessionContext = opts.getSessionContext ?? (() => ({}));

    const dlg = document.createElement("dialog");
    dlg.className = "reader-dialog";
    dlg.setAttribute("closedby", "any");
    dlg.setAttribute("aria-labelledby", "readerDialogTitle");
    dlg.innerHTML = `
      <div class="reader-shell">
        <header class="reader-head">
          <h1 id="readerDialogTitle" class="reader-title" data-reader-title>Communication Reader</h1>
          <div class="reader-head-actions">
            <div class="reader-mode-toggle" role="group" aria-label="View mode">
              <button type="button" class="reader-mode-btn" data-reader-mode="formatted" aria-pressed="true">Formatted</button>
              <button type="button" class="reader-mode-btn" data-reader-mode="raw" aria-pressed="false">Raw</button>
            </div>
            <button type="button" class="copy-btn" data-reader-copy-md>Copy Markdown</button>
            <button type="button" class="copy-btn reader-fs-btn" data-reader-fullscreen aria-pressed="false">Fullscreen</button>
            <button type="button" class="insp-icon-btn" data-reader-close aria-label="Close reader">✕</button>
          </div>
        </header>

        <div class="reader-meta-bar">
          <div class="reader-meta-items" data-reader-meta></div>
          <div class="reader-status-slot" data-reader-status aria-live="polite"></div>
        </div>

        <details class="reader-toc-drawer" data-reader-toc-drawer hidden>
          <summary class="reader-sections-toggle" data-reader-sections-toggle>Sections (0)</summary>
          <nav class="reader-toc-drawer-nav" aria-label="Document sections" data-reader-toc-mobile></nav>
        </details>

        <div class="reader-body" data-reader-body>
          <nav class="reader-toc" aria-label="Document sections" data-reader-toc hidden></nav>
          <div class="panel-resizer" data-resizer="reader-toc" hidden><span class="panel-resizer-pill" aria-hidden="true"></span></div>
          <div class="reader-main-scroll" data-reader-scroll>
            <div class="reader-content" data-reader-content></div>
            <details class="reader-raw-drawer" data-reader-raw-drawer>
              <summary class="reader-raw-summary">Raw Telemetry Payload (JSON)</summary>
              <div class="reader-raw-drawer-body">
                <div class="reader-raw-drawer-toolbar">
                  <span class="reader-raw-meta">Event Payload JSON</span>
                  <button type="button" class="copy-btn" data-reader-copy-json>Copy JSON</button>
                </div>
                <div class="insp-pre-wrap" role="region" tabindex="0" aria-label="Event JSON payload">
                  <pre class="insp-pre"><code data-reader-json-code></code></pre>
                </div>
              </div>
            </details>
          </div>
        </div>

        <div class="sr-only" aria-live="polite" data-reader-live></div>
      </div>
    `;

    document.body.appendChild(dlg);
    this.dialog = dlg;

    this.titleEl = dlg.querySelector("[data-reader-title]") as HTMLElement;
    this.metaEl = dlg.querySelector("[data-reader-meta]") as HTMLElement;
    this.statusEl = dlg.querySelector("[data-reader-status]") as HTMLElement;
    this.bodyGridEl = dlg.querySelector("[data-reader-body]") as HTMLElement;
    this.tocDesktopEl = dlg.querySelector("[data-reader-toc]") as HTMLElement;
    this.tocResizerEl = dlg.querySelector('[data-resizer="reader-toc"]') as HTMLElement;
    this.tocDrawerEl = dlg.querySelector("[data-reader-toc-drawer]") as HTMLDetailsElement;
    this.tocDrawerSummaryEl = dlg.querySelector("[data-reader-sections-toggle]") as HTMLElement;
    this.tocMobileEl = dlg.querySelector("[data-reader-toc-mobile]") as HTMLElement;
    this.scrollEl = dlg.querySelector("[data-reader-scroll]") as HTMLElement;
    this.contentEl = dlg.querySelector("[data-reader-content]") as HTMLElement;
    this.jsonCodeEl = dlg.querySelector("[data-reader-json-code]") as HTMLElement;
    this.rawDrawerEl = dlg.querySelector("[data-reader-raw-drawer]") as HTMLDetailsElement;
    this.liveEl = dlg.querySelector("[data-reader-live]") as HTMLElement;
    this.copyMdBtn = dlg.querySelector("[data-reader-copy-md]") as HTMLButtonElement;
    this.copyJsonBtn = dlg.querySelector("[data-reader-copy-json]") as HTMLButtonElement;
    this.fullscreenBtn = dlg.querySelector("[data-reader-fullscreen]") as HTMLButtonElement;

    this.bindEvents();
    this.tocResizer = attachPanelResizer({
      id: "reader-toc",
      container: this.bodyGridEl,
      handle: this.tocResizerEl,
      primaryPane: this.tocDesktopEl,
      cssVar: "--reader-toc",
      persistMode: "px",
      minLeft: 180,
      maxLeft: 380,
      minRight: 340,
      ariaLabel: "Resize document outline and article reader",
      paneLabel: "Document outline",
    });
  }

  private bindEvents(): void {
    const dlg = this.dialog;

    // Safari light-dismiss fallback: require pointerdown + pointerup outside dialog bounds
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      const isOutside = (e: PointerEvent): boolean => {
        const r = dlg.getBoundingClientRect();
        return (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        );
      };
      let pressedOutside = false;
      dlg.addEventListener("pointerdown", (e) => {
        pressedOutside = isOutside(e);
      });
      dlg.addEventListener("pointerup", (e) => {
        if (pressedOutside && isOutside(e)) {
          dlg.close();
        }
        pressedOutside = false;
      });
    }

    dlg.addEventListener("close", () => {
      this.openGeneration += 1;
      this.disconnectTocObserver();
    });

    dlg.querySelector("[data-reader-close]")?.addEventListener("click", () => dlg.close());

    dlg.querySelectorAll<HTMLButtonElement>("[data-reader-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.dataset.readerMode as ReaderViewMode | undefined;
        if (!next || next === this.mode) return;
        this.mode = next;
        this.syncModeButtons();
        this.renderDocumentBody();
      });
    });

    this.copyMdBtn.addEventListener("click", () => {
      void this.handleCopyButton(
        this.copyMdBtn,
        this.currentBody,
        "Copy Markdown",
        "Copied Markdown to clipboard"
      );
    });

    this.copyJsonBtn.addEventListener("click", () => {
      const jsonText = this.currentEvent ? JSON.stringify(this.currentEvent, null, 2) : "";
      void this.handleCopyButton(
        this.copyJsonBtn,
        jsonText,
        "Copy JSON",
        "Copied telemetry JSON to clipboard"
      );
    });

    this.fullscreenBtn.addEventListener("click", () => {
      this.isFullscreen = !this.isFullscreen;
      this.dialog.classList.toggle("is-fullscreen", this.isFullscreen);
      this.fullscreenBtn.setAttribute("aria-pressed", this.isFullscreen ? "true" : "false");
      this.fullscreenBtn.textContent = this.isFullscreen ? "Exit Fullscreen" : "Fullscreen";
      this.tocResizer?.sync();
    });

    // Delegated clicks inside rendered article (code copy + IDE file chips)
    this.contentEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const codeCopyBtn = target.closest<HTMLButtonElement>("[data-code-copy]");
      if (codeCopyBtn) {
        const block = codeCopyBtn.closest(".reader-code-block");
        const codeEl = block?.querySelector("code");
        const codeText = codeEl?.textContent ?? "";
        void this.handleCopyButton(codeCopyBtn, codeText, "Copy", "Copied code snippet to clipboard");
        return;
      }

      const fileChip = target.closest<HTMLButtonElement>(".reader-file-chip");
      if (fileChip) {
        void this.handleFileChipClick(fileChip);
      }
    });

    // Delegated retry click in metadata bar
    this.statusEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-reader-retry]")) {
        void this.fetchFullBody();
      }
    });

    // Delegated TOC link clicks (desktop + mobile drawer)
    const handleTocClick = (e: Event, closeMobileDrawer: boolean): void => {
      const target = e.target as HTMLElement | null;
      const link = target?.closest<HTMLAnchorElement>("[data-toc-id]");
      if (!link) return;
      e.preventDefault();
      const id = link.dataset.tocId;
      if (!id) return;
      if (closeMobileDrawer) {
        this.tocDrawerEl.open = false;
      }
      this.jumpToHeading(id);
    };

    this.tocDesktopEl.addEventListener("click", (e) => handleTocClick(e, false));
    this.tocMobileEl.addEventListener("click", (e) => handleTocClick(e, true));
  }

  public open(ev: NormalizedEvent, opts: CommReaderOpenOptions = {}): void {
    this.openGeneration += 1;
    this.currentEvent = ev;
    this.labelMap = opts.labelMap;
    this.mode = "formatted";
    this.currentBody = extractInitialBody(ev);
    this.loadError = "";
    this.rawDrawerEl.open = false;
    this.tocDrawerEl.open = false;

    const needsFetch = this.shouldFetchFullBody(ev, this.currentBody);
    this.loadState = needsFetch ? "loading" : "ready";

    this.syncModeButtons();
    this.renderHeaderAndMeta();
    this.renderStatusBadge();
    this.renderDocumentBody();
    this.jsonCodeEl.textContent = JSON.stringify(ev, null, 2);

    if (!this.dialog.open) {
      this.dialog.showModal();
    }
    this.scrollEl.scrollTop = 0;
    this.tocResizer?.sync();

    if (needsFetch) {
      void this.fetchFullBody();
    }
  }

  public dispose(): void {
    this.openGeneration += 1;
    this.tocResizer?.destroy();
    this.tocResizer = null;
    this.disconnectTocObserver();
    if (this.dialog.open) {
      this.dialog.close();
    }
    this.dialog.remove();
  }

  private shouldFetchFullBody(ev: NormalizedEvent, initialBody: string): boolean {
    if (!ev.id) return false;
    if (ev.bodyTruncated === false && initialBody.length > 0) return false;
    if (ev.bodyTruncated === true) return true;
    if (typeof ev.bodyLength === "number" && ev.bodyLength > initialBody.length) return true;
    if (initialBody.endsWith("...") || initialBody.endsWith("…")) return true;
    return ev.kind === "message" || ev.kind === "user_input" || ev.kind === "subagent_spawn";
  }

  private async fetchFullBody(): Promise<void> {
    const ev = this.currentEvent;
    if (!ev) return;

    const ctx = this.getSessionContext();
    const sessionId = ev.sessionId || ctx.sessionId || "";
    if (!sessionId) {
      this.loadState = "ready";
      this.renderStatusBadge();
      return;
    }

    const gen = this.openGeneration;
    this.loadState = "loading";
    this.loadError = "";
    this.renderStatusBadge();

    const res = await fetchEventBody({
      sessionId,
      eventId: ev.id,
      ide: ev.ide || ctx.ide,
      project: ev.projectId || ctx.project,
      workspace: ev.workspacePath || ctx.workspace,
    });

    if (gen !== this.openGeneration || !this.dialog.open) return;

    if (res.ok && typeof res.body === "string" && res.body.length > 0) {
      this.loadState = "ready";
      this.loadError = "";
      if (res.body !== this.currentBody) {
        this.currentBody = res.body;
        this.renderDocumentBody();
        this.announce("Full message body loaded");
      }
      this.renderStatusBadge();
    } else if (res.ok) {
      this.loadState = "ready";
      this.renderStatusBadge();
    } else {
      this.loadState = "error";
      this.loadError = res.error || "Unable to fetch full body";
      this.renderStatusBadge();
    }
  }

  private syncModeButtons(): void {
    this.dialog.querySelectorAll<HTMLButtonElement>("[data-reader-mode]").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.dataset.readerMode === this.mode ? "true" : "false");
    });
  }

  private renderHeaderAndMeta(): void {
    const ev = this.currentEvent;
    if (!ev) return;

    const cls = classifyEventReadable(ev);
    const ide = getIdeMeta(ev.ide);
    this.titleEl.innerHTML = `
      <span class="pill ${cls.cssClass}">${escHtml(cls.badge)}</span>
      <span class="reader-title-text">${escHtml(cls.humanTitle)}</span>
      <span class="ide-chip" style="color:${ide.color};border-color:${ide.border};background:${ide.bg}">${escHtml(ide.label)}</span>
    `;

    const actorDisplay = formatActorName(ev.agentId, this.labelMap, ev.agentLabel);
    const targetDisplay =
      ev.targetAgentId && ev.targetAgentId !== ev.agentId
        ? formatActorName(ev.targetAgentId, this.labelMap)
        : "";
    const showToolMeta =
      Boolean(ev.toolName) && ev.toolName?.toLowerCase() !== "call_mcp_tool";

    this.metaEl.innerHTML = `
      <span class="reader-meta-route">
        <b>${escHtml(actorDisplay)}</b>${targetDisplay ? ` <span class="reader-meta-arrow" aria-hidden="true">→</span> <b>${escHtml(targetDisplay)}</b>` : ""}
      </span>
      ${showToolMeta ? `<span><b>Tool:</b> <code>${escHtml(ev.toolName)}</code></span>` : ""}
      <span><b>Time:</b> <time>${escHtml(fmtClock(ev.ts || ev.epoch))}</time></span>
    `;
  }

  private renderStatusBadge(): void {
    if (this.loadState === "loading") {
      this.statusEl.innerHTML = `<span class="reader-status-pill is-loading">Preview · Loading…</span>`;
      return;
    }
    if (this.loadState === "error") {
      this.statusEl.innerHTML = `
        <span class="reader-status-pill is-preview" title="${escHtml(this.loadError)}">Preview only</span>
        <button type="button" class="reader-retry-btn" data-reader-retry>Retry</button>
      `;
      return;
    }
    this.statusEl.innerHTML = "";
  }

  private renderDocumentBody(): void {
    this.disconnectTocObserver();

    if (this.mode === "raw") {
      this.headings = [];
      this.updateTocVisibility();
      this.contentEl.innerHTML = `<pre class="reader-raw-pre" tabindex="0"><code>${escHtml(
        this.currentBody
      )}</code></pre>`;
      return;
    }

    const rendered = renderMarkdown(this.currentBody, {
      idPrefix: "reader-sec-",
      enableFileLinks: true,
    });
    this.headings = rendered.headings;
    this.contentEl.innerHTML = `<article class="reader-article reader-md">${rendered.html}</article>`;
    this.updateTocVisibility();
    this.setupTocObserver();
  }

  private updateTocVisibility(): void {
    const showToc = this.mode === "formatted" && this.headings.length >= 2;
    this.bodyGridEl.classList.toggle("has-toc", showToc);
    this.tocDesktopEl.hidden = !showToc;
    this.tocResizerEl.hidden = !showToc;
    this.tocDrawerEl.hidden = !showToc;

    if (!showToc) {
      this.tocDesktopEl.innerHTML = "";
      this.tocMobileEl.innerHTML = "";
      this.tocDrawerSummaryEl.textContent = "Sections (0)";
      this.tocResizer?.sync();
      return;
    }

    this.tocDrawerSummaryEl.textContent = `Sections (${this.headings.length})`;
    const linksHtml = this.headings
      .map(
        (h, idx) =>
          `<a class="reader-toc-link reader-toc-l${h.level}${
            idx === 0 ? " target-current" : ""
          }" href="#${escHtml(h.id)}" data-toc-id="${escHtml(h.id)}"${
            idx === 0 ? ' aria-current="true"' : ""
          }>${escHtml(h.text)}</a>`
      )
      .join("");

    this.tocDesktopEl.innerHTML = `<div class="reader-toc-title">On this message</div>${linksHtml}`;
    this.tocMobileEl.innerHTML = linksHtml;
    this.tocResizer?.sync();
  }

  private setupTocObserver(): void {
    if (this.mode !== "formatted" || this.headings.length < 2) return;
    if (typeof IntersectionObserver === "undefined") return;

    const headingEls = this.headings
      .map((h) => this.contentEl.querySelector<HTMLElement>(`#${CSS.escape(h.id)}`))
      .filter((el): el is HTMLElement => el !== null);
    if (headingEls.length === 0) return;

    this.tocObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const top = visible[0]?.target as HTMLElement | undefined;
        if (top?.id) {
          this.setActiveTocId(top.id);
        }
      },
      {
        root: this.scrollEl,
        rootMargin: "0px 0px -70% 0px",
        threshold: [0, 1],
      }
    );

    for (const el of headingEls) {
      this.tocObserver.observe(el);
    }
  }

  private disconnectTocObserver(): void {
    if (this.tocObserver) {
      this.tocObserver.disconnect();
      this.tocObserver = null;
    }
  }

  private setActiveTocId(id: string): void {
    this.dialog.querySelectorAll<HTMLAnchorElement>("[data-toc-id]").forEach((a) => {
      const active = a.dataset.tocId === id;
      a.classList.toggle("target-current", active);
      if (active) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    });
  }

  private jumpToHeading(id: string): void {
    const target = this.contentEl.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!target) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "start",
    });
    this.setActiveTocId(id);
    target.focus({ preventScroll: true });
  }

  private async handleCopyButton(
    btn: HTMLButtonElement,
    text: string,
    defaultLabel: string,
    srAnnouncement: string
  ): Promise<void> {
    if (!text) return;
    const ok = await copyTextSafe(text);
    btn.textContent = ok ? "Copied ✓" : "Copy failed";
    btn.classList.toggle("copied", ok);
    if (ok) this.announce(srAnnouncement);
    window.setTimeout(() => {
      btn.textContent = defaultLabel;
      btn.classList.remove("copied");
    }, 1600);
  }

  private async handleFileChipClick(chip: HTMLButtonElement): Promise<void> {
    const uri = chip.dataset.fileUri ?? "";
    if (!uri) return;
    const startLineRaw = chip.dataset.startLine;
    const endLineRaw = chip.dataset.endLine;
    const startLine = startLineRaw ? Number.parseInt(startLineRaw, 10) : undefined;
    const endLine = endLineRaw ? Number.parseInt(endLineRaw, 10) : undefined;

    const originalHtml = chip.dataset.origHtml ?? chip.innerHTML;
    chip.dataset.origHtml = originalHtml;

    if (this.embedMode && window.parent !== window) {
      window.parent.postMessage(
        {
          type: "agentStudio.openFile",
          uri,
          ...(Number.isFinite(startLine) ? { startLine } : {}),
          ...(Number.isFinite(endLine) ? { endLine } : {}),
        },
        "*"
      );
      chip.classList.add("is-feedback");
      chip.textContent = "Opened beside ✓";
      this.announce("Opened file beside in editor");
      window.setTimeout(() => {
        chip.classList.remove("is-feedback");
        chip.innerHTML = originalHtml;
      }, 1600);
      return;
    }

    const decodedPath = decodeFileUriToPath(uri);
    const ok = await copyTextSafe(decodedPath);
    chip.classList.toggle("is-feedback", ok);
    chip.textContent = ok ? "Copied path ✓" : "Copy failed";
    if (ok) this.announce("Copied file path to clipboard");
    window.setTimeout(() => {
      chip.classList.remove("is-feedback");
      chip.innerHTML = originalHtml;
    }, 1600);
  }

  private announce(msg: string): void {
    this.liveEl.textContent = "";
    window.setTimeout(() => {
      this.liveEl.textContent = msg;
    }, 20);
  }
}
