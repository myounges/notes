import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import DOMPurify from "dompurify";

/** Rich-text paste payload captured at paste time by the editor. */
export interface RichPasteData {
  html: string;
  from: number;
  to: number;
}

export interface PastePayload {
  files: File[];
  html: string;
}

/** The editor's clipboard has nothing for us (none) | image file items (files) | rich HTML (rich). */
export type PasteDecision = "none" | "files" | "rich";

/** An inline image extracted from pasted HTML, handed to the caller for upload. */
export interface DataImage {
  src: string;
  mime: string;
  alt: string;
}

export interface ConvertResult {
  markdown: string;
  uploaded: number;
}

/** Returns the attachment filename for the given embedded image. */
export type DataToAttachment = (img: DataImage) => Promise<string>;

/** Pasted HTML larger than this (~2MB) is too heavy to convert; fall back to plain text. */
export const MAX_RICH_HTML_LENGTH = 2_000_000;

const FORBID_TAGS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "select",
  "textarea",
  "button",
  "noscript",
  "svg",
  "math",
];

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  emDelimiter: "_",
  strongDelimiter: "**",
  codeBlockStyle: "fenced",
  linkStyle: "inlined",
});
turndown.use(gfm);
// Links with an empty href (Word/bookmark artifacts) keep only their text.
turndown.addRule("emptyLink", {
  filter: (node) => node.nodeName === "A" && !(node.getAttribute?.("href") ?? "").trim(),
  replacement: (content) => content,
});

function toDom(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** Sanitize arbitrary pasted HTML: scripts/handlers/javascript: links all go. */
function clean(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_TAGS, ALLOW_DATA_ATTR: false });
}

function replaceNbsp(root: Element): void {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3 && (node.textContent ?? "").includes("\u00A0")) {
        node.textContent = (node.textContent ?? "").replace(/\u00A0/g, " ");
      }
    }
  }
}

function removeEmptyPods(root: Element): void {
  for (const el of Array.from(root.querySelectorAll('p, div'))) {
    const text = (el.textContent ?? "").trim();
    if (text === "" && !el.querySelector("img")) el.remove();
  }
}

/** Drop Word/Outlook/Google-Docs decoration that only adds noise to Markdown. */
function tidyDom(root: Element): void {
  for (const el of Array.from(root.querySelectorAll("o\\:p"))) {
    el.remove();
  }
  // Only non-checkbox form controls are decoration; checkbox inputs feed the
  // task-list converter.
  for (const el of Array.from(root.querySelectorAll("input"))) {
    if ((el.getAttribute("type") ?? "text") !== "checkbox") el.remove();
  }
  for (const el of Array.from(root.querySelectorAll('a[href=""], a:not([href])'))) {
    if (!(el.textContent ?? "").trim()) el.remove();
  }
  // List items copied with a leading space (Word/GFM checkbox markup) would
  // otherwise render as "-   [x]  done"; drop leading whitespace on direct
  // text children so list lines stay tight.
  for (const li of Array.from(root.querySelectorAll("li"))) {
    for (const node of Array.from(li.childNodes)) {
      if (node.nodeType === 3 && /^\s+\S/.test(node.textContent ?? "")) {
        node.textContent = (node.textContent ?? "").replace(/^\s+/, "");
        break;
      }
    }
  }
  replaceNbsp(root);
  removeEmptyPods(root);
}

const tidyMarkdown = (md: string): string =>
  md
    .replace(/^(\s*(?:[-+*]|\d+\.))\s+/gm, "$1 ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "")
    .concat("\n");

/**
 * Classify a paste payload. `rich` → convert HTML to Markdown; `files` → the
 * caller's existing image-upload path; `none` → default (plain-text) paste.
 */
export function decidePasteAction({ files, html }: PastePayload): PasteDecision {
  const hasFiles = files.length > 0;
  const trimmed = html.trim();
  if (!trimmed || trimmed.length > MAX_RICH_HTML_LENGTH) return hasFiles ? "files" : "none";
  const doc = toDom(clean(html));
  const hasText = (doc.body.textContent ?? "").trim().length > 0;
  // Image-only rich paste (copying a picture). Prefer the file-item path when
  // present — it avoids converting AND uploading the same image twice.
  if (!hasText) return hasFiles ? "files" : "rich";
  return "rich";
}

/**
 * Convert sanitized rich-text HTML to Markdown. Embedded `data:` images are
 * uploaded through `dataToAttachment` and rewritten to `attachments/<name>`;
 * remote URLs are left untouched; SVG data URIs (and images without src) leave
 * their alt text behind.
 */
export async function convertRich(html: string, dataToAttachment: DataToAttachment): Promise<ConvertResult> {
  const doc = toDom(clean(html));
  tidyDom(doc.body);
  let uploaded = 0;
  for (const img of Array.from(doc.body.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    const alt = (img.getAttribute("alt") ?? "").trim();
    if (!src || /^data:image\/svg(\+xml)?/i.test(src)) {
      if (alt) {
        img.replaceWith(img.ownerDocument.createTextNode(alt));
      } else {
        img.remove();
      }
      continue;
    }
    if (src.startsWith("data:image/")) {
      const mime = src.match(/^data:([^;,]+)/)?.[1] ?? "image/png";
      const name = await dataToAttachment({ src, mime, alt });
      img.setAttribute("src", `attachments/${encodeURIComponent(name)}`);
      uploaded++;
      continue;
    }
    // remote (http/https) and relative srcs pass through as-is
  }
  return { markdown: tidyMarkdown(turndown.turndown(doc.body.innerHTML)), uploaded };
}