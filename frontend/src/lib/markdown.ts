import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";
import taskLists from "markdown-it-task-lists";
import type { LinkPreview } from "./types";

export type ResolveHref = (href: string, kind: "image" | "link") => string;

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
}).enable("table")
  .use(taskLists, { enabled: true, label: true });

const ATTACHMENT_LINK_RE = /^attachments\//;

const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
const defaultLinkClose = md.renderer.rules.link_close ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet("href") ?? "";
  const isAttachment = ATTACHMENT_LINK_RE.test(href);
  if (env?.resolveHref && isAttachment) {
    tokens[idx].attrSet("href", env.resolveHref(href, "link"));
  }
  const finalHref = tokens[idx].attrGet("href") ?? "";
  if (isAttachment || (/^(https?:)?\/\//i.test(finalHref) && !finalHref.startsWith("/"))) {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = token.attrGet("src") ?? "";
  if (env?.resolveHref && ATTACHMENT_LINK_RE.test(src)) {
    token.attrSet("src", env.resolveHref(src, "image"));
  }
  return self.renderToken(tokens, idx, options);
};

const MEDIA_RE = /\.(webm|ogg|mp3|m4a|wav|mp4|mov)(#.*)?$/i;

/** When a paragraph contains exactly one http(s) link, mark it for a rich-preview card. */
function standaloneLinkHref(tokens: Token[]): string | null {
  if (tokens.length !== 3) return null;
  if (tokens[0]?.type !== "link_open" || tokens[2]?.type !== "link_close" || tokens[1]?.type !== "text") return null;
  const href = tokens[0].attrGet("href") ?? "";
  if (!/^https?:\/\//i.test(href)) return null;
  if (ATTACHMENT_LINK_RE.test(href) || MEDIA_RE.test(href)) return null;
  return href;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Full rich-card markup for a resolved preview (rendered synchronously by the Renderer). */
function previewCardHtml(res: LinkPreview): string {
  const href = escAttr(res.url || "");
  const title = escText(res.title || res.url || href);
  const host = escText(res.provider || hostOf(res.url || href));
  const desc = res.description ? `<span class="link-preview-desc">${escText(res.description)}</span>` : "";
  const img = res.image ? `<img src="${escAttr(res.image)}" alt="${escAttr(res.title ?? "")}" loading="lazy">` : "";
  return `<a class="link-preview-card" href="${href}" target="_blank" rel="noopener noreferrer">${img}<span class="link-preview-text"><span class="link-preview-title">${title}</span><span class="link-preview-host">${host}</span>${desc}</span></a>`;
}

md.renderer.rules.link_close = (tokens, idx, options, env, self) => {
  let href: string | null = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (tokens[i].type === "link_open") {
      href = tokens[i].attrGet("href");
      break;
    }
  }
  if (href && MEDIA_RE.test(href)) {
    const isAudio = /\.(webm|ogg|mp3|m4a|wav)(#.*)?$/i.test(href);
    const label = idx > 0 && tokens[idx - 1].type === "text" ? tokens[idx - 1].content : "media";
    const esc = (s: string) => s.replace(/"/g, "&quot;");
    const player = `<${isAudio ? "audio" : "video"} controls preload="metadata" src="${esc(href)}" aria-label="${esc(label)}"></${isAudio ? "audio" : "video"}>`;
    return `${defaultLinkClose(tokens, idx, options, env, self)}${player}`;
  }
  const previewHref = standaloneLinkHref(tokens);
  if (previewHref) {
    const esc = (s: string) => s.replace(/"/g, "&quot;");
    const previews = (env?.previews ?? {}) as Record<string, LinkPreview | null>;
    const known = previews[previewHref];
    if (known && (known.title || known.image)) {
      return `${defaultLinkClose(tokens, idx, options, env, self)}${previewCardHtml(known)}`;
    }
    if (known === null) {
      // preview attempted but unavailable — keep the plain link, no card
      return defaultLinkClose(tokens, idx, options, env, self);
    }
    return `${defaultLinkClose(tokens, idx, options, env, self)}<div class="link-preview loading" data-href="${esc(previewHref)}"></div>`;
  }
  return defaultLinkClose(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string, resolveHref?: ResolveHref, previews?: Record<string, LinkPreview | null>): string {
  return md.render(source, { resolveHref, previews });
}