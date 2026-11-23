import { useEffect, useRef, useState } from "react";
import { renderMarkdown, type ResolveHref } from "../lib/markdown";
import type { LinkPreview } from "../lib/types";
import { api } from "../lib/api";

interface Props {
  source: string;
  resolveHref?: ResolveHref;
  onScrollSync?: (fraction: number) => void;
}

/** Module-level cache so navigating away and back doesn't refetch or re-flicker. */
const previewCache = new Map<string, LinkPreview | null>();

/** Debounce before fetching so mid-typing partial URLs don't trigger a request storm. */
const FETCH_DELAY_MS = 350;

export default function Preview({ source, resolveHref, onScrollSync }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef(0);
  const [previews, setPreviews] = useState<Record<string, LinkPreview | null>>(() => {
    const init: Record<string, LinkPreview | null> = {};
    for (const [k, v] of previewCache) init[k] = v;
    return init;
  });
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  const inFlight = useRef(new Set<string>());

  const html = renderMarkdown(source, resolveHref, previews);

  useEffect(() => {
    // after render, restore scroll by fraction to keep sync
    const el = ref.current;
    if (!el) return;
    const sync = last.current;
    if (sync > 0) {
      el.scrollTop = sync * el.scrollHeight;
    }
  }, [html]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // wait for a quiet pause so a link that's still being typed is only fetched once complete
    const t = setTimeout(() => {
      const nodes = Array.from(el.querySelectorAll<HTMLElement>(".link-preview.loading[data-href]:not([data-scanned])"));
      for (const node of nodes) {
        node.dataset.scanned = "1";
        const href = node.dataset.href ?? "";
        if (!href) continue;
        if (href in previewsRef.current || inFlight.current.has(href)) continue;
        inFlight.current.add(href);
        api.linkPreview(href).then((res) => {
          inFlight.current.delete(href);
          previewCache.set(href, res);
          setPreviews((prev) => (prev[href] !== undefined ? prev : { ...prev, [href]: res }));
        });
      }
    }, FETCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [source]);

  return (
    <div
      ref={ref}
      className="markdown-preview"
      onScroll={(e) => {
        const el = e.currentTarget;
        const fraction = el.scrollTop / (el.scrollHeight - el.clientHeight || 1);
        last.current = fraction;
        onScrollSync?.(fraction);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}