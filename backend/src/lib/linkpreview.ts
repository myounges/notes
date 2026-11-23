import net from "node:net";
import { lookup } from "node:dns/promises";

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  provider?: string;
  videoId?: string;
}

const TIMEOUT_MS = 4500;
const MAX_HTML = 300_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_LIMIT = 200;

const cache = new Map<string, { at: number; val: LinkPreview | null }>();

/** Pulls the video id out of common YouTube URL shapes, or null. */
export function extractVideoId(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const ok = (id: string | null) => (id && /^[\w-]{6,}$/.test(id) ? id : null);
  if (host !== "youtube.com" && host !== "www.youtube.com" && host !== "m.youtube.com" && host !== "music.youtube.com" && host !== "youtu.be") {
    return null;
  }
  if (host === "youtu.be") {
    return ok(u.pathname.split("/")[1] ?? null);
  }
  if (u.pathname === "/watch") {
    return ok(u.searchParams.get("v"));
  }
  const m = /^\/(?:embed|shorts|live|v)\/([\w-]{6,})$/.exec(u.pathname);
  return ok(m?.[1] ?? null);
}

/** Pulls the numeric design id from a MakerWorld model URL (`/models/1390818`, with optional locale prefix). */
export function extractMakerWorldDesignId(raw: string): string | null {
  const m = /^https:\/\/(?:www\.)?makerworld\.com(?:\/[a-z]{2})?\/models\/(\d+)/i.exec(raw);
  return m?.[1] ?? null;
}

/** Strip HTML/entities out of an API description field. */
export function cleanHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^Boost\s*Me\b/i, "")
    .trim()
    .slice(0, 400);
}

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

/** True when an IP is loopback/private/link-local/reserved (SSRF guard). */
export function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::" || lower === "0.0.0.0") return true;
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
    return isPrivateIpV4(lower.slice(7));
  }
  if (lower.includes(":")) {
    const first = lower.split(":")[0] ?? "";
    const hext = parseInt(first, 16);
    if (Number.isNaN(hext)) return false;
    if (hext >= 0xfc00) return true; // fc00::/7 (unique local)
    if (hext >= 0xfe80 && hext <= 0xfebf) return true; // fe80::/10 (link-local)
    return false;
  }
  return isPrivateIpV4(ip);
}

function isPrivateIpV4(ip: string): boolean {
  const parts = ipv4Parts(ip);
  if (!parts) return true; // not even parseable
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, 127/8
  if (a === 169 && b === 254) return true; // 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15
  return false;
}

/** Returns a reason string when the raw URL must not be fetched, else null. */
export async function isBlockedUrl(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid url";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme not http(s)";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".local") || host.endsWith(".internal")) {
    return "local hostname";
  }
  const hostNoBrackets = host.replace(/^\[|\]$/g, "");
  if (net.isIP(hostNoBrackets)) {
    return isPrivateIp(hostNoBrackets) ? "private ip" : null;
  }
  try {
    const { address } = await lookup(hostNoBrackets, { all: false });
    return isPrivateIp(address) ? "private ip" : null;
  } catch {
    return "dns failed";
  }
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return null;
  return htmlDecode(m[1] ?? m[2] ?? m[3] ?? "");
}

function htmlDecode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function metas(html: string): Array<{ key: string | null; content: string | null }> {
  const out: Array<{ key: string | null; content: string | null }> = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    out.push({ key: attr(tag, "property") ?? attr(tag, "name") ?? attr(tag, "itemprop"), content: attr(tag, "content") });
  }
  return out;
}

function pick(html: string, keys: string[]): string | null {
  for (const { key, content } of metas(html)) {
    if (content && key && keys.some((k) => k.toLowerCase() === key.toLowerCase())) return content;
  }
  return null;
}

function discoverOEmbed(html: string): string | null {
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const t = tag[0];
    const type = attr(t, "type");
    const rel = attr(t, "rel");
    if (/^application\/json\+oembed$/i.test(type ?? "") && rel && /\balternate\b/i.test(rel)) {
      const href = attr(t, "href");
      if (href) return href;
    }
  }
  return null;
}

function toPreview(base: URL, data: Record<string, unknown>): LinkPreview {
  const p: LinkPreview = { url: base.href };
  const map: Array<[string, keyof LinkPreview]> = [
    ["title", "title"],
    ["thumbnail_url", "image"],
    ["provider_name", "provider"],
    ["description", "description"],
    ["video_id", "videoId"],
  ];
  for (const [src, dst] of map) {
    const v = data[src];
    if (typeof v === "string" && v.trim()) (p as unknown as Record<string, unknown>)[dst] = v;
  }
  if (p.image && !/^https?:\/\//i.test(p.image)) {
    try {
      p.image = new URL(p.image, base.href).href;
    } catch {
      delete p.image;
    }
  }
  if (p.image && !/^https?:\/\//i.test(p.image)) delete p.image;
  return p;
}

async function fetchJson(url: string, maxBytes = 50_000): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const text = (await res.text()).slice(0, maxBytes);
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function scrape(html: string, baseUrl: URL): LinkPreview {
  const p: LinkPreview = { url: baseUrl.href };
  const title = pick(html, ["og:title", "twitter:title", "title"]);
  if (!title) {
    const h1 = /<h1[^>]*>\s*(.*?)\s*<\/h1>/is.exec(html);
    if (h1 && h1[1]) {
      try {
        p.title = htmlDecode(h1[1]);
      } catch {
        p.title = h1[1];
      }
    }
  } else {
    p.title = title;
  }
  const description = pick(html, ["og:description", "twitter:description", "description"]);
  if (description) p.description = description;
  let image: string | null = pick(html, ["og:image", "og:image:url", "twitter:image"]);
  if (image) {
    if (!/^https?:\/\//i.test(image)) {
      try {
        image = new URL(image, baseUrl.href).href;
      } catch {
        image = null;
      }
    }
    if (image && /^https?:\/\//i.test(image)) p.image = image;
  }
  const provider = baseUrl.hostname;
  if (provider) p.provider = provider;
  return p;
}

async function makerworldPreview(id: string, base: URL): Promise<LinkPreview | null> {
  // MakerWorld page routes sit behind a Cloudflare challenge, but the design
  // service on api.bambulab.com responds anonymously with full metadata.
  const data = await fetchJson(`https://api.bambulab.com/v1/design-service/design/${id}`, 200_000);
  if (!data) return null;
  const p: LinkPreview = { url: base.href, provider: "MakerWorld" };
  if (typeof data.title === "string" && data.title.trim()) p.title = data.title.trim();
  if (typeof data.summary === "string" && data.summary.trim()) p.description = cleanHtml(data.summary);
  if (typeof data.coverUrl === "string" && /^https?:\/\//i.test(data.coverUrl)) p.image = data.coverUrl;
  return p.title || p.image ? p : null;
}

async function fetchPreview(url: URL): Promise<LinkPreview | null> {
  const ytId = extractVideoId(url.href);
  if (ytId) {
    const data = await fetchJson(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ytId}`)}&format=json`,
    );
    const p = toPreview(url, data ?? { video_id: ytId });
    if (!p.videoId) p.videoId = ytId;
    if (!p.provider) p.provider = "YouTube";
    if (!p.image && ytId) p.image = `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`;
    return p;
  }

  const mwId = extractMakerWorldDesignId(url.href);
  if (mwId) {
    const p = await makerworldPreview(mwId, url);
    if (p) return p;
  }

  const res = await fetch(url.href, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const finalUrl = new URL(res.url || url.href);
  const ct = res.headers.get("content-type") ?? "";
  if (ct && !ct.startsWith("text/html") && !ct.includes("xml") && !ct.includes("json") && !ct.startsWith("text/")) {
    return null;
  }
  const html = (await res.text()).slice(0, MAX_HTML);

  const oembedHref = discoverOEmbed(html);
  if (oembedHref) {
    try {
      const oembedUrl = new URL(oembedHref, finalUrl.href);
      if ((oembedUrl.protocol === "http:" || oembedUrl.protocol === "https:") && !(await isBlockedUrl(oembedUrl.href))) {
        const data = await fetchJson(oembedUrl.href);
        if (data && (data.title || data.thumbnail_url)) return toPreview(finalUrl, data);
      }
    } catch {
      // fall through to scraping
    }
  }

  return scrape(html, finalUrl);
}

/** Resolves a "rich preview" for an http(s) URL, or null if none could be built. Always safe to call. */
export async function linkPreview(raw: string): Promise<LinkPreview | null> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (await isBlockedUrl(url.href)) return null;

  const key = url.href;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.val;

  let val: LinkPreview | null = null;
  try {
    val = await fetchPreview(url);
  } catch {
    val = null;
  }

  if (cache.size >= CACHE_LIMIT) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.at > CACHE_TTL_MS) cache.delete(k);
    }
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, { at: Date.now(), val });
  return val;
}