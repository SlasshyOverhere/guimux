// Zero-dependency Markdown preview for the explorer.
// Raw HTML is escaped before any markup is generated, so file content
// can never inject live nodes.

// Placeholders that won't appear in normal text. Used to protect
// already-processed spans from later regex passes.
const P0 = "\u0001";
const P1 = "\u0002";

export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(p);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHref(href: string): string | null {
  const h = href.trim();
  if (!h || /[\u0000-\u001f\u007f\\]/.test(h)) return null;
  if (/^(https?:\/\/|mailto:|#)/i.test(h)) return esc(h);
  if (/^\.{1,2}\//.test(h)) return esc(h);
  if (/^\/(?!\/)/.test(h)) return esc(h);
  return null;
}

// Inline emphasis on already-escaped text. Code/link placeholders are
// control chars plus digits, so these markers never match inside them.
function emph(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\s][^*]*?)\*(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\s][^_]*?)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}

function inline(line: string, spans: string[], chunks: string[]): string {
  let s = esc(line);
  // Inline code first: its content skips all further formatting.
  s = s.replace(/`([^`]+)`/g, (_, code: string) => {
    spans.push(`<code>${code}</code>`);
    return `${P0}${spans.length - 1}${P0}`;
  });
  // Autolinked bare URLs in angle brackets.
  s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, (_, url: string) => {
    chunks.push(`<a href="${url}" rel="noopener noreferrer">${url}</a>`);
    return `${P1}${chunks.length - 1}${P1}`;
  });
  // Images render as alt text only: no remote loads from file content.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => `<span class="gm-md-img">${emph(alt)}</span>`);
  // Links with an unsafe scheme degrade to their text.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m: string, text: string, href: string) => {
    const safe = sanitizeHref(href);
    if (!safe) return emph(text);
    chunks.push(`<a href="${safe}" rel="noopener noreferrer">${emph(text)}</a>`);
    return `${P1}${chunks.length - 1}${P1}`;
  });
  s = emph(s);
  chunks.forEach((html, i) => {
    s = s.split(`${P1}${i}${P1}`).join(html);
  });
  spans.forEach((html, i) => {
    s = s.split(`${P0}${i}${P0}`).join(html);
  });
  return s;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

function isDelimRow(line: string): string[] | null {
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const aligns: string[] = [];
  for (const c of cells) {
    const m = c.match(/^(:?)-{1,}(:?)$/);
    if (!m) return null;
    aligns.push(m[1] && m[2] ? "center" : m[2] ? "right" : "left");
  }
  return aligns;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const spans: string[] = [];
  const chunks: string[] = [];
  const out: string[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];
  let fence: string[] | null = null;
  let fenceLang = "";

  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${para.map((l) => inline(l, spans, chunks)).join("<br>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`${list.ordered ? "<ol>" : "<ul>"}${list.items.join("")}${list.ordered ? "</ol>" : "</ul>"}`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length > 0) {
      out.push(`<blockquote>${quote.map((l) => inline(l, spans, chunks)).join("<br>")}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };
  const emitFence = () => {
    if (fence == null) return;
    const lang = fenceLang ? ` data-lang="${esc(fenceLang)}"` : "";
    out.push(`<pre class="gm-md-pre"><code${lang}>${esc(fence.join("\n"))}</code></pre>`);
    fence = null;
    fenceLang = "";
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (fence != null) {
      if (/^```[ \t]*$/.test(raw)) emitFence();
      else fence.push(raw);
      continue;
    }
    const fenceOpen = raw.match(/^```(\w*)\s*$/);
    if (fenceOpen) {
      flushAll();
      fence = [];
      fenceLang = fenceOpen[1] ?? "";
      continue;
    }
    if (/^\s*$/.test(raw)) {
      flushAll();
      continue;
    }
    const heading = raw.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (heading) {
      flushAll();
      const level = heading[1]?.length ?? 1;
      const text = (heading[2] ?? "").replace(/\s+#+\s*$/, "");
      out.push(`<h${level}>${inline(text, spans, chunks)}</h${level}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
      flushAll();
      out.push("<hr>");
      continue;
    }
    // Table: header row plus a delimiter row directly beneath it.
    if (raw.includes("|")) {
      const aligns = isDelimRow(lines[i + 1] ?? "");
      if (aligns) {
        flushAll();
        const head = splitRow(raw);
        const th = head
          .map((c, k) => `<th${aligns[k] && aligns[k] !== "left" ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c, spans, chunks)}</th>`)
          .join("");
        const rows: string[] = [];
        i += 2;
        while (i < lines.length && (lines[i] ?? "").includes("|") && !/^\s*$/.test(lines[i] ?? "")) {
          const cells = splitRow(lines[i] ?? "");
          if (cells.length === 0) break;
          rows.push(
            `<tr>${cells.map((c, k) => `<td${aligns[k] && aligns[k] !== "left" ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c, spans, chunks)}</td>`).join("")}</tr>`,
          );
          i++;
        }
        i--;
        out.push(`<table><thead><tr>${th}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
        continue;
      }
    }
    const bq = raw.match(/^\s*>\s?(.*)$/);
    if (bq) {
      flushPara();
      flushList();
      quote.push(bq[1] ?? "");
      continue;
    }
    flushQuote();
    const ul = raw.match(/^\s*[-*+]\s+(.*)$/);
    const ol = raw.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const ordered = !ul;
      const text = (ul?.[1] ?? ol?.[1] ?? "").trim();
      const task = text.match(/^\[([ xX])\]\s+(.*)$/);
      const item = task
        ? `<input type="checkbox" disabled${task[1]?.toLowerCase() === "x" ? " checked" : ""}> ${inline(task[2] ?? "", spans, chunks)}`
        : inline(text, spans, chunks);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(`<li>${item}</li>`);
      continue;
    }
    flushList();
    para.push(raw);
  }
  emitFence();
  flushAll();
  return out.join("");
}
