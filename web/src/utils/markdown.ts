import { escHtml } from "../utils.js";

export interface MarkdownHeading {
  id: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

export interface MarkdownRenderResult {
  html: string;
  headings: MarkdownHeading[];
}

export interface RenderMarkdownOptions {
  idPrefix?: string;
  enableFileLinks?: boolean;
}

const FILE_LINE_RE = /#L(\d+)(?:-L?(\d+))?$/i;

type SafeLink =
  | { kind: "external"; url: string }
  | { kind: "mailto"; url: string }
  | { kind: "hash"; url: string }
  | {
      kind: "file";
      fullUrl: string;
      baseUri: string;
      startLine?: number;
      endLine?: number;
    }
  | { kind: "blocked" };

function sanitizeLinkUrl(rawUrl: string): SafeLink {
  let cleaned = rawUrl.trim();
  if (cleaned.startsWith("<") && cleaned.endsWith(">")) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  // Remove ASCII control characters and whitespace before scheme inspection
  const schemeCheck = cleaned.replace(/[\u0000-\u0020\u007f]+/g, "");
  if (!schemeCheck) return { kind: "blocked" };

  if (schemeCheck.startsWith("#")) {
    return { kind: "hash", url: cleaned };
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(schemeCheck);
  if (!schemeMatch?.[1]) {
    return { kind: "blocked" };
  }

  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === "https" || scheme === "http") {
    return { kind: "external", url: cleaned };
  }
  if (scheme === "mailto") {
    return { kind: "mailto", url: cleaned };
  }
  if (scheme === "file") {
    let baseUri = cleaned;
    let startLine: number | undefined;
    let endLine: number | undefined;
    const lm = FILE_LINE_RE.exec(cleaned);
    if (lm?.[1]) {
      startLine = Number.parseInt(lm[1], 10);
      if (lm[2]) {
        endLine = Number.parseInt(lm[2], 10);
      }
      baseUri = cleaned.slice(0, lm.index);
    }
    return {
      kind: "file",
      fullUrl: cleaned,
      baseUri: baseUri || cleaned,
      startLine: Number.isFinite(startLine) ? startLine : undefined,
      endLine: Number.isFinite(endLine) ? endLine : undefined,
    };
  }

  return { kind: "blocked" };
}

function renderFileChip(
  labelHtml: string,
  link: Extract<SafeLink, { kind: "file" }>
): string {
  const linePill =
    link.startLine !== undefined
      ? `<span class="reader-file-lines">L${link.startLine}${
          link.endLine !== undefined && link.endLine !== link.startLine
            ? `–L${link.endLine}`
            : ""
        }</span>`
      : "";
  const startAttr =
    link.startLine !== undefined ? ` data-start-line="${link.startLine}"` : "";
  const endAttr =
    link.endLine !== undefined ? ` data-end-line="${link.endLine}"` : "";

  return (
    `<button type="button" class="reader-file-chip"` +
    ` data-file-uri="${escHtml(link.baseUri)}"${startAttr}${endAttr}` +
    ` title="${escHtml(link.fullUrl)}">` +
    `<span class="reader-file-ico" aria-hidden="true">📄</span>` +
    `<span class="reader-file-label">${labelHtml}</span>` +
    linePill +
    `</button>`
  );
}

function extractBalancedMarkdownLinks(
  text: string,
  onLink: (label: string, url: string, isImage: boolean) => string
): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const isImage = ch === "!" && text[i + 1] === "[";
    if (ch === "[" || isImage) {
      const openBracket = isImage ? i + 1 : i;
      // Find matching ']' (not inside nested brackets)
      let depth = 1;
      let j = openBracket + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "\\" && j + 1 < text.length) {
          j += 2;
          continue;
        }
        if (text[j] === "[") depth += 1;
        else if (text[j] === "]") depth -= 1;
        j += 1;
      }

      if (depth === 0 && text[j] === "(") {
        const label = text.slice(openBracket + 1, j - 1);
        // Scan balanced '(' ... ')' for URL
        let pDepth = 1;
        let k = j + 1;
        while (k < text.length && pDepth > 0) {
          const kc = text[k];
          if (kc === "\\" && k + 1 < text.length) {
            k += 2;
            continue;
          }
          if (kc === "\n") break;
          if (kc === "(") pDepth += 1;
          else if (kc === ")") pDepth -= 1;
          k += 1;
        }
        if (pDepth === 0) {
          const rawUrl = text.slice(j + 1, k - 1);
          out += onLink(label, rawUrl, isImage);
          i = k;
          continue;
        }
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

function applyEmphasisEscaped(escapedText: string): string {
  let s = escapedText;
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<![\w])__([^_\n]+)__(?![\w])/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, "<em>$1</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return s;
}

function renderInline(raw: string, enableFileLinks: boolean): string {
  const placeholders: string[] = [];
  const pushToken = (html: string): string => {
    const idx = placeholders.length;
    placeholders.push(html);
    return `\u0000TK${idx}\u0000`;
  };

  // 1. Protect inline code spans (`...` or ``...``)
  let work = "";
  let pos = 0;
  while (pos < raw.length) {
    if (raw[pos] === "`") {
      let ticks = 0;
      while (pos + ticks < raw.length && raw[pos + ticks] === "`") {
        ticks += 1;
      }
      const fence = "`".repeat(ticks);
      const closeIdx = raw.indexOf(fence, pos + ticks);
      if (closeIdx !== -1 && (raw[closeIdx + ticks] !== "`" || ticks > 1)) {
        let code = raw.slice(pos + ticks, closeIdx);
        if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim().length > 0) {
          code = code.slice(1, -1);
        }
        work += pushToken(`<code>${escHtml(code)}</code>`);
        pos = closeIdx + ticks;
        continue;
      }
      work += fence;
      pos += ticks;
      continue;
    }
    work += raw[pos];
    pos += 1;
  }

  // 2. Parse Markdown links [label](url) & images ![alt](url)
  work = extractBalancedMarkdownLinks(work, (label, url, isImage) => {
    const labelHtml = applyEmphasisEscaped(escHtml(label)).replace(/\u0000TK(\d+)\u0000/g, (_m, n) => {
      return placeholders[Number(n)] ?? "";
    });
    if (isImage) {
      return pushToken(labelHtml);
    }
    const safe = sanitizeLinkUrl(url);
    switch (safe.kind) {
      case "external":
        return pushToken(
          `<a href="${escHtml(safe.url)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`
        );
      case "mailto":
      case "hash":
        return pushToken(`<a href="${escHtml(safe.url)}">${labelHtml}</a>`);
      case "file":
        if (enableFileLinks) {
          return pushToken(renderFileChip(labelHtml, safe));
        }
        return pushToken(`<code>${labelHtml}</code>`);
      case "blocked":
        return pushToken(labelHtml);
    }
  });

  // 3. Auto-link bare http(s):// URLs outside placeholders
  work = work.replace(/(^|[\s(])(https?:\/\/[^\s<>\u0000]+)/g, (match, lead: string, urlRaw: string) => {
    let url = urlRaw;
    let trail = "";
    while (url.length > 0 && /[.,;:!?]$/.test(url)) {
      trail = url.slice(-1) + trail;
      url = url.slice(0, -1);
    }
    while (url.endsWith(")")) {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) {
        trail = ")" + trail;
        url = url.slice(0, -1);
      } else {
        break;
      }
    }
    const safe = sanitizeLinkUrl(url);
    if (safe.kind !== "external") return match;
    return `${lead}${pushToken(
      `<a href="${escHtml(safe.url)}" target="_blank" rel="noopener noreferrer">${escHtml(safe.url)}</a>`
    )}${trail}`;
  });

  // 4. Escape remaining raw text and apply inline emphasis
  let escaped = escHtml(work);
  escaped = applyEmphasisEscaped(escaped);

  // 5. Line breaks
  escaped = escaped.replace(/(?: {2,}|\\)\n/g, "<br />");

  // 6. Restore protected tokens
  return escaped.replace(/\u0000TK(\d+)\u0000/g, (_m, n: string) => {
    return placeholders[Number(n)] ?? "";
  });
}

function stripInlineMarkdown(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*\*|___|\*\*|__|~~|\*|_)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyHeading(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function isHorizontalRule(line: string): boolean {
  return /^\s{0,3}(?:(\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line);
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) {
    trimmed = trimmed.slice(0, -1);
  }
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

type TableAlign = "left" | "center" | "right" | null;

function parseTableSeparator(line: string): TableAlign[] | null {
  if (!line.includes("-")) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) aligns.push("center");
    else if (right) aligns.push("right");
    else if (left) aligns.push("left");
    else aligns.push(null);
  }
  return aligns;
}

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK_PREFIX_RE = /^\[([ xX])\]\s+(.*)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})(?:\s+(.*))?$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

interface ParseContext {
  idPrefix: string;
  enableFileLinks: boolean;
  headings: MarkdownHeading[];
  slugCounts: Map<string, number>;
}

function renderListBlock(
  lines: string[],
  startIdx: number,
  ctx: ParseContext
): { html: string; nextIdx: number } {
  interface ListFrame {
    tag: "ul" | "ol";
    indent: number;
    items: string[];
    openLi: boolean;
  }

  const stack: ListFrame[] = [];
  const rootParts: string[] = [];

  const closeTopFrame = () => {
    const frame = stack.pop();
    if (!frame) return;
    if (frame.openLi) {
      frame.items.push("</li>");
      frame.openLi = false;
    }
    const html = `<${frame.tag}>${frame.items.join("")}</${frame.tag}>`;
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.items.push(html);
    } else {
      rootParts.push(html);
    }
  };

  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      // Peek ahead: if next non-empty line is also a list item, continue; else end list
      let look = i + 1;
      while (look < lines.length && !lines[look]!.trim()) look += 1;
      if (look < lines.length && LIST_ITEM_RE.test(lines[look]!)) {
        i = look;
        continue;
      }
      break;
    }

    const m = LIST_ITEM_RE.exec(line);
    if (!m) {
      // Continuation line for open list item?
      const top = stack[stack.length - 1];
      if (
        top &&
        top.openLi &&
        !HEADING_RE.test(line) &&
        !FENCE_RE.test(line) &&
        !isHorizontalRule(line) &&
        !/^\s{0,3}>/.test(line)
      ) {
        top.items.push(`<br />${renderInline(line.trim(), ctx.enableFileLinks)}`);
        i += 1;
        continue;
      }
      break;
    }

    const indent = (m[1] ?? "").replace(/\t/g, "  ").length;
    const marker = m[2] ?? "-";
    const tag: "ul" | "ol" = /^\d/.test(marker) ? "ol" : "ul";
    const content = m[3] ?? "";

    while (stack.length > 0 && indent < stack[stack.length - 1]!.indent) {
      closeTopFrame();
    }

    let top = stack[stack.length - 1];
    if (!top || indent > top.indent) {
      top = { tag, indent, items: [], openLi: false };
      stack.push(top);
    } else if (top.tag !== tag) {
      closeTopFrame();
      top = { tag, indent, items: [], openLi: false };
      stack.push(top);
    } else if (top.openLi) {
      top.items.push("</li>");
      top.openLi = false;
    }

    const taskMatch = tag === "ul" ? TASK_PREFIX_RE.exec(content) : null;
    if (taskMatch) {
      const checked = taskMatch[1]!.toLowerCase() === "x";
      const taskText = taskMatch[2] ?? "";
      top.items.push(
        `<li class="reader-task-item"><input type="checkbox" class="reader-task-check" disabled${
          checked ? " checked" : ""
        } aria-label="${escHtml(stripInlineMarkdown(taskText))}" /><span>${renderInline(
          taskText,
          ctx.enableFileLinks
        )}</span>`
      );
    } else {
      top.items.push(`<li>${renderInline(content, ctx.enableFileLinks)}`);
    }
    top.openLi = true;
    i += 1;
  }

  while (stack.length > 0) {
    closeTopFrame();
  }

  return { html: rootParts.join(""), nextIdx: i };
}

function renderBlocks(lines: string[], ctx: ParseContext): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 1. Fenced code block
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch?.[1]) {
      const fence = fenceMatch[1];
      const fenceChar = fence[0]!;
      const fenceLen = fence.length;
      const info = (fenceMatch[2] ?? "").trim();
      const validBacktickFence = fenceChar !== "`" || !info.includes("`");
      if (validBacktickFence) {
        const lang = info.split(/\s+/)[0] ?? "";
        const codeLines: string[] = [];
        let j = i + 1;
        const closeRe = new RegExp(`^\\s{0,3}${fenceChar}{${fenceLen},}\\s*$`);
        while (j < lines.length && !closeRe.test(lines[j]!)) {
          codeLines.push(lines[j]!);
          j += 1;
        }
        const codeText = codeLines.join("\n");
        const langHtml = lang
          ? `<span class="reader-code-lang">${escHtml(lang)}</span>`
          : `<span class="reader-code-lang" aria-hidden="true"></span>`;
        out.push(
          `<div class="reader-code-block">` +
            `<div class="reader-code-bar">` +
            langHtml +
            `<button type="button" class="copy-btn reader-code-copy" data-code-copy>Copy</button>` +
            `</div>` +
            `<pre class="reader-code-pre" tabindex="0"><code>${escHtml(codeText)}</code></pre>` +
            `</div>`
        );
        i = j < lines.length ? j + 1 : j;
        continue;
      }
    }

    // 2. ATX Heading (H1-H6)
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch?.[1]) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const rawText = (headingMatch[2] ?? "").replace(/\s+#+\s*$/, "").trim();
      const plainText = stripInlineMarkdown(rawText) || `Section ${ctx.headings.length + 1}`;
      const baseSlug = slugifyHeading(plainText);
      const count = (ctx.slugCounts.get(baseSlug) ?? 0) + 1;
      ctx.slugCounts.set(baseSlug, count);
      const slug = count === 1 ? baseSlug : `${baseSlug}-${count}`;
      const id = `${ctx.idPrefix}${slug}`;

      ctx.headings.push({ id, level, text: plainText });
      out.push(
        `<h${level} id="${escHtml(id)}" tabindex="-1">${renderInline(
          rawText,
          ctx.enableFileLinks
        )}</h${level}>`
      );
      i += 1;
      continue;
    }

    // 3. Horizontal rule
    if (isHorizontalRule(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    // 4. Blockquote
    if (/^\s{0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      let j = i;
      while (j < lines.length && /^\s{0,3}>/.test(lines[j]!)) {
        quoteLines.push(lines[j]!.replace(/^\s{0,3}>\s?/, ""));
        j += 1;
      }
      const innerHtml = renderBlocks(quoteLines, ctx);
      out.push(`<blockquote>${innerHtml}</blockquote>`);
      i = j;
      continue;
    }

    // 5. GFM Table
    if (line.includes("|") && i + 1 < lines.length) {
      const aligns = parseTableSeparator(lines[i + 1]!);
      const headerCells = splitTableRow(line);
      if (aligns && headerCells.length > 0 && aligns.length === headerCells.length) {
        const theadHtml =
          "<thead><tr>" +
          headerCells
            .map((cell, idx) => {
              const al = aligns[idx];
              const style = al ? ` style="text-align:${al}"` : "";
              return `<th${style}>${renderInline(cell, ctx.enableFileLinks)}</th>`;
            })
            .join("") +
          "</tr></thead>";

        const bodyRows: string[] = [];
        let j = i + 2;
        while (
          j < lines.length &&
          lines[j]!.trim() &&
          lines[j]!.includes("|") &&
          !FENCE_RE.test(lines[j]!) &&
          !HEADING_RE.test(lines[j]!) &&
          !isHorizontalRule(lines[j]!)
        ) {
          const cells = splitTableRow(lines[j]!);
          const rowHtml =
            "<tr>" +
            headerCells
              .map((_h, idx) => {
                const al = aligns[idx];
                const style = al ? ` style="text-align:${al}"` : "";
                return `<td${style}>${renderInline(cells[idx] ?? "", ctx.enableFileLinks)}</td>`;
              })
              .join("") +
            "</tr>";
          bodyRows.push(rowHtml);
          j += 1;
        }

        const tbodyHtml = `<tbody>${bodyRows.join("")}</tbody>`;
        out.push(
          `<div class="reader-table-wrap" role="region" tabindex="0" aria-label="Data table">` +
            `<table>${theadHtml}${tbodyHtml}</table>` +
            `</div>`
        );
        i = j;
        continue;
      }
    }

    // 6. Ordered / Unordered / Task List
    if (LIST_ITEM_RE.test(line)) {
      const res = renderListBlock(lines, i, ctx);
      out.push(res.html);
      i = res.nextIdx;
      continue;
    }

    // 7. Paragraph
    const paraLines: string[] = [line];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j]!;
      if (
        !next.trim() ||
        FENCE_RE.test(next) ||
        HEADING_RE.test(next) ||
        isHorizontalRule(next) ||
        /^\s{0,3}>/.test(next) ||
        LIST_ITEM_RE.test(next) ||
        (next.includes("|") &&
          j + 1 < lines.length &&
          parseTableSeparator(lines[j + 1]!) !== null)
      ) {
        break;
      }
      paraLines.push(next);
      j += 1;
    }

    out.push(`<p>${renderInline(paraLines.join("\n"), ctx.enableFileLinks)}</p>`);
    i = j;
  }

  return out.join("\n");
}

export function renderMarkdown(
  md: string,
  opts: RenderMarkdownOptions = {}
): MarkdownRenderResult {
  const normalized = String(md ?? "")
    .replace(/\r\n?/g, "\n")
    // Strip control characters except tab and newline so sentinel tokens can never collide
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

  const ctx: ParseContext = {
    idPrefix: opts.idPrefix ?? "md-",
    enableFileLinks: opts.enableFileLinks !== false,
    headings: [],
    slugCounts: new Map(),
  };

  const lines = normalized.split("\n");
  const html = renderBlocks(lines, ctx);
  return { html, headings: ctx.headings };
}
